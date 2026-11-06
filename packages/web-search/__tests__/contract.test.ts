/**
 * Web Search tool contract + pure logic tests — Vitest.
 *
 * Verifies, through the public tool surface and pure helpers:
 *   - Tool metadata and parameter schema
 *   - Query composition: normalization, exact phrases, exclusions, site restrictions, count bounds
 *   - Credential resolution: env vars, missing credentials
 *   - Google API error shaping
 *   - Empty and successful result formatting
 *   - searchGoogle with mocked fetch (no live web calls)
 *
 * Run: pnpm test  (from this package)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webSearchExtension from "../index.ts";
import {
  composeQuery,
  normalizeTerm,
  normalizeSite,
  resolveCredentials,
  defaultCredentialsPath,
  shapeApiError,
  formatSearchResults,
  searchGoogle,
  cleanInput,
  CredentialsError,
  SearchError,
} from "../search.ts";
import type { SearchResponseDetails, SearchResult, WebSearchDetails } from "../search.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => {
      captured.push(tool as ToolDefinition);
    },
    on: () => {},
  } as unknown as ExtensionAPI;
}

function registerWebSearch(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  webSearchExtension(makeFakeApi(tools));
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

/**
 * Fetch mock whose headers never arrive. `honorSignal: false` models a
 * transport that ignores the request signal, so the deadline must not depend
 * on the transport reacting to it. The recorded signals make request release
 * observable.
 */
function makeStalledHeadersFetch(opts: { honorSignal?: boolean } = {}): {
  fetchFn: typeof globalThis.fetch;
  signals: () => Array<AbortSignal | undefined>;
} {
  const signals: Array<AbortSignal | undefined> = [];
  const fetchFn: typeof globalThis.fetch = (_url, init) => {
    const signal = (init as RequestInit | undefined)?.signal ?? undefined;
    signals.push(signal);
    if (opts.honorSignal === false) return new Promise<Response>(() => {});
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  };
  return { fetchFn, signals: () => signals };
}

/**
 * Fetch mock whose headers arrive immediately but whose body never yields.
 * Reports how often the body stream was cancelled so cleanup is observable.
 */
function makeStalledBodyFetch(opts: { honorSignal?: boolean } = {}): {
  fetchFn: typeof globalThis.fetch;
  signals: () => Array<AbortSignal | undefined>;
  cancels: () => number;
} {
  const signals: Array<AbortSignal | undefined> = [];
  let cancelCount = 0;
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const signal = (init as RequestInit | undefined)?.signal ?? undefined;
    signals.push(signal);
    return {
      ok: true,
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          if (opts.honorSignal === false) return;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
      body: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          cancelCount += 1;
        },
      }),
    } as unknown as Response;
  };
  return { fetchFn, signals: () => signals, cancels: () => cancelCount };
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

describe("web_search tool metadata", () => {
  it("registers with name 'web_search' and label 'Web Search'", () => {
    const tool = registerWebSearch();
    expect(tool.name).toBe("web_search");
    expect(tool.label).toBe("Web Search");
  });

  it("description mentions Google and the credential sources", () => {
    const tool = registerWebSearch();
    expect(tool.description).toMatch(/Google/);
    expect(tool.description).toMatch(/GOOGLE_API_KEY|environment/);
  });

  it("prompt guidelines mention web_fetch and exactPhrases", () => {
    const tool = registerWebSearch();
    const p = tool.promptGuidelines ?? [];
    expect(p.some((g) => g.includes("web_fetch"))).toBe(true);
    expect(p.some((g) => g.includes("exactPhrases"))).toBe(true);
  });
});

// ─── Parameter schema ───────────────────────────────────────────────────────

describe("web_search parameter schema", () => {
  it("requires a string `query`", () => {
    const tool = registerWebSearch();
    const props = (tool.parameters as { properties: Record<string, { type: string }> }).properties;
    expect(props.query).toBeDefined();
    expect(props.query.type).toBe("string");
  });

  it("`count` is an integer clamped to 1-10 with default 5", () => {
    const tool = registerWebSearch();
    const props = (
      tool.parameters as {
        properties: { count: { minimum: number; maximum: number; default: number } };
      }
    ).properties;
    expect(props.count.minimum).toBe(1);
    expect(props.count.maximum).toBe(10);
    expect(props.count.default).toBe(5);
  });

  it("exposes optional `exactPhrases`, `excludeTerms`, and `site`", () => {
    const tool = registerWebSearch();
    const props = (
      tool.parameters as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(props.exactPhrases).toBeDefined();
    expect(props.excludeTerms).toBeDefined();
    expect(props.site).toBeDefined();
  });
});

// ─── Pure helpers: normalization ────────────────────────────────────────────

describe("normalizeTerm", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeTerm("  hello  ")).toBe("hello");
  });

  it("collapses runs of internal whitespace to a single space", () => {
    expect(normalizeTerm("hello   world")).toBe("hello world");
  });
});

