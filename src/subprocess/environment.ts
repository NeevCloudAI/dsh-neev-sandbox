import { posix } from 'node:path'

/**
 * Collect the explicit environment overlay for a remote spawn. Only the caller's
 * deliberate entries are forwarded; the sandbox keeps its own base environment
 * and the host's environment never enters the sandbox implicitly. `undefined`
 * values are dropped (the SDK merge cannot express a tombstone).
 */
export function buildChildEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Translate a DSH absolute cwd into the workspace-root-relative path the SDK
 * expects. The root itself becomes '.'; paths under it become relative.
 */
export function toWorkspaceRelative(absCwd: string, root: string): string {
  const rel = posix.relative(root, absCwd)
  return rel === '' ? '.' : rel
}
