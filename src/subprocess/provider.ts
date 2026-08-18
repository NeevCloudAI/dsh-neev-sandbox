import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { NeevSubprocessHandle } from './process.ts'
import { asError } from './remote.ts'

/**
 * Base that tracks live handles for disposal and validates the spec invariants
 * shared by every spawn path. Concrete providers implement the seam methods.
 */
export abstract class TrackedSubprocessRuntime extends SubprocessRuntime {
  protected readonly live = new Set<NeevSubprocessHandle>()
  protected disposing = false

  /** Bind the disposal effect that terminates and joins every live handle. */
  constructor(ctx: Context, private readonly teardownLabel: string) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposing = true
      const pending = [...this.live].map(async (handle) => {
        handle.terminate()
        await handle.waitForExit()
        await handle.done.catch(() => undefined)
        this.live.delete(handle)
      })
      const outcomes = await Promise.allSettled(pending)
      const failures = outcomes.flatMap<unknown>(o => o.status === 'rejected' ? [o.reason] : [])
      if (failures.length === 1) throw asError(failures[0])
      if (failures.length > 1) throw new AggregateError(failures, `${this.teardownLabel}: teardown failed`)
    }, this.teardownLabel)
  }

  /** Retain a handle for disposal and drop it once it settles. */
  protected adoptHandle(handle: NeevSubprocessHandle): NeevSubprocessHandle {
    this.live.add(handle)
    void handle.done.catch(() => undefined).finally(() => this.live.delete(handle))
    return handle
  }

  /** Enforce the seam's positive-finite grace bound before any spawn. */
  protected guardSpawn(spec: SubprocessSpawnSpec | SubprocessTerminalSpawnSpec): void {
    if (this.disposing) throw new Error('subprocess-neev: service is disposing')
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subprocess-neev: graceMs must be positive, finite, and <= ${MAX_TIMER_DELAY_MS}`)
    }
  }
}
