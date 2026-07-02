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

import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webSearchExtension from "../index.ts";
import {
	composeQuery,
	normalizeTerm,
	normalizeSite,
	resolveCredentials,
	shapeApiError,
	formatSearchResults,
	searchGoogle,
	cleanInput,
	CredentialsError,
} from "../search.ts";
import type { SearchResponseDetails, SearchResult } from "../search.ts";

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
		const props = (tool.parameters as {
			properties: { count: { minimum: number; maximum: number; default: number } };
		}).properties;
		expect(props.count.minimum).toBe(1);
		expect(props.count.maximum).toBe(10);
		expect(props.count.default).toBe(5);
	});

	it("exposes optional `exactPhrases`, `excludeTerms`, and `site`", () => {
		const tool = registerWebSearch();
		const props = (tool.parameters as {
			properties: Record<string, unknown>;
		}).properties;
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
	it("returns API key + CSE ID read from env vars", () => {
		const creds = resolveCredentials({ GOOGLE_API_KEY: "key123", GOOGLE_CSE_ID: "cse456" });
		expect(creds.apiKey).toBe("key123");
		expect(creds.cseId).toBe("cse456");
	});

	it("throws CredentialsError when both env vars are missing", () => {
		expect(() => resolveCredentials({})).toThrow(CredentialsError);
	});

	it("throws when only GOOGLE_API_KEY is set", () => {
		expect(() => resolveCredentials({ GOOGLE_API_KEY: "key" })).toThrow(CredentialsError);
	});

	it("throws when only GOOGLE_CSE_ID is set", () => {
		expect(() => resolveCredentials({ GOOGLE_CSE_ID: "cse" })).toThrow(CredentialsError);
	});

	it("CredentialsError names both env vars, the auth file path, and the docs URL", () => {
		try {
			resolveCredentials({});
		} catch (e) {
			expect(e).toBeInstanceOf(CredentialsError);
			const msg = (e as CredentialsError).message;
			expect(msg).toContain("GOOGLE_API_KEY");
			expect(msg).toContain("GOOGLE_CSE_ID");
			expect(msg).toContain("web-search.json");
			expect(msg).toContain("developers.google.com");
		}
	});
});

// ─── Error shaping ──────────────────────────────────────────────────────────

describe("shapeApiError", () => {
	it("extracts the message and status from a JSON error body", () => {
		const msg = shapeApiError(403, JSON.stringify({ error: { code: 403, message: "Daily limit exceeded" } }));
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

		const { results, totalResults } = await searchGoogle("test", "key", "cse", 2, mockFetch);
		expect(results).toHaveLength(2);
		expect(results[0]?.title).toBe("Result One");
		expect(results[1]?.url).toBe("https://example.com/2");
		expect(totalResults).toBe(100);
	});

	it("rejects with the shaped message on a JSON API error", async () => {
		const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			jsonResponse(
				{ error: { code: 403, message: "Daily limit exceeded", status: "PERMISSION_DENIED" } },
				{ ok: false, status: 403 },
			),
		);

		await expect(searchGoogle("test", "key", "cse", 2, mockFetch)).rejects.toThrow(/Daily limit exceeded/);
	});

	it("returns an empty result list when the API returns no items", async () => {
		const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			jsonResponse({ searchInformation: { totalResults: "0" } }),
		);

		const { results, totalResults } = await searchGoogle("test", "key", "cse", 5, mockFetch);
		expect(results).toHaveLength(0);
		expect(totalResults).toBe(0);
	});

	it("rejects with a status-coded message on a non-JSON error body", async () => {
		const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "Internal Server Error",
		} as Response);

		await expect(searchGoogle("test", "key", "cse", 2, mockFetch)).rejects.toThrow(
			/Google Custom Search API error \(500\)/,
		);
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
