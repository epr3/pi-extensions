/**
 * LSP tool-choice evaluation (ticket 0005). Spec's Testing/Implementation decisions
 * back this: "Run the documented non-gating comparison with the same task set and
 * setup for both guidance variants … report unavailable prerequisites or unexecuted
 * scenarios instead of implying they passed."
 *
 * Run by hand: `node_modules/.bin/tsx scripts/lsp-tool-choice-eval.ts` (repo root).
 * NEVER wired into pnpm test / vitest / verify:ext. Exits 0 whatever the model
 * chose; non-zero exit only if a real prerequisite is missing before any run.
 *
 * Each task runs twice — against the BASELINE guidance (the lsp package
 * materialized from a git revision, default 580785b, the last pre-preference
 * commit) and the REVISED guidance (default HEAD) — under the same model,
 * thinking level, and tool allowlist, against the committed fixture project
 * scripts/lsp-eval-fixture. Model answers come from `pi -p --mode json`; the
 * harness only extracts tool_call events. Model choice is variable: results are
 * recorded, never scored. See scripts/lsp-tool-choice-eval.README.md.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(REPO_ROOT, "packages", "lsp", "eval");

const MODEL = process.env.LSP_EVAL_MODEL ?? "gpt-6.1-terra";
const THINKING = process.env.LSP_EVAL_THINKING ?? "low";
const BASELINE_REV = process.env.LSP_EVAL_BASELINE_REV ?? "580785b";
const REVISED_REV = process.env.LSP_EVAL_REVISED_REV ?? "HEAD";
const PI_TIMEOUT_MS = Number(process.env.LSP_EVAL_TIMEOUT_MS ?? 240_000);
const KEEP_SCRATCH = process.env.LSP_EVAL_KEEP != null;

/** Same allowlist for both variants: the lsp tools under test plus the
 * grep/find/read orientation + textual-search trio and bash. */
const TOOL_ALLOWLIST = [
  "lsp_definition",
  "lsp_references",
  "lsp_implementation",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_hover",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
  "bash",
  "grep",
  "find",
  "read",
].join(",");

export const SEMANTIC_TOOLS = new Set([
  "lsp_definition",
  "lsp_references",
  "lsp_implementation",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_hover",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
]);
export const ORIENTATION_TOOLS = new Set(["lsp_document_symbols", "read"]);
export const TEXTUAL_TOOLS = new Set(["grep", "find", "bash"]);

export interface TaskDef {
  id: string;
  category: string;
  intent: string;
  prompt: string;
  expectedFirstClass: string;
}
interface TaskSet {
  tasks: TaskDef[];
}

/** Where the fixture copy for a variant lives — also the pi spawn cwd. */
interface Variant {
  label: "baseline" | "revised";
  rev: string;
  fixtureDir: string;
  lspDir: string;
  piPath: string;
}

export interface RunRecord {
  variant: "baseline" | "revised";
  task: TaskDef;
  toolOrder: string[];
  firstTool: string | undefined;
  firstClass: string;
  transcriptPath: string | null;
  error: string | null;
  seconds: number;
}

// --- pi discoverability ------------------------------------------------------
// The pi CLI is resolved through packages/lsp/node_modules/.bin/pi. Because it
// is a symlink into a node_modules/.pnpm store, the binary's own module
// resolution works from any cwd; the runner passes it as an absolute argv0.

export function piCandidate(): string {
  const candidate = process.env.LSP_EVAL_PI ?? path.join(REPO_ROOT, "packages", "lsp", "node_modules", ".bin", "pi");
  if (!existsSync(candidate))
    throw new Error(
      `pi CLI not found at ${candidate}. ` +
        `Run this script from a worktree of the monorepo (node_modules are prelinked ` +
        `to the primary checkout) or point LSP_EVAL_PI at a pi binary.`,
    );
  return candidate;
}

// --- pure parsing / classification helpers (unit-testable, no side effects) --

/** Tool-call extraction from `pi -p --mode json` stdout: one JSON event per line. */
export function parseToolOrder(jsonl: string): string[] {
  const order: string[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const e = event as { type?: unknown; toolName?: unknown };
    if (e?.type === "tool_execution_start" && typeof e.toolName === "string") order.push(e.toolName);
  }
  return order;
}

/** Class of a single tool name; "none" when no tool ran (text-only answer). */
export function classifyTool(toolName: string | undefined): string {
  if (!toolName) return "none";
  if (SEMANTIC_TOOLS.has(toolName)) return "semantic";
  if (ORIENTATION_TOOLS.has(toolName)) return "orientation";
  if (TEXTUAL_TOOLS.has(toolName)) return "textual";
  return "other";
}

