// ─── Streaming, incremental HTML → Markdown converter ───────────────────────
//
// Reads HTML in chunks and writes Markdown in chunks.  No full source or full
// output is kept in memory.  Exceeding a documented limit is an error.
//
// Scope (ticket 0004): whole-page order, drop scripts/styles, keep nav/refs,
// headings, paragraphs, emphasis, lists, links, code.  Tables/nested lists
// keep their text; rich formatting is ticket 0005.

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

// ─── Public types ───────────────────────────────────────────────────────────

export interface StreamingConverterOptions {
  /** Source URL, used to resolve relative links in the artifact. */
  url: string;
  /** Maximum bytes to buffer for an incomplete token/entity (default 64 KiB). */
  maxTokenBufferBytes?: number;
  /** Maximum element nesting depth (default 256). */
  maxStackDepth?: number;
  /** Maximum length of a single attribute value (default 8 KiB). */
  maxAttributeLength?: number;
  /** Flush output after it grows past this many bytes (default 16 KiB). */
  outputFlushBytes?: number;
  /** Abort signal; aborting stops parsing and leaves the output incomplete. */
  signal?: AbortSignal;
}

export interface StreamingConverterResult {
  title: string;
  source: "html";
  contentType: "text/html";
  /** Character count of textual content written to the artifact. */
  textChars: number;
  /** Character count of the full Markdown output written. */
  outputChars: number;
  /** True when the page had very little textual content. */
  extractionWarning?: string;
}

/** Error thrown when the converter hits a documented bounded-state limit. */
export class StreamingConverterError extends Error {
  constructor(message: string) {
    super(`web_fetch: ${message}`);
    this.name = "StreamingConverterError";
  }
}

/** Async destination for converted Markdown. */
export interface MarkdownWriter {
  write(text: string): Promise<void>;
}

// ─── Default limits ─────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKEN_BUFFER_BYTES = 64 * 1024;
const DEFAULT_MAX_STACK_DEPTH = 256;
const DEFAULT_MAX_ATTRIBUTE_LENGTH = 8 * 1024;
const DEFAULT_OUTPUT_FLUSH_BYTES = 16 * 1024;

// ─── Element categories ─────────────────────────────────────────────────────

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const SKIPPED_ROOTS = new Set([
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
]);

