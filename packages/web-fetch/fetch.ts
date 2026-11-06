// ─── Types ───────────────────────────────────────────────────────────────────

import type { ExtractionThinkingWarning } from "./thinking-level.ts";

/** Structured details returned in tool result `details`. */
export interface WebFetchDetails {
  url: string;
  title: string;
  contentType: string;
  /** Where the content was extracted from. */
  source: "html" | "text" | "pdf";
  /** Error message if the fetch succeeded but extraction was poor. */
  extractionWarning?: string;
  /**
   * Page count when the extractor could verify it. Absent means unknown — the
   * built-in PDF extractor cannot count pages reliably, so it never claims one.
   */
  pageCount?: number;
  /** Absolute path of the finalized Readable artifact on disk. */
  artifactPath: string;
  /**
   * Whether the artifact provably contains the whole converted source:
   * `complete` (verified in full), `partial` (extractor reported missing
   * content), or `unknown` (the extractor cannot verify completeness).
   * Independent of `modelInputTruncated`.
   */
  artifactCompleteness: ArtifactCompleteness;
  /** AI extraction answer returned by the Extraction model. */
  answer: string;
  /** Character count of the AI extraction answer. */
  answerLength: number;
  /** Character count of the full converted source artifact. */
  sourceLength: number;
  /** Whether only a leading portion of the artifact was sent to the model. */
  modelInputTruncated: boolean;
  /** Provider identifier of the Extraction model. */
  modelProvider?: string;
  /** Model identifier of the Extraction model. */
  modelId?: string;
  /** Warnings about the configured Extraction thinking preference. */
  warnings?: ExtractionThinkingWarning[];
}

/**
 * How much of the fetched source a Readable artifact provably contains.
 *
 * `unknown` is not a synonym for either — the built-in PDF extractor scans the
 * whole capped file but cannot prove it captured every page's text.
 */
export type ArtifactCompleteness = "complete" | "partial" | "unknown";

/** Options for fetching a URL. */
export interface FetchOptions {
  signal?: AbortSignal;
  /** Max bytes to read from the response body (default 512KB). */
  maxContentBytes?: number;
  /** Max bytes for PDF responses (default 10MB). */
  maxPdfBytes?: number;
  /** Deadline in ms for the whole request, response body included (default 30s). */
  fetchTimeoutMs?: number;
  /** Custom fetch implementation (for tests). */
  fetchFn?: typeof globalThis.fetch;
  /** Custom user agent (for tests). */
  userAgent?: string;
  /** Custom PDF extraction function (for tests). */
  extractPdfFn?: PdfExtractFn;
  /** When provided, body bytes are streamed here instead of accumulated. */
  sink?: (chunk: Uint8Array) => Promise<void>;
}

/**
 * Result of PDF text extraction.
 *
 * Page count and completeness are optional claims: an extractor that cannot
 * verify them must omit them rather than guess. No page limit is enforced —
 * extraction reads the whole capped file.
 */
export interface PdfExtractResult {
  text: string;
  /** Total page count when the extractor can verify it; omit when unknown. */
  pageCount?: number;
  /** Whether every page's text was captured when the extractor can verify it. */
  complete?: boolean;
}

/**
 * PDF extraction function signature — injectable for testability.
 */
export type PdfExtractFn = (body: string, url: string) => PdfExtractResult;

// ─── Error ───────────────────────────────────────────────────────────────────

/**
 * Error thrown when URL validation or fetching fails.
 * Carries the failing URL and a human-readable reason.
 */
