// ─── Types ───────────────────────────────────────────────────────────────────

/** Structured details returned in tool result `details`. */
export interface WebFetchDetails {
  url: string;
  title: string;
  contentType: string;
  /** Where the content was extracted from. */
  source: "html" | "text" | "pdf";
  /** Error message if the fetch succeeded but extraction was poor. */
  extractionWarning?: string;
  /** Page count for PDFs. */
  pageCount?: number;
  /** Whether PDF content was truncated (page limit hit). */
  truncated?: boolean;
  /** Absolute path of the finalized Readable artifact on disk. */
  artifactPath: string;
  /** Whether the artifact contains the full converted source within limits. */
  artifactComplete: boolean;
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
}

/** Options for fetching a URL. */
export interface FetchOptions {
  signal?: AbortSignal;
  /** Max bytes to read from the response body (default 512KB). */
  maxContentBytes?: number;
  /** Max bytes for PDF responses (default 10MB). */
  maxPdfBytes?: number;
  /** Fetch timeout in ms (default 30s). */
  fetchTimeoutMs?: number;
  /** Custom fetch implementation (for tests). */
  fetchFn?: typeof globalThis.fetch;
  /** Custom user agent (for tests). */
  userAgent?: string;
  /** Custom PDF extraction function (for tests). */
  extractPdfFn?: PdfExtractFn;
  /** Maximum pages to extract from a PDF (default 50). */
  pdfPageLimit?: number;
  /** When provided, body bytes are streamed here instead of accumulated. */
  sink?: (chunk: Uint8Array) => Promise<void>;
}

/**
 * Result of PDF text extraction.
 */
export interface PdfExtractResult {
  text: string;
  pageCount: number;
  truncated?: boolean;
}

/**
 * PDF extraction function signature — injectable for testability.
 */
export type PdfExtractFn = (
  body: string,
  url: string,
  options?: { pageLimit?: number },
) => PdfExtractResult;

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

const DEFAULT_PDF_PAGE_LIMIT = 50;
const DEFAULT_PDF_MAX_BYTES = 10 * 1024 * 1024; // 10 MB for PDFs

export { DEFAULT_PDF_PAGE_LIMIT };

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
 * The default handler does basic text extraction from simple PDFs by parsing
 * text objects (BT...ET blocks) and extracting text between parentheses.
 * For compressed or complex PDFs, consider using a dedicated PDF library.
 *
 * @param body - Raw PDF bytes as string
 * @param url - Source URL (for error messages)
 * @param options - Optional custom extractor and page limit
 * @returns Extracted text and page count
 */
export function extractPdfContent(
  body: string,
  url: string,
  options: { extractPdfFn?: PdfExtractFn; pageLimit?: number } = {},
): PdfExtractResult {
  const extractFn = options.extractPdfFn ?? defaultPdfExtractFn;
  const pageLimit = options.pageLimit ?? DEFAULT_PDF_PAGE_LIMIT;
  return extractFn(body, url, { pageLimit });
}

/**
 * Default PDF text extractor.
 *
 * Handles simple PDFs by scanning for text objects (BT...ET blocks)
 * and extracting text between parentheses after Tj/TJ operators.
 * For compressed or complex PDFs this will return empty text.
 */
export function defaultPdfExtractFn(
  body: string,
  _url: string,
  options: { pageLimit?: number } = {},
): PdfExtractResult {
  const pageLimit = options.pageLimit ?? DEFAULT_PDF_PAGE_LIMIT;

  if (!body || !body.includes("%PDF")) {
    return { text: "", pageCount: 0 };
  }

  // Count pages by looking for /Type /Page (but not /Pages) in obj..endobj blocks
  const pageMatches = body.match(/obj[\s\S]*?\/Type\s*\/Page[^s\w][\s\S]*?endobj/g);
  const pageCount = pageMatches ? pageMatches.length : 0;

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

  let text = textFragments.join(" ");

  // Check page limit
  const truncated = pageCount > pageLimit;
  if (truncated) {
    text += `\n\n[... PDF truncated: ${pageCount} pages total, extraction limited to first ${pageLimit} pages]`;
  }

  return {
    text: text.trim(),
    pageCount,
    truncated,
  };
}

