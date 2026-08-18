/**
 * NeevSandbox Service Provider for the filesystem capability seam. Reads,
 * writes, edits, and lists files in the shared sandbox over the SDK files API.
 * @module @neevcloud/dsh-sandbox/filesystem
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { NotFoundError } from '@neevcloud/sdk'
import type { FileEntry, Sandbox } from '@neevcloud/sdk'
import { toWorkspaceRelative } from '../subprocess/environment.ts'
import { applyLiteralEdit, decodeTextStrict, makeVersion, mapFileError } from './helpers.ts'

/** Configuration for the Neev filesystem adapter (currently none). */
export interface Config {}

/** Neev filesystem provider registered as `ctx.fs`. */
export class NeevFileSystem extends FileSystem {
  static inject = ['neev']

  static Config: z<Config> = z.object({})

  /** Wire the service; the sandbox is resolved lazily per operation. */
  constructor(ctx: Context) {
    super(ctx)
  }

  /** Resolve a path to a target: relative key for the SDK, absolute display path. */
  override async resolve(path: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTarget> {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const root = this.ctx.neev.cwd
    const cwd = opts?.cwd ?? root
    const absolute = posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(cwd, path)
    // A path outside the workspace root yields a '..'-prefixed key. This is not
    // fenced here on purpose: the SDK operates only inside the isolated sandbox
    // where the caller already has root, so an out-of-root path is in-sandbox
    // self-access, not a cross-boundary escape. The sandbox is the boundary;
    // policy-level containment stays with the consumer via contains().
    return { targetKey: FsTargetKey(toWorkspaceRelative(absolute, root)), displayPath: absolute }
  }

  /** Absolute in-sandbox path for consumers and containment checks. */
  override processPath(target: FsTarget): string {
    return posix.resolve(this.ctx.neev.cwd, String(target.targetKey))
  }

  /** Percent-encoded file: URI for the target's process path. */
  override fileUrl(target: FsTarget): string {
    return `file://${encodeURI(this.processPath(target))}`
  }

  /** True when `child` is at or under `parent` in the sandbox tree. */
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = posix.relative(this.processPath(parent), this.processPath(child))
    return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))
  }

  /** Follow-symlink metadata for an existing target, or undefined when absent. */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.checkAbort(signal, 'stat', target.displayPath)
    const sandbox = await this.ctx.neev.getSandbox()
    try {
      const entry = await sandbox.files.stat(this.key(target), { signal })
      return { version: makeVersion(entry), type: infoType(entry.type), size: entry.size }
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return undefined
      throw mapFileError(error, 'stat', target.displayPath)
    }
  }

  /** No-follow metadata for a raw path, reporting symlinks distinctly. */
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const root = this.ctx.neev.cwd
    const absolute = posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(opts?.cwd ?? root, path)
    const rel = toWorkspaceRelative(absolute, root)
    const sandbox = await this.ctx.neev.getSandbox()
    try {
      const entry = await sandbox.files.stat(rel, { signal })
      return { version: makeVersion(entry), type: pathType(entry.type), size: entry.size }
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return undefined
      throw mapFileError(error, 'stat', absolute)
    }
  }

  /** Read a target as UTF-8 text, rejecting binary or malformed content. */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.checkAbort(signal, 'read', target.displayPath)
    const sandbox = await this.ctx.neev.getSandbox()
    try {
      const bytes = await sandbox.files.read(this.key(target), { signal })
      return decodeTextStrict(bytes, target.displayPath)
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw mapFileError(error, 'read', target.displayPath)
    }
  }

  /** Stream a target's text; this POC reads the whole file, then chunks it. */
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return (async function* chunks(): AsyncIterable<string> {
      const size = 65_536
      for (let offset = 0; offset < text.length; offset += size) yield text.slice(offset, offset + size)
    })()
  }

  /** Read up to `maxBytes` raw bytes, rejecting an oversized file. */
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.checkAbort(signal, 'read', target.displayPath)
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const sandbox = await this.ctx.neev.getSandbox()
    try {
      // The SDK has no ranged read, so when stat reports no size the whole file
      // is read before the post-read length check — a best-effort bound only.
      const bytes = await sandbox.files.read(this.key(target), { signal })
      if (bytes.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      return bytes
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw mapFileError(error, 'read', target.displayPath)
    }
  }

  /** One-level directory listing with per-entry targets and versions. */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const sandbox = await this.ctx.neev.getSandbox()
    try {
      const entries = await sandbox.files.list(this.key(target), { recursive: false, signal })
      return entries
        // Hide this provider's in-flight atomic-write temp files from listings.
        .filter(entry => !(entry.name.startsWith('.dsh-neev-') && entry.name.endsWith('.tmp')))
        .map(entry => ({
        name: entry.name,
        type: infoType(entry.type),
        target: { targetKey: FsTargetKey(entry.path), displayPath: posix.resolve(this.ctx.neev.cwd, entry.path) },
        version: makeVersion(entry),
        size: entry.size,
      }))
    } catch (error: unknown) {
      throw mapFileError(error, 'list', target.displayPath)
    }
  }

  /** Create or replace a file's full text, honoring the write intent guard. */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    this.checkAbort(signal, 'write', target.displayPath)
    const info = await this.stat(target, signal)
    const exists = info !== undefined
    if (expected?.kind === 'createIfAbsent' && exists) {
      throw new FsError(`cannot create "${target.displayPath}": already exists`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion' && (!exists || info.version !== expected.version)) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    if (exists && info.type !== 'file') {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const rawBefore = exists ? await this.readText(target, signal).catch(() => null) : null
    const before = rawBefore === null ? null : rawBefore.replace(/\r\n/g, '\n')
    const sandbox = await this.ctx.neev.getSandbox()
    await this.writeAtomic(sandbox, this.key(target), content, signal, target.displayPath)
    return { operation: exists ? 'update' : 'create', version: await this.versionAfter(this.key(target), signal, target.displayPath), before, after: content }
  }

  /** Apply a literal edit atomically, guarding against stale content. */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    this.checkAbort(signal, 'edit', target.displayPath)
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && info.version !== expected.version) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    // Match and report in LF space per the seam contract; restore the file's
    // dominant CRLF ending on storage so a CRLF file stays CRLF on disk.
    const raw = await this.readText(target, signal)
    const hadCRLF = raw.includes('\r\n')
    const existing = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw
    const next = applyLiteralEdit(existing, edit, target.displayPath)
    const storage = hadCRLF ? next.replace(/\n/g, '\r\n') : next
    const sandbox = await this.ctx.neev.getSandbox()
    await this.writeAtomic(sandbox, this.key(target), storage, signal, target.displayPath)
    return { version: await this.versionAfter(this.key(target), signal, target.displayPath), before: existing, after: next }
  }

  /** Relative workspace key the SDK files API addresses. */
  private key(target: FsTarget): string {
    return String(target.targetKey)
  }

  /** Version token of a freshly-written file, with SDK errors mapped to FsError. */
  private async versionAfter(key: string, signal: AbortSignal | undefined, displayPath: string): Promise<FsVersion> {
    const sandbox = await this.ctx.neev.getSandbox()
    try {
      return makeVersion(await sandbox.files.stat(key, { signal }))
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw mapFileError(error, 'stat', displayPath)
    }
  }

  /** Reject an already-aborted operation with the seam's FS_ABORTED code. */
  private checkAbort(signal: AbortSignal | undefined, operation: string, displayPath: string): void {
    if (signal?.aborted === true) throw new FsError(`cannot ${operation} "${displayPath}": aborted`, 'FS_ABORTED')
  }

  /**
   * Publish content as safely as the backend allows. The happy path writes a
   * sibling temp file and renames it over the target (atomic when the backend's
   * rename overwrites). If the rename cannot publish, fall back to an in-place
   * write so the target is NEVER removed before its replacement exists — this
   * trades strict atomicity for the guarantee that a failure can never lose both
   * the old and the new content.
   */
  private async writeAtomic(sandbox: Sandbox, key: string, content: string, signal: AbortSignal | undefined, displayPath: string): Promise<void> {
    const dir = posix.dirname(key)
    const temp = dir === '.' ? `.dsh-neev-${randomUUID()}.tmp` : posix.join(dir, `.dsh-neev-${randomUUID()}.tmp`)
    try {
      await sandbox.files.write(temp, content, { signal })
    } catch (error: unknown) {
      // The target is untouched; nothing to clean beyond a possible partial temp.
      await sandbox.files.remove(temp, { signal }).catch(() => undefined)
      if (error instanceof FsError) throw error
      throw mapFileError(error, 'write', displayPath)
    }
    try {
      await sandbox.files.move(temp, key, { signal })
    } catch {
      // Rename could not publish. Overwrite in place instead of removing the
      // target first, then drop the temp. On failure the target keeps its
      // prior (or partially rewritten) content — the temp copy is never the
      // sole surviving copy at the moment we delete it.
      try {
        await sandbox.files.write(key, content, { signal })
      } catch (error: unknown) {
        await sandbox.files.remove(temp, { signal }).catch(() => undefined)
        if (error instanceof FsError) throw error
        throw mapFileError(error, 'write', displayPath)
      }
      await sandbox.files.remove(temp, { signal }).catch(() => undefined)
    }
  }
}

/** Map an SDK entry type to the follow-symlink FsInfo/FsDirEntry vocabulary. */
function infoType(type: FileEntry['type']): 'file' | 'directory' | 'other' {
  return type === 'file' ? 'file' : type === 'directory' ? 'directory' : 'other'
}

/** Map an SDK entry type to the no-follow FsPathInfo vocabulary. */
function pathType(type: FileEntry['type']): 'file' | 'directory' | 'symlink' | 'other' {
  return type === 'file' ? 'file' : type === 'directory' ? 'directory' : type === 'symlink' ? 'symlink' : 'other'
}

export default NeevFileSystem