export class WebFetchError extends Error {
  public readonly url: string;
  constructor(url: string, reason: string) {
    super(`web_fetch: ${reason}\nURL: ${url}`);
    this.name = "WebFetchError";
    this.url = url;
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KB

const PDF_MIME = "application/pdf";

const BINARY_TYPE_RE =
  /^(image|audio|video|font)\/|^application\/(?!json|xml|.*\+xml|.*json|.*javascript|.*ecmascript|pdf)/;

const DEFAULT_PDF_MAX_BYTES = 10 * 1024 * 1024; // 10 MB for PDFs

// ─── URL validation (pure) ───────────────────────────────────────────────────

/**
 * Validate and parse a raw URL string.
 * Throws WebFetchError for invalid URLs, missing protocol, or non-http(s).
 */
export function validateUrl(raw: string): URL {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    throw new WebFetchError(String(raw), "URL must be a non-empty string");
  }

  const trimmed = raw.trim();

  // Handle bare domains without protocol
  // If URL already has a protocol, keep it as-is (we'll validate below).
  // If not, default to https.
  const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const withProtocol = hasProtocol ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new WebFetchError(trimmed, "URL is malformed — could not be parsed");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebFetchError(
      trimmed,
      `Unsupported protocol "${parsed.protocol}" — only http and https are allowed`,
    );
  }

  // Require a real hostname
  if (!parsed.hostname || parsed.hostname.length < 1) {
    throw new WebFetchError(trimmed, "URL has no hostname");
  }

  return parsed;
}

// ─── Content-type helpers (pure) ─────────────────────────────────────────────

/**
 * Normalize a Content-Type header value to a lowercase MIME type string.
 */
export function normalizeContentType(raw: string | null): string {
  if (!raw) return "";
  return raw.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Check if a MIME type is a binary media type that can't be extracted.
 */
export function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false;
  return BINARY_TYPE_RE.test(contentType);
}

/**
 * Check if a MIME type or URL indicates a PDF.
 *
 * Returns true if the content-type is application/pdf,
 * or if no conflicting content-type is set and the URL ends in .pdf.
 */
export function isPdfContentType(contentType: string, url: string): boolean {
  if (contentType === PDF_MIME) return true;
  // URL-based detection as a fallback
  if (!contentType || contentType === "text/html" || contentType.startsWith("text/")) {
    // Check if URL ends in .pdf (case-insensitive, with optional query params)
    const urlPath = url.split("?")[0] ?? url;
    return urlPath.toLowerCase().endsWith(".pdf");
  }
  return false;
}

/**
 * Check if a MIME type looks like HTML.
 */
