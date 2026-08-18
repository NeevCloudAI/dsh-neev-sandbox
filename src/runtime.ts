/**
 * Shared ownership of one NeevSandbox. Capability adapters await the same SDK
 * handle, so process and (future) filesystem ops inhabit one remote Linux world.
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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    neev: NeevRuntime
  }
}

/**
 * Creates one lazily consumable NeevSandbox handle and deletes it at disposal.
 * Creation begins at plugin construction; adapters await getSandbox() first.
 */
export class NeevRuntime extends Service {
  static Config: z<Config> = z.object({
    orgId: z.string(),
    projectId: z.string(),
    templateId: z.string(),
    image: z.string(),
    cwd: z.string(),
  })

  /** Absolute in-sandbox workspace root shared by provider adapters. */
  cwd = '/'
  /** Reserved absolute directory for adapter-owned state (created lazily by adapters). */
  runtimeRoot = '/'

  private readonly config: Config
  private readonly client: Neev
  private readonly ready: Promise<Sandbox>
  private disposed = false

  /** Wire config, start eager sandbox creation, and bind disposal teardown. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'neev')
    this.config = config
    // The API key is read from NEEV_API_KEY by the SDK; it is never taken from
    // config. baseURL is likewise not a config field — customers target
    // production (the SDK default), and the SDK honors NEEV_BASE_URL from the
    // environment for internal testing against other planes.
    this.client = new Neev({
      orgId: config.orgId ?? process.env.NEEV_ORG_ID,
      projectId: config.projectId ?? process.env.NEEV_PROJECT_ID,
      // The runtime's global WebSocket cannot send the bearer auth header, so
      // supply a `ws`-backed factory for interactive PTY sessions in Node.
      webSocket: (url, opts) => new WebSocket(url, opts) as unknown as SandboxWebSocket,
    })
    this.ready = this.open()
    // Keep an eager-creation failure observed; getSandbox() still surfaces it.
    void this.ready.catch(() => {})
    ctx.effect(() => this.teardown, 'neev sandbox teardown')
  }

  /**
   * Return the shared live SDK handle after the sandbox is Ready.
   * @throws when creation failed or the service is disposing.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('NeevSandbox service is disposing')
    const sandbox = await this.ready
    // Disposal can race the awaited readiness despite the synchronous precheck.
    if (this.disposed) throw new Error('NeevSandbox service is disposing')
    return sandbox
  }

  /** Create the sandbox, wait until Ready, and resolve the absolute workspace root. */
  private async open(): Promise<Sandbox> {
    // An explicit image wins; otherwise use the configured template, falling
    // back to the default. templateId carries no schema default, so an
    // image-only config genuinely reaches the image branch.
    const create: CreateSandboxParams = this.config.image !== undefined && this.config.image !== ''
      ? { image: this.config.image }
      : { sandbox_template_id: this.config.templateId ?? DEFAULT_TEMPLATE_ID }
    const sandbox = await this.client.sandboxes.create(create)
    try {
      await sandbox.waitUntilReady()
      // The SDK addresses files/processes with workspace-relative paths, so learn
      // the absolute root once and hand every consumer the same identity.
      const pwd = this.config.cwd ?? (await sandbox.exec(['pwd'])).stdout.trim()
      this.cwd = pwd
      this.runtimeRoot = posix.join(pwd, '.dsh-neev')
      this.ctx.logger.info('NeevSandbox created: %s (cwd %s)', sandbox.id, this.cwd)
      process.stderr.write(`NeevSandbox created: ${sandbox.id}\n`)
      return sandbox
    } catch (error: unknown) {
      await sandbox.delete().catch(() => undefined)
      throw error
    }
  }

  /** Delete the sandbox at disposal; a missing sandbox is accepted as quiescence. */
  private readonly teardown = async (): Promise<void> => {
    this.disposed = true
    let sandbox: Sandbox
    try {
      sandbox = await this.ready
    } catch {
      return
    }
    await sandbox.delete().catch(() => undefined)
    this.ctx.logger.info('NeevSandbox terminated: %s', sandbox.id)
    process.stderr.write(`NeevSandbox terminated: ${sandbox.id}\n`)
  }
}

export default NeevRuntime