describe("normalizeSite", () => {
  it("strips an https:// protocol prefix", () => {
    expect(normalizeSite("https://example.com")).toBe("example.com");
  });

  it("strips trailing slashes", () => {
    expect(normalizeSite("example.com/")).toBe("example.com");
    expect(normalizeSite("example.com///")).toBe("example.com");
  });

  it("strips a leading www.", () => {
    expect(normalizeSite("www.example.com")).toBe("example.com");
    expect(normalizeSite("https://www.example.com/")).toBe("example.com");
  });

  it("lowercases the host", () => {
    expect(normalizeSite("Example.Com")).toBe("example.com");
  });
});

describe("cleanInput", () => {
  it("trims and collapses internal whitespace", () => {
    expect(cleanInput("  hello  world  ")).toBe("hello world");
    expect(cleanInput("plain")).toBe("plain");
    expect(cleanInput("")).toBe("");
  });
});

// ─── Pure helpers: query composition ────────────────────────────────────────

describe("composeQuery", () => {
  it("returns a minimal details object for a bare query", () => {
    const d = composeQuery({ query: "hello world" });
    expect(d.normalizedQuery).toBe("hello world");
    expect(d.composedQuery).toBe("hello world");
    expect(d.resultCount).toBe(5);
    expect(d.siteRestriction).toBeNull();
    expect(d.exactPhrases).toEqual([]);
    expect(d.excludeTerms).toEqual([]);
  });

  it("wraps each exact phrase in double quotes", () => {
    const d = composeQuery({ query: "hello", exactPhrases: ["exact phrase", "another"] });
    expect(d.composedQuery).toContain('"exact phrase"');
    expect(d.composedQuery).toContain('"another"');
    expect(d.composedQuery.startsWith("hello")).toBe(true);
  });

  it("prefixes each excluded term with `-`", () => {
    const d = composeQuery({ query: "hello", excludeTerms: ["bad", "ugly"] });
    expect(d.composedQuery).toContain("-bad");
    expect(d.composedQuery).toContain("-ugly");
  });

  it("passes multiword exclusions through unquoted after the minus prefix", () => {
    const d = composeQuery({ query: "hello", excludeTerms: ["bad phrase"] });
    expect(d.excludeTerms).toEqual(["bad phrase"]);
    expect(d.composedQuery).toBe("hello -bad phrase");
  });

  it("passes embedded quotation marks through in exact phrases", () => {
    const d = composeQuery({ query: "hello", exactPhrases: ['a "quoted" phrase'] });
    expect(d.exactPhrases).toEqual(['a "quoted" phrase']);
    expect(d.composedQuery).toBe('hello "a "quoted" phrase"');
  });

  it("normalizes the site restriction and appends `site:<host>`", () => {
    const d = composeQuery({ query: "hello", site: "https://www.example.com/" });
    expect(d.composedQuery).toContain("site:example.com");
    expect(d.siteRestriction).toBe("example.com");
  });

  it("clamps `count` into the [1, 10] range", () => {
    expect(composeQuery({ query: "hello", count: 0 }).resultCount).toBe(1);
    expect(composeQuery({ query: "hello", count: 100 }).resultCount).toBe(10);
    expect(composeQuery({ query: "hello", count: 7 }).resultCount).toBe(7);
  });

  it("defaults `count` to 5 when omitted", () => {
    expect(composeQuery({ query: "test" }).resultCount).toBe(5);
  });

  it("combines all features into a single composed query", () => {
    const d = composeQuery({
      query: "  typescript  patterns  ",
      exactPhrases: ["design patterns"],
      excludeTerms: ["java"],
      site: "github.com",
      count: 3,
    });

    expect(d.normalizedQuery).toBe("typescript patterns");
    expect(d.resultCount).toBe(3);
    expect(d.siteRestriction).toBe("github.com");
    expect(d.exactPhrases).toEqual(["design patterns"]);
    expect(d.excludeTerms).toEqual(["java"]);
    expect(d.composedQuery.startsWith("typescript patterns")).toBe(true);
    expect(d.composedQuery).toContain('"design patterns"');
    expect(d.composedQuery).toContain("-java");
    expect(d.composedQuery).toContain("site:github.com");
  });
});