export function loadTaskSet(raw: string, source = "task set"): TaskSet {
  const parsed = JSON.parse(raw) as TaskSet;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0)
    throw new Error(`${source}: "tasks" must be a non-empty array`);
  const seen = new Set<string>();
  for (const [i, t] of parsed.tasks.entries()) {
    for (const key of ["id", "category", "intent", "prompt", "expectedFirstClass"] as const)
      if (typeof t?.[key] !== "string" || !t[key])
        throw new Error(`${source}: task #${i} is missing a non-empty "${key}" string`);
    if (seen.has(t.id)) throw new Error(`${source}: duplicate task id "${t.id}"`);
    seen.add(t.id);
  }
  return parsed;
}

// --- prerequisites -----------------------------------------------------------

function missingPrerequisites(): string[] {
  const missing: string[] = [];
  // An unusable language server would make every semantic scenario meaningless;
  // the ticket says to report prerequisite gaps rather than run past them.
  if (spawnSync("typescript-language-server", ["--version"], { encoding: "utf8" }).status !== 0)
    missing.push("typescript-language-server not on PATH or not runnable");
  const probe = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--verify", `${BASELINE_REV}^{commit}`], { encoding: "utf8" });
  if (probe.status !== 0) missing.push(`baseline revision ${BASELINE_REV} not found in this checkout`);
  const probe2 = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--verify", `${REVISED_REV}^{commit}`], { encoding: "utf8" });
  if (probe2.status !== 0) missing.push(`revised revision ${REVISED_REV} not found in this checkout`);
  const fixture = path.join(REPO_ROOT, "scripts", "lsp-eval-fixture");
  if (!existsSync(path.join(fixture, "tsconfig.json")))
    missing.push(`fixture project missing at ${fixture} — the evaluation needs the committed fixture`);
  return missing;
}

/**
 * Model/provider/thinking are pinned by pi flags; these environment variables
 * would silently override them (per user/global pi settings precedence), so
 * strip them. Everything else passes through — including PI_KEEP, which is
 * merely kept for compatibility with operator wrappers, and PATH/HOME which
 * pi needs to find auth and servers.
 */
function piEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PI_DEFAULT_PROVIDER;
  delete env.PI_DEFAULT_MODEL;
  delete env.PI_DEFAULT_THINKING_LEVEL;
  delete env.PI_REASONING_LEVEL;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_SESSION_ID;
  return env;
}

// --- variant materialization -------------------------------------------------

const LSP_PACKAGE_FILES = ["index.ts", "tools.ts", "client.ts", "render-call.ts", "render-result.ts", "servers.json"];

/** Extract packages/lsp sources (and only those) for one guidance variant from
 * a git revision — never by editing a working tree, so both arms are
 * reproducible from history. */
function extractLspPackage(rev: string, destDir: string): void {
  for (const file of LSP_PACKAGE_FILES) {
    const show = spawnSync("git", ["-C", REPO_ROOT, "show", `${rev}:packages/lsp/${file}`], { encoding: "utf8" });
    if (show.status !== 0)
      throw new Error(`revision ${rev} has no readable packages/lsp/${file}: ${show.stderr?.split("\n")[0]}`);
    writeFileSync(path.join(destDir, file), show.stdout);
  }
}

/** Copy the committed fixture; link lsp runtime deps into the copied lsp dir
 * (exact versions via the primary checkout's store; a fresh-clone operator
 * running verify:ext already has these). */
function materializeVariant(label: "baseline" | "revised", rev: string, scratchRoot: string, worktreePi: string): Variant {
  const fixtureDir = path.join(scratchRoot, `fixture-${label}`);
  mkdirSync(fixtureDir, { recursive: true });
  const src = path.join(REPO_ROOT, "scripts", "lsp-eval-fixture");
  const depsToCopy = [
    "package.json",
    "tsconfig.json",
    ".pi/settings.json",
    "src/tags.ts",
    "src/values.ts",
    "src/emitters.ts",
    "src/sinks.ts",
    "src/tasks.ts",
    "src/task-types.ts",
    "src/notes.md",
  ];
  for (const rel of depsToCopy) {
    const dest = path.join(fixtureDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(path.join(src, rel)));
  }

  const lspDir = path.join(scratchRoot, `lsp-${label}`);
  mkdirSync(path.join(lspDir, "node_modules", "@earendil-works"), { recursive: true });
  extractLspPackage(rev, lspDir);
  const store = realpathSync(path.join(REPO_ROOT, "packages", "lsp", "node_modules"));
  for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    symlinkSync(path.join(store, dep), path.join(lspDir, "node_modules", dep), "dir");
  }
  return { label, rev, fixtureDir, lspDir, piPath: worktreePi };
}