const HEAD_CHILDREN = new Set([
  "base",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "details",
  "div",
  "dl",
  "dt",
  "dd",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "main",
  "nav",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function collapseWhitespace(
  text: string,
  prevSpace: boolean,
): { text: string; endsWithSpace: boolean } {
  let out = "";
  let endsWithSpace = prevSpace;
  for (const c of text) {
    if (isWhitespace(c)) {
      if (!endsWithSpace) {
        out += " ";
        endsWithSpace = true;
      }
    } else {
      out += c;
      endsWithSpace = false;
    }
  }
  return { text: out, endsWithSpace };
}

/** Decode common named and numeric HTML entities. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#96;/g, "`")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

/** Resolve a possibly-relative URL against the document URL. */
function resolveUrl(href: string, base: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

// ─── Incremental UTF-8 decoder ──────────────────────────────────────────────

/**
 * Decodes UTF-8 chunks incrementally, preserving incomplete multi-byte
 * sequences across chunk boundaries.
 */
class IncrementalUtf8Decoder {
  private leftover = new Uint8Array(0);

  decode(chunk: Uint8Array, flush = false): string {
    const combined = new Uint8Array(this.leftover.length + chunk.length);
    combined.set(this.leftover);
    combined.set(chunk, this.leftover.length);

    // Determine how many trailing bytes form an incomplete UTF-8 sequence.
    let keep = 0;
    if (!flush) {
      for (let i = combined.length - 1; i >= 0; i--) {
        const b = combined[i];
        if (b < 0x80) break; // ASCII, sequence is complete
        keep++;
        if ((b & 0xc0) === 0xc0) {
          // Start byte.  How many continuation bytes should follow?
          const expected = b < 0xe0 ? 1 : b < 0xf0 ? 2 : b < 0xf8 ? 3 : 0;
          if (keep < expected) {
            // Incomplete; keep the trailing bytes for the next chunk.
            break;
          }
          // Complete sequence; stop scanning.
          keep = 0;
          break;
        }
        if (keep > 4) {
          // Defensive: malformed sequence, flush it.
          keep = 0;
          break;
        }
      }
    }

    const usable = keep === 0 ? combined : combined.subarray(0, combined.length - keep);
    this.leftover = keep === 0 ? new Uint8Array(0) : combined.subarray(combined.length - keep);
    return new TextDecoder("utf-8", { fatal: false }).decode(usable);
  }
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

interface StartTag {
  type: "start";
  name: string;
  attrs: Map<string, string>;
  selfClosing: boolean;
}

interface EndTag {
  type: "end";
  name: string;
}

type Token = { type: "text"; text: string } | StartTag | EndTag;

/**
 * Simplified incremental HTML tokenizer.  Handles tags, attributes, comments,
 * doctype, and raw text elements (script/style).  Incomplete tokens are
 * buffered until the next chunk completes them.
 */
class IncrementalHtmlTokenizer {
  private buffer = "";
  private state:
    | "data"
    | "entity"
    | "tagOpen"
    | "tagName"
    | "beforeAttrName"
    | "attrName"
    | "afterAttrName"
    | "beforeAttrValue"
    | "attrValueDoubleQuoted"
    | "attrValueSingleQuoted"
    | "attrValueUnquoted"
    | "selfClosingStartTag"
    | "markupDeclarationOpen"
    | "commentStart"
    | "comment"
    | "commentEndDash"
    | "commentEnd"
    | "bogusComment"
    | "rawText"
    | "rawTextLt"
    | "rawTextEndTagSlash"
    | "rawTextEndTagNameAfter" = "data";

  private tagName = "";
  private isEndTag = false;
  private attrName = "";
  private attrValue = "";
  private attrs = new Map<string, string>();
  private selfClosing = false;
  private rawElement = "";
  private rawEndTagName = "";
  private entityBuffer = "";

  private pending: Token[] = [];
  private maxBuffer: number;
  private maxAttr: number;

  constructor(options: { maxTokenBufferBytes: number; maxAttributeLength: number }) {
    this.maxBuffer = options.maxTokenBufferBytes;
    this.maxAttr = options.maxAttributeLength;
  }

  feed(text: string): Token[] {
    this.buffer += text;
    if (this.buffer.length > this.maxBuffer) {
      throw new StreamingConverterError(
        `HTML token buffer exceeded ${this.maxBuffer} bytes; the document contains an ` +
          "unreasonably long tag, comment, or unclosed structure.",
      );
    }

    while (this.buffer.length > 0) {
      const prevState = this.state;
      const consumed = this.step();
      if (consumed === 0 && this.state === prevState) break;
      this.buffer = this.buffer.slice(consumed);
    }

    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Flush any trailing text as a final token. */
  flush(): Token[] {
    if (this.state === "data" && this.buffer.length > 0) {
      this.pending.push({ type: "text", text: this.buffer });
      this.buffer = "";
    } else if (this.state === "entity") {
      this.emitText(`&${this.entityBuffer}`);
      this.entityBuffer = "";
      this.state = "data";
    } else if (this.state === "rawText" || this.state === "rawTextLt") {
      // Trailing raw text without an end tag: emit as text (scripts/styles are
      // already skipped because rawText never emits text).
      this.state = "data";
    } else if (this.state === "rawTextEndTagSlash" || this.state === "rawTextEndTagNameAfter") {
      this.state = "data";
    }
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private emitText(text: string): void {
    if (text.length > 0) this.pending.push({ type: "text", text });
  }

  private emitStartTag(): void {
    this.pending.push({
      type: "start",
      name: this.tagName,
      attrs: this.attrs,
      selfClosing: this.selfClosing,
    });
    this.resetTag();
  }

  private emitEndTag(): void {
    this.pending.push({ type: "end", name: this.tagName });
    this.resetTag();
  }

  private resetTag(): void {
    this.tagName = "";
    this.isEndTag = false;
    this.attrName = "";
    this.attrValue = "";
    this.attrs = new Map();
    this.selfClosing = false;
  }

  private step(): number {
    const s = this.buffer;
    switch (this.state) {
      case "data":
        return this.stepData(s);
      case "entity":
        return this.stepEntity(s);
      case "tagOpen":
        return this.stepTagOpen(s);
      case "tagName":
        return this.stepTagName(s);
      case "beforeAttrName":
        return this.stepBeforeAttrName(s);
      case "attrName":
        return this.stepAttrName(s);
      case "afterAttrName":
        return this.stepAfterAttrName(s);
      case "beforeAttrValue":
        return this.stepBeforeAttrValue(s);
      case "attrValueDoubleQuoted":
        return this.stepAttrValueDoubleQuoted(s);
      case "attrValueSingleQuoted":
        return this.stepAttrValueSingleQuoted(s);
      case "attrValueUnquoted":
        return this.stepAttrValueUnquoted(s);
      case "selfClosingStartTag":
        return this.stepSelfClosingStartTag(s);
      case "markupDeclarationOpen":
        return this.stepMarkupDeclarationOpen(s);
      case "commentStart":
      case "comment":
      case "commentEndDash":
      case "commentEnd":
        return this.stepComment(s);
      case "bogusComment":
        return this.stepBogusComment(s);
      case "rawText":
        return this.stepRawText(s);
      case "rawTextLt":
        return this.stepRawTextLt(s);
      case "rawTextEndTagSlash":
        return this.stepRawTextEndTagSlash(s);
      case "rawTextEndTagNameAfter":
        return this.stepRawTextEndTagNameAfter(s);
      default:
        return 0;
    }
  }

  private stepData(s: string): number {
    // Emit text up to the next '<' or '&'.  '&' starts an entity reference that
    // may span chunks, so it gets its own state.
    let i = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "<" || c === "&") break;
    }
    if (i > 0) {
      this.emitText(s.slice(0, i));
    }
    if (i >= s.length) {
      return s.length;
    }
    if (s[i] === "<") {
      this.state = "tagOpen";
      return i + 1;
    }
    // s[i] === '&'
    this.entityBuffer = "";
    this.state = "entity";
    return i + 1;
  }

  private stepEntity(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      // Entity reference ends at ';' or when it can no longer be an entity.
      if (c === ";") {
        const entity = this.entityBuffer;
        this.emitText(decodeHtmlEntities(`&${entity};`));
        this.entityBuffer = "";
        this.state = "data";
        return i + 1;
      }
      if (c === "<" || isWhitespace(c)) {
        // Not an entity reference: emit the literal '&' and buffered chars.
        this.emitText(`&${this.entityBuffer}`);
        this.entityBuffer = "";
        this.state = "data";
        return i;
      }
      // Valid entity characters: alphanumerics, '#', 'x'.
      if (!/[a-zA-Z0-9#]/.test(c)) {
        this.emitText(`&${this.entityBuffer}${c}`);
        this.entityBuffer = "";
        this.state = "data";
        return i + 1;
      }
      this.entityBuffer += c;
      if (this.entityBuffer.length > 32) {
        // Entity name too long to be valid; treat as literal text.
        this.emitText(`&${this.entityBuffer}`);
        this.entityBuffer = "";
        this.state = "data";
        return i + 1;
      }
    }
    return s.length;
  }

  private stepTagOpen(s: string): number {
    if (s.length === 0) return 0;
    const c = s[0];
    if (c === "!") {
      this.state = "markupDeclarationOpen";
      return 1;
    }
    if (c === "/") {
      this.isEndTag = true;
      this.state = "tagName";
      this.tagName = "";
      return 1;
    }
    if (/[a-zA-Z]/.test(c)) {
      this.isEndTag = false;
      this.state = "tagName";
      this.tagName = c.toLowerCase();
      return 1;
    }
    if (c === "?") {
      this.state = "bogusComment";
      return 1;
    }
    // Not a tag; emit the literal '<' and go back to data.
    this.emitText("<");
    this.state = "data";
    return 0; // re-examine current char in data state
  }

  private stepTagName(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (isWhitespace(c)) {
        // Move to attribute parsing; the tag will be emitted once '>' is seen.
        this.state = "beforeAttrName";
        return i + 1;
      }
      if (c === "/" && !this.isEndTag) {
        this.state = "selfClosingStartTag";
        return i + 1;
      }
      if (c === ">") {
        this.finishTag();
        return i + 1;
      }
      this.tagName += c.toLowerCase();
    }
    return s.length;
  }

  private finishTag(): void {
    if (this.isEndTag) {
      this.emitEndTag();
    } else {
      this.emitStartTag();
      const last = this.pending[this.pending.length - 1];
      if (last?.type === "start" && (last.name === "script" || last.name === "style")) {
        this.state = "rawText";
        this.rawElement = last.name;
        return;
      }
    }
    this.isEndTag = false;
    this.selfClosing = false;
    this.state = "data";
  }

  private stepBeforeAttrName(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (isWhitespace(c)) continue;
      if (c === "/") {
        this.state = "selfClosingStartTag";
        return i + 1;
      }
      if (c === ">") {
        this.finishTag();
        return i + 1;
      }
      this.attrName = "";
      this.state = "attrName";
      return i;
    }
    return s.length;
  }

  private stepAttrName(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (isWhitespace(c) || c === "/" || c === ">" || c === "=") {
        this.state = "afterAttrName";
        return i;
      }
      this.attrName += c.toLowerCase();
    }
    return s.length;
  }

  private stepAfterAttrName(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (isWhitespace(c)) continue;
      if (c === "=") {
        this.state = "beforeAttrValue";
        return i + 1;
      }
      if (c === "/") {
        this.state = "selfClosingStartTag";
        return i + 1;
      }
      if (c === ">") {
        this.attrs.set(this.attrName, "");
        this.finishTag();
        return i + 1;
      }
      this.attrs.set(this.attrName, "");
      this.attrName = "";
      this.state = "attrName";
      return i;
    }
    return s.length;
  }

  private stepBeforeAttrValue(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (isWhitespace(c)) continue;
      if (c === '"') {
        this.state = "attrValueDoubleQuoted";
        this.attrValue = "";
        return i + 1;
      }
      if (c === "'") {
        this.state = "attrValueSingleQuoted";
        this.attrValue = "";
        return i + 1;
      }
      this.state = "attrValueUnquoted";
      this.attrValue = "";
      return i;
    }
    return s.length;
  }

  private stepAttrValueDoubleQuoted(s: string): number {
    return this.stepQuotedAttrValue(s, '"');
  }
  private stepAttrValueSingleQuoted(s: string): number {
    return this.stepQuotedAttrValue(s, "'");
  }

  private stepQuotedAttrValue(s: string, quote: string): number {
    const idx = s.indexOf(quote);
    if (idx === -1) {
      this.attrValue += s;
      if (this.attrValue.length > this.maxAttr) {
        throw new StreamingConverterError(
          `Attribute value exceeded ${this.maxAttr} bytes; the document contains an ` +
            "unreasonably long attribute.",
        );
      }
      return s.length;
    }
    this.attrValue += s.slice(0, idx);
    this.attrs.set(this.attrName, decodeHtmlEntities(this.attrValue));
    this.state = "beforeAttrName";
    return idx + 1;
  }

  private stepAttrValueUnquoted(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (isWhitespace(c)) {
        this.attrs.set(this.attrName, decodeHtmlEntities(this.attrValue));
        this.state = "beforeAttrName";
        return i + 1;
      }
      if (c === ">") {
        this.attrs.set(this.attrName, decodeHtmlEntities(this.attrValue));
        this.finishTag();
        return i + 1;
      }
      this.attrValue += c;
      if (this.attrValue.length > this.maxAttr) {
        throw new StreamingConverterError(
          `Attribute value exceeded ${this.maxAttr} bytes; the document contains an ` +
            "unreasonably long attribute.",
        );
      }
    }
    return s.length;
  }

  private stepSelfClosingStartTag(s: string): number {
    if (s.length === 0) return 0;
    if (s[0] === ">") {
      this.selfClosing = true;
      this.finishTag();
      return 1;
    }
    // Treat '/' as part of an unquoted attribute value.
    this.state = "beforeAttrName";
    return 0;
  }

  private stepMarkupDeclarationOpen(s: string): number {
    if (s.startsWith("--")) {
      this.state = "commentStart";
      return 2;
    }
    if (s.toLowerCase().startsWith("doctype")) {
      // Skip the doctype.
      this.state = "bogusComment";
      return 0;
    }
    if (s.startsWith("[CDATA[")) {
      // Treat CDATA as text until "]]>".
      const end = s.indexOf("]]>");
      if (end === -1) {
        this.emitText(s);
        return s.length;
      }
      this.emitText(s.slice(0, end));
      this.state = "data";
      return end + 3;
    }
    this.state = "bogusComment";
    return 0;
  }

  private stepComment(s: string): number {
    const end = s.indexOf("-->");
    if (end !== -1) {
      this.state = "data";
      return end + 3;
    }
    return s.length;
  }

  private stepBogusComment(s: string): number {
    const end = s.indexOf(">");
    if (end !== -1) {
      this.state = "data";
      return end + 1;
    }
    return s.length;
  }

  private stepRawText(s: string): number {
    const idx = s.indexOf("<");
    if (idx === -1) {
      return s.length; // consume all, stay in rawText
    }
    if (idx > 0) {
      // Consume raw text up to the '<'.
      return idx;
    }
    // s[0] === '<'.  Check whether it starts an end tag for rawElement.
    this.state = "rawTextLt";
    return 0;
  }

  private stepRawTextLt(s: string): number {
    if (s.length < 2) return 0;
    if (s[1] === "/") {
      this.rawEndTagName = "";
      this.state = "rawTextEndTagSlash";
      return 2;
    }
    // Not an end tag: consume the '<' as raw text.
    this.state = "rawText";
    return 1;
  }

  private stepRawTextEndTagSlash(s: string): number {
    if (s.length === 0) return 0;
    const c = s[0];
    if (this.rawEndTagName.length === this.rawElement.length) {
      // Name fully matched on previous step; the current char is what follows.
      this.state = "rawTextEndTagNameAfter";
      return 0;
    }
    const expected = this.rawElement[this.rawEndTagName.length];
    if (c.toLowerCase() === expected) {
      this.rawEndTagName += c.toLowerCase();
      if (this.rawEndTagName.length === this.rawElement.length) {
        this.state = "rawTextEndTagNameAfter";
      }
      return 1;
    }
    // Mismatch: the '</' plus matched chars are raw text.
    this.emitText(`</${this.rawEndTagName}${c}`);
    this.rawEndTagName = "";
    this.state = "rawText";
    return 1;
  }

  private stepRawTextEndTagNameAfter(s: string): number {
    if (s.length === 0) return 0;
    const c = s[0];
    if (isWhitespace(c) || c === ">") {
      // It is the matching end tag.  Leave '/name...' in the buffer so the normal
      // tag parser can emit the end token, then return to data.
      this.buffer = `/${this.rawElement}${s}`;
      this.state = "tagOpen";
      this.tagName = "";
      this.isEndTag = true;
      return 0;
    }
    // Something like '</scriptfoo' — not the end tag.
    this.emitText(`</${this.rawElement}${c}`);
    this.state = "rawText";
    return 1;
  }
}

