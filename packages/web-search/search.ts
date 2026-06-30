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

/** Structured details returned in tool result `details`. */
export interface SearchResponseDetails {
  normalizedQuery: string;
  exactPhrases: string[];
  excludeTerms: string[];
  siteRestriction: string | null;
  resultCount: number;
  composedQuery: string;
}

/** Google CSE credentials. */
export interface Credentials {
  apiKey: string;
  cseId: string;
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
    super([
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
    ].join("\n"));
    this.name = "CredentialsError";
  }
}

/**
 * Resolve Google CSE credentials.
 *
 * Precedence:
 * 1. Environment variables: GOOGLE_API_KEY, GOOGLE_CSE_ID
 * 2. Auth file: ~/.pi/agent/auth/web-search.json (fields: apiKey, cseId)
 *
 * Throws CredentialsError if neither source provides valid credentials.
 */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const envApiKey = env.GOOGLE_API_KEY?.trim();
  const envCseId = env.GOOGLE_CSE_ID?.trim();
  if (envApiKey && envCseId) return { apiKey: envApiKey, cseId: envCseId };

  const authDir = path.join(homedir(), ".pi", "agent", "auth");
  const authPath = path.join(authDir, "web-search.json");

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

/**
 * Call the Google Custom Search API.
 *
 * @param query    The composed search query string.
 * @param apiKey   Google API key.
 * @param cseId    Custom Search Engine ID.
 * @param count    Number of results (1-10).
 * @param fetchFn  Fetch implementation (default globalThis.fetch; replace for tests).
 */
export async function searchGoogle(
  query: string,
  apiKey: string,
  cseId: string,
  count: number,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ results: SearchResult[]; totalResults: number }> {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cseId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(count));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetchFn(url.toString(), { signal: controller.signal });
    clearTimeout(timeoutId);
    const body = await response.text();

    if (!response.ok) {
      throw new Error(shapeApiError(response.status, body));
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
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
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
export function formatSearchResults(results: SearchResult[], details: SearchResponseDetails): string {
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