export function isHtmlContentType(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

/**
 * Check if a MIME type looks like plain text we can handle.
 * Includes text/* (except text/html which we handle separately),
 * and application/json, application/xml, application/*+xml.
 */
export function isTextContentType(contentType: string): boolean {
  if (!contentType) return true; // assume text if unknown
  if (isHtmlContentType(contentType)) return false;
  if (isBinaryContentType(contentType)) return false;
  if (contentType.startsWith("text/")) return true;
  if (contentType === "application/json") return true;
  if (contentType.endsWith("+xml") || contentType === "application/xml") return true;
  if (contentType === "application/javascript" || contentType === "application/ecmascript")
    return true;
  return false;
}

// ─── PDF extraction (injectable) ─────────────────────────────────────────────

/**
 * Extract text content from a PDF.
 *
 * Uses an injectable extraction function (defaultPdfExtractFn by default).
 * No page limit is applied: the whole (already size-capped) file is scanned.
 *
 * @param body - Raw PDF bytes as string
 * @param url - Source URL (for error messages)
 * @param options - Optional custom extractor
 * @returns Extracted text plus any page-count/completeness claim the extractor
 *   can actually verify
 */
export function extractPdfContent(
  body: string,
  url: string,
  options: { extractPdfFn?: PdfExtractFn } = {},
): PdfExtractResult {
  const extractFn = options.extractPdfFn ?? defaultPdfExtractFn;
  return extractFn(body, url);
}

/**
 * Default PDF text extractor.
 *
 * Handles simple PDFs by scanning for text objects (BT...ET blocks)
 * and extracting text between parentheses after Tj/TJ operators. For
 * compressed or complex PDFs this will return empty text.
 *
 * It reports no page count and no completeness claim: the scan is
 * regex-based over the whole file and cannot know how many pages the document
 * has or whether every page's text was found. Omitting those claims is
 * deliberate — an unverified number is reported as unknown, not guessed.
 */
export function defaultPdfExtractFn(body: string, _url: string): PdfExtractResult {
  if (!body || !body.includes("%PDF")) {
    return { text: "" };
  }

  // Extract text from PDF text objects
  const textFragments: string[] = [];

  // Find all BT...ET blocks (text objects)
  const textObjectRegex = /BT([\s\S]*?)ET/g;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textObjectRegex.exec(body)) !== null) {
    const textBlock = textMatch[1];

    // Extract text from Tj operators: (text) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch: RegExpExecArray | null;
    while ((tjMatch = tjRegex.exec(textBlock)) !== null) {
      textFragments.push(tjMatch[1]);
    }

    // Extract text from TJ operators: [(text) num (text)] TJ
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
    let tjArrayMatch: RegExpExecArray | null;
    while ((tjArrayMatch = tjArrayRegex.exec(textBlock)) !== null) {
      const arrayContent = tjArrayMatch[1];
      const parenRegex = /\(([^)]*)\)/g;
      let parenMatch: RegExpExecArray | null;
      while ((parenMatch = parenRegex.exec(arrayContent)) !== null) {
        textFragments.push(parenMatch[1]);
      }
    }
  }

  // If no text found via operators, try a broader scan for parenthesized content
  if (textFragments.length === 0) {
    const broadRegex = /\(([^)]{2,})\)/g;
    let broadMatch: RegExpExecArray | null;
    while ((broadMatch = broadRegex.exec(body)) !== null) {
      const candidate = broadMatch[1];
      // Filter out PDF structural content (numeric, hex, etc.)
      if (/[a-zA-Z]{3,}/.test(candidate)) {
        textFragments.push(candidate);
      }
    }
  }

  const text = textFragments.join(" ");

  return { text: text.trim() };
}

// ─── Fetch (IO, injected for testability) ────────────────────────────────────

/**
 * Fetch a URL with browser-like user agent, timeout, and size caps.
 *
 * Returns the response + body text. Throws WebFetchError on network failure,
 * timeout, caller cancellation, binary content, oversized responses, or HTTP
 * errors. The deadline covers the whole download, response body included; on
 * any early exit the body stream and its connection are released.
 */
