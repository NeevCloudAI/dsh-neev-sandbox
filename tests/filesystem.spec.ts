import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import NeevRuntime from '../src/runtime.ts'
import NeevFileSystem from '../src/filesystem/index.ts'
import NeevSubprocessRuntime from '../src/subprocess/index.ts'
import { LIVE, TEST_TEMPLATE_ID } from './helpers.ts'

describe.skipIf(!LIVE)('NeevFileSystem', () => {
  let ctx: Context
  let dispose: () => Promise<void>

  beforeAll(async () => {
    ctx = new Context()
    const rt = await ctx.plugin(NeevRuntime, { templateId: TEST_TEMPLATE_ID })
    const sub = await ctx.plugin(NeevSubprocessRuntime, {})
    const fs = await ctx.plugin(NeevFileSystem, {})
    await ctx.neev.getSandbox()
    dispose = async () => { await fs.dispose(); await sub.dispose(); await rt.dispose() }
  })
  afterAll(async () => { await dispose() })

  it('writes and reads a file, exposing a version', async () => {
    const target = await ctx.fs.resolve('hello.txt')
    const outcome = await ctx.fs.writeText(target, 'hello world')
    expect(outcome.operation).toBe('create')
    expect(String(outcome.version)).toMatch(/^neev:/)
    expect(await ctx.fs.readText(target)).toBe('hello world')
  })

  it('lists a directory', async () => {
    const dir = await ctx.fs.resolve('.')
    const entries = await ctx.fs.listDir(dir)
    expect(entries.some(e => e.name === 'hello.txt' && e.type === 'file')).toBe(true)
  })

  it('edits with a version guard and rejects stale writes', async () => {
    const target = await ctx.fs.resolve('guard.txt')
    const written = await ctx.fs.writeText(target, 'v1')
    const edited = await ctx.fs.editText(target, { oldString: 'v1', newString: 'v2', replaceAll: false }, { version: written.version })
    expect(edited.after).toBe('v2')
    // The pre-edit version is now stale.
    await expect(
      ctx.fs.editText(target, { oldString: 'v2', newString: 'v3', replaceAll: false }, { version: written.version }),
    ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('rejects an ambiguous edit and honors replaceAll', async () => {
    const target = await ctx.fs.resolve('amb.txt')
    await ctx.fs.writeText(target, 'x x')
    await expect(
      ctx.fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: false }),
    ).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    const all = await ctx.fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: true })
    expect(all.after).toBe('y y')
  })

  it('edits a CRLF file matched in LF space and preserves CRLF on disk', async () => {
    // Write CRLF content via Bash so the bytes really contain \r\n.
    const w = ctx.subprocess.spawn({
      argv: ['bash', '-c', "printf 'a\\r\\nb\\r\\n' > crlf.txt"],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 1000,
    })
    expect((await w.done).exitCode).toBe(0)
    const target = await ctx.fs.resolve('crlf.txt')
    // The model supplies LF; the edit must still match the CRLF file.
    const edited = await ctx.fs.editText(target, { oldString: 'a\nb', newString: 'x\ny', replaceAll: false })
    expect(edited.after).toBe('x\ny\n')
    // On disk the dominant CRLF ending is preserved.
    expect(await ctx.fs.readText(target)).toBe('x\r\ny\r\n')
  })

  it('enforces createIfAbsent', async () => {
    const target = await ctx.fs.resolve('once.txt')
    await ctx.fs.writeText(target, 'a')
    await expect(
      ctx.fs.writeText(target, 'b', { kind: 'createIfAbsent' }),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('shares one world with Bash: bash writes, fs reads; fs writes, bash reads', async () => {
    // Bash writes a file; the filesystem provider sees it.
    const w = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'printf from-bash > cross.txt'],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 1000,
    })
    expect((await w.done).exitCode).toBe(0)
    expect(await ctx.fs.readText(await ctx.fs.resolve('cross.txt'))).toBe('from-bash')

    // The filesystem provider writes a file; Bash sees it.
    await ctx.fs.writeText(await ctx.fs.resolve('from-fs.txt'), 'from-fs')
    const r = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'cat from-fs.txt'],
      cwd: ctx.neev.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 256 } },
      graceMs: 1000,
    })
    expect((await r.done).exitCode).toBe(0)
    expect(r.collected.stdout?.readFrom(0).text).toBe('from-fs')
  })
})