// ─── Markdown emitter ───────────────────────────────────────────────────────

interface InlineContext {
  name: string;
  prefix: string;
  suffix: string;
  href?: string;
  prefixEmitted: boolean;
}

interface ListContext {
  type: "ul" | "ol";
  index: number;
}

class MarkdownEmitter {
  private writer: MarkdownWriter;
  private baseUrl: string;
  private signal?: AbortSignal;

  private stack: { name: string; skip: boolean; inline?: InlineContext }[] = [];
  private lists: ListContext[] = [];
  private outputBuffer = "";
  private flushThreshold: number;

  private title = "";
  private inHead = false;
  private inPre = false;
  private blockOpen = false;
  private lastWasSpace = true;
  private textCharCount = 0;
  private tableCols = 0;
  private tableHeaderRow = false;
  private outputCharCount = 0;

  private maxDepth: number;

  constructor(
    writer: MarkdownWriter,
    options: {
      url: string;
      outputFlushBytes: number;
      maxStackDepth: number;
      signal?: AbortSignal;
    },
  ) {
    this.writer = writer;
    this.baseUrl = options.url;
    this.flushThreshold = options.outputFlushBytes;
    this.maxDepth = options.maxStackDepth;
  }

  async emitText(text: string): Promise<void> {
    if (this.signal?.aborted) {
      throw new DOMException("Conversion aborted", "AbortError");
    }

    const top = this.stack[this.stack.length - 1];
    if (top?.skip) return;

    if (this.inHead) {
      if (this.stack.some((c) => c.name === "title")) {
        this.title += text;
      }
      return;
    }

    if (this.inPre) {
      await this.writeRaw(decodeHtmlEntities(text));
      this.textCharCount += text.length;
      return;
    }

    const decoded = decodeHtmlEntities(text);
    const collapsed = collapseWhitespace(decoded, this.lastWasSpace);
    if (!collapsed.text) return;

    await this.ensureInlinePrefixes();
    await this.writeRaw(collapsed.text);
    this.blockOpen = false;
    this.textCharCount += collapsed.text.length;
  }

