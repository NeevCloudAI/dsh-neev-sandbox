import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { Sandbox } from '@neevcloud/sdk'
import type NeevRuntime from '../runtime.ts'
import { BoundedOutput } from './output.ts'
import { buildChildEnv, toWorkspaceRelative } from './environment.ts'
import { signalNumber } from './remote.ts'

/**
 * One managed NeevSandbox process. `processes.start` returns immediately with a
 * string id; a single `processes.follow` demultiplexes stdout/stderr/exit into
 * the spec's per-stream dispositions. `pid` is -1 — the SDK exposes no numeric
 * OS pid — so termination goes through the string process id.
 */
export class NeevSubprocessHandle implements SubprocessHandle {
  readonly pid = -1
  readonly stdin = undefined
  stdout: Readable | undefined
  stderr: Readable | undefined
  collected: { stdout?: BoundedOutput, stderr?: BoundedOutput } = {}
  readonly done: Promise<SubprocessOutcome>

  private stdoutPipe: PassThrough | undefined
  private stderrPipe: PassThrough | undefined
  private sandbox: Sandbox | undefined
  private processId = ''
  private exited = false
  private killRequested = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private abortTimer: ReturnType<typeof setTimeout> | undefined
  // Fires only as a last-resort backstop to unstick the follow loop when kill
  // fails to produce an exit, so run()/done can never hang forever.
  private readonly abort = new AbortController()

  /**
   * Wire the stdio dispositions and start the process.
   * @param neev - lifecycle owner; the sandbox is resolved inside run().
   * @param spec - fully-specified spawn request.
   */
  constructor(
    private readonly neev: NeevRuntime,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    this.setupStream('stdout', spec.stdio.stdout)
    this.setupStream('stderr', spec.stdio.stderr)
    this.done = this.run()
    // A signal that is already aborted never emits 'abort'; honor it directly.
    if (spec.signal?.aborted) this.terminate()
    else spec.signal?.addEventListener('abort', () => this.terminate(), { once: true })
  }

  /** Allocate a raw pipe or a bounded collector for one output stream. */
  private setupStream(which: 'stdout' | 'stderr', mode: SubprocessOutputMode): void {
    if (mode === 'pipe') {
      const pipe = new PassThrough()
      if (which === 'stdout') { this.stdout = pipe; this.stdoutPipe = pipe }
      else { this.stderr = pipe; this.stderrPipe = pipe }
    } else if (mode !== 'inherit') {
      this.collected[which] = new BoundedOutput(mode.maxBytes)
    }
  }

  /** Route one decoded chunk to its pipe, the harness stream, or its collector. */
  private emit(which: 'stdout' | 'stderr', data: string): void {
    const mode = which === 'stdout' ? this.spec.stdio.stdout : this.spec.stdio.stderr
    if (mode === 'pipe') (which === 'stdout' ? this.stdoutPipe : this.stderrPipe)?.write(data)
    else if (mode === 'inherit') process[which].write(data)
    else this.collected[which]?.push(data)
  }

  /** Start the process, drain its follow stream, and resolve exit facts. */
  private async run(): Promise<SubprocessOutcome> {
    const sandbox = await this.neev.getSandbox()
    this.sandbox = sandbox
    try {
      const started = await sandbox.processes.start([...this.spec.argv], {
        cwd: toWorkspaceRelative(this.spec.cwd, this.neev.cwd),
        env: buildChildEnv(this.spec.env),
        ...(typeof this.spec.stdio.stdin === 'object' ? { stdin: this.spec.stdio.stdin.data } : {}),
      })
      this.processId = started.id
      // A terminate() that raced process start is honored now the id exists.
      if (this.killRequested) this.escalate()
      let exitCode: number | null = null
      for await (const event of sandbox.processes.follow(this.processId, { signal: this.abort.signal })) {
        if (event.type === 'exit') { exitCode = event.exitCode; break }
        this.emit(event.type, event.data)
      }
      return { exitCode, signal: null }
    } finally {
      // Settle every resource on any exit path (normal, throw, or abort) so a
      // consumer draining a piped stream to EOF never hangs.
      this.exited = true
      this.clearTimers()
      this.stdoutPipe?.end()
      this.stderrPipe?.end()
    }
  }

  /** Deliver SIGTERM, then SIGKILL after grace, then abort follow as a backstop. */
  private escalate(): void {
    const sandbox = this.sandbox
    if (sandbox === undefined || this.processId === '') return
    void sandbox.processes.kill(this.processId, signalNumber('SIGTERM')).catch(() => false)
    this.killTimer = setTimeout(() => {
      if (!this.exited) void sandbox.processes.kill(this.processId, signalNumber('SIGKILL')).catch(() => false)
      // If SIGKILL still yields no exit event, stop waiting on the remote by
      // cancelling the follow stream so run()/done settle instead of hanging.
      this.abortTimer = setTimeout(() => {
        if (!this.exited) this.abort.abort()
      }, this.spec.graceMs)
      this.abortTimer.unref?.()
    }, this.spec.graceMs)
    this.killTimer.unref?.()
  }

  /** Clear any pending kill/abort timers. */
  private clearTimers(): void {
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    if (this.abortTimer !== undefined) clearTimeout(this.abortTimer)
  }

  /** Begin termination; idempotent and a no-op once the process has exited. */
  terminate(): void {
    if (this.exited || this.killRequested) return
    this.killRequested = true
    this.escalate()
  }

  /** Resolve true once the process exits, false if `signal` aborts the wait first. */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.exited) return true
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => resolve(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      void this.done.then(() => resolve(true), () => resolve(true))
        .finally(() => signal?.removeEventListener('abort', onAbort))
    })
  }
}
