import { Signal } from '@neevcloud/sdk'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'

/** argv[0] label used for adapter-internal bash control commands. */
export const SHELL_NAME = 'dsh-neev'

/** Map a POSIX signal name to the numeric code the sandbox process API accepts. */
export function signalNumber(name: 'SIGTERM' | 'SIGKILL'): number {
  return name === 'SIGKILL' ? Signal.KILL : Signal.TERM
}

/** Map a terminal signal name to the string the PTY control channel expects. */
export function ptySignalName(name: SubprocessTerminalSignal): string {
  return name
}

/** Coerce an unknown rejection to an Error for teardown aggregation. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