  async emitStartTag(
    name: string,
    attrs: Map<string, string>,
    _selfClosing: boolean,
  ): Promise<void> {
    if (this.signal?.aborted) {
      throw new DOMException("Conversion aborted", "AbortError");
    }

    if (this.stack.length > this.maxDepth) {
      throw new StreamingConverterError(
        `Element nesting depth exceeded ${this.maxDepth}; the document is too deeply nested.`,
      );
    }

    const parent = this.stack[this.stack.length - 1];
    if (parent?.skip) {
      this.stack.push({ name, skip: true });
      return;
    }

    if (name === "head") {
      this.inHead = true;
      this.stack.push({ name, skip: false });
      return;
    }
    if (this.inHead && !HEAD_CHILDREN.has(name)) {
      this.stack.push({ name, skip: true });
      return;
    }

    if (SKIPPED_ROOTS.has(name) || (this.inHead && name !== "title")) {
      this.stack.push({ name, skip: true });
      return;
    }

    if (VOID_ELEMENTS.has(name)) {
      await this.emitVoidElement(name, attrs);
      return;
    }

    // Block formatting.
    if (BLOCK_ELEMENTS.has(name)) {
      await this.emitBlockStart(name, attrs);
    }

    // Inline formatting.
    const inline = this.inlineContextFor(name, attrs);
    if (inline) {
      this.stack.push({ name, skip: false, inline });
    } else {
      this.stack.push({ name, skip: false });
    }

    if (name === "pre") {
      this.inPre = true;
    }
  }

