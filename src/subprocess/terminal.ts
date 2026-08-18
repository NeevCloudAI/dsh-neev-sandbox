import { PassThrough } from 'node:stream'
import type {
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type NeevRuntime from '../runtime.ts'
import { ptySignalName } from './remote.ts'

/**
 * Allocate a PTY in the sandbox and adapt it to the seam's terminal handle.
 * The SDK PtyHandle drives byte I/O, resize, signals, and exit. PTY create
 * takes no cwd/env, so the terminal runs in the sandbox's default working
 * directory and environment; foreground-group inspection is unavailable.
 */
export async function spawnNeevTerminal(
  neev: NeevRuntime,
  spec: SubprocessTerminalSpawnSpec,
): Promise<SubprocessTerminalHandle> {
  const sandbox = await neev.getSandbox()
  // Keep the sandbox awake for the life of the PTY so an idle pause cannot
  // freeze an interactive session; released when the terminal exits.
  const release = neev.hold()
  const output = new PassThrough()
  const decoder = new TextDecoder()
  const [program, ...args] = spec.argv
  // Release the hold if allocation fails, so a failed PTY create doesn't wedge
  // the active count and permanently disable idle auto-pause.
  const pty = await sandbox.pty.create({
    program,
    args,
    cols: spec.cols,
    rows: spec.rows,
    onData: chunk => output.write(decoder.decode(chunk, { stream: true })),
  }).catch((error: unknown) => { release(); throw error })
  // Flush any trailing multibyte sequence, then end the output stream. Runs on
  // both a clean exit and a transport failure so a reader never hangs on EOF.
  const finish = (): void => {
    release()
    const trailing = decoder.decode()
    if (trailing !== '') output.write(trailing)
    output.end()
  }
  const done = pty.wait().then(
    (result) => { finish(); return { exitCode: result.exitCode, signal: null } },
    (error: unknown) => { finish(); throw error },
  )

  return {
    pid: -1,
    output,
    done,
    write: async (data: string): Promise<void> => { pty.sendInput(data) },
    inspectForeground: async (): Promise<SubprocessTerminalForeground | undefined> => undefined,
    signalForeground: async (signal: SubprocessTerminalSignal): Promise<number> => {
      pty.kill(ptySignalName(signal))
      return -1
    },
    terminate: async (): Promise<void> => {
      pty.kill('SIGKILL')
      await pty.wait().catch(() => undefined)
    },
  }
}
