import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * Bounded in-memory tail for one collected stream with whole-stream offsets.
 * Overflow drops from the head; a read starting before the retained window is
 * reported lossy. This POC keeps no spill file.
 *
 * Note: the cap and offsets are counted in UTF-16 code units, not bytes, so the
 * memory bound is approximate for non-ASCII and head-eviction can split a
 * surrogate pair. Offsets are self-consistent, so read/resume stay correct.
 */
export class BoundedOutput implements SubprocessOutputReader {
  private buffer = ''
  private dropped = 0

  constructor(private readonly maxBytes: number) {}

  /** Append a decoded chunk, evicting the oldest bytes once past the cap. */
  push(text: string): void {
    this.buffer += text
    if (this.buffer.length > this.maxBytes) {
      const overflow = this.buffer.length - this.maxBytes
      this.buffer = this.buffer.slice(overflow)
      this.dropped += overflow
    }
  }

  /** Read everything captured since `fromByte`; lossy when it slid out of the tail. */
  readFrom(fromByte: number): SubprocessOutputRead {
    const total = this.dropped + this.buffer.length
    if (fromByte < this.dropped) {
      return { text: this.buffer, nextOffset: total, lossy: true }
    }
    const start = fromByte - this.dropped
    return { text: this.buffer.slice(start), nextOffset: total, lossy: false }
  }
}