// ─── Credentials ────────────────────────────────────────────────────────────

describe("resolveCredentials", () => {
  // Every credential test points at a temp auth path so the host's own
  // ~/.pi/agent/auth/web-search.json can never influence the result.
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pi-web-search-creds-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAuthFile(contents: string, name = "web-search.json"): string {
    const filePath = path.join(tempDir, name);
    writeFileSync(filePath, contents, "utf8");
    return filePath;
  }

  function missingAuthPath(): string {
    return path.join(tempDir, "absent.json");
  }

  it("returns API key + CSE ID read from env vars", () => {
    const creds = resolveCredentials(
      { GOOGLE_API_KEY: "key123", GOOGLE_CSE_ID: "cse456" },
      { authPath: missingAuthPath() },
    );
    expect(creds.apiKey).toBe("key123");
    expect(creds.cseId).toBe("cse456");
  });

  it("throws CredentialsError when both env vars are missing", () => {
    expect(() => resolveCredentials({}, { authPath: missingAuthPath() })).toThrow(CredentialsError);
  });

  it("throws when only GOOGLE_API_KEY is set", () => {
    expect(() =>
      resolveCredentials({ GOOGLE_API_KEY: "key" }, { authPath: missingAuthPath() }),
    ).toThrow(CredentialsError);
  });

  it("throws when only GOOGLE_CSE_ID is set", () => {
    expect(() =>
      resolveCredentials({ GOOGLE_CSE_ID: "cse" }, { authPath: missingAuthPath() }),
    ).toThrow(CredentialsError);
  });

  it("CredentialsError names both env vars, the auth file path, and the docs URL", () => {
    const authPath = path.join(tempDir, "web-search.json");
    try {
      resolveCredentials({}, { authPath });
    } catch (e) {
      expect(e).toBeInstanceOf(CredentialsError);
      const msg = (e as CredentialsError).message;
      expect(msg).toContain("GOOGLE_API_KEY");
      expect(msg).toContain("GOOGLE_CSE_ID");
      expect(msg).toContain(authPath);
      expect(msg).toContain("web-search.json");
      expect(msg).toContain("developers.google.com");
    }
  });

  it("falls back to the auth file when the environment has no credentials", () => {
    const authPath = writeAuthFile('{ "apiKey": "file-key", "cseId": "file-cse" }');
    const creds = resolveCredentials({}, { authPath });
    expect(creds.apiKey).toBe("file-key");
    expect(creds.cseId).toBe("file-cse");
  });

  it("trims surrounding whitespace in auth file values", () => {
    const authPath = writeAuthFile('{ "apiKey": "  file-key  ", "cseId": "\\nfile-cse\\n" }');
    const creds = resolveCredentials({}, { authPath });
    expect(creds.apiKey).toBe("file-key");
    expect(creds.cseId).toBe("file-cse");
  });

  it("prefers complete environment credentials over a valid auth file", () => {
    const authPath = writeAuthFile('{ "apiKey": "file-key", "cseId": "file-cse" }');
    const creds = resolveCredentials(
      { GOOGLE_API_KEY: "env-key", GOOGLE_CSE_ID: "env-cse" },
      { authPath },
    );
    expect(creds.apiKey).toBe("env-key");
    expect(creds.cseId).toBe("env-cse");
  });

  it("uses the auth file as a whole when the environment is only partially set", () => {
    const authPath = writeAuthFile('{ "apiKey": "file-key", "cseId": "file-cse" }');
    const creds = resolveCredentials({ GOOGLE_API_KEY: "env-key" }, { authPath });
    expect(creds.apiKey).toBe("file-key");
    expect(creds.cseId).toBe("file-cse");
  });

  it("throws when the auth file is malformed JSON", () => {
    const authPath = writeAuthFile('{ "apiKey": "super-secret-api-key", ');
    expect(() => resolveCredentials({}, { authPath })).toThrow(CredentialsError);
  });

  it("throws when the auth file lacks a usable apiKey or cseId", () => {
    const missingCse = writeAuthFile('{ "apiKey": "file-key" }', "missing-cse.json");
    expect(() => resolveCredentials({}, { authPath: missingCse })).toThrow(CredentialsError);

    const nonString = writeAuthFile('{ "apiKey": 42, "cseId": ["file-cse"] }', "non-string.json");
    expect(() => resolveCredentials({}, { authPath: nonString })).toThrow(CredentialsError);

    const emptyStrings = writeAuthFile('{ "apiKey": "  ", "cseId": "" }', "empty.json");
    expect(() => resolveCredentials({}, { authPath: emptyStrings })).toThrow(CredentialsError);
  });

  it("never includes auth file secrets in the missing-credentials message", () => {
    const authPath = writeAuthFile('{ "apiKey": "super-secret-api-key", "cseId": ');
    try {
      resolveCredentials({}, { authPath });
      expect.unreachable("expected CredentialsError");
    } catch (e) {
      expect(e).toBeInstanceOf(CredentialsError);
      const msg = (e as CredentialsError).message;
      expect(msg).not.toContain("super-secret-api-key");
    }
  });

  it("documents the default auth file under the Pi agent auth directory", () => {
    expect(
      defaultCredentialsPath().endsWith(path.join(".pi", "agent", "auth", "web-search.json")),
    ).toBe(true);
  });
});

