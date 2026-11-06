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
 * Longest prefix of `text` that fits in `budget` UTF-8 bytes without splitting
 * a character, with the byte length of that prefix. Steps back over UTF-8
 * continuation bytes (0b10xxxxxx) so the prefix holds only complete
 * characters.
 */
function prefixWithinBytes(text: string, budget: number): { prefix: string; prefixBytes: number } {
  const bytes = encoder.encode(text);
  if (bytes.length <= budget) return { prefix: text, prefixBytes: bytes.length };
  let end = budget;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { prefix: decoder.decode(bytes.slice(0, end)), prefixBytes: end };
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
  const { prefix, prefixBytes } = prefixWithinBytes(text, RESULT_TEXT_LIMIT);
  return { text: prefix, truncated: true, originalBytes, retainedBytes: prefixBytes };
}

/**
 * Composed form: bounded text plus its truncation notice (outside the limit)
 * when truncated. This is the text stored on a Subagent run, so every consumer
 * — foreground return, explicit retrieval, and later automatic delivery or
 * partial output — shows the same bounded content and the same byte counts.
 */
export function composeBoundedResult(bounded: BoundedResultText): string {
  const notice = truncationNotice(bounded);
  return notice ? `${bounded.text}\n\n${notice}` : bounded.text;
}

/**
 * One-call variant of `composeBoundedResult` for text that arrives whole.
 */
export function appendTruncationNotice(text: string): string {
  return composeBoundedResult(boundResultText(text));
}

/**
 * Incremental capture of one growing text (assistant deltas during a run),
 * bounded by the same limit as a result text and reporting the same byte
 * counts.
 *
 * The point is memory in the capture itself: it never holds more than the
 * retained prefix, so a long stream cannot accumulate without limit here. It
 * is not a bound on total child-session memory — the child session keeps its
 * own message history, which this capture does not own.
 */
export interface BoundedTextCapture {
  /**
   * Append the next delta. Text arriving after the capture is full is counted
   * but not retained, and deltas are never split between appends: a trailing
   * high surrogate waits for the next delta, so a character split across two
   * deltas is retained whole and counted once.
   */
  append(delta: string): void;
  /** The retained prefix and the byte counts as of now. */
  snapshot(): BoundedResultText;
}

/** Create an empty `BoundedTextCapture` under the fixed result-text limit. */
export function createBoundedTextCapture(): BoundedTextCapture {
  const retained: string[] = [];
  let retainedBytes = 0;
  let originalBytes = 0;
  // Set once the prefix is full: later deltas only add to `originalBytes`.
  let full = false;
  // A trailing high surrogate from the previous delta, held back until the
  // next delta shows whether it pairs with a low surrogate. Counting it early
  // would misreport the character's UTF-8 byte length.
  let carry = "";

  return {
    append(delta) {
      if (!delta) return;
      let incoming = carry + delta;
      carry = "";
      const last = incoming.charCodeAt(incoming.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        carry = incoming.slice(-1);
        incoming = incoming.slice(0, -1);
        if (!incoming) return;
      }
      const incomingBytes = encoder.encode(incoming).length;
      originalBytes += incomingBytes;
      if (full) return;
      const { prefix, prefixBytes } = prefixWithinBytes(
        incoming,
        RESULT_TEXT_LIMIT - retainedBytes,
      );
      retained.push(prefix);
      retainedBytes += prefixBytes;
      if (prefixBytes < incomingBytes) full = true;
    },

    snapshot() {
      // An unpaired trailing surrogate is not a complete character: count the
      // replacement bytes the encoder would produce, keep it out of the text.
      const original = originalBytes + (carry ? encoder.encode(carry).length : 0);
      return {
        text: retained.join(""),
        truncated: original > retainedBytes,
        originalBytes: original,
        retainedBytes,
      };
    },
  };
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