import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import NeevRuntime from '../src/runtime.ts'
import NeevSubprocessRuntime from '../src/subprocess/index.ts'
import { LIVE, TEST_TEMPLATE_ID, neevFromEnv } from './helpers.ts'

describe.skipIf(!LIVE)('persistent sandbox', () => {
  const createdIds: string[] = []
  afterAll(async () => {
    const client = neevFromEnv()
    for (const id of createdIds) await client.sandboxes.delete(id).catch(() => undefined)
  })

  it('reconnects by persist name and preserves the workspace', async () => {
    const persist = `dsh-persist-${randomUUID().slice(0, 8)}`

    // First run: write a marker file, then dispose (pauses, does not delete).
    const ctxA = new Context()
    const a = await ctxA.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID, persist })
    const sandboxA = await ctxA.neev.getSandbox()
    const idA = sandboxA.id
    createdIds.push(idA)
    await sandboxA.exec(['bash', '-c', 'echo persist-check > marker.txt'])
    await a.dispose()

    // Second run: the same persist name reconnects to the same sandbox and
    // sees the file the first run wrote.
    const ctxB = new Context()
    const b = await ctxB.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID, persist })
    const sandboxB = await ctxB.neev.getSandbox()
    expect(sandboxB.id).toBe(idA)
    const read = await sandboxB.exec(['cat', 'marker.txt'])
    expect(read.stdout.trim()).toBe('persist-check')
    await b.dispose()
  })

  it('auto-pauses when idle and resumes on next use', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID, idleTimeoutMs: 2500 })
    const sandbox = await ctx.neev.getSandbox()
    createdIds.push(sandbox.id)

    // Wait past the idle window for the auto-pause to fire.
    await new Promise(r => setTimeout(r, 6000))
    const paused = await neevFromEnv().sandboxes.get(sandbox.id)
    expect(paused.phase).toBe('Paused')

    // The next use lazily resumes it.
    const resumed = await ctx.neev.getSandbox()
    expect(resumed.phase).toBe('Ready')
    await fiber.dispose()
  })

  it('creates the sandbox with the server-side orphan backstop', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID, orphanTimeoutSeconds: 600 })
    const sandbox = await ctx.neev.getSandbox()
    createdIds.push(sandbox.id)
    const live = await neevFromEnv().sandboxes.get(sandbox.id)
    expect(live.data.idle_timeout_seconds).toBe(600)
    expect(live.data.on_idle).toBe('pause')
    expect(live.data.paused_retention_seconds).toBe(86_400)
    await fiber.dispose()
  })

  it('resumes a sandbox paused behind its back once the heartbeat goes stale', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID, orphanTimeoutSeconds: 3 })
    const sandbox = await ctx.neev.getSandbox()
    createdIds.push(sandbox.id)

    // Pause through a separate client, as the server would after a missed heartbeat.
    const other = await neevFromEnv().sandboxes.get(sandbox.id)
    await other.pause()
    while (other.phase !== 'Paused') { await new Promise(r => setTimeout(r, 500)); await other.refresh() }
    // Give the 1s heartbeat a tick to notice the pause.
    await new Promise(r => setTimeout(r, 2500))

    const resumed = await ctx.neev.getSandbox()
    expect(resumed.phase).toBe('Ready')
    expect((await resumed.exec(['true'])).exitCode).toBe(0)
    await fiber.dispose()
  })

  it('keeps the sandbox awake while a process is live', async () => {
    const ctx = new Context()
    const rt = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID, idleTimeoutMs: 2000 })
    const sub = await ctx.plugin(NeevSubprocessRuntime, {})
    const sandbox = await ctx.neev.getSandbox()
    createdIds.push(sandbox.id)

    const handle = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'sleep 6'],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 1000,
    })
    // Past the idle window, but the live process holds the sandbox awake.
    await new Promise(r => setTimeout(r, 4000))
    const mid = await neevFromEnv().sandboxes.get(sandbox.id)
    expect(mid.phase).toBe('Ready')

    await handle.done
    await sub.dispose()
    await rt.dispose()
  })
})
