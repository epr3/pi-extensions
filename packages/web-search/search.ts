import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchInputs {
  query: string;
  exactPhrases?: string[];
  excludeTerms?: string[];
  site?: string;
  count?: number;
}

/** A single search result from Google CSE. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Structured details of a composed query, before any request is made. */
export interface SearchResponseDetails {
  normalizedQuery: string;
  exactPhrases: string[];
  excludeTerms: string[];
  siteRestriction: string | null;
  /** Requested result count (the `num` sent to the API), not what came back. */
  resultCount: number;
  composedQuery: string;
}

/** Structured details returned in tool result `details`. */
export interface WebSearchDetails extends SearchResponseDetails {
  /** Results actually returned by the API; presentation counts come from this. */
  results: SearchResult[];
  /** Google's reported total match count, not the number of returned results. */
  totalResults: number;
}

/** Google CSE credentials. */
export interface Credentials {
  apiKey: string;
  cseId: string;
}

/** Options for resolving Search credentials. */
export interface ResolveCredentialsOptions {
  /** Auth file to read when the environment is incomplete (default: see `defaultCredentialsPath`). */
  authPath?: string;
}

// ─── Query composition (pure) ────────────────────────────────────────────────

/**
 * Normalize a single term: trim whitespace, collapse internal whitespace.
 */
export function normalizeTerm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Normalize site restriction: remove protocol, trailing slash, "www." prefix.
 * Lowercases for consistent matching.
 */
export function normalizeSite(s: string): string {
  let out = s.trim().toLowerCase();
  out = out.replace(/^https?:\/\//, "");
  out = out.replace(/\/+$/, "");
  out = out.replace(/^www\./, "");
  return out;
}

/**
 * Compose a Google Custom Search query from structured inputs.
 *
 * - Quotes exact phrases.
 * - Prefixes excluded terms with `-`.
 * - Appends `site:domain` when a site restriction is given.
 * - Clamps count to 1-10, defaulting to 5.
 */
export function composeQuery(inputs: SearchInputs): SearchResponseDetails {
  const base = normalizeTerm(inputs.query);
  const exact = (inputs.exactPhrases ?? []).map(normalizeTerm).filter(Boolean);
  const exclude = (inputs.excludeTerms ?? []).map(normalizeTerm).filter(Boolean);
  const site = inputs.site ? normalizeSite(inputs.site) : null;
  const count = Math.max(1, Math.min(10, inputs.count ?? 5));

  const parts: string[] = [base];
  for (const phrase of exact) parts.push(`"${phrase}"`);
  for (const term of exclude) parts.push(`-${term}`);
  if (site) parts.push(`site:${site}`);

  return {
    normalizedQuery: base,
    exactPhrases: exact,
    excludeTerms: exclude,
    siteRestriction: site,
    resultCount: count,
    composedQuery: parts.join(" "),
  };
}

/**
 * Clean a user-facing input value: trim + collapse whitespace.
 */
export function cleanInput(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

// ─── Credential resolution (IO) ──────────────────────────────────────────────

/**
 * Error thrown when Google CSE credentials are missing from all sources.
 */
export class CredentialsError extends Error {
  constructor(authPath: string) {
    super(
      [
        "web_search requires Google Custom Search credentials.",
        "",
        "Set the following environment variables:",
        "  GOOGLE_API_KEY  — your Google API key",
        "  GOOGLE_CSE_ID   — your Custom Search Engine ID",
        "",
        "Or create the credentials file:",
        `  ${authPath}`,
        '  with JSON: { "apiKey": "...", "cseId": "..." }',
        "",
        "See: https://developers.google.com/custom-search/v1/overview",
      ].join("\n"),
    );
    this.name = "CredentialsError";
  }
}

/**
 * Default location of the Search credentials file.
 */
export function defaultCredentialsPath(): string {
  return path.join(homedir(), ".pi", "agent", "auth", "web-search.json");
}

/**
 * Resolve Google CSE credentials.
 *
 * Precedence:
 * 1. Environment variables: GOOGLE_API_KEY, GOOGLE_CSE_ID (both required)
 * 2. Auth file: ~/.pi/agent/auth/web-search.json (fields: apiKey, cseId)
 *
 * Sources are all-or-nothing: a partially configured environment falls through
 * to the file. Failures never echo file contents, so credentials cannot leak
 * into logs or model-facing errors.
 *
 * Throws CredentialsError if neither source provides valid credentials.
 */
export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCredentialsOptions = {},
): Credentials {
  const envApiKey = env.GOOGLE_API_KEY?.trim();
  const envCseId = env.GOOGLE_CSE_ID?.trim();
  if (envApiKey && envCseId) return { apiKey: envApiKey, cseId: envCseId };

  const authPath = options.authPath ?? defaultCredentialsPath();

  try {
    const raw = readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fileApiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : undefined;
    const fileCseId = typeof parsed.cseId === "string" ? parsed.cseId.trim() : undefined;
    if (fileApiKey && fileCseId) return { apiKey: fileApiKey, cseId: fileCseId };
  } catch {
    // missing or malformed — fall through to error
  }

  throw new CredentialsError(authPath);
}

// ─── Google API call (IO, fetch injected for testability) ────────────────────

/** Default deadline in ms for the whole search request, response body included. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Error thrown when a search fails: network failure, timeout, cancellation,
 * HTTP error, or an unreadable response body.
 */
export class SearchError extends Error {
  constructor(reason: string) {
    super(`web_search: ${reason}`);
    this.name = "SearchError";
  }
}

/** Options for a Google Custom Search call. */
export interface SearchOptions {
  /** Fetch implementation (default globalThis.fetch; replace for tests). */
  fetchFn?: typeof globalThis.fetch;
  /** Caller cancellation, forwarded to the request and the body read. */
  signal?: AbortSignal;
  /** Deadline in ms for the whole request, response body included (default 15s). */
  timeoutMs?: number;
}

/**
 * Call the Google Custom Search API.
 *
 * The deadline spans headers *and* body, so a stalled response cannot hang the
 * tool. Failures are reported as a SearchError that distinguishes a timeout
 * from caller cancellation and other failures; on any early exit the body is
 * released and the request aborted.
 *
 * @param query    The composed search query string.
 * @param apiKey   Google API key.
 * @param cseId    Custom Search Engine ID.
 * @param count    Number of results (1-10).
 * @param options  Fetch implementation, caller signal, and deadline override.
 */
export async function searchGoogle(
  query: string,
  apiKey: string,
  cseId: string,
  count: number,
  options: SearchOptions = {},
): Promise<{ results: SearchResult[]; totalResults: number }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cseId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(count));

  // The deadline spans headers *and* body. Firing aborts the request so a
  // cooperative transport can release the connection.
  const timeoutController = new AbortController();
  const callerSignal = options.signal;
  let stopCause: "timeout" | "cancelled" | undefined;
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
  const abortError = (): SearchError =>
    stopCause === "cancelled" || callerSignal?.aborted
      ? new SearchError(cancellationReason(callerSignal))
      : new SearchError(`Search timed out after ${timeoutMs}ms`);

  let response: Response;
  try {
    response = await withAbort(fetchFn(url.toString(), { signal }), signal);
  } catch (err) {
    cleanup();
    throw signal.aborted || isAbortError(err)
      ? abortError()
      : new SearchError(`Network error: ${(err as Error).message}`);
  }

  let body: string;
  let bodyRead = false;
  try {
    body = await withAbort(response.text(), signal);
    bodyRead = true;
  } catch (err) {
    throw signal.aborted || isAbortError(err)
      ? abortError()
      : new SearchError(`Failed to read response body: ${(err as Error).message}`);
  } finally {
    cleanup();
    if (!bodyRead) {
      // Stop consuming and let the transport release the connection.
      void response.body?.cancel().catch(() => {});
      timeoutController.abort();
    }
  }

  if (!response.ok) {
    throw new SearchError(shapeApiError(response.status, body));
  }

  const parsed = JSON.parse(body) as {
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
    searchInformation?: { totalResults?: string };
  };

  const results: SearchResult[] = (parsed.items ?? []).map((item) => ({
    title: item.title ?? "",
    url: item.link ?? "",
    snippet: item.snippet ?? "",
  }));
  const totalResults = parseInt(parsed.searchInformation?.totalResults ?? "0", 10) || 0;

  return { results, totalResults };
}