// --- running -----------------------------------------------------------------

function runPi(variant: Variant, task: TaskDef, scratchRoot: string): RunRecord {
  const started = Date.now();
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--no-extensions",
    "-e",
    variant.lspDir,
    "--no-context-files",
    "--no-skills",
    "--tools",
    TOOL_ALLOWLIST,
    "--model",
    MODEL,
    "--thinking",
    THINKING,
    task.prompt,
  ];
  const res = spawnSync(variant.piPath, args, {
    cwd: variant.fixtureDir,
    env: piEnv(),
    encoding: "utf8",
    timeout: PI_TIMEOUT_MS,
  });
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  // Full raw stdout (JSONL) is preserved for each run in the committed eval
  // area (packages/lsp/eval/tmp, gitignored) so the report cites reality.
  const dumpDir = path.join(EVAL_DIR, "tmp");
  mkdirSync(dumpDir, { recursive: true });
  const transcriptPath = path.join(dumpDir, `${startedStamp()}-${variant.label}-${task.id}.jsonl`);
  writeFileSync(transcriptPath, res.stdout ?? "(pi produced no stdout)");
  const base: RunRecord = {
    variant: variant.label,
    task,
    toolOrder: [],
    firstTool: undefined,
    firstClass: "none",
    transcriptPath,
    error: null,
    seconds,
  };
  if (res.error) return { ...base, error: `pi launch failed: ${String(res.error)}` };
  if (res.status !== 0)
    return { ...base, error: `pi exited ${res.status}: ${(res.stderr ?? "").split("\n")[0].slice(0, 300)}` };
  const toolOrder = parseToolOrder(res.stdout ?? "");
  const firstTool = toolOrder[0];
  const firstClass = classifyTool(firstTool);
  // The report cites the biggest single signal: what the model tried first.
  return { ...base, toolOrder, firstTool, firstClass };
}

// --- report ------------------------------------------------------------------

function startedStamp(): string {
  return STARTED_AT.toISOString().replace(/[:.]/g, "-");
}

const STARTED_AT = new Date();

function reportPath(now: Date): string {
  mkdirSync(EVAL_DIR, { recursive: true });
  const date = now.toISOString().slice(0, 10);
  const base = `${date}-${MODEL.replace(/[^a-zA-Z0-9.-]+/g, "_")}-thinking-${THINKING}`;
  let candidate = path.join(EVAL_DIR, `${base}.md`);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(EVAL_DIR, `${base}-${i}.md`);
  return candidate;
}

function environmentFacts(): string[] {
  const facts: string[] = [];
  facts.push(`- pi CLI: SDK 0.84.1 (packages/lsp/node_modules/.bin/pi), invoked with --no-session --mode json --print; model flags \`--model ${MODEL} --thinking ${THINKING}\``);
  facts.push(`- Node ${process.version}, platform ${process.platform}/${process.arch}`);
  const tls = spawnSync("typescript-language-server", ["--version"], { encoding: "utf8" });
  facts.push(`- typescript-language-server: ${tls.status === 0 ? (tls.stdout ?? "").trim() : "NOT RUNNABLE"}`);
  facts.push(`- Tool allowlist passed to pi: \`${TOOL_ALLOWLIST}\` — identical for both variants`);
  return facts;
}

