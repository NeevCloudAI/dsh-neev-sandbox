// Minimal example: run Bash and manage files inside a NeevSandbox using the
// three providers directly (no dsh, no model needed). Shows that a file the
// filesystem provider writes is visible to Bash in the same sandbox.
//
// Prereqs:  npm install && npm run build   (builds the package this imports)
// Run:      NEEV_API_KEY=... NEEV_ORG_ID=... NEEV_PROJECT_ID=... \
//             node examples/quickstart.mjs

import { Context } from '@deepseek-ai/cordis'
import NeevRuntime from '@neevcloud/dsh-sandbox/runtime'
import NeevSubprocessRuntime from '@neevcloud/dsh-sandbox/subprocess'
import NeevFileSystem from '@neevcloud/dsh-sandbox/filesystem'

const ctx = new Context()
const runtime = await ctx.plugin(NeevRuntime, { templateId: 'sb-ubuntu-26-04-minimal' })
const subprocess = await ctx.plugin(NeevSubprocessRuntime, {})
const filesystem = await ctx.plugin(NeevFileSystem, {})

try {
  await ctx.neev.getSandbox()

  // 1. Run a command in the sandbox and collect its output.
  const info = ctx.subprocess.spawn({
    argv: ['bash', '-c', 'head -1 /etc/os-release; whoami'],
    cwd: ctx.neev.cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'inherit' },
    graceMs: 1000,
  })
  await info.done
  console.log('the sandbox reports:\n' + info.collected.stdout?.readFrom(0).text)

  // 2. Write a file with the filesystem provider...
  await ctx.fs.writeText(await ctx.fs.resolve('hello.txt'), 'written by ctx.fs')

  // 3. ...and read it back with Bash — same sandbox, one world.
  const read = ctx.subprocess.spawn({
    argv: ['cat', 'hello.txt'],
    cwd: ctx.neev.cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: 'inherit' },
    graceMs: 1000,
  })
  await read.done
  console.log('Bash read the fs-written file:', read.collected.stdout?.readFrom(0).text)
} finally {
  // Disposing the plugins deletes the sandbox.
  await filesystem.dispose()
  await subprocess.dispose()
  await runtime.dispose()
}
