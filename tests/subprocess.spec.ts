import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import NeevRuntime from '../src/runtime.ts'
import NeevSubprocessRuntime from '../src/subprocess/index.ts'
import { LIVE } from './helpers.ts'

describe.skipIf(!LIVE)('NeevSubprocessRuntime', () => {
  let ctx: Context
  let dispose: () => Promise<void>

  beforeAll(async () => {
    ctx = new Context()
    const runtimeFiber = await ctx.plugin(NeevRuntime, { templateId: 'sb-ubuntu-26-04-dev' })
    const subFiber = await ctx.plugin(NeevSubprocessRuntime, {})
    await ctx.neev.getSandbox()
    dispose = async () => { await subFiber.dispose(); await runtimeFiber.dispose() }
  })
  afterAll(async () => { await dispose() })

  it('resolves bash to an absolute in-sandbox path', async () => {
    const path = await ctx.subprocess.resolveExecutable('bash')
    expect(path.startsWith('/')).toBe(true)
  })

  it('runs a command in the sandbox and collects its output', async () => {
    const handle = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'cat /etc/os-release; hostname; id -un'],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
      graceMs: 1000,
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    const out = handle.collected.stdout?.readFrom(0).text ?? ''
    expect(out).toContain('Ubuntu')
    expect(out).toMatch(/26\.04/)
  })

  it('propagates a non-zero exit code', async () => {
    const handle = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'exit 7'],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 256 } },
      graceMs: 1000,
    })
    expect((await handle.done).exitCode).toBe(7)
  })

  it('terminates a long-running process', async () => {
    const handle = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'sleep 600'],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 500,
    })
    // Let the process register in the supervisor, then terminate and await exit.
    await new Promise(r => setTimeout(r, 1500))
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
    const sandbox = await ctx.neev.getSandbox()
    const running = (await sandbox.processes.list()).filter(p => p.state === 'running')
    expect(running.some(p => p.args?.includes('sleep 600'))).toBe(false)
  })
})
