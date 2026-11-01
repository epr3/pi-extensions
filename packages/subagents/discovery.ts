// Custom Subagent definitions: discovery, parsing, and validation.
//
// Definitions are Pi-scoped Markdown files with YAML frontmatter (required
// `name` and `description`; the Markdown body is the system prompt). They are
// read fresh on every launch — edits apply to subsequent launches, never to a
// run already in progress — and precedence never merges: the nearest scope
// that mentions a name decides whether that name is valid, invalid, or
// conflicted, and an invalid winner shadows lower-priority definitions of the
// same name so a configuration error cannot silently select unintended
// instructions.
//
// Markdown without frontmatter or without a `name` is documentation and is
// ignored silently.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { parseModelRef } from "./model-ref.ts";

/** Fields the frontmatter grammar accepts. Every accepted field is
 *  implemented; anything else is an explicitly rejected `unknown-field`, so
 *  unimplemented settings are never mistaken for guarantees. `skills` is the
 *  frontmatter list of Pi skill names to preload into the Subagent's initial
 *  context. */
export const SUPPORTED_FIELDS = [
  "name",
  "description",
  "skills",
  "tools",
  "disallowedTools",
  "model",
] as const;

/** The explicit parent-model sentinel for the `model` frontmatter field. */
export const MODEL_INHERIT = "inherit";

/** Built-in Subagent names; custom definitions cannot shadow them. */
export const RESERVED_NAMES = ["explore", "general"] as const;

export interface CustomSubagentDef {
  /** Frontmatter `name` — the identity used for `subagent_type` matching. */
  name: string;
  description: string;
  /** The file's Markdown body. */
  systemPrompt: string;
  /** Frontmatter `skills`: Pi skill names to preload into the run's initial
   *  context, deduped in list order. Resolved against normal Pi skill
   *  discovery at launch; an empty list means no preloading. */
  skills: string[];
  sourcePath: string;

  /** Explicit tool allowlist (bare Pi tool names, YAML list or comma-joined
   *  string, deduped). Omitted means: inherit the available Subagent tools
   *  (write and shell included). Shapes and pattern syntax are validated
   *  here; tool availability against the live session is checked at launch
   *  — see packages/subagents/toolset.ts. */
  tools?: string[];
  /** Tool names removed from the run's toolset (allowlisted or inherited)
   *  after the fixed safety exclusions. Same format rules as `tools`. */
  disallowedTools?: string[];
  /** Exact `"provider/model"` reference, or `"inherit"` to explicitly use
   *  the parent session's model. Omitted keeps the existing configured
   *  defaults then parent-model fallback. Syntax is validated here; the
   *  registry lookup happens at launch and a miss fails the run. */
  model?: string;
}

export type DefinitionDiagnosticKind =
  | "malformed-frontmatter"
  | "invalid-definition"
  | "unknown-field"
  | "reserved-name"
  | "conflict"
  | "shadowed"
  | "unreadable";

export interface DefinitionDiagnostic {
  kind: DefinitionDiagnosticKind;
  /** The definition name when it could be established. */
  name?: string;
  /** Message naming the offending file(s). */
  message: string;
}

export interface CustomTypeDiscovery {
  /** Name → winner, nearest-scope precedence, invalid definitions excluded. */
  valid: Map<string, CustomSubagentDef>;
  /** Diagnosed problems, one per invalidated definition or conflict. */
  diagnostics: DefinitionDiagnostic[];
}

// ─── Per-file parsing and validation ────────────────────────────────────────

type ParseOutcome =
  | { kind: "documentation" } // no frontmatter / no name: silently ignored
  | { kind: "valid"; def: CustomSubagentDef }
  | { kind: "invalid"; diagnostic: DefinitionDiagnostic };