// ─── Error shaping ──────────────────────────────────────────────────────────

describe("shapeApiError", () => {
  it("extracts the message and status from a JSON error body", () => {
    const msg = shapeApiError(
      403,
      JSON.stringify({ error: { code: 403, message: "Daily limit exceeded" } }),
    );
    expect(msg).toContain("Daily limit exceeded");
    expect(msg).toContain("(403)");
  });

  it("falls back to a raw body when the response is not JSON", () => {
    const msg = shapeApiError(500, "Internal Server Error");
    expect(msg).toContain("500");
    expect(msg).toContain("Internal Server Error");
  });
});

// ─── Result formatting ──────────────────────────────────────────────────────

describe("formatSearchResults", () => {
  it("emits the empty message that includes the composed query", () => {
    const details = composeQuery({ query: "nothing" });
    const text = formatSearchResults([], details);
    expect(text).toContain("No results for:");
    expect(text).toContain(details.composedQuery);
  });

  it("renders multiple results with numbered titles, URLs, and snippets", () => {
    const results: SearchResult[] = [
      { title: "Result One", url: "https://example.com/1", snippet: "First snippet" },
      { title: "Result Two", url: "https://example.com/2", snippet: "Second snippet" },
    ];
    const details = composeQuery({ query: "test", count: 2 });
    const text = formatSearchResults(results, details);

    expect(text).toContain("Found 2 results for:");
    expect(text).toContain(details.composedQuery);
    expect(text).toContain("1. Result One");
    expect(text).toContain("2. Result Two");
    expect(text).toContain("https://example.com/1");
    expect(text).toContain("https://example.com/2");
    expect(text).toContain("First snippet");
    expect(text).toContain("Second snippet");
  });

  it("uses the singular 'result' for a single hit", () => {
    const results: SearchResult[] = [
      { title: "Only Result", url: "https://example.com/only", snippet: "Only snippet" },
    ];
    const details = composeQuery({ query: "test", count: 1 });
    const text = formatSearchResults(results, details);

    expect(text).toContain("Found 1 result for:");
    expect(text).toContain("1. Only Result");
  });
});

// ─── searchGoogle with mocked fetch ─────────────────────────────────────────

describe("searchGoogle (mocked fetch)", () => {
  it("parses a successful response into results and totalResults", async () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        items: [
          { title: "Result One", link: "https://example.com/1", snippet: "Snippet 1" },
          { title: "Result Two", link: "https://example.com/2", snippet: "Snippet 2" },
        ],
        searchInformation: { totalResults: "100" },
      }),
    );

    const { results, totalResults } = await searchGoogle("test", "key", "cse", 2, {
      fetchFn: mockFetch,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe("Result One");
    expect(results[1]?.url).toBe("https://example.com/2");
    expect(totalResults).toBe(100);
  });

  it("rejects with the shaped message on a JSON API error", async () => {
    const mockFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 403, message: "Daily limit exceeded", status: "PERMISSION_DENIED" } },
          { ok: false, status: 403 },
        ),
      );

    await expect(searchGoogle("test", "key", "cse", 2, { fetchFn: mockFetch })).rejects.toThrow(
      /Daily limit exceeded/,
    );
  });

  it("returns an empty result list when the API returns no items", async () => {
    const mockFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ searchInformation: { totalResults: "0" } }));

    const { results, totalResults } = await searchGoogle("test", "key", "cse", 5, {
      fetchFn: mockFetch,
    });
    expect(results).toHaveLength(0);
    expect(totalResults).toBe(0);
  });

  it("rejects with a status-coded message on a non-JSON error body", async () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    await expect(searchGoogle("test", "key", "cse", 2, { fetchFn: mockFetch })).rejects.toThrow(
      /Google Custom Search API error \(500\)/,
    );
  });
});

