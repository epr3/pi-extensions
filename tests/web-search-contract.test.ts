/**
 * Web Search contract and pure logic tests.
 *
 * Verifies:
 *   - Tool metadata and parameter schema
 *   - Query composition: normalization, exact phrases, exclusions, site restrictions, count bounds
 *   - Credential resolution: env vars, missing credentials
 *   - Google API error shaping
 *   - Empty and successful result formatting
 *   - Search function with mocked fetch (no live web calls)
 *
 * Run: npx tsx tests/web-search-contract.test.ts
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webSearchExtension from "../packages/web-search/index.ts";
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
} from "../packages/web-search/search.ts";
import type { SearchInputs, SearchResponseDetails, SearchResult } from "../packages/web-search/search.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return { registerTool: (tool) => captured.push(tool as ToolDefinition), on: () => {} } as unknown as ExtensionAPI;
}

function registerWebSearch(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  webSearchExtension(makeFakeApi(tools));
  assert.strictEqual(tools.length, 1, "web_search registers exactly one tool");
  return tools[0]!;
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

function testToolNameAndLabel() {
  const tool = registerWebSearch();
  assert.strictEqual(tool.name, "web_search", "tool name is web_search");
  assert.strictEqual(tool.label, "Web Search", "tool label is Web Search");
  console.log("  Tool name and label .............................. PASS");
}

function testDescriptionMentionsGoogle() {
  const tool = registerWebSearch();
  assert.ok(tool.description.includes("Google"), "description mentions Google");
  assert.ok(
    tool.description.includes("GOOGLE_API_KEY") || tool.description.includes("environment"),
    "description mentions credential sources",
  );
  console.log("  Description mentions Google + credentials ......... PASS");
}

function testPromptGuidelines() {
  const tool = registerWebSearch();
  const p = tool.promptGuidelines ?? [];
  assert.ok(p.some((g: string) => g.includes("web_fetch")), "guidelines mention web_fetch");
  assert.ok(p.some((g: string) => g.includes("exactPhrases")), "guidelines mention exactPhrases");
  console.log("  Prompt guidelines are present .................... PASS");
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

function testParameterSchemaHasQuery() {
  const tool = registerWebSearch();
  const props = (tool.parameters as any).properties;
  assert.ok(props.query, "parameters have query property");
  assert.strictEqual(props.query.type, "string", "query is a string");
  console.log("  Parameter schema has query ....................... PASS");
}

function testParameterSchemaOptionalCount() {
  const tool = registerWebSearch();
  const props = (tool.parameters as any).properties;
  assert.ok(props.count, "parameters have count property");
  assert.strictEqual(props.count.minimum, 1, "count minimum is 1");
  assert.strictEqual(props.count.maximum, 10, "count maximum is 10");
  assert.strictEqual(props.count.default, 5, "count default is 5");
  console.log("  Parameter schema has count (1-10, default 5) ..... PASS");
}

function testParameterSchemaOptionalArrays() {
  const tool = registerWebSearch();
  const props = (tool.parameters as any).properties;
  assert.ok(props.exactPhrases, "parameters have exactPhrases property");
  assert.ok(props.excludeTerms, "parameters have excludeTerms property");
  assert.ok(props.site, "parameters have site property");
  console.log("  Parameter schema has optional arrays + site ...... PASS");
}

// ---------------------------------------------------------------------------
// normalizeTerm
// ---------------------------------------------------------------------------

function testNormalizeTermTrimWhitespace() {
  assert.strictEqual(normalizeTerm("  hello  "), "hello");
  console.log("  normalizeTerm trims whitespace ................... PASS");
}

function testNormalizeTermCollapseSpaces() {
  assert.strictEqual(normalizeTerm("hello   world"), "hello world");
  console.log("  normalizeTerm collapses internal spaces .......... PASS");
}

// ---------------------------------------------------------------------------
// normalizeSite
// ---------------------------------------------------------------------------

function testNormalizeSiteStripsProtocol() {
  assert.strictEqual(normalizeSite("https://example.com"), "example.com");
  console.log("  normalizeSite strips https:// .................... PASS");
}

function testNormalizeSiteStripsTrailingSlash() {
  assert.strictEqual(normalizeSite("example.com/"), "example.com");
  assert.strictEqual(normalizeSite("example.com///"), "example.com");
  console.log("  normalizeSite strips trailing slashes ............. PASS");
}

function testNormalizeSiteStripsWww() {
  assert.strictEqual(normalizeSite("www.example.com"), "example.com");
  assert.strictEqual(normalizeSite("https://www.example.com/"), "example.com");
  console.log("  normalizeSite strips www. ........................ PASS");
}

function testNormalizeSiteLowercases() {
  assert.strictEqual(normalizeSite("Example.Com"), "example.com");
  console.log("  normalizeSite lowercases ......................... PASS");
}

// ---------------------------------------------------------------------------
// cleanInput
// ---------------------------------------------------------------------------

function testCleanInput() {
  assert.strictEqual(cleanInput("  hello  world  "), "hello world");
  assert.strictEqual(cleanInput("plain"), "plain");
  assert.strictEqual(cleanInput(""), "");
  console.log("  cleanInput trims and collapses ................... PASS");
}

// ---------------------------------------------------------------------------
// composeQuery
// ---------------------------------------------------------------------------

function testComposeQuerySimple() {
  const d = composeQuery({ query: "hello world" });
  assert.strictEqual(d.normalizedQuery, "hello world");
  assert.strictEqual(d.composedQuery, "hello world");
  assert.strictEqual(d.resultCount, 5);
  assert.strictEqual(d.siteRestriction, null);
  assert.deepStrictEqual(d.exactPhrases, []);
  assert.deepStrictEqual(d.excludeTerms, []);
  console.log("  composeQuery simple query ........................ PASS");
}

function testComposeQueryExactPhrases() {
  const d = composeQuery({ query: "hello", exactPhrases: ["exact phrase", "another"] });
  assert.ok(d.composedQuery.includes('"exact phrase"'), "exact phrase is quoted");
  assert.ok(d.composedQuery.includes('"another"'), "second phrase is quoted");
  assert.ok(d.composedQuery.startsWith("hello"), "base query is first");
  console.log("  composeQuery quotes exact phrases ................ PASS");
}

function testComposeQueryExcludeTerms() {
  const d = composeQuery({ query: "hello", excludeTerms: ["bad", "ugly"] });
  assert.ok(d.composedQuery.includes("-bad"), "excluded term has minus prefix");
  assert.ok(d.composedQuery.includes("-ugly"), "second excluded term has minus prefix");
  console.log("  composeQuery excludes terms with - ................ PASS");
}

function testComposeQuerySiteRestriction() {
  const d = composeQuery({ query: "hello", site: "https://www.example.com/" });
  assert.ok(d.composedQuery.includes("site:example.com"), "site restriction normalized");
  assert.strictEqual(d.siteRestriction, "example.com");
  console.log("  composeQuery normalizes site restriction ......... PASS");
}

function testComposeQueryCountBounds() {
  const d1 = composeQuery({ query: "hello", count: 0 });
  assert.strictEqual(d1.resultCount, 1, "count clamped to minimum 1");

  const d2 = composeQuery({ query: "hello", count: 100 });
  assert.strictEqual(d2.resultCount, 10, "count clamped to maximum 10");

  const d3 = composeQuery({ query: "hello", count: 7 });
  assert.strictEqual(d3.resultCount, 7, "count 7 stays as-is");

  console.log("  composeQuery clamps count to 1-10 ............... PASS");
}

function testComposeQueryAllTogether() {
  const d = composeQuery({
    query: "  typescript  patterns  ",
    exactPhrases: ["design patterns"],
    excludeTerms: ["java"],
    site: "github.com",
    count: 3,
  });

  assert.strictEqual(d.normalizedQuery, "typescript patterns");
  assert.strictEqual(d.resultCount, 3);
  assert.strictEqual(d.siteRestriction, "github.com");
  assert.deepStrictEqual(d.exactPhrases, ["design patterns"]);
  assert.deepStrictEqual(d.excludeTerms, ["java"]);
  assert.ok(d.composedQuery.startsWith("typescript patterns"));
  assert.ok(d.composedQuery.includes('"design patterns"'));
  assert.ok(d.composedQuery.includes("-java"));
  assert.ok(d.composedQuery.includes("site:github.com"));
  console.log("  composeQuery all features together ............... PASS");
}

function testComposeQueryDefaultCount() {
  const d = composeQuery({ query: "test" });
  assert.strictEqual(d.resultCount, 5, "default count is 5");
  console.log("  composeQuery default count is 5 ................. PASS");
}

// ---------------------------------------------------------------------------
// resolveCredentials
// ---------------------------------------------------------------------------

function testResolveCredentialsFromEnv() {
  const creds = resolveCredentials({ GOOGLE_API_KEY: "key123", GOOGLE_CSE_ID: "cse456" });
  assert.strictEqual(creds.apiKey, "key123");
  assert.strictEqual(creds.cseId, "cse456");
  console.log("  resolveCredentials from env vars ................. PASS");
}

function testResolveCredentialsMissing() {
  assert.throws(() => resolveCredentials({}), CredentialsError, "empty env throws");
  assert.throws(
    () => resolveCredentials({ GOOGLE_API_KEY: "key" }),
    CredentialsError,
    "only API key throws",
  );
  assert.throws(
    () => resolveCredentials({ GOOGLE_CSE_ID: "cse" }),
    CredentialsError,
    "only CSE ID throws",
  );
  console.log("  resolveCredentials missing throws ................ PASS");
}

function testCredentialsErrorMessage() {
  try {
    resolveCredentials({});
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CredentialsError);
    const msg = (e as CredentialsError).message;
    assert.ok(msg.includes("GOOGLE_API_KEY"), "message mentions GOOGLE_API_KEY");
    assert.ok(msg.includes("GOOGLE_CSE_ID"), "message mentions GOOGLE_CSE_ID");
    assert.ok(msg.includes("web-search.json"), "message mentions auth file");
    assert.ok(msg.includes("developers.google.com"), "message links to docs");
  }
  console.log("  CredentialsError has clear message .............. PASS");
}

// ---------------------------------------------------------------------------
// shapeApiError
// ---------------------------------------------------------------------------

function testShapeApiErrorWithJsonBody() {
  const msg = shapeApiError(403, JSON.stringify({ error: { code: 403, message: "Daily limit exceeded" } }));
  assert.ok(msg.includes("Daily limit exceeded"), "includes error message");
  assert.ok(msg.includes("(403)"), "includes status code");
  console.log("  shapeApiError with JSON body ..................... PASS");
}

function testShapeApiErrorWithRawBody() {
  const msg = shapeApiError(500, "Internal Server Error");
  assert.ok(msg.includes("500"), "includes status code");
  assert.ok(msg.includes("Internal Server Error"), "includes raw body");
  console.log("  shapeApiError with raw body ...................... PASS");
}

// ---------------------------------------------------------------------------
// formatSearchResults
// ---------------------------------------------------------------------------

function testFormatSearchResultsEmpty() {
  const details = composeQuery({ query: "nothing" });
  const text = formatSearchResults([], details);
  assert.ok(text.includes("No results for:"), "empty results message");
  assert.ok(text.includes(details.composedQuery), "includes query string");
  console.log("  formatSearchResults empty ........................ PASS");
}

function testFormatSearchResultsSuccess() {
  const results: SearchResult[] = [
    { title: "Result One", url: "https://example.com/1", snippet: "First snippet" },
    { title: "Result Two", url: "https://example.com/2", snippet: "Second snippet" },
  ];
  const details = composeQuery({ query: "test", count: 2 });
  const text = formatSearchResults(results, details);

  assert.ok(text.includes("Found 2 results for:"), "header with count");
  assert.ok(text.includes(details.composedQuery), "includes query");
  assert.ok(text.includes("1. Result One"), "numbered first result");
  assert.ok(text.includes("2. Result Two"), "numbered second result");
  assert.ok(text.includes("https://example.com/1"), "includes first URL");
  assert.ok(text.includes("https://example.com/2"), "includes second URL");
  assert.ok(text.includes("First snippet"), "includes first snippet");
  assert.ok(text.includes("Second snippet"), "includes second snippet");

  console.log("  formatSearchResults success ...................... PASS");
}

function testFormatSearchResultsSingle() {
  const results: SearchResult[] = [
    { title: "Only Result", url: "https://example.com/only", snippet: "Only snippet" },
  ];
  const details = composeQuery({ query: "test", count: 1 });
  const text = formatSearchResults(results, details);

  assert.ok(text.includes("Found 1 result for:"), "singular 'result'");
  assert.ok(text.includes("1. Only Result"), "numbered result");
  console.log("  formatSearchResults singular 'result' ............ PASS");
}

// ---------------------------------------------------------------------------
// searchGoogle (mocked)
// ---------------------------------------------------------------------------

async function testSearchGoogleSuccess() {
  const mockFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          items: [
            { title: "Result One", link: "https://example.com/1", snippet: "Snippet 1" },
            { title: "Result Two", link: "https://example.com/2", snippet: "Snippet 2" },
          ],
          searchInformation: { totalResults: "100" },
        }),
    } as Response;
  };

  const { results, totalResults } = await searchGoogle("test", "key", "cse", 2, mockFetch);
  assert.strictEqual(results.length, 2, "two results returned");
  assert.strictEqual(results[0].title, "Result One");
  assert.strictEqual(results[1].url, "https://example.com/2");
  assert.strictEqual(totalResults, 100);
  console.log("  searchGoogle (mocked) success .................... PASS");
}

async function testSearchGoogleApiError() {
  const mockFetch = async (): Promise<Response> => {
    return {
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: { code: 403, message: "Daily limit exceeded", status: "PERMISSION_DENIED" } }),
    } as Response;
  };

  await assert.rejects(
    () => searchGoogle("test", "key", "cse", 2, mockFetch),
    /Daily limit exceeded/,
  );
  console.log("  searchGoogle (mocked) API error .................. PASS");
}

async function testSearchGoogleEmptyResults() {
  const mockFetch = async (): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ searchInformation: { totalResults: "0" } }),
    } as Response;
  };

  const { results, totalResults } = await searchGoogle("test", "key", "cse", 5, mockFetch);
  assert.strictEqual(results.length, 0, "zero results");
  assert.strictEqual(totalResults, 0, "total results is 0");
  console.log("  searchGoogle (mocked) empty results ............. PASS");
}

async function testSearchGoogleNonJsonBody() {
  const mockFetch = async (): Promise<Response> => {
    return {
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response;
  };

  await assert.rejects(
    () => searchGoogle("test", "key", "cse", 2, mockFetch),
    /Google Custom Search API error \(500\)/,
  );
  console.log("  searchGoogle (mocked) non-JSON error ............ PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nWeb Search contract tests\n");

  // Tool metadata
  testToolNameAndLabel();
  testDescriptionMentionsGoogle();
  testPromptGuidelines();

  // Parameter schema
  testParameterSchemaHasQuery();
  testParameterSchemaOptionalCount();
  testParameterSchemaOptionalArrays();

  // Pure functions: normalization
  testNormalizeTermTrimWhitespace();
  testNormalizeTermCollapseSpaces();
  testNormalizeSiteStripsProtocol();
  testNormalizeSiteStripsTrailingSlash();
  testNormalizeSiteStripsWww();
  testNormalizeSiteLowercases();
  testCleanInput();

  // Pure functions: query composition
  testComposeQuerySimple();
  testComposeQueryExactPhrases();
  testComposeQueryExcludeTerms();
  testComposeQuerySiteRestriction();
  testComposeQueryCountBounds();
  testComposeQueryAllTogether();
  testComposeQueryDefaultCount();

  // Credential resolution
  testResolveCredentialsFromEnv();
  testResolveCredentialsMissing();
  testCredentialsErrorMessage();

  // Error shaping
  testShapeApiErrorWithJsonBody();
  testShapeApiErrorWithRawBody();

  // Result formatting
  testFormatSearchResultsEmpty();
  testFormatSearchResultsSuccess();
  testFormatSearchResultsSingle();

  // searchGoogle with mocked fetch
  await testSearchGoogleSuccess();
  await testSearchGoogleApiError();
  await testSearchGoogleEmptyResults();
  await testSearchGoogleNonJsonBody();

  console.log("\nAll tests PASS\n");
}

main();