function parseDefinitionFile(filePath: string, raw: string): ParseOutcome {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(raw);
    frontmatter = parsed.frontmatter as Record<string, unknown>;
    body = parsed.body;
  } catch (e) {
    return {
      kind: "invalid",
      diagnostic: {
        kind: "malformed-frontmatter",
        message: `${filePath}: malformed YAML frontmatter (${(e as Error).message})`,
      },
    };
  }

  // A missing `name` makes the file documentation — people keep ordinary
  // Markdown notes next to definitions. A present-but-unusable `name` is a
  // diagnosable definition error instead.
  if (!("name" in frontmatter)) return { kind: "documentation" };

  const nameValue = frontmatter["name"];
  if (typeof nameValue !== "string" || nameValue.trim() === "") {
    return {
      kind: "invalid",
      diagnostic: {
        kind: "invalid-definition",
        message: `${filePath}: \`name\` must be a non-empty string`,
      },
    };
  }

  const name = nameValue.trim();
  const fail = (kind: DefinitionDiagnosticKind, message: string): ParseOutcome => ({
    kind: "invalid",
    diagnostic: { kind, name, message: `${filePath}: ${message}` },
  });

  const descriptionValue = frontmatter["description"];
  if (typeof descriptionValue !== "string" || descriptionValue.trim() === "") {
    return fail("invalid-definition", "missing or empty required field `description`");
  }

  // Optional capability fields: validated in declaration order so an error
  // always points at the first offending field.
  const custom: { tools?: string[]; disallowedTools?: string[]; model?: string } = {};
  if ("tools" in frontmatter) {
    const parsed = parseToolListField(frontmatter["tools"], "tools");
    if (parsed.error) return fail("invalid-definition", parsed.error);
    custom.tools = parsed.value;
  }
  if ("disallowedTools" in frontmatter) {
    const parsed = parseToolListField(frontmatter["disallowedTools"], "disallowedTools");
    if (parsed.error) return fail("invalid-definition", parsed.error);
    custom.disallowedTools = parsed.value;
  }
  if ("model" in frontmatter) {
    const parsed = parseModelField(frontmatter["model"]);
    if (parsed.error) return fail("invalid-definition", parsed.error);
    custom.model = parsed.value;
  }

  for (const field of Object.keys(frontmatter)) {
    if ((SUPPORTED_FIELDS as readonly string[]).includes(field)) continue;
    return fail("unknown-field", `unsupported frontmatter field \`${field}\``);
  }

  // `skills` must be a YAML list of non-empty skill names. Resolution against
  // actual Pi skills happens at launch (a missing skill fails that run, not
  // the parse), so here we only enforce the field's shape.
  let skills: string[] | undefined;
  const skillsValue = frontmatter["skills"];
  if ("skills" in frontmatter) {
    if (!Array.isArray(skillsValue)) {
      return fail(
        "invalid-definition",
        "field `skills` must be a YAML list of skill names (e.g. `skills:\n  - code-review`)",
      );
    }
    const names: string[] = [];
    for (const entry of skillsValue) {
      if (typeof entry !== "string" || entry.trim() === "") {
        return fail(
          "invalid-definition",
          "field `skills` must be a YAML list of non-empty skill names",
        );
      }
      const trimmed = entry.trim();
      if (!names.includes(trimmed)) names.push(trimmed);
    }
    skills = names;
  }

  if ((RESERVED_NAMES as readonly string[]).includes(name.toLowerCase())) {
    return fail(
      "reserved-name",
      `\`${name}\` is a reserved built-in Subagent name and cannot be redefined`,
    );
  }

  return {
    kind: "valid",
    def: {
      name,
      description: descriptionValue,
      systemPrompt: body,
      skills: skills ?? [],
      sourcePath: filePath,
      ...custom,
    },
  };
}

// ─── Optional frontmatter field grammars ───────────────────────────────────

/** Characters that mark a scoped pattern, wildcard, or mapping-like form.
 *  Pi tool names are plain identifiers; anything else in a tool field is
 *  rejected rather than translated. */
const TOOL_NAME_FORBIDDEN = /[()*:*]/;

/** The shared discriminated result shape for optional-field parsers, matching
 *  parseModelField: exactly one of `value` (accepted) / `error` (rejected). */
interface FieldParseResult<T> {
  value?: T;
  error?: string;
}

/**
 * Validate a `tools` / `disallowedTools` frontmatter value.
 * Accepted: a YAML list of strings, or a comma-separated string — both of
 * bare Pi tool names (trimmed, empties dropped, deduped). Returns `{ error }`
 * for: non-string/non-array shapes, non-string entries, scoped patterns and
 * wildcards (`Bash(...)`, `Edit:*`, `Edit*`), and entries that become empty
 * after trimming.
 */