// ─── registered tool: returned results in details ───────────────────────────

describe("web_search tool — returned results in details", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function executeWith(
    apiBody: unknown,
    params: { query: string; count?: number },
  ): Promise<WebSearchDetails> {
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    vi.stubEnv("GOOGLE_CSE_ID", "test-cse");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(apiBody)),
    );

    const tool = registerWebSearch();
    const result = await tool.execute(
      "call-1",
      params as never,
      undefined,
      undefined,
      undefined as never,
    );
    return result.details as WebSearchDetails;
  }

  it("carries the results actually returned when the API returns fewer than requested", async () => {
    const details = await executeWith(
      {
        items: [{ title: "Only Hit", link: "https://example.com/only", snippet: "Snippet" }],
        searchInformation: { totalResults: "1234" },
      },
      { query: "test", count: 5 },
    );

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.url).toBe("https://example.com/only");
    // The requested count is still recorded separately from what came back.
    expect(details.resultCount).toBe(5);
    expect(details.totalResults).toBe(1234);
  });

  it("carries an empty results list when the API returns no items", async () => {
    const details = await executeWith(
      { searchInformation: { totalResults: "0" } },
      { query: "test", count: 5 },
    );

    expect(details.results).toEqual([]);
    expect(details.resultCount).toBe(5);
  });
});

// ─── structured details shape ───────────────────────────────────────────────

describe("SearchResponseDetails shape", () => {
  it("exposes every field of the details contract on a fully-populated input", () => {
    const d: SearchResponseDetails = composeQuery({
      query: "  hello  world  ",
      exactPhrases: ["a b"],
      excludeTerms: ["c"],
      site: "example.com",
      count: 4,
    });
    expect(d).toEqual({
      normalizedQuery: "hello world",
      exactPhrases: ["a b"],
      excludeTerms: ["c"],
      siteRestriction: "example.com",
      resultCount: 4,
      composedQuery: 'hello world "a b" -c site:example.com',
    });
  });
});
// ─── Deadline and cancellation ──────────────────────────────────────────────

