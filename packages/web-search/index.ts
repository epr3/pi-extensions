import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  composeQuery,
  resolveCredentials,
  searchGoogle,
  formatSearchResults,
  cleanInput,
} from "./search.ts";
import type { SearchResponseDetails, SearchResult } from "./search.ts";
import { renderWebSearchCall, renderWebSearchResult } from "./render.ts";

// ─── Dual-result helper ──────────────────────────────────────────────────────

function textResult(
  text: string,
  details: SearchResponseDetails & { results: SearchResult[]; totalResults: number },
): AgentToolResult<SearchResponseDetails> {
  return { content: [{ type: "text" as const, text }], details };
}

// ─── Parameter schema ────────────────────────────────────────────────────────

const parameters = Type.Object({
  query: Type.String({
    description: "The base search query — what you're looking for",
  }),
  exactPhrases: Type.Optional(
    Type.Array(Type.String(), {
      description: "Exact phrases that must appear in the results (will be quoted)",
    }),
  ),
  excludeTerms: Type.Optional(
    Type.Array(Type.String(), {
      description: "Terms to exclude from the search results",
    }),
  ),
  site: Type.Optional(
    Type.String({
      description: "Restrict search to a specific site or domain (e.g., 'example.com')",
    }),
  ),
  count: Type.Optional(
    Type.Integer({
      description: "Number of results to return (1-10, default 5)",
      minimum: 1,
      maximum: 10,
      default: 5,
    }),
  ),
});

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Google Custom Search. Accepts a base query, exact phrase inclusions, " +
      "excluded terms, optional site restriction, and optional result count. " +
      "Returns numbered results with title, URL, and snippet. " +
      "Credentials come from GOOGLE_API_KEY and GOOGLE_CSE_ID environment variables, " +
      "or ~/.pi/agent/auth/web-search.json. " +
      "Missing credentials produce a clear setup message.",
    promptSnippet: "Search the web for current, authoritative information",
    promptGuidelines: [
      "Use web_search to discover external sources on a specific topic, not the model's training data.",
      "Combine with web_fetch to retrieve full page content from promising results.",
      "Use exactPhrases and site restriction to narrow results when you know what you're looking for.",
    ],
    parameters,
    renderCall: renderWebSearchCall,
    renderResult: renderWebSearchResult,
    async execute(_toolCallId, params) {
      // Clean and validate inputs
      const query = cleanInput(params.query as string);
      const exactPhrases = ((params.exactPhrases as string[] | undefined) ?? [])
        .map(cleanInput)
        .filter(Boolean);
      const excludeTerms = ((params.excludeTerms as string[] | undefined) ?? [])
        .map(cleanInput)
        .filter(Boolean);
      const site = params.site ? cleanInput(params.site as string) : undefined;
      const count = Math.max(1, Math.min(10, (params.count as number | undefined) ?? 5));

      // Compose query string
      const details = composeQuery({ query, exactPhrases, excludeTerms, site, count });

      // Resolve credentials (may throw CredentialsError)
      const credentials = resolveCredentials();

      // Execute search
      const { results, totalResults } = await searchGoogle(
        details.composedQuery,
        credentials.apiKey,
        credentials.cseId,
        count,
      );

      // Format results and return dual result
      const text = formatSearchResults(results, details);
      return textResult(text, { ...details, results, totalResults });
    },
  });
}