  async emitEndTag(name: string): Promise<void> {
    if (this.signal?.aborted) {
      throw new DOMException("Conversion aborted", "AbortError");
    }

    // Pop matching context (and any mismatched inline contexts on top).
    while (this.stack.length > 0) {
      const top = this.stack[this.stack.length - 1];
      this.stack.pop();
      if (top.inline && top.inline.prefixEmitted) {
        await this.writeRaw(top.inline.suffix);
      }
      if (top.name === name) break;
    }

    if (name === "head") {
      this.inHead = false;
      return;
    }
    if (name === "title") return;
    if (name === "pre") {
      this.inPre = false;
    }

    if (BLOCK_ELEMENTS.has(name)) {
      await this.emitBlockEnd(name);
    }
  }

  private async emitVoidElement(name: string, attrs: Map<string, string>): Promise<void> {
    if (name === "br") {
      await this.writeRaw("\n");
      this.blockOpen = false;
      return;
    }
    if (name === "hr") {
      await this.ensureBlankLine();
      await this.writeRaw("---\n");
      this.blockOpen = true;
      return;
    }
    if (name === "img") {
      const src = resolveUrl(attrs.get("src") ?? "", this.baseUrl);
      const alt = attrs.get("alt") ?? "";
      await this.ensureInlinePrefixes();
      await this.writeRaw(`![${alt}](${src})`);
      this.blockOpen = false;
    }
  }

