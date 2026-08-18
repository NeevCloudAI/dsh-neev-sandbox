/**
 * NeevSandbox Service Provider for the subprocess capability seam. Each handle
 * starts through the shared sandbox's process supervisor.
 * @module @neevcloud/dsh-sandbox/subprocess
 */

import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { TrackedSubprocessRuntime } from './provider.ts'
import { NeevSubprocessHandle } from './process.ts'
import { spawnNeevTerminal } from './terminal.ts'
import { SHELL_NAME } from './remote.ts'

/** Configuration for the Neev subprocess adapter. */
export interface Config {
  /** Status/liveness poll cadence in milliseconds. */
  pollMs?: number
}

/** Neev process manager registered as `ctx.subprocess`. */
export class NeevSubprocessRuntime extends TrackedSubprocessRuntime {
  static inject = ['neev']

  static Config: z<Config> = z.object({ pollMs: z.number().default(20) })

  private readonly pollMs: number

  /** Wire config and disposal policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'neev subprocess teardown')
    this.pollMs = (config as { pollMs: number }).pollMs
  }

  /** Resolve one executable in the sandbox: verify absolute, look up bare names. */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-neev: executable name must be non-empty')
    signal?.throwIfAborted()
    const sandbox = await this.ctx.neev.getSandbox()
    if (posix.isAbsolute(command)) {
      const probe = await sandbox.exec(['bash', '-c', 'test -f "$1" && test -x "$1"', SHELL_NAME, command])
      signal?.throwIfAborted()
      if (probe.exitCode !== 0) throw new Error(`subprocess-neev: ${JSON.stringify(command)} is not an executable file`)
      return command
    }
    if (command.includes('/')) {
      throw new Error(`subprocess-neev: ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`)
    }
    const lookup = await sandbox.exec(
      ['bash', '-c', 'command -v -- "$1"', SHELL_NAME, command],
      { cwd: '.', ...(env?.PATH === undefined ? {} : { env: { PATH: env.PATH } }) },
    )
    signal?.throwIfAborted()
    const found = lookup.stdout.trim()
    if (lookup.exitCode !== 0 || found === '' || found.includes('\n')) {
      throw new Error(`subprocess-neev: executable ${JSON.stringify(command)} was not found on PATH`)
    }
    return posix.resolve(this.ctx.neev.cwd, found)
  }

  /** Start one managed process and return its live handle. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.guardSpawn(spec)
    // spawn() is synchronous per the seam; the handle resolves the sandbox
    // inside its own run() before starting the process.
    return this.adoptHandle(new NeevSubprocessHandle(this.ctx.neev, spec, this.pollMs))
  }

  /** Allocate a PTY-backed terminal session in the sandbox. */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.guardSpawn(spec)
    return spawnNeevTerminal(this.ctx.neev, spec)
  }
}

export default NeevSubprocessRuntime
