import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in SDK: records create/get calls and hands back a scripted sandbox.
const sdk = vi.hoisted(() => {
  class NotFoundError extends Error {}
  const state = {
    created: [] as unknown[],
    existing: undefined as Record<string, unknown> | undefined,
    sandbox: undefined as Record<string, any> | undefined,
  }
  function fakeSandbox(overrides: Record<string, unknown> = {}): Record<string, any> {
    const sb: Record<string, any> = {
      id: 'sb-1',
      phase: 'Ready',
      lastCrash: null,
      exec: vi.fn(async () => ({ stdout: '/home/user\n', stderr: '', exitCode: 0 })),
      keepalive: vi.fn(async () => sb),
      refresh: vi.fn(async () => sb),
      resume: vi.fn(async () => { sb.phase = 'Ready'; return sb }),
      pause: vi.fn(async () => { sb.phase = 'Paused'; return sb }),
      delete: vi.fn(async () => undefined),
      updateTimeout: vi.fn(async () => sb),
      ...overrides,
    }
    return sb
  }
  class Neev {
    sandboxes = {
      create: vi.fn(async (params: unknown) => {
        state.created.push(params)
        state.sandbox = fakeSandbox()
        return state.sandbox
      }),
      get: vi.fn(async () => {
        if (state.existing === undefined) throw new NotFoundError('not found')
        state.sandbox = fakeSandbox(state.existing)
        return state.sandbox
      }),
    }
  }
  return { Neev, NotFoundError, state }
})
vi.mock('@neevcloud/sdk', () => ({ Neev: sdk.Neev, NotFoundError: sdk.NotFoundError }))

const { default: NeevRuntime } = await import('../src/runtime.ts')

/** Start the runtime with config and wait for its sandbox. */
async function start(config: Record<string, unknown>) {
  const ctx = new Context()
  const fiber = await ctx.plugin(NeevRuntime, config)
  const sandbox = await ctx.neev.getSandbox()
  return { ctx, fiber, sandbox }
}

describe('NeevRuntime (mocked SDK)', () => {
  beforeEach(() => {
    sdk.state.created = []
    sdk.state.existing = undefined
    sdk.state.sandbox = undefined
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('success: an ephemeral sandbox is created with a pause backstop and a day of paused retention', async () => {
    const { fiber } = await start({ templateId: 'tpl' })
    expect(sdk.state.created).toEqual([{
      sandbox_template_id: 'tpl',
      lifecycle: { idle_timeout_seconds: 900, on_idle: 'pause', paused_retention_seconds: 86_400 },
    }])
    await fiber.dispose()
  })

  it('success: a persisted sandbox keeps the account retention', async () => {
    const { fiber } = await start({ templateId: 'tpl', persist: 'p1', orphanTimeoutSeconds: 60 })
    expect(sdk.state.created).toEqual([{
      sandbox_template_id: 'tpl',
      name: 'p1',
      lifecycle: { idle_timeout_seconds: 60, on_idle: 'pause' },
    }])
    await fiber.dispose()
  })

  it('success: orphanTimeoutSeconds 0 clears the idle limit and sends no heartbeat', async () => {
    vi.useFakeTimers()
    const { fiber } = await start({ image: 'img', orphanTimeoutSeconds: 0 })
    // Omitting lifecycle would inherit the account's default idle pause.
    expect(sdk.state.created).toEqual([{ image: 'img', lifecycle: { idle_timeout_seconds: 0 } }])
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(sdk.state.sandbox!.keepalive).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('success: reconnecting with orphanTimeoutSeconds 0 clears the idle limit', async () => {
    sdk.state.existing = { id: 'sb-old' }
    const { fiber } = await start({ persist: 'p1', orphanTimeoutSeconds: 0 })
    expect(sdk.state.sandbox!.updateTimeout).toHaveBeenCalledWith({ idle_timeout_seconds: 0 })
    await fiber.dispose()
  })

  it('success: reconnects by name and applies the backstop to the existing sandbox', async () => {
    sdk.state.existing = { id: 'sb-old' }
    const { fiber, sandbox } = await start({ persist: 'p1' })
    expect(sandbox.id).toBe('sb-old')
    expect(sdk.state.created).toEqual([])
    expect(sandbox.updateTimeout).toHaveBeenCalledWith({ idle_timeout_seconds: 900, on_idle: 'pause' })
    await fiber.dispose()
  })

  it('success: a RestoreFailed sandbox with the persist name is replaced', async () => {
    sdk.state.existing = { id: 'sb-old', phase: 'RestoreFailed' }
    const { fiber, sandbox } = await start({ persist: 'p1' })
    expect(sandbox.id).toBe('sb-1')
    expect(sdk.state.created).toHaveLength(1)
    await fiber.dispose()
  })

  it('success: warns when a reconnected sandbox lost its storage', async () => {
    sdk.state.existing = { id: 'sb-old', lastCrash: { reason: 'oom', at: '2026-10-01T00:00:00Z', storage_reset: true } }
    const { fiber } = await start({ persist: 'p1' })
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('storage was reset'))
    await fiber.dispose()
  })

  it('success: the heartbeat sends keepalives and stops on disposal', async () => {
    vi.useFakeTimers()
    const { fiber, sandbox } = await start({ orphanTimeoutSeconds: 3 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sandbox.keepalive).toHaveBeenCalledTimes(3)
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sandbox.keepalive).toHaveBeenCalledTimes(3)
  })

  it('success: a pause the server made during host sleep is resumed on next use', async () => {
    const { ctx, fiber } = await start({ orphanTimeoutSeconds: 3 })
    const sandbox = sdk.state.sandbox!
    // The host slept: no heartbeat ran and the server paused the sandbox.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    sandbox.keepalive.mockImplementationOnce(async () => { throw new Error('sandbox paused') })
    sandbox.refresh.mockImplementationOnce(async () => { sandbox.phase = 'Paused'; return sandbox })
    const again = await ctx.neev.getSandbox()
    expect(sandbox.resume).toHaveBeenCalled()
    expect(again.phase).toBe('Ready')
    await fiber.dispose()
  })
})
