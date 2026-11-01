const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Fixed, non-configurable upper bound on Subagent result text, measured in
 * UTF-8 bytes. Not configurable by design: parents must be able to assume a
 * stable bound on every result path (foreground result, retrieval, and any
 * future automatic completion or partial output).
 */
export const RESULT_TEXT_LIMIT = 20_000;

/** A result text cut to the fixed byte limit, keeping the beginning. */
export interface BoundedResultText {
  /** Result text at or below the limit. The truncation notice is NOT included. */
  text: string;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
}

/**
 * Bound one Subagent result text to a fixed 20,000 UTF-8 bytes, keeping the
 * beginning and never splitting a character. Status, failure reason, and the
 * truncation notice are outside the limit and must not be passed through this
 * function.
 */
export function boundResultText(text: string): BoundedResultText {
  const originalBytes = encoder.encode(text).length;
  if (originalBytes <= RESULT_TEXT_LIMIT) {
    return { text, truncated: false, originalBytes, retainedBytes: originalBytes };
  }
  // Cut on a character boundary: step back over UTF-8 continuation bytes
  // (0b10xxxxxx) so the retained prefix contains only complete characters.
  const bytes = encoder.encode(text);
  let end = RESULT_TEXT_LIMIT;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const retained = decoder.decode(bytes.slice(0, end));
  return { text: retained, truncated: true, originalBytes, retainedBytes: end };
}

/**
 * One-call variant: bounds a result text and appends its truncation notice
 * (outside the limit) when truncated. This is the composed text stored on a
 * Subagent run, so every consumer — foreground return, explicit retrieval,
 * and later automatic delivery or partial output — shows the same bounded
 * content.
 */
export function appendTruncationNotice(text: string): string {
  const bounded = boundResultText(text);
  const notice = truncationNotice(bounded);
  return notice ? `${bounded.text}\n\n${notice}` : bounded.text;
}

/**
 * Parent-facing truncation report for a bounded result. Always empty when the
 * text was not truncated; when truncated, states the fact plus original and
 * retained byte counts. Composed after the bounded text, outside its limit.
 */
export function truncationNotice(bounded: BoundedResultText): string {
  if (!bounded.truncated) return "";
  const retained = bounded.retainedBytes.toLocaleString("en-US");
  const original = bounded.originalBytes.toLocaleString("en-US");
  return (
    `[Truncated: showing the first ${retained} of ${original} bytes.] ` +
    "The omitted remainder is not recoverable; for large deliverables, have the " +
    "Subagent write its output to a file instead."
  );
}