export function parseToolListField(value: unknown, field: string): FieldParseResult<string[]> {
  let names: string[];
  if (typeof value === "string") {
    names = value.split(",").map((s) => s.trim());
  } else if (Array.isArray(value)) {
    if (value.some((v) => typeof v !== "string")) {
      return { error: `\`${field}\` entries must all be tool names (strings)` };
    }
    names = (value as unknown[]).map((v) => String(v).trim());
  } else {
    return {
      error: `\`${field}\` must be a YAML list of tool names or a comma-separated string`,
    };
  }

  const out: string[] = [];
  for (const raw of names) {
    if (raw === "") {
      return {
        error: `\`${field}\` contains an empty tool name${
          typeof value === "string" ? " — separate names with commas" : ""
        }`,
      };
    }
    if (TOOL_NAME_FORBIDDEN.test(raw)) {
      return {
        error:
          `\`${field}\` entry "${raw}" is not a bare Pi tool name — scoped patterns ` +
          `and wildcards (like Bash(git*:*), Configure:*, or Browser(*)) are not supported; ` +
          `write the exact Pi tool name, e.g. "bash"`,
      };
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return { value: out };
}

/**
 * Validate a `model` frontmatter value.
 * Accepted: an exact `provider/model` reference (see model-ref.ts), or the
 * literal `"inherit"` to explicitly use the parent session's model. A bare
 * alias ("haiku"), missing slash, empty provider/model id, or a non-string
 * value returns an error message — unlike the configured defaults, an
 * explicit definition model never falls back silently.
 */
export function parseModelField(value: unknown): { value?: string; error?: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "`model` must be a string — an exact `provider/model` reference or `inherit`" };
  }
  const trimmed = value.trim();
  if (trimmed === MODEL_INHERIT) return { value: trimmed };
  if (!parseModelRef(trimmed)) {
    return {
      error:
        `\`model\` value "${trimmed}" is not an exact \`provider/model\` reference ` +
        `(e.g. "anthropic/claude-sonnet-4-20250514") or \`inherit\` — bare model ` +
        `aliases are not supported`,
    };
  }
  return { value: trimmed };
}

// ─── Scope walking ──────────────────────────────────────────────────────────

function markdownFiles(dirPath: string): string[] {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

interface ScopeEntry {
  status: "valid" | "invalid" | "conflict";
  def?: CustomSubagentDef;
  /** File that first established the name in this scope (for conflicts). */
  firstPath?: string;
  diagnostics: DefinitionDiagnostic[];
}

/** Record that a definition of `name` in `scope` (file `filePath`) cannot be
 *  used; a second occurrence makes the whole name conflicted in that scope —
 *  selection must not be arbitrary. The recorded reason names every path
 *  involved. */
function markNonValid(
  byName: Map<string, ScopeEntry>,
  name: string,
  scope: string,
  filePath: string,
  reason?: DefinitionDiagnostic,
): void {
  const prior = byName.get(name);
  if (!prior) {
    byName.set(name, {
      status: "invalid",
      firstPath: filePath,
      diagnostics: reason ? [reason] : [],
    });
    return;
  }
  if (prior.status === "conflict") return; // already conflicted; keep it that way
  const first = prior.firstPath ?? filePath;
  prior.status = "conflict";
  prior.def = undefined;
  prior.diagnostics = [
    {
      kind: "conflict",
      name,
      message:
        `${scope}: conflicting definitions of \`${name}\` at ${first} and ${filePath}` +
        ` — remove one so selection is not arbitrary`,
    },
  ];
}

function scanScope(scope: string): {
  byName: Map<string, ScopeEntry>;
  diagnostics: DefinitionDiagnostic[];
} {
  const byName = new Map<string, ScopeEntry>();
  const diagnostics: DefinitionDiagnostic[] = [];

  for (const filePath of markdownFiles(scope)) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (e) {
      diagnostics.push({
        kind: "unreadable",
        message: `${filePath}: cannot read definition file (${(e as Error).message})`,
      });
      continue;
    }
    const outcome = parseDefinitionFile(filePath, raw);
    if (outcome.kind === "documentation") continue;
    if (outcome.kind === "invalid") {
      // A nameless invalid file cannot conflict or shadow anything; it is
      // still diagnosed, not silently dropped.
      if (outcome.diagnostic.name === undefined) {
        diagnostics.push(outcome.diagnostic);
        continue;
      }
      markNonValid(byName, outcome.diagnostic.name, scope, filePath, outcome.diagnostic);
      continue;
    }

    const prior = byName.get(outcome.def.name);
    if (prior) {
      markNonValid(byName, outcome.def.name, scope, filePath);
      continue;
    }
    byName.set(outcome.def.name, {
      status: "valid",
      def: outcome.def,
      firstPath: filePath,
      diagnostics: [],
    });
  }

  return { byName, diagnostics };
}

