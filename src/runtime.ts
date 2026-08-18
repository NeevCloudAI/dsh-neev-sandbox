/**
 * Shared ownership of one NeevSandbox. Capability adapters await the same SDK
 * handle, so process and filesystem ops inhabit one remote Linux world. The
 * sandbox can optionally persist across runs (reconnect by name) and auto-pause
 * while idle.
 * @module @neevcloud/dsh-sandbox/runtime
 */

import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebSocket } from 'ws'
import { Neev } from '@neevcloud/sdk'
import type { CreateSandboxParams, Sandbox, SandboxWebSocket } from '@neevcloud/sdk'

export type { Sandbox } from '@neevcloud/sdk'

/** Default template when neither templateId nor image is configured. */
const DEFAULT_TEMPLATE_ID = 'sb-ubuntu-26-04-minimal'

/**
 * Configuration for the shared NeevSandbox owner. The API key is intentionally
 * NOT a config field: it is read only from NEEV_API_KEY so a secret can never
 * be placed in a committed profile patch.
 */
export interface Config {
  /** Org id; omission reads NEEV_ORG_ID. */
  orgId?: string
  /** Project id; omission reads NEEV_PROJECT_ID. */
  projectId?: string
  /** Sandbox template id; the server resolves the image and default command. */
  templateId?: string
  /** Explicit image; takes precedence over templateId (mutually exclusive). */
  image?: string
  /** Absolute working directory; when omitted it is discovered via `pwd`. */
  cwd?: string
  /**
   * A stable sandbox name enabling persistence. When set, the runtime
   * reconnects to the live sandbox with this name instead of always creating,
   * and pauses (rather than deletes) it on shutdown, so its files and state
   * survive across runs. Omit for the default, fully-ephemeral behavior.
   */
  persist?: string
  /**
   * Auto-pause the sandbox after this many milliseconds of no activity, and
   * resume it lazily on the next operation. Omit to never auto-pause.
   */
  idleTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    neev: NeevRuntime
  }
}

/**
 * Owns one NeevSandbox handle across its consumers. Acquisition begins at
 * plugin construction; adapters await getSandbox() before their first
 * operation, which also resumes a sandbox that auto-paused while idle.
 */
export class NeevRuntime extends Service {
  static Config: z<Config> = z.object({
    orgId: z.string(),
    projectId: z.string(),
    templateId: z.string(),
    image: z.string(),
    cwd: z.string(),
    persist: z.string(),
    idleTimeoutMs: z.number(),
  })

  /** Absolute in-sandbox workspace root shared by provider adapters. */
  cwd = '/'
  /** Reserved absolute directory for adapter-owned state (created lazily by adapters). */
  runtimeRoot = '/'

  private readonly config: Config
  private readonly client: Neev
  private readonly ready: Promise<Sandbox>
  private handle: Sandbox | undefined
  private disposed = false
  // Whether this runtime paused the sandbox for idleness (so getSandbox resumes).
  private paused = false
  // Count of in-flight operations that must keep the sandbox awake.
  private active = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  // An in-flight idle pause, so getSandbox/teardown can serialize with it.
  private pausePromise: Promise<void> | undefined