// ─── Fetch (IO, injected for testability) ────────────────────────────────────

/**
 * Fetch a URL with browser-like user agent, timeout, and size caps.
 *
 * Returns the response + body text. Throws WebFetchError on network failure,
 * timeout, binary content, oversized responses, or HTTP errors.
 */
export async function fetchUrl(
  url: URL,
  options: FetchOptions = {},
): Promise<{ response: Response; body: string }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? BROWSER_UA;

  // Set up timeout via AbortController
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Combine with caller's signal if provided
  const signal = options.signal
    ? anySignal([options.signal, timeoutController.signal])
    : timeoutController.signal;

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new WebFetchError(url.toString(), `Request timed out after ${timeoutMs}ms`);
    }
    throw new WebFetchError(url.toString(), `Network error: ${(err as Error).message}`);
  }
  clearTimeout(timeoutId);

  // Check for HTTP errors
  if (!response.ok) {
    throw new WebFetchError(
      url.toString(),
      `HTTP ${response.status} ${response.statusText ?? ""}`.trim(),
    );
  }

  // Check Content-Type
  const contentType = normalizeContentType(response.headers.get("content-type"));

  if (isBinaryContentType(contentType)) {
    throw new WebFetchError(
      url.toString(),
      `Unsupported content type "${contentType}" — the tool can only fetch HTML, plain text, and PDFs`,
    );
  }

  // Determine effective size cap (PDFs get a larger cap)
  const effectiveMaxBytes = isPdfContentType(contentType, url.toString())
    ? (options.maxPdfBytes ?? DEFAULT_PDF_MAX_BYTES)
    : maxBytes;

  // Enforce size cap
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > effectiveMaxBytes) {
      throw new WebFetchError(
        url.toString(),
        `Response too large: ${len} bytes (max ${effectiveMaxBytes} bytes)`,
      );
    }
  }

  // Read body with size cap. When a sink is provided, bytes are streamed to it
  // incrementally (disk-backed download) instead of accumulated in memory;
  // the cap is enforced identically in both modes.
  let body: string;
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > effectiveMaxBytes) {
          reader.cancel();
          throw new WebFetchError(
            url.toString(),
            `Response exceeded size cap: read over ${effectiveMaxBytes} bytes`,
          );
        }
        if (options.sink) {
          await options.sink(value);
        } else {
          chunks.push(value);
        }
      }
      if (options.sink) {
        body = "";
      } else {
        const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = new TextDecoder().decode(combined);
      }
    } else if (options.sink) {
      const text = await response.text();
      if (text.length > effectiveMaxBytes) {
        throw new WebFetchError(
          url.toString(),
          `Response too large: ${text.length} bytes (max ${effectiveMaxBytes} bytes)`,
        );
      }
      await options.sink(new TextEncoder().encode(text));
      body = "";
    } else {
      body = await response.text();
      if (body.length > effectiveMaxBytes) {
        throw new WebFetchError(
          url.toString(),
          `Response too large: ${body.length} bytes (max ${effectiveMaxBytes} bytes)`,
        );
      }
    }
  } catch (err) {
    if (err instanceof WebFetchError) throw err;
    throw new WebFetchError(
      url.toString(),
      `Failed to read response body: ${(err as Error).message}`,
    );
  }

  return { response, body };
}

// ─── Plain-text pass-through (pure) ─────────────────────────────────────────

/**
 * Process plain-text content for model consumption.
 */
export function processPlainText(body: string): string {
  return body.trim();
}

// ─── Signal combiner ─────────────────────────────────────────────────────────

/**
 * Combine multiple AbortSignals into one that fires when any fires.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}