/**
 * Discover custom Subagent definitions across scopes in nearest-first
 * precedence order. Matches are exact against `name`; a name resolved in an
 * earlier scope is never re-decided by a later one and definitions are never
 * merged.
 */
export function discoverCustomSubagents(scopes: string[]): CustomTypeDiscovery {
  const diagnostics: DefinitionDiagnostic[] = [];
  const winners = new Map<string, CustomSubagentDef>();
  const seen = new Set<string>();

  const scanned = scopes.map(scanScope);

  // Names any lower-priority scope had a valid definition for — used to tell
  // "shadowed" (invalid winner over a usable definition) apart from a plain
  // invalid definition. Iterating far→near and overwriting keeps the NEAREST
  // lower-priority valid path: that is the definition an invalid winner
  // actually shadows, so the diagnostic cites it, not some farther namesake.
  const lowerValid = new Map<string, string>(); // name → nearest lower scope's path
  for (let i = scopes.length - 1; i >= 0; i--) {
    for (const [name, entry] of scanned[i].byName) {
      if (entry.status === "valid") {
        lowerValid.set(name, entry.def!.sourcePath);
      }
    }
  }

  for (let i = 0; i < scopes.length; i++) {
    diagnostics.push(...scanned[i].diagnostics);
    for (const [name, entry] of scanned[i].byName) {
      // The first (nearest) scope that mentions a name decides its fate.
      if (seen.has(name)) continue;
      seen.add(name);
      if (entry.status === "valid") {
        winners.set(name, entry.def!);
      } else if (entry.status === "conflict") {
        // Both conflicting paths are diagnosed; the name is unusable in every
        // scope for this launch.
        diagnostics.push(...entry.diagnostics);
      } else if (lowerValid.has(name)) {
        diagnostics.push({
          kind: "shadowed",
          name,
          message: `${entry.diagnostics[0]?.message ?? scopes[i]}: invalid definition of \`${name}\` shadows a lower-priority definition at ${lowerValid.get(name)}`,
        });
      } else {
        diagnostics.push(...entry.diagnostics);
      }
    }
  }

  return { valid: winners, diagnostics };
}

/** Convenience: names currently resolvable for the parent. */
export function validNames(d: CustomTypeDiscovery): string[] {
  return [...d.valid.keys()];
}

// ─── Scope computation from the filesystem ──────────────────────────────────

/**
 * Compute the definition directories in precedence order (nearest project
 * scope first, user scope last):
 *
 * - project scopes are `<dir>/.pi/agents` from `cwd` to its Git repository
 *   root inclusive (the walk stops at the first directory containing `.git`);
 *   outside Git only the working directory's project scope is inspected;
 * - the user scope is `<agentDir>/agents`, e.g. `~/.pi/agent/agents`
 *   (respects Pi's `PI_CODING_AGENT_DIR` override).
 */
export function customSubagentScopes(
  cwd: string,
  agentDefinitionsDir: () => string = defaultUserDefinitionsDir,
): string[] {
  const walk: string[] = [];
  let current = path.resolve(cwd);
  let inGit = false;
  // Bounded upward walk; POSIX root ("/") has no parent, so guard on that.
  for (;;) {
    walk.push(current);
    try {
      if (statSync(path.join(current, ".git"), { throwIfNoEntry: false })) {
        inGit = true;
        break; // the Git root is inclusive:
      }
    } catch {
      /* unreadable directory: treat as no Git marker here */
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Outside Git, inspect only the working directory's project scope.
  const projectDirs = inGit ? walk : [walk[0]];
  return [...projectDirs.map((dir) => path.join(dir, ".pi", "agents")), agentDefinitionsDir()];
}

function defaultUserDefinitionsDir(): string {
  return path.join(getAgentDir(), "agents");
}