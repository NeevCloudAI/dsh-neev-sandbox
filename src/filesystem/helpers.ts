import { createHash } from 'node:crypto'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsEditRequest } from '@deepseek-ai/dsh-fs'
import { NotFoundError, PermissionDeniedError } from '@neevcloud/sdk'
import type { FileEntry } from '@neevcloud/sdk'

/**
 * Derive an opaque freshness token from a file's metadata. The SDK exposes no
 * native version, so a hash of mtime + size + mode stands in: any write changes
 * mtime (and usually size), so a guarded write detects a concurrent change.
 */
export function makeVersion(entry: FileEntry): FsVersion {
  const facts = `${entry.modifiedTime}:${entry.size}:${entry.mode}`
  return FsVersion(`neev:${createHash('sha256').update(facts).digest('hex').slice(0, 24)}`)
}

/** Map an SDK file error to the seam's typed FsError vocabulary. */
export function mapFileError(error: unknown, operation: string, displayPath: string): FsError {
  if (error instanceof Error && error.name === 'AbortError') {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (error instanceof NotFoundError) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (error instanceof PermissionDeniedError) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  // Keep the raw error only on `cause`, never interpolated into the message,
  // so a future SDK error string can't leak internals into tool output.
  return new FsError(`cannot ${operation} "${displayPath}"`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Decode bytes as UTF-8 text, rejecting binary content. A NUL byte in the head
 * marks binary; strict decoding rejects malformed sequences. Both surface as
 * FS_NOT_TEXT so the file tools report a clean error instead of mojibake.
 */
export function decodeTextStrict(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

/**
 * Apply a literal search/replace to file content. An empty or unmatched search
 * is FS_EDIT_NOT_FOUND; multiple matches without replaceAll is FS_AMBIGUOUS_EDIT.
 * Uses index/split arithmetic so `$` in the replacement is never special.
 */
export function applyLiteralEdit(content: string, edit: FsEditRequest, displayPath: string): string {
  if (edit.oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  const matches = content.split(edit.oldString).length - 1
  if (matches === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (matches > 1 && !edit.replaceAll) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  if (edit.replaceAll) return content.split(edit.oldString).join(edit.newString)
  const index = content.indexOf(edit.oldString)
  return content.slice(0, index) + edit.newString + content.slice(index + edit.oldString.length)
}