export async function fetchUrl(
  url: URL,
  options: FetchOptions = {},
): Promise<{ response: Response; body: string }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? BROWSER_UA;
  const urlStr = url.toString();

  // The deadline spans headers *and* body, so a stalled body cannot outlive it.
  // Firing aborts the request so the transport can release the connection.
  const timeoutController = new AbortController();
  let stopCause: "timeout" | "cancelled" | undefined;
  const callerSignal = options.signal;
  const onCallerAbort = () => {
    stopCause ??= "cancelled";
  };
  if (callerSignal) {
    if (callerSignal.aborted) stopCause = "cancelled";
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeoutId = setTimeout(() => {
    stopCause ??= "timeout";
    timeoutController.abort();
  }, timeoutMs);

  const combined = callerSignal ? anySignal([callerSignal, timeoutController.signal]) : undefined;
  const signal = combined?.signal ?? timeoutController.signal;

  const cleanup = () => {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    combined?.dispose();
  };

  // Report why the request stopped, based on whichever event came first.
  const abortError = (): WebFetchError =>
    stopCause === "cancelled" || callerSignal?.aborted
      ? new WebFetchError(urlStr, cancellationReason(callerSignal))
      : new WebFetchError(urlStr, `Request timed out after ${timeoutMs}ms`);

  let response: Response;
  try {
    response = await fetchFn(urlStr, {
      signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });
  } catch (err) {
    const aborted = signal.aborted || isAbortError(err);
    const wrapped = aborted
      ? abortError()
      : new WebFetchError(urlStr, `Network error: ${(err as Error).message}`);
    cleanup();
    throw wrapped;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyConsumed = false;
  try {
    // Check for HTTP errors
    if (!response.ok) {
      throw new WebFetchError(
        urlStr,
        `HTTP ${response.status} ${response.statusText ?? ""}`.trim(),
      );
    }

    // Check Content-Type
    const contentType = normalizeContentType(response.headers.get("content-type"));

    if (isBinaryContentType(contentType)) {
      throw new WebFetchError(
        urlStr,
        `Unsupported content type "${contentType}" — the tool can only fetch HTML, plain text, and PDFs`,
      );
    }

    // Determine effective size cap (PDFs get a larger cap)
    const effectiveMaxBytes = isPdfContentType(contentType, urlStr)
      ? (options.maxPdfBytes ?? DEFAULT_PDF_MAX_BYTES)
      : maxBytes;

    // Enforce size cap
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const len = parseInt(contentLength, 10);
      if (!isNaN(len) && len > effectiveMaxBytes) {
        throw new WebFetchError(
          urlStr,
          `Response too large: ${len} bytes (max ${effectiveMaxBytes} bytes)`,
        );
      }
    }

    // Read body with size cap. When a sink is provided, bytes are streamed to it
    // incrementally (disk-backed download) instead of accumulated in memory;
    // the cap is enforced identically in both modes. Every await is raced
    // against the signal so the deadline also bounds a stalled body.
    let body: string;
    reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal);
        if (done) break;
        total += value.byteLength;
        if (total > effectiveMaxBytes) {
          throw new WebFetchError(
            urlStr,
            `Response exceeded size cap: read over ${effectiveMaxBytes} bytes`,
          );
        }
        if (options.sink) {
          await options.sink(value);
        } else {
          chunks.push(value);
        }
      }
      bodyConsumed = true;
      if (options.sink) {
        body = "";
      } else {
        const combinedBytes = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          combinedBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = new TextDecoder().decode(combinedBytes);
      }
    } else if (options.sink) {
      const text = await withAbort(response.text(), signal);
      bodyConsumed = true;
      if (text.length > effectiveMaxBytes) {
        throw new WebFetchError(
          urlStr,
          `Response too large: ${text.length} bytes (max ${effectiveMaxBytes} bytes)`,
        );
      }
      await options.sink(new TextEncoder().encode(text));
      body = "";
    } else {
      body = await withAbort(response.text(), signal);
      bodyConsumed = true;
      if (body.length > effectiveMaxBytes) {
        throw new WebFetchError(
          urlStr,
          `Response too large: ${body.length} bytes (max ${effectiveMaxBytes} bytes)`,
        );
      }
    }

    return { response, body };
  } catch (err) {
    if (err instanceof WebFetchError) throw err;
    if (signal.aborted) throw abortError();
    throw new WebFetchError(urlStr, `Failed to read response body: ${(err as Error).message}`);
  } finally {
    cleanup();
    if (!bodyConsumed) {
      // Stop consuming and let the transport release the connection.
      if (reader) void reader.cancel().catch(() => {});
      else if (response.body) void response.body.cancel().catch(() => {});
      timeoutController.abort();
    }
  }
}

// ─── Plain-text pass-through (pure) ─────────────────────────────────────────

/**
 * Process plain-text content for model consumption.
 */
export function processPlainText(body: string): string {
  return body.trim();
}

// ─── Signal helpers ─────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === "AbortError";
}

/**
 * Human-readable reason for a caller-initiated cancellation. Pi's cancellation
 * carries no reason, so the fallback wording stays neutral.
 */
function cancellationReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason as unknown;
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message) {
    return `Request cancelled: ${reason.message}`;
  }
  return "Request cancelled";
}

/**
 * Combine multiple AbortSignals into one that fires when any fires.
 * Call `dispose` to remove the listeners it registered.
 */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of removers) remove();
    },
  };
}

/**
 * Await `promise`, but reject as soon as `signal` aborts — a transport that
 * ignores the signal must not outlive the deadline.
 */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}