function writeReport(records: RunRecord[], taskSet: TaskSet, variantRevs: { baseline: string; revised: string }, startedAt: Date): string {
  const lines: string[] = [];
  lines.push(`# LSP tool-choice evaluation — ${startedAt.toISOString()}`, "");
  lines.push(
    "**Non-gating observation, not a correctness test.** The model's tool choice is variable: " +
      "the same task can legitimately produce different tool orders. This report records what " +
      "happened in the recorded runs; it deliberately has no pass-rate threshold.",
    "",
  );
  lines.push("## Setup", "");
  lines.push(`- Model/provider: \`${MODEL}\` (provider per local pi auth at run time), thinking level \`${THINKING}\``);
  lines.push(...environmentFacts());
  lines.push(`- Baseline guidance materialized from git rev \`${variantRevs.baseline}\` (packages/lsp as of that commit); revised guidance from \`${variantRevs.revised}\`; extraction is \`git show <rev>:packages/lsp/<file>\` — the comparison reads history, never working-tree edits`);
  lines.push("- Fixture project: `scripts/lsp-eval-fixture` (committed, deterministic target code, including a TODO-eventions comment marker for the textual scenario)");
  lines.push("", "## Task set (with intent)", "");
  for (const t of taskSet.tasks)
    lines.push(`### ${t.id} — category: ${t.category}; expected-first-class: ${t.expectedFirstClass}`, "", t.intent, "", `Prompt: "${t.prompt}"`, "");
  lines.push("## Tool choices", "");
  for (const t of taskSet.tasks) {
    lines.push(`### ${t.id}`);
    for (const variant of ["baseline", "revised"] as const) {
      const rec = records.find((r) => r.variant === variant && r.task.id === t.id);
      if (!rec) {
        lines.push(`- ${variant}: NOT RUN (no record)`);
        continue;
      }
      const picked = rec.error ? `error: ${rec.error}` : `${rec.firstTool ?? "no tool calls"}`;
      lines.push(`- ${variant} (${rec.seconds}s): first call \`${picked}\` — class: ${rec.firstClass}; full order: ${rec.toolOrder.join(" → ") || "(none)"}`);
    }
    lines.push("");
  }
  lines.push("## Observed results and limitations", "");
  // Synthesized observations (data above), not a grade: counts are descriptive.
  for (const variant of ["baseline", "revised"] as const) {
    const rs = records.filter((r) => r.variant === variant);
    if (!rs.length) continue;
    const matchedExpected = rs.filter((r) => !r.error && r.firstClass === r.task.expectedFirstClass).length;
    const errored = rs.filter((r) => r.error).length;
    const lspFirst = rs.filter((r) => !r.error && r.firstTool?.startsWith("lsp_")).length;
    lines.push(
      `### ${variant}`,
      "",
      `- tasks run: ${rs.length}/${taskSet.tasks.length}; errors: ${errored}; first-call class matched the lens in ${matchedExpected} task(s)`,
      `- lsp_* tools were called first in ${lspFirst} task(s)`,
    );
  }
  for (const r of records)
    lines.push(`  - ${r.variant}/${r.task.id}: ${path.basename(r.transcriptPath ?? "(none)")}`);
  lines.push(
    "",
    "### Stand",
    "",
    "- Single observation run per (task, variant) at the recorded thinking level — model choice is variable, and these stand as recorded observations, not assertions of guidance efficacy.",
    "- Transcripts (raw `--mode json` stdout per run) are preserved under `packages/lsp/eval/tmp/` (gitignored):",
    "",
    "## Unexecuted / prerequisite notes",
    "",
    "- Recorded here rather than implied to have passed.",
    "",
    "## Repeating this run",
    "",
    "Commands and requirements: `scripts/lsp-tool-choice-eval.README.md`.",
  );
  const target = reportPath(startedAt);
  writeFileSync(target, lines.join("\n") + "\n");
  return target;
}

// --- entrypoint --------------------------------------------------------------

function main(): void {
  // When imported by tests (vitest picks scripts/__tests__ only via the root
  // coverage run), do nothing — never spawn a model from a test suite.
  if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) return;

  const missing = missingPrerequisites();
  if (missing.length) {
    console.error(`refusing to run — missing prerequisites:\n- ${missing.join("\n- ")}`);
    process.exit(1);
  }
  if (process.env.PI_DEFAULT_MODEL || process.env.PI_MODEL || process.env.PI_PROVIDER)
    console.error(
      "note: your environment sets PI_MODEL/PI_PROVIDER/PI_DEFAULT_*; the harness strips these for child pi runs, so pi's flags alone pin the model.",
    );

  const piPath = piCandidate();
  const taskSet = loadTaskSet(readFileSync(path.join(REPO_ROOT, "scripts", "lsp-tool-choice-eval.tasks.json"), "utf8"), "lsp-tool-choice-eval.tasks.json");
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "lsp-eval-"));
  const startedAt = new Date();
  try {
    const variants = [
      materializeVariant("baseline", BASELINE_REV, scratchRoot, piPath),
      materializeVariant("revised", REVISED_REV, scratchRoot, piPath),
    ];
    const records: RunRecord[] = [];
    for (const variant of variants)
      for (const task of taskSet.tasks) {
        process.stdout.write(`[${variant.label}] ${task.id} ... `);
        const record = runPi(variant, task, scratchRoot);
        records.push(record);
        console.log(record.error ? "ERROR" : record.firstTool ?? "no tool calls", `(${record.seconds}s)`);
      }
    const where = writeReport(records, taskSet, { baseline: BASELINE_REV, revised: REVISED_REV }, startedAt);
    console.log(`\nreport written: ${where}`);
    if (KEEP_SCRATCH) console.log(`scratch kept: ${scratchRoot}`);
    else rmSync(scratchRoot, { recursive: true, force: true });
  } catch (e) {
    console.error(String(e));
    process.exitCode = 0; // non-gating: report what happened, never hard-fail on model behavior
  } finally {
    if (!KEEP_SCRATCH) rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main();
