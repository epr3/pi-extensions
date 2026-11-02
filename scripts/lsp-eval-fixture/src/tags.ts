export const LOG_PREFIX = "[app]";

/** Formats a log line with the shared prefix. */
export function formatLog(level: string, message: string): string {
  return `${LOG_PREFIX} ${level}: ${message}`;
}

// TODO(eventions): include structured fields once the sink API grows them.