  /** Wire config, start eager sandbox acquisition, and bind disposal teardown. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'neev')
    this.config = config
    // The API key is read from NEEV_API_KEY by the SDK; it is never taken from
    // config. baseURL is likewise not a config field — customers target
    // production (the SDK default), and the SDK honors NEEV_BASE_URL from the
    // environment for testing against other environments.
    this.client = new Neev({
      orgId: config.orgId ?? process.env.NEEV_ORG_ID,
      projectId: config.projectId ?? process.env.NEEV_PROJECT_ID,
      // The runtime's global WebSocket cannot send the bearer auth header, so
      // supply a `ws`-backed factory for interactive PTY sessions in Node.
      webSocket: (url, opts) => new WebSocket(url, opts) as unknown as SandboxWebSocket,
    })
    this.ready = this.open()
    // Keep an eager-acquisition failure observed; getSandbox() still surfaces it.
    void this.ready.catch(() => {})
    ctx.effect(() => this.teardown, 'neev sandbox teardown')
  }

  /**
   * Return the shared live SDK handle, resuming it first if it auto-paused.
   * Every call counts as activity and defers the next idle pause.
   * @throws when acquisition failed or the service is disposing.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('NeevSandbox service is disposing')
    const sandbox = await this.ready
    if (this.disposed) throw new Error('NeevSandbox service is disposing')
    // Let any in-flight idle pause settle before deciding whether to resume, so
    // a hold that arrived mid-pause doesn't run against a pausing sandbox.
    if (this.pausePromise !== undefined) await this.pausePromise.catch(() => undefined)
    // Resume whenever the sandbox is paused — by our idle timer or out of band
    // (e.g. another session sharing the persist name) — using the real phase.
    if (this.paused || sandbox.phase === 'Paused') {
      await this.resumeIfPaused(sandbox)
      this.paused = false
    }
    this.markActivity()
    return sandbox
  }

  /**
   * Keep the sandbox awake for the duration of an operation. Adapters take a
   * hold while a process or PTY is live so the idle timer cannot pause the
   * sandbox mid-stream (which would stall the follow and deadlock the caller).
   * @returns a release function; call it once when the work settles.
   */
  hold(): () => void {
    this.active += 1
    this.markActivity()
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.markActivity()
    }
  }

  /** Acquire the sandbox — reconnect by name when persisting, else create. */
  private async open(): Promise<Sandbox> {
    const persist = this.config.persist
    let sandbox: Sandbox
    let reused = false
    if (persist !== undefined) {
      const existingId = await this.findByName(persist)
      if (existingId !== undefined) {
        sandbox = await this.client.sandboxes.get(existingId)
        reused = true
      } else {
        sandbox = await this.client.sandboxes.create(this.createParams(persist))
      }
    } else {
      sandbox = await this.client.sandboxes.create(this.createParams(undefined))
    }
    try {
      await this.resumeIfPaused(sandbox)
      // The SDK addresses files/processes with workspace-relative paths, so learn
      // the absolute root once and hand every consumer the same identity.
      const pwd = this.config.cwd ?? (await sandbox.exec(['pwd'])).stdout.trim()
      this.cwd = pwd
      this.runtimeRoot = posix.join(pwd, '.dsh-neev')
      this.handle = sandbox
      const verb = reused ? 'reconnected' : 'created'
      this.ctx.logger.info('NeevSandbox %s: %s (cwd %s)', verb, sandbox.id, this.cwd)
      process.stderr.write(`NeevSandbox ${verb}: ${sandbox.id}\n`)
      this.scheduleIdle()
      return sandbox
    } catch (error: unknown) {
      // Only delete a sandbox we just created; never delete a reused one.
      if (!reused) await sandbox.delete().catch(() => undefined)
      throw error
    }
  }

  /**
   * Poll a sandbox to Ready, handling both a cold create (Pending → Ready) and a
   * paused reconnect. The SDK's waitUntilReady rejects any Paused phase outright,
   * and resume() can return still-paused and transition slowly, so drive the
   * wait here: resume while paused (re-issuing if it stalls) and poll refresh.
   */
  private async resumeIfPaused(sandbox: Sandbox): Promise<void> {
    const deadline = Date.now() + 180_000
    let lastResume = 0
    for (;;) {
      if (sandbox.phase === 'Ready') {
        await this.waitReachable(sandbox)
        return
      }
      if (sandbox.phase === 'RestoreFailed') {
        throw new Error(`NeevSandbox ${sandbox.id} failed to resume`)
      }
      if (sandbox.phase === 'Paused' && Date.now() - lastResume > 8_000) {
        await sandbox.resume().catch(() => undefined)
        lastResume = Date.now()
      }
      if (Date.now() >= deadline) {
        throw new Error(`NeevSandbox ${sandbox.id} did not become Ready within 180s (phase: ${sandbox.phase})`)
      }
      await new Promise(resolve => setTimeout(resolve, 1_500))
      await sandbox.refresh().catch(() => undefined)
    }
  }

  /**
   * Wait until the sandbox's data plane is routable. After create or resume the
   * phase can read Ready before the connect route is up, so a trivial exec is
   * retried (it throws a 503/connect error until the route exists).
   */
  private async waitReachable(sandbox: Sandbox): Promise<void> {
    const deadline = Date.now() + 90_000
    for (;;) {
      try {
        await sandbox.exec(['true'])
        return
      } catch (error: unknown) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
    }
  }

  /**
   * Find a reusable sandbox by persist name, skipping unrecoverable ones. Pages
   * through the whole listing so a persisted sandbox beyond the first page is
   * still found rather than silently re-created (which would orphan its files).
   */
  private async findByName(name: string): Promise<string | undefined> {
    for (let page = 1; ; page += 1) {
      const res = await this.client.sandboxes.list({ page, limit: 100 })
      const match = res.items.find(s => s.name === name && s.phase !== 'RestoreFailed')
      if (match !== undefined) return match.id
      if (res.items.length < 100 || page * 100 >= res.total) return undefined
    }
  }

  /** Build the create request, tagging it with the persist name when set. */
  private createParams(name: string | undefined): CreateSandboxParams {
    const base = this.config.image !== undefined && this.config.image !== ''
      ? { image: this.config.image }
      : { sandbox_template_id: this.config.templateId ?? DEFAULT_TEMPLATE_ID }
    return (name !== undefined ? { ...base, name } : base) as CreateSandboxParams
  }

  /** Record activity and (re)arm the idle-pause timer. */
  private markActivity(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.scheduleIdle()
  }

  /** Arm the idle-pause timer when idle-pausing is enabled and work is quiescent. */
  private scheduleIdle(): void {
    const ms = this.config.idleTimeoutMs
    if (ms === undefined || ms <= 0 || this.disposed || this.active > 0) return
    this.idleTimer = setTimeout(() => { void this.pauseIfIdle() }, ms)
    this.idleTimer.unref?.()
  }

  /** Pause the sandbox once it has been idle with no in-flight work. */
  private async pauseIfIdle(): Promise<void> {
    if (this.disposed || this.paused || this.active > 0 || this.handle === undefined || this.pausePromise !== undefined) return
    const sandbox = this.handle
    // Publish the pause so getSandbox/teardown can await it instead of racing.
    this.pausePromise = (async () => {
      try {
        await this.pauseAndWait(sandbox)
        this.paused = true
        this.ctx.logger.info('NeevSandbox paused (idle): %s', sandbox.id)
      } catch {
        // Leave the sandbox running if the pause did not land.
      } finally {
        this.pausePromise = undefined
      }
    })()
    await this.pausePromise
  }

  /**
   * Pause and wait until the sandbox reports Paused. `pause()` can return before
   * the pause is durable; waiting ensures the workspace is fully checkpointed
   * before the process exits or the next run resumes it. Throws if the pause
   * does not land, so callers never falsely record it as paused.
   */
  private async pauseAndWait(sandbox: Sandbox): Promise<void> {
    await sandbox.pause()
    const deadline = Date.now() + 60_000
    while (sandbox.phase !== 'Paused') {
      if (Date.now() >= deadline) {
        throw new Error(`NeevSandbox ${sandbox.id} did not reach Paused within 60s (phase: ${sandbox.phase})`)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
      await sandbox.refresh().catch(() => undefined)
    }
  }

  /** On disposal, pause a persistent sandbox to keep it for next run; else delete. */
  private readonly teardown = async (): Promise<void> => {
    this.disposed = true
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    let sandbox: Sandbox
    try {
      sandbox = await this.ready
    } catch {
      return
    }
    // Let an in-flight idle pause settle so we don't double-pause or misreport.
    if (this.pausePromise !== undefined) await this.pausePromise.catch(() => undefined)
    if (this.config.persist !== undefined) {
      try {
        if (!this.paused) await this.pauseAndWait(sandbox)
        this.ctx.logger.info('NeevSandbox paused (persist): %s', sandbox.id)
        process.stderr.write(`NeevSandbox paused: ${sandbox.id}\n`)
      } catch {
        this.ctx.logger.warn('NeevSandbox failed to pause on exit; it may still be running: %s', sandbox.id)
        process.stderr.write(`NeevSandbox failed to pause: ${sandbox.id}\n`)
      }
      return
    }
    await sandbox.delete().catch(() => undefined)
    this.ctx.logger.info('NeevSandbox terminated: %s', sandbox.id)
    process.stderr.write(`NeevSandbox terminated: ${sandbox.id}\n`)
  }
}

export default NeevRuntime