  private async emitBlockStart(name: string, _attrs: Map<string, string>): Promise<void> {
    if (name === "p") {
      await this.ensureBlankLine();
      this.blockOpen = true;
      return;
    }

    const level = HEADING_LEVELS[name];
    if (level) {
      await this.ensureBlankLine();
      await this.writeRaw("#".repeat(level) + " ");
      this.blockOpen = true;
      return;
    }

    if (name === "ul") {
      this.lists.push({ type: "ul", index: 0 });
      return;
    }
    if (name === "ol") {
      this.lists.push({ type: "ol", index: 1 });
      return;
    }
    if (name === "li") {
      await this.writeRaw("\n");
      const indent = "  ".repeat(Math.max(0, this.lists.length - 1));
      const list = this.lists[this.lists.length - 1];
      if (list?.type === "ol") {
        await this.writeRaw(`${indent}${list.index}. `);
        list.index++;
      } else {
        await this.writeRaw(`${indent}- `);
      }
      this.blockOpen = true;
      return;
    }

    if (name === "blockquote") {
      await this.ensureBlankLine();
      this.blockOpen = true;
      return;
    }

    if (name === "pre") {
      await this.ensureBlankLine();
      await this.writeRaw("\n```\n");
      this.blockOpen = false;
      return;
    }

    if (name === "table" || name === "tbody" || name === "thead" || name === "tfoot") {
      await this.ensureBlankLine();
      return;
    }
    if (name === "tr") {
      this.tableCols = 0;
      this.tableHeaderRow = false;
      await this.writeRaw("\n");
      return;
    }
    if (name === "td" || name === "th") {
      this.tableCols++;
      if (name === "th") this.tableHeaderRow = true;
      await this.writeRaw("| ");
      return;
    }

    // Other block containers (div, section, article, nav, header, footer, ...)
    // just ensure a little vertical separation.
    await this.writeRaw("\n");
    this.blockOpen = true;
  }

