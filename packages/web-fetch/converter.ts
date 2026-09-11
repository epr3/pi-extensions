// ─── HTML → Markdown conversion (Turndown + jsdom) ────────────────────────
//
// Whole-page conversion over the capped source. Transport streams the
// download to disk; conversion holds the source and its Markdown in memory —
// the response cap (512 KiB) is the documented bound and fails before
// conversion. Scripts/styles and other non-document elements are removed;
// relative links resolve against the retrieved document URL.

import { readFile, writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import {
  tables as gfmTables,
  strikethrough as gfmStrikethrough,
  taskListItems as gfmTaskListItems,
} from "turndown-plugin-gfm";

// ─── Public types ───────────────────────────────────────────────────────────

export interface ConverterOptions {
  /** Source URL; resolves relative links in the artifact. */
  url: string;
  /** Abort signal; aborting leaves the artifact unwritten. */
  signal?: AbortSignal;
}

export interface ConverterResult {
  title: string;
  source: "html";
  contentType: "text/html";
  /** Character count of textual content extracted from the page. */
  textChars: number;
  /** Character count of the Markdown output. */
  outputChars: number;
  /** True when the page had very little textual content. */
  extractionWarning?: string;
}

// Non-document content removed before conversion.
const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "embed",
  "object",
  "iframe",
  "frame",
  "frameset",
].join(",");

// ─── DOM preprocessing ──────────────────────────────────────────────────────

/**
 * GFM needs a header row; move the first row into a <thead> with <th> cells
 * when the table has none, so it converts as a table.
 */
function promoteFirstRowHeader(doc: Document): void {
  for (const table of doc.querySelectorAll("table")) {
    if (table.querySelector("thead")) continue;
    const firstRow = table.querySelector("tr");
    if (!firstRow || firstRow.children.length === 0) continue;
    const thead = doc.createElement("thead");
    const headerRow = doc.createElement("tr");
    for (const cell of Array.from(firstRow.children)) {
      const th = doc.createElement("th");
      th.innerHTML = cell.innerHTML;
      headerRow.append(th);
    }
    thead.append(headerRow);
    firstRow.remove();
    table.prepend(thead);
  }
}

/** Resolve relative link/image URLs against the document base. */
function absolutizeLinks(doc: Document, base: string): void {
  for (const el of doc.querySelectorAll("[href], [src]")) {
    for (const attr of ["href", "src"] as const) {
      const value = el.getAttribute(attr);
      if (!value?.trim()) continue;
      try {
        el.setAttribute(attr, new URL(value, base).toString());
      } catch {
        // Unresolvable value stays as-is.
      }
    }
  }
}

// ─── Code fence fidelity ───────────────────────────────────────────────────

/** Longest run of backticks in a code string. */
function maxBacktickRun(text: string): number {
  let max = 0;
  let run = 0;
  for (const c of text) {
    run = c === "`" ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
}

/** Safely derivable code language: `language-*` / `lang-*` class prefix. */
function codeLanguage(node: Element | null): string {
  const cls = node?.getAttribute("class") ?? "";
  const match = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls);
  return match?.[1] ?? "";
}

// ─── Turndown setup ────────────────────────────────────────────────────────

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use([gfmTables, gfmStrikethrough, gfmTaskListItems]);

  // Fenced code with language info and a fence longer than any inner run.
  service.addRule("fencedCodeBlock", {
    filter: (node) => node.nodeName === "PRE" && node.firstElementChild?.nodeName === "CODE",
    replacement: (_content: string, node: Node) => {
      const pre = node as Element;
      const code = pre.firstElementChild;
      const text = code?.textContent ?? "";
      const language = codeLanguage(code);
      const fence = "`".repeat(Math.max(3, maxBacktickRun(text) + 1));
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });

  // Table cells: literal pipes stay single-cell; cell newlines become spaces.
  service.addRule("tableCell", {
    filter: ["td", "th"],
    replacement: (content: string, node: Node) => {
      const children = node.parentNode?.childNodes ?? [];
      const index = Array.from(children).indexOf(node as ChildNode);
      const prefix = index === 0 ? "| " : " ";
      const escaped = content.replace(/\n+/g, " ").replace(/(?<!\\)\|/g, "\\|");
      return `${prefix}${escaped} |`;
    },
  });

  return service;
}

// ─── Conversion ────────────────────────────────────────────────────────

/** Warning when the page yielded very little textual content. */
function extractionWarningFor(textChars: number): string | undefined {
  return textChars < 50
    ? `Very little content extracted (${textChars} chars) — the page may be dynamic or rely on JavaScript`
    : undefined;
}

/** Convert an HTML string to whole-page Markdown. */
export function convertHtmlToMarkdown(
  html: string,
  baseUrl: string,
): {
  markdown: string;
  title: string;
  textChars: number;
} {
  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;
  const title = (doc.title || "").trim();
  const body = doc.body;
  if (!body) {
    return { markdown: "", title, textChars: 0 };
  }

  doc.querySelectorAll(STRIP_SELECTORS).forEach((el) => el.remove());
  absolutizeLinks(doc, baseUrl);
  promoteFirstRowHeader(doc);

  const markdown = createTurndown().turndown(body);
  return {
    markdown,
    title,
    textChars: body.textContent?.length ?? 0,
  };
}

/** Convert an HTML source file to a Markdown artifact file. */
export async function convertHtmlFileToMarkdown(
  sourcePath: string,
  artifactPath: string,
  options: ConverterOptions,
): Promise<ConverterResult> {
  if (options.signal?.aborted) {
    throw new DOMException("Conversion aborted", "AbortError");
  }
  const html = await readFile(sourcePath, "utf8");
  const { markdown, title, textChars } = convertHtmlToMarkdown(html, options.url);
  if (options.signal?.aborted) {
    throw new DOMException("Conversion aborted", "AbortError");
  }
  await writeFile(artifactPath, markdown);

  return {
    title,
    source: "html",
    contentType: "text/html",
    textChars,
    outputChars: markdown.length,
    extractionWarning: extractionWarningFor(textChars),
  };
}

/** Convert an HTML string to Markdown. For tests only. */
export async function convertHtmlToMarkdownAsync(
  html: string,
  url = "https://example.com",
): Promise<{ markdown: string; title: string; extractionWarning?: string }> {
  const { markdown, title, textChars } = convertHtmlToMarkdown(html, url);
  return {
    markdown,
    title,
    extractionWarning: extractionWarningFor(textChars),
  };
}