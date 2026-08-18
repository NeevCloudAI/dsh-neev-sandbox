import { posix } from 'node:path'

/** Credential-shaped names never forwarded into the sandbox, as a defensive floor. */
const CREDENTIAL_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Collect the explicit environment overlay for a remote spawn. Only the caller's
 * deliberate entries are forwarded; the sandbox keeps its own base environment
 * and the host's environment never enters the sandbox implicitly.
 *
 * As a belt-and-suspenders floor (independent of the seam's upstream scrub),
 * NEEV_* and credential-shaped names are dropped so host secrets can never
 * reach a sandbox process. `undefined` values are also dropped: the SDK env
 * merge cannot express a tombstone, so a caller cannot unset a base-image
 * variable through this path (documented limitation).
 */
export function buildChildEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith('NEEV_') || CREDENTIAL_ENV_PATTERN.test(key)) continue
    out[key] = value
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
