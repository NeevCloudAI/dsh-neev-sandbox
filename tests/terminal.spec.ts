import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import NeevRuntime from '../src/runtime.ts'
import NeevSubprocessRuntime from '../src/subprocess/index.ts'
import { LIVE, TEST_TEMPLATE_ID } from './helpers.ts'

describe.skipIf(!LIVE)('Neev PTY', () => {
  let ctx: Context
  let dispose: () => Promise<void>

  beforeAll(async () => {
    ctx = new Context()
    const rt = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID })
    const sub = await ctx.plugin(NeevSubprocessRuntime, {})
    await ctx.neev.getSandbox()
    dispose = async () => { await sub.dispose(); await rt.dispose() }
  })
  afterAll(async () => { await dispose() })

  it('runs an interactive shell in the sandbox and echoes command output', async () => {
    const term = await ctx.subprocess.spawnTerminal({
      argv: ['bash', '-i'],
      cwd: ctx.neev.cwd,
      rows: 24,
      cols: 80,
      graceMs: 1000,
    })
    let buf = ''
    term.output.setEncoding('utf8')
    term.output.on('data', (chunk: string) => { buf += chunk })
    // Let the interactive shell start before sending a command. The marker is
    // split (PT"Y_OK") so the terminal's input echo cannot satisfy the check;
    // only the expanded command output contains a contiguous PTY_OK.
    await new Promise(r => setTimeout(r, 800))
    await term.write('echo PT"Y_OK"\n')
    const deadline = Date.now() + 8000
    while (!buf.includes('PTY_OK') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    await term.terminate()
    expect(buf).toContain('PTY_OK')
  })
})
