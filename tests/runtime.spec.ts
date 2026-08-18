import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import NeevRuntime from '../src/runtime.ts'
import { LIVE, TEST_TEMPLATE_ID, neevFromEnv } from './helpers.ts'

describe.skipIf(!LIVE)('NeevRuntime lifecycle', () => {
  it('creates a sandbox, exposes an absolute cwd, and deletes it on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID })
    const sandbox = await ctx.neev.getSandbox()
    const id = sandbox.id
    expect(id).toBeTruthy()
    expect(ctx.neev.cwd.startsWith('/')).toBe(true)

    await fiber.dispose()

    // The disposed sandbox must no longer appear in the project listing.
    const client = neevFromEnv()
    const page = await client.sandboxes.list({ limit: 100 })
    expect(page.items.some(s => s.id === id)).toBe(false)
  })
})
