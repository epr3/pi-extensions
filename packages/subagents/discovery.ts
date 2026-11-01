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

/** Fields the frontmatter grammar accepts. `tools`, `disallowedTools`,
 *  `model`, and `skills` are rejected explicitly until their tickets
 *  implement them — never silently ignored, so unimplemented settings are
 *  never mistaken for guarantees. */
export const SUPPORTED_FIELDS = ["name", "description"] as const;
export const PLANNED_FIELDS = ["tools", "disallowedTools", "model", "skills"] as const;

/** Built-in Subagent names; custom definitions cannot shadow them. */
export const RESERVED_NAMES = ["explore", "general"] as const;

export interface CustomSubagentDef {
  /** Frontmatter `name` — the identity used for `subagent_type` matching. */
  name: string;
  description: string;
  /** The file's Markdown body. */
  systemPrompt: string;
  sourcePath: string;
}

export type DefinitionDiagnosticKind =
  | "malformed-frontmatter"
  | "invalid-definition"
  | "unknown-field"
  | "unsupported-field"
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

  for (const field of Object.keys(frontmatter)) {
    if ((SUPPORTED_FIELDS as readonly string[]).includes(field)) continue;
    if ((PLANNED_FIELDS as readonly string[]).includes(field)) {
      return fail(
        "unsupported-field",
        `frontmatter field \`${field}\` is not supported yet — planned for a later ` +
          `ticket; remove it or the definition cannot be used`,
      );
    }
    return fail("unknown-field", `unsupported frontmatter field \`${field}\``);
  }

  if ((RESERVED_NAMES as readonly string[]).includes(name.toLowerCase())) {
    return fail(
      "reserved-name",
      `\`${name}\` is a reserved built-in Subagent name and cannot be redefined`,
    );
  }

  return {
    kind: "valid",
    def: { name, description: descriptionValue, systemPrompt: body, sourcePath: filePath },
  };
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
  // invalid definition.
  const lowerValid = new Map<string, string>(); // name → lower scope's path
  for (let i = scopes.length - 1; i >= 0; i--) {
    for (const [name, entry] of scanned[i].byName) {
      if (entry.status === "valid" && !lowerValid.has(name)) {
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