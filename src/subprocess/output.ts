import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * Bounded in-memory tail for one collected stream with whole-stream byte
 * offsets. Overflow drops from the head; a read starting before the retained
 * window is reported lossy. This POC keeps no spill file.
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