// ─── Signal helpers ──────────────────────────────────────────────────────────

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
    return `Search cancelled: ${reason.message}`;
  }
  return "Search cancelled";
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
  if (signal.aborted) {
    // The abandoned promise must not surface as an unhandled rejection.
    promise.catch(() => {});
    throw new DOMException("Aborted", "AbortError");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => {});
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// ─── Error shaping (pure) ────────────────────────────────────────────────────

/**
 * Shape a Google CSE API error response into a user-readable message.
 */
export function shapeApiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: number; message?: string; status?: string };
    };
    if (parsed.error?.message) {
      return `Google Custom Search API error (${parsed.error.code ?? status}): ${parsed.error.message}`;
    }
  } catch {
    // not JSON — use raw text
  }
  return `Google Custom Search API error (${status}): ${body.slice(0, 500)}`;
}

// ─── Result formatting (pure) ────────────────────────────────────────────────

/**
 * Format search results into stable plain-text content.
 *
 * Output format:
 *   Found N results for: <composed query>
 *
 *   1. Title
 *      URL
 *      Snippet
 *
 *   2. Title
 *      URL
 *      Snippet
 *
 * Or for empty results:
 *   No results for: <composed query>
 */
export function formatSearchResults(
  results: SearchResult[],
  details: SearchResponseDetails,
): string {
  if (results.length === 0) {
    return `No results for: ${details.composedQuery}`;
  }

  const header = `Found ${results.length} result${results.length !== 1 ? "s" : ""} for: ${details.composedQuery}`;
  const lines: string[] = [header, ""];

  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    lines.push(`   ${r.snippet}`);
    if (i < results.length - 1) lines.push("");
  });

  return lines.join("\n");
}