  private async emitBlockEnd(name: string): Promise<void> {
    if (name === "ul" || name === "ol") {
      this.lists.pop();
      await this.writeRaw("\n");
      this.blockOpen = true;
      return;
    }
    if (name === "li") {
      await this.writeRaw("\n");
      this.blockOpen = true;
      return;
    }
    if (name === "pre") {
      await this.writeRaw("\n```\n");
      this.blockOpen = true;
      return;
    }
    if (name === "blockquote") {
      await this.writeRaw("\n");
      this.blockOpen = true;
      return;
    }
    if (name === "td" || name === "th") {
      await this.writeRaw(" ");
      return;
    }
    if (name === "tr") {
      await this.writeRaw("|\n");
      if (this.tableHeaderRow && this.tableCols > 0) {
        await this.writeRaw("|" + " --- |".repeat(this.tableCols) + "\n");
      }
      return;
    }
    if (name === "table" || name === "tbody" || name === "thead" || name === "tfoot") {
      await this.writeRaw("\n");
      this.blockOpen = true;
      return;
    }

    await this.writeRaw("\n");
    this.blockOpen = true;
  }

  private inlineContextFor(name: string, attrs: Map<string, string>): InlineContext | undefined {
    if (name === "a") {
      return {
        name,
        prefix: "[",
        suffix: `](${resolveUrl(attrs.get("href") ?? "", this.baseUrl)})`,
        href: attrs.get("href") ?? "",
        prefixEmitted: false,
      };
    }
    if (name === "strong" || name === "b") {
      return { name, prefix: "**", suffix: "**", prefixEmitted: false };
    }
    if (name === "em" || name === "i") {
      return { name, prefix: "*", suffix: "*", prefixEmitted: false };
    }
    if (name === "code") {
      if (this.inPre) {
        return undefined;
      }
      return { name, prefix: "`", suffix: "`", prefixEmitted: false };
    }
    return undefined;
  }

  private async ensureInlinePrefixes(): Promise<void> {
    for (const ctx of this.stack) {
      if (ctx.inline && !ctx.inline.prefixEmitted) {
        await this.writeRaw(ctx.inline.prefix);
        ctx.inline.prefixEmitted = true;
      }
    }
  }

  private async ensureBlankLine(): Promise<void> {
    if (this.outputBuffer.length === 0) return;
    if (this.outputBuffer.endsWith("\n\n")) return;
    if (this.outputBuffer.endsWith("\n")) {
      await this.writeRaw("\n");
    } else {
      await this.writeRaw("\n\n");
    }
  }

  private async writeRaw(text: string): Promise<void> {
    this.outputBuffer += text;
    this.outputCharCount += text.length;
    if (text.length > 0) {
      this.lastWasSpace = isWhitespace(text[text.length - 1]);
    }
    if (this.outputBuffer.length >= this.flushThreshold) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.outputBuffer.length === 0) return;
    const chunk = this.outputBuffer;
    this.outputBuffer = "";
    await this.writer.write(chunk);
  }

  getTitle(): string {
    return decodeHtmlEntities(this.title).trim();
  }

  getTextCharCount(): number {
    return this.textCharCount;
  }

  getOutputCharCount(): number {
    return this.outputCharCount;
  }
}