const credentialEnv = { GOOGLE_API_KEY: "key123", GOOGLE_CSE_ID: "cse456" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("searchGoogle deadline (mocked fetch)", () => {
  it("times out when headers never arrive, even if the transport ignores the signal", async () => {
    const stalled = makeStalledHeadersFetch({ honorSignal: false });
    const pending = searchGoogle("test", "key", "cse", 5, {
      fetchFn: stalled.fetchFn,
      timeoutMs: 50,
    });
    await expect(pending).rejects.toThrowError(/Search timed out after 50ms/);
    // The request was aborted so a cooperative transport can release it.
    expect(stalled.signals()[0]?.aborted).toBe(true);
  });

  it("keeps the 15-second default deadline through the response body", async () => {
    vi.useFakeTimers();
    const stalled = makeStalledBodyFetch({ honorSignal: false });
    const pending = searchGoogle("test", "key", "cse", 5, { fetchFn: stalled.fetchFn });
    const settled = pending.catch((err: Error) => err);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(stalled.cancels()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(SearchError);
    expect(err.message).toMatch(/Search timed out after 15000ms/);
    expect(stalled.cancels()).toBe(1);
    expect(stalled.signals()[0]?.aborted).toBe(true);
  });

  it("times out when the body stalls after headers arrive", async () => {
    const stalled = makeStalledBodyFetch();
    await expect(
      searchGoogle("test", "key", "cse", 5, { fetchFn: stalled.fetchFn, timeoutMs: 50 }),
    ).rejects.toThrowError(/Search timed out after 50ms/);
    expect(stalled.cancels()).toBe(1);
  });

  it("reports caller cancellation during stalled headers as a cancellation, not a timeout", async () => {
    const controller = new AbortController();
    const stalled = makeStalledHeadersFetch({ honorSignal: false });
    const pending = searchGoogle("test", "key", "cse", 5, {
      fetchFn: stalled.fetchFn,
      signal: controller.signal,
    });
    const settled = pending.catch((err: Error) => err);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(SearchError);
    expect(err.message).toMatch(/cancel/i);
    expect(err.message).not.toMatch(/timed out/);
  });

  it("reports caller cancellation during a stalled body as a cancellation, not a timeout", async () => {
    const controller = new AbortController();
    const stalled = makeStalledBodyFetch({ honorSignal: false });
    const pending = searchGoogle("test", "key", "cse", 5, {
      fetchFn: stalled.fetchFn,
      signal: controller.signal,
    });
    const settled = pending.catch((err: Error) => err);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(SearchError);
    expect(err.message).toMatch(/cancel/i);
    expect(err.message).not.toMatch(/timed out/);
    expect(stalled.cancels()).toBe(1);
  });

  it("does not consult the deadline when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const stalled = makeStalledHeadersFetch({ honorSignal: false });
    await expect(
      searchGoogle("test", "key", "cse", 5, {
        fetchFn: stalled.fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toThrowError(/cancel/i);
  });

  it("reports a network failure distinctly from a timeout", async () => {
    const failingFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND www.googleapis.com"));
    await expect(
      searchGoogle("test", "key", "cse", 5, { fetchFn: failingFetch }),
    ).rejects.toThrowError(/Network error:.*ENOTFOUND/);
  });

  it("clears its deadline timer once the search completes", async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ items: [] }));
    await searchGoogle("test", "key", "cse", 5, { fetchFn: mockFetch });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Deadline and cancellation through the registered tool ──────────────────

function executeThroughTool(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = registerWebSearch();
  return tool.execute("call-1", params as never, signal, undefined, {} as never);
}

describe("web_search tool deadline and cancellation", () => {
  it("times out when headers never arrive and reports a timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GOOGLE_API_KEY", credentialEnv.GOOGLE_API_KEY);
    vi.stubEnv("GOOGLE_CSE_ID", credentialEnv.GOOGLE_CSE_ID);
    const stalled = makeStalledHeadersFetch({ honorSignal: false });
    vi.stubGlobal("fetch", stalled.fetchFn);

    const pending = executeThroughTool({ query: "pi coding agent" }).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await pending;

    expect(err).toBeInstanceOf(SearchError);
    expect(err.message).toMatch(/Search timed out after 15000ms/);
    expect(stalled.signals()[0]?.aborted).toBe(true);
  });

  it("times out when the body stalls after headers and releases the body", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GOOGLE_API_KEY", credentialEnv.GOOGLE_API_KEY);
    vi.stubEnv("GOOGLE_CSE_ID", credentialEnv.GOOGLE_CSE_ID);
    const stalled = makeStalledBodyFetch({ honorSignal: false });
    vi.stubGlobal("fetch", stalled.fetchFn);

    const pending = executeThroughTool({ query: "pi coding agent" }).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await pending;

    expect(err).toBeInstanceOf(SearchError);
    expect(err.message).toMatch(/Search timed out after 15000ms/);
    expect(stalled.cancels()).toBe(1);
  });

  it("propagates caller cancellation as a cancellation, not a timeout", async () => {
    vi.stubEnv("GOOGLE_API_KEY", credentialEnv.GOOGLE_API_KEY);
    vi.stubEnv("GOOGLE_CSE_ID", credentialEnv.GOOGLE_CSE_ID);
    const stalled = makeStalledBodyFetch({ honorSignal: false });
    vi.stubGlobal("fetch", stalled.fetchFn);
    const controller = new AbortController();

    const pending = executeThroughTool({ query: "pi coding agent" }, controller.signal).catch(
      (err: Error) => err,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const err = await pending;

    expect(err).toBeInstanceOf(SearchError);
    expect(err.message).toMatch(/cancel/i);
    expect(err.message).not.toMatch(/timed out/);
    expect(stalled.cancels()).toBe(1);
  });

  it("returns results normally when the response arrives in time", async () => {
    vi.stubEnv("GOOGLE_API_KEY", credentialEnv.GOOGLE_API_KEY);
    vi.stubEnv("GOOGLE_CSE_ID", credentialEnv.GOOGLE_CSE_ID);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({
          items: [{ title: "Result One", link: "https://example.com/1", snippet: "Snippet 1" }],
        }),
      ),
    );

    const result = (await executeThroughTool({ query: "pi coding agent" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toContain("Found 1 result");
  });
});