// ─── Public entry points ────────────────────────────────────────────────────

/** Convert an HTML byte stream to Markdown, writing incrementally. */
export async function streamHtmlToMarkdown(
  source: AsyncIterable<Uint8Array>,
  writer: MarkdownWriter,
  options: StreamingConverterOptions,
): Promise<StreamingConverterResult> {
  const maxTokenBufferBytes = options.maxTokenBufferBytes ?? DEFAULT_MAX_TOKEN_BUFFER_BYTES;
  const maxStackDepth = options.maxStackDepth ?? DEFAULT_MAX_STACK_DEPTH;
  const maxAttributeLength = options.maxAttributeLength ?? DEFAULT_MAX_ATTRIBUTE_LENGTH;
  const outputFlushBytes = options.outputFlushBytes ?? DEFAULT_OUTPUT_FLUSH_BYTES;

  const decoder = new IncrementalUtf8Decoder();
  const tokenizer = new IncrementalHtmlTokenizer({
    maxTokenBufferBytes,
    maxAttributeLength,
  });
  const emitter = new MarkdownEmitter(writer, {
    url: options.url,
    outputFlushBytes,
    maxStackDepth,
    signal: options.signal,
  });

  function checkAborted(): void {
    if (options.signal?.aborted) {
      throw new DOMException("Conversion aborted", "AbortError");
    }
  }

  for await (const chunk of source) {
    checkAborted();
    const text = decoder.decode(chunk);
    const tokens = tokenizer.feed(text);
    await processTokens(tokens, emitter);
    checkAborted();
  }

  // Flush any trailing bytes and tokens.
  const finalText = decoder.decode(new Uint8Array(0), true);
  if (finalText) {
    const tokens = tokenizer.feed(finalText);
    await processTokens(tokens, emitter);
    checkAborted();
  }
  const trailing = tokenizer.flush();
  await processTokens(trailing, emitter);
  await emitter.flush();
  checkAborted();

  const title = emitter.getTitle();
  const textChars = emitter.getTextCharCount();
  const extractionWarning =
    textChars < 50
      ? `Very little content extracted (${textChars} chars) — the page may be dynamic or rely on JavaScript`
      : undefined;

  return {
    title,
    source: "html",
    contentType: "text/html",
    textChars,
    outputChars: emitter.getOutputCharCount(),
    extractionWarning,
  };
}

async function processTokens(tokens: Token[], emitter: MarkdownEmitter): Promise<void> {
  for (const token of tokens) {
    if (token.type === "text") {
      await emitter.emitText(token.text);
    } else if (token.type === "start") {
      await emitter.emitStartTag(token.name, token.attrs, token.selfClosing);
    } else {
      await emitter.emitEndTag(token.name);
    }
  }
}

/** Convenience: convert the HTML file at `sourcePath` to a Markdown file. */
export async function convertHtmlFileToMarkdown(
  sourcePath: string,
  artifactPath: string,
  options: StreamingConverterOptions,
): Promise<StreamingConverterResult> {
  const handle = await open(artifactPath, "w");
  try {
    const writer: MarkdownWriter = {
      async write(text: string) {
        await handle.write(text);
      },
    };

    const stream = createReadStream(sourcePath, {
      highWaterMark: 16 * 1024,
      signal: options.signal,
    });

    return await streamHtmlToMarkdown(stream, writer, options);
  } finally {
    await handle.close();
  }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Convert an HTML string to Markdown.  For tests only. */
export async function convertHtmlToMarkdownAsync(
  html: string,
  url = "https://example.com",
  overrides: Partial<Omit<StreamingConverterOptions, "url">> = {},
): Promise<{ markdown: string; title: string; extractionWarning?: string }> {
  const chunks: string[] = [];
  const writer: MarkdownWriter = {
    async write(text: string) {
      chunks.push(text);
    },
  };

  const encoder = new TextEncoder();
  const result = await streamHtmlToMarkdown(
    (async function* () {
      yield encoder.encode(html);
    })(),
    writer,
    { url, ...overrides },
  );

  return {
    markdown: chunks.join(""),
    ...result,
  };
}