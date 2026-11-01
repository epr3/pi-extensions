import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveTypeRequest, exploreToolset } from "./agents.ts";
import {
  discoverCustomSubagents,
  customSubagentScopes,
  type CustomTypeDiscovery,
} from "./discovery.ts";
import { runSubagent, type StreamEvent, type StreamCallback } from "./runner.ts";
import {
  ACTIVITY_TAIL_LIMIT,
  activityTail,
  entryFromStreamEvent,
  ActivityCapture,
} from "./activity.ts";
import {
  OutcomePersistence,
  reconstructBranchRuns,
  describeBranchRuns,
  reconstructedRetrievalText,
} from "./outcome-records.ts";
import { resolveDefinitionToolset } from "./toolset.ts";
import { SubagentCardBody, SubagentCardTop } from "./presentation.ts";
import { AgentManager, type AgentRecord, type StopOutcome } from "./manager.ts";
import {
  OUTCOME_MESSAGE_TYPE,
  CompletionDelivery,
  ParentBusyTracker,
  modeDeliveryDiagnostic,
  partialOutputBlock,
  renderOutcomeMessage,
  type OutcomeMessage,
} from "./delivery.ts";
import {
  resolveTypeDefaultModel,
  resolveDefaultModel,
  resolveDefinitionModel,
  checkDefaultModelWarnings,
} from "./model-ref.ts";
import { resolveTypeThinkingLevel } from "./thinking-level.ts";
import { resolveSkillPreloads, type PreloadedSkill } from "./skills.ts";
import type { AgentWarning } from "./warnings.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/** The parent session's actually active tool names — the availability source
 *  for custom definitions' `tools` / `disallowedTools`. Returns undefined
 *  when the boundary cannot report a tool set (test seams), in which case
 *  only shape-level checks apply. */
function getActiveToolNamesFrom(pi: ExtensionAPI): string[] | undefined {
  try {
    const names = (pi as { getActiveTools?: () => unknown }).getActiveTools?.();
    return Array.isArray(names) ? names.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the requested Subagent type against built-ins plus the custom
 * definitions discovered right now. Unknown or invalid types fail with an
 * actionable message — never a silent fallback to `general` — and, when the
 * requested name exists as a definition but is unusable (invalid fields,
 * conflict, shadowing), the diagnosing message is appended.
 */
export function resolveTypeRequestOrThrow(requested: string, discovery: CustomTypeDiscovery) {
  try {
    return resolveTypeRequest(requested, discovery);
  } catch (e) {
    const diag = discovery.diagnostics.find((d) => d.name === requested);
    if (diag) {
      throw new Error(`${(e as Error).message} (${diag.message})`, { cause: e });
    }
    throw e;
  }
}

// ─── Foreground stream rendering ───────────────────────────────────────────

/** Maximum number of stream entries to include in expanded partial rendering.
 *  Prevents long Subagent runs from producing unbounded tool rows in the TUI.
 *  It is the same bound the persisted background activity tail keeps. */
export const EXPANDED_TAIL_LIMIT = ACTIVITY_TAIL_LIMIT;

import type { StreamEntry } from "./activity.ts";
export type { StreamEntry };

export interface AgentStreamDetails {
  streamEntries?: StreamEntry[];
  streamText?: string;
  /** Number of earlier activity entries dropped from the retained tail. */
  streamOmitted?: number;
  /** Run id of the streaming run, set once the record exists — ride along so
   *  compact active rows can attribute concurrent runs by id. */
  agentId?: string;
  /** Structured identity, so renderers do not need to reparse display text. */
  type?: string;
  description?: string;
  status?: string;
  tokens?: number;
  toolUses?: number;
  background?: boolean;
  /** Pi's background launch uses snake_case for the model-facing receipt. */
  agent_id?: string;
}

/** Latest tool lifecycle marker with its word — status never rides on a
 *  symbol or color alone. */
function toolMarkerText(entry: Extract<StreamEntry, { type: "tool_start" | "tool_end" }>): string {
  if (entry.type === "tool_start") return `▶ started ${entry.name}`;
  return entry.error ? `✗ failed ${entry.name}` : `✓ finished ${entry.name}`;
}

/**
 * Expanded UI-only activity tail: at most the last 50 assistant-text and
 * tool-activity entries, chronologically, with an explicit omission indicator
 * when earlier entries were dropped. Hidden reasoning never reaches this list
 * (the runner never forwards thinking deltas). Display-only.
 */
export function formatExpandedStream(entries: StreamEntry[], omitted = 0): string {
  const tail = entries.length > EXPANDED_TAIL_LIMIT ? entries.slice(-EXPANDED_TAIL_LIMIT) : entries;
  const lines: string[] = [];
  const dropped = omitted + entries.length - tail.length;
  if (dropped > 0) lines.push(`… ${dropped} earlier entries not shown`);
  let textBuffer = "";
  for (const e of tail) {
    if (e.type === "text") {
      textBuffer += e.text;
      continue;
    }
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = "";
    }
    if (!("name" in e) || typeof e.name !== "string") continue; // tolerate unknown entries
    lines.push(toolMarkerText(e));
  }
  if (textBuffer) lines.push(textBuffer);
  return lines.join("\n");
}

/**
 * Compact active row: the textual run state plus the latest progress marker —
 * never live assistant prose. The run id is included when it is known so
 * concurrent runs stay attributable, following the "run identifier where
 * needed, especially for background runs" boundary.
 */
export function formatCollapsedStream(entries: StreamEntry[], runId?: string): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "tool_start" || e.type === "tool_end") {
      const head = runId ? `running [run ${runId}]` : "running";
      return `${head} — ${toolMarkerText(e)}`;
    }
  }
  // No tool activity yet: compact neutral status instead of assistant prose.
  return "running";
}

/**
 * The background launch result's receipt line. The finalized row stays an
 * identifiable receipt — type, short task, run id, and the textual queued
 * state — while the separately attributed completion message is the
 * authoritative visible outcome.
 */
export function backgroundReceiptText(
  run: { type: string; description: string; id: string },
  modeDiagnostic?: string,
): string {
  return (
    `Subagent ${run.type} "${run.description}" [run ${run.id}] — status: queued.\n` +
    "Retrieve the result with get_subagent_result, or stop the run with stop_subagent." +
    (modeDiagnostic ? ` ${modeDiagnostic}` : "")
  );
}

function isTextContent(c: any): c is { type: "text"; text: string } {
  return c?.type === "text";
}

/**
 * Render the Agent tool result. During a foreground stream the collapsed row
 * shows the latest activity; the expanded row shows assistant text interleaved
 * with compact tool lifecycle markers. The final result renders the clean
 * subagent answer.
 */
export function renderAgentResult(
  result: AgentToolResult<AgentStreamDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Text | SubagentCardBody {
  const details = (result.details ?? {}) as AgentStreamDetails;
  const runId = details.agentId ?? details.agent_id;
  const status = details.status ?? (options.isPartial ? "running" : "completed");
  const contentText = result.content
    .filter(isTextContent)
    .map((c) => c.text)
    .join("\n");

  if (options.isPartial) {
    const entries = details.streamEntries;
    if (!entries || entries.length === 0) return new Text("", 0, 0);
    const activity = formatExpandedStream(entries, details.streamOmitted);
    const body = options.expanded
      ? `${partialHead(theme, status, runId, entries)}${activity ? `\n\n${theme.fg("muted", "Activity")}\n${theme.fg("toolOutput", activity)}` : ""}`
      : partialHead(theme, status, runId, entries);
    return new SubagentCardBody(theme, body);
  }

  // Background launch receipt: the top border names the run, the body is the
  // textual queued state plus the retrieve/stop pointers. The authoritative
  // outcome arrives later as a separate attributed completion.
  if (details.background || (!details.streamEntries && details.agent_id && status === "queued")) {
    const instructions =
      contentText.split("\n").slice(1).join("\n").trim() ||
      "Retrieve the result with get_subagent_result, or stop the run with stop_subagent.";
    const body = `${statusHead(theme, status, undefined)}\n${theme.fg("toolOutput", instructions)}`;
    return new SubagentCardBody(theme, body);
  }

  const head = statusHead(theme, status, statsText(details.toolUses, details.tokens));
  const label = (name: string) => theme.fg("muted", name);
  const output = theme.fg("toolOutput", contentText);
  if (!options.expanded) {
    return new SubagentCardBody(theme, head);
  }
  const omitted = details.streamOmitted ?? 0;
  const activity = details.streamEntries?.length
    ? formatExpandedStream(details.streamEntries, omitted)
    : "";
  return new SubagentCardBody(
    theme,
    `${head}${activity ? `\n\n${label("Activity")}\n${theme.fg("toolOutput", activity)}` : ""}\n\n${label("Result")}\n${output}`,
  );
}

/** Status is always spelled out, so meaning never rides on the icon/color. */
function statusHead(theme: Theme, status: string, detail?: string): string {
  const icon =
    status === "completed" ? "✓" : status === "failed" ? "✗" : status === "stopped" ? "⏹" : "◷";
  const color =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "error"
        : status === "stopped"
          ? "warning"
          : "accent";
  return `${theme.fg(color, icon)} ${theme.fg(color, status)}${detail ? ` · ${detail}` : ""}`;
}

function latestToolMarker(entries: StreamEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "tool_start" || e.type === "tool_end") return toolMarkerText(e);
  }
  return undefined;
}

function partialHead(
  theme: Theme,
  status: string,
  runId: string | undefined,
  entries: StreamEntry[],
): string {
  const marker = latestToolMarker(entries);
  return `${statusHead(theme, status, undefined)}${runId ? ` [run ${runId}]` : ""}${marker ? ` — ${marker}` : ""}`;
}

function statsText(toolUses?: number, tokens?: number): string | undefined {
  const parts: string[] = [];
  if (typeof toolUses === "number" && toolUses >= 0) {
    parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
  }
  if (typeof tokens === "number" && tokens > 0) {
    parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Subagent extension. Two built-in types for context hygiene — `explore`
 * (read-only discovery) and `general` (scoped read/write) — plus custom types
 * discovered from `.pi/agents` definition files (discovery.ts). The Agent tool
 * surface follows @tintinweb/pi-subagents loosely (not verbatim): Agent +
 * get_subagent_result + stop_subagent + a concurrency queue; no Plan agent,
 * steering, resume, or nested delegation.
 *
 * Scheduling/records/concurrency live in AgentManager; this file only wires Pi
 * tools to it and supplies the env-bound exec thunk.
 */

/**
 * The Agent tool's Subagent type surface. Built-ins stay enumerated; this
 * description is a static snapshot computed once at module import — the
 * custom names and descriptions listed here reflect the definition
 * directories as of import time and refresh on the next session. Every
 * launch re-reads the definitions (see the Agent execute handler), so edits
 * and additions apply to subsequent launches even when this snapshot is
 * stale; only the tool description's own list lags until then.
 */
export function agentTypeDescription(custom: CustomTypeDiscovery): string {
  const lines = [...custom.valid.values()].map(
    (d) => `'${d.name}' — ${d.description} (custom, from ${d.sourcePath})`,
  );
  return (
    "Subagent type. Built-ins: 'explore' (read-only codebase discovery), " +
    "'general' (scoped read/write work off the main context)." +
    (lines.length
      ? " Custom types: " + lines.join("; ") + "."
      : " Custom types are defined as Markdown frontmatter files (required name + " +
        "description; the body is the Subagent's system prompt) under .pi/agents " +
        "directories — see the extension README.")
  );
}

export const agentParams = Type.Object({
  subagent_type: Type.String({
    description: agentTypeDescription(discoverCustomSubagents(customSubagentScopes(process.cwd()))),
  }),
  prompt: Type.String({ description: "The task for the subagent" }),
  description: Type.String({ description: "Short 3-5 word summary shown in UI" }),
  run_in_background: Type.Optional(
    Type.Boolean({ description: "Return an id immediately instead of blocking" }),
  ),
});

export const resultParams = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean({ description: "Block until the agent finishes" })),
});

export const stopParams = Type.Object({
  agent_id: Type.String({
    description: "Subagent id returned by a background Agent launch (details.agent_id)",
  }),
});

function settledText(rec: AgentRecord): string {
  if (rec.status === "completed")
    return `\u2713 ${rec.type} (${rec.description}) \u2014 ${rec.toolUses} tool uses`;
  if (rec.status === "stopped") return `\u23f9 ${rec.type} (${rec.description}) stopped`;
  return `\u2717 ${rec.type} (${rec.description}) ${rec.status}: ${rec.error ?? ""}`;
}

/**
 * Compose the parent-facing text for an explicit background retrieval.
 * Completed runs return their result; stopped and failed runs name the
 * outcome, include any available partial assistant text as clearly marked
 * incomplete (or state explicitly that none is available), and — for
 * failures — the failure reason. The truncation notice inside the partial
 * text was composed by the manager outside the result-text limit.
 */
export function retrievalText(rec: AgentRecord): string {
  if (rec.status === "completed") return rec.result ?? "(no output)";
  const head =
    rec.status === "stopped"
      ? `stopped \u2014 ${rec.stopReason ?? "stopped by request"}`
      : rec.status === "failed"
        ? `failed: ${rec.error}`
        : `status: ${rec.status}`;
  return `${head}${partialOutputBlock(rec)}`;
}

/** Compose the parent-facing response for a stop request. */
export function stopResultText(outcome: StopOutcome): string {
  const rec = outcome.record;
  if (outcome.action === "unchanged") {
    const why =
      rec.status === "completed"
        ? "already completed before the stop request"
        : rec.status === "failed"
          ? `already failed with: ${rec.error}`
          : "was already stopped";
    return `Subagent ${rec.id} (${rec.type}, ${rec.description}) ${why}. The stop did not change the outcome.`;
  }
  const head = `Stopped ${rec.type} (${rec.description}) \u2014 ${rec.stopReason ?? "stopped by request"}.`;
  // Shared partial block: marked incomplete, or an explicit "none available"
  // — identical wording to explicit retrieval and automatic completions.
  return `${head}${partialOutputBlock(rec)}`;
}

/**
 * Merge abort sources into one signal for a run's exec: the parent's tool
 * cancellation (foreground only) plus the manager's stop signal.
 */
export function mergedAbortSignal(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const merged = new AbortController();
  for (const signal of present) {
    if (signal.aborted) merged.abort();
    else signal.addEventListener("abort", () => merged.abort(), { once: true });
  }
  return merged.signal;
}

/**
 * The Subagent type shown on the run row. Built-in names resolve to their
 * canonical label case-insensitively; anything else — a resolved custom type,
 * a legacy alias input, or an unsupported request — is displayed exactly as
 * requested. Crucially, a custom name such as "explorer" is never rewritten
 * to the built-in `explore` it merely resembles: rendering cannot read the
 * definition directories (no filesystem access here) without making every
 * redraw nondeterministic, and displaying what the parent asked for is
 * accurate for launch-time validation, which rejects unsupported types.
 */
export function displayAgentTypeName(requested: string): string {
  const s = String(requested).toLowerCase();
  if (s === "explore" || s === "general") return s;
  return requested;
}

/**
 * Render the Agent tool call row, showing the subagent type and description.
 * Exported for testing with a fake theme.
 */
export function renderAgentCall(
  args: { subagent_type: string; description: string; run_in_background?: boolean },
  theme: Theme,
): SubagentCardTop {
  const type = displayAgentTypeName(args.subagent_type);
  const title =
    theme.fg("toolTitle", theme.bold("Agent")) +
    (args.run_in_background ? theme.fg("muted", " · background") : "");
  const header =
    theme.fg("accent", type) +
    (args.description ? theme.fg("muted", ` · "${args.description}"`) : "");
  return new SubagentCardTop(theme, title, header);
}

// Settings: this extension reads its own top-level "subagents" key from Pi's
// settings files (global then project; project wins), inline and self-contained
// — no shared loader. Env vars override on top.
function settingsKey(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of [
    path.join(homedir(), ".pi", "agent", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"))["subagents"] ?? {};
      for (const key of Object.keys(raw)) {
        if (key === "explore" || key === "general") continue;
        out[key] = raw[key];
      }
      // Merge each per-type object rather than replacing it, so a project
      // per-type thinking value does not discard a global per-type model (or
      // vice versa) — thinking and model stay independently configurable.
      for (const type of ["explore", "general"] as const) {
        if (raw[type] !== undefined) {
          out[type] = { ...out[type], ...raw[type] };
        }
      }
    } catch {
      /* missing or malformed file: defaults stand */
    }
  }
  return out;
}

/** Strip the OutcomeMessage down to the Pick<CustomMessage,…> shape pi.sendMessage accepts. */
function toPiMessage(msg: OutcomeMessage) {
  return {
    customType: msg.customType,
    content: msg.content,
    display: msg.display,
    details: msg.details,
  };
}

export default function (pi: ExtensionAPI) {
  // Attributed background completions render through a message renderer: the
  // compact row is one attributable line, the expanded row adds the full
  // authoritative content (bounded result or marked partial/missing output).
  // This keeps the 0014 custom message legible in the TUI without putting
  // activity into model-facing content.
  pi.registerMessageRenderer(OUTCOME_MESSAGE_TYPE, renderOutcomeMessage);

  const raw = settingsKey();
  const cfg = {
    maxConcurrency: Number(raw.maxConcurrency) > 0 ? Number(raw.maxConcurrency) : 4,
    explore: {
      extraTools: Array.isArray(raw.explore?.extraTools) ? raw.explore.extraTools : [],
      defaultModel: String(raw.explore?.defaultModel ?? "").trim() || undefined,
      thinkingLevel: raw.explore?.thinkingLevel,
    },

    // Raw thinking values are validated by resolveTypeThinkingLevel so a
    // malformed candidate can warn and fall through to the next level.
    thinkingLevel: raw.thinkingLevel,
    defaultModel: String(raw.defaultModel ?? "").trim() || undefined,
    general: {
      excludeExtraTools: Array.isArray(raw.general?.excludeExtraTools)
        ? raw.general.excludeExtraTools
        : [],
      defaultModel: String(raw.general?.defaultModel ?? "").trim() || undefined,
      thinkingLevel: raw.general?.thinkingLevel,
    },
  };
  const exploreTools = exploreToolset(cfg.explore.extraTools);

  const manager = new AgentManager({
    maxConcurrency: Number(process.env.PI_SUBAGENT_CONCURRENCY) || cfg.maxConcurrency,
    onEvent: (name, record) => pi.events.emit(`subagents:${name}`, { ...record }),
  });

  // ───────────────────────── Delivery to the originating session ────────────
  // Runs and their completions belong to the session that launched them.
  // Busy/idle is decided from Pi's own agent lifecycle (agent_start →
  // agent_settled), never from UI availability; the attributed completion is
  // a custom message (`subagent-outcome`) so the text is visible to the
  // model while structured attribution rides in `details`.
  const busy = new ParentBusyTracker();
  pi.on("agent_start", () => busy.onAgentStart());
  pi.on("agent_settled", () => busy.onAgentSettled());

  const delivery = new CompletionDelivery(
    {
      isParentBusy: () => busy.isBusy(),
      queueFollowUp: (msg) =>
        pi.sendMessage(toPiMessage(msg), { triggerTurn: true, deliverAs: "followUp" }),
      startParentTurn: (msg) => pi.sendMessage(toPiMessage(msg), { triggerTurn: true }),
    },
    {
      onError: (d) => pi.events.emit("subagents:delivery-error", d),
    },
  );

  // Owning-session guard: anything after shutdown (quit, reload, new,
  // resume, fork) belongs to a different/consuming runtime — stop all work
  // and cancel delivery instead of leaking into a replacement session.
  // Best-effort persistence writes share the originating session's lifetime:
  // the shutdown-stopped runs still get their stopped outcome recorded while
  // this session can write (pi handlers run before replacement invalidates
  // ctx), and once shutdown has passed nothing persists or delivers again.
  // Persistence and delivery remain distinct: delivery may be withheld while
  // an outcome persists, and a crash can prevent the write.
  const persistence = new OutcomePersistence(
    (customType, data) => pi.appendEntry(customType, data),
    { onError: (d) => pi.events.emit("subagents:persistence-error", d) },
  );
  let sessionEnded = false;
  pi.on("session_shutdown", () => {
    // Delivery first: runs stopped by shutdown must never deliver into a
    // dying or replaced session (their owner is gone).
    delivery.deactivate();
    // Then stop the runs — the settles fire synchronously and persist while
    // this session can still write.
    manager.shutdown("Session shutdown or replacement");
    // Close this session's persistence channel; later settles go nowhere.
    persistence.endSession();
    sessionEnded = true;
  });

  pi.registerTool({
    name: "Agent",
    label: "Subagent",
    description:
      "Launch a Subagent in an isolated session to keep the main context clean. " +
      "subagent_type='explore' is read-only codebase discovery (read/grep/find/ls plus codemode); 'general' has full tools. " +
      "Foreground (default) blocks and returns the result; run_in_background:true returns an id you " +
      "poll with get_subagent_result.",
    promptSnippet: "Run a Subagent in an isolated context",
    promptGuidelines: [
      "Use subagent_type='explore' to gather codebase context and 'general' for off-context work that writes.",
      "For independent delegated tasks of the same subagent type, issue multiple foreground Agent calls in the same assistant turn (same-turn fan-out) — one call per task, each with its own prompt and description. Do not use a batch parameter or aggregate result API; each call returns its own result.",
      "Subagent result text is limited to 20,000 bytes. When a Subagent's deliverable is a large document, artifact, or dataset, instruct it to write the full content to a file and return a concise summary plus the file path — omitted result text is not otherwise recoverable.",
    ],
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
    renderShell: "self",
    parameters: agentParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const availableTools = getActiveToolNamesFrom(pi);
      // Re-read custom definitions on every launch: edits and additions apply
      // to subsequent launches; a running Subagent keeps its launch-time
      // definition snapshot.
      const discovery = discoverCustomSubagents(customSubagentScopes(ctx.cwd));
      const background = !!params.run_in_background;

      // Surface definition diagnostics (malformed, conflicts, reserved names,
      // shadowing) without disabling the valid types.
      const defDiagnostics = discovery.diagnostics.map((d) => d.message);
      if (defDiagnostics.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`Subagent definitions:\n${defDiagnostics.join("\n")}`, "warning");
      }

      const resolved = resolveTypeRequestOrThrow(params.subagent_type, discovery);
      const isBuiltin = resolved.kind === "builtin";
      const type = isBuiltin ? resolved.type : resolved.name; // display/record identity
      const agentDef = resolved.kind === "custom" ? discovery.valid.get(resolved.name) : undefined;

      // Resolve the definition's `skills` list through normal Pi skill
      // discovery. A missing or unreadable skill makes that launch fail with
      // an actionable error — a run must not start with incomplete required
      // instructions — while unrelated definitions stay usable. Skill edits
      // are re-read on every launch, like definitions.
      let preloadedSkills: PreloadedSkill[] | undefined;
      if (agentDef && agentDef.skills.length > 0) {
        const skillPreload = await resolveSkillPreloads({
          cwd: ctx.cwd,
          skillNames: agentDef.skills,
        });
        if (skillPreload.problems.length > 0) {
          throw new Error(
            `Cannot launch Subagent type "${type}" — skill preloading failed: ` +
              `${skillPreload.problems.map((p) => p.message).join("; ")}.`,
          );
        }
        preloadedSkills = skillPreload.skills;
      }

      // Custom capability selection: allowlist/denials are validated against
      // the parent session's actual active tool names (availableTools, the
      // extension boundary). Unknown or unavailable names are rejected —
      // never silently dropped — and the fixed safety exclusions always win,
      // so no custom definition can be granted nested delegation or related
      // bypasses. Built-in explore/general boundaries are unchanged.
      const customToolset = agentDef
        ? resolveDefinitionToolset(agentDef, availableTools)
        : undefined;

      // Resolve model: an explicit definition model sets the run's model and
      // never falls back silently (invalid or unavailable references fail the
      // launch). Without one: type-specific override → shared default →
      // parent model, each falling through when unconfigured, invalid, or
      // missed in the registry.
      const findModel = (provider: string, modelId: string) =>
        ctx.modelRegistry.find(provider, modelId);
      const defModelRef = !isBuiltin && agentDef?.model !== undefined ? agentDef.model : undefined;
      let model = defModelRef
        ? undefined // set below via resolveDefinitionModel
        : isBuiltin
          ? resolveTypeDefaultModel(
              {
                explore: cfg.explore.defaultModel,
                general: cfg.general.defaultModel,
              },
              resolved.type,
              cfg.defaultModel,
              findModel,
              ctx.model,
            )
          : resolveDefaultModel(cfg.defaultModel, findModel, ctx.model);
      let modelFailure: string | undefined;
      if (defModelRef) {
        const resolvedDefModel = resolveDefinitionModel(defModelRef, findModel, ctx.model);
        if ("error" in resolvedDefModel) modelFailure = resolvedDefModel.error;
        else model = resolvedDefModel.model;
      }
      // Compute warnings for any configured-but-broken model refs. Settings
      // defaults are warned about only when they are actually consulted: an
      // explicit definition model does not consult them for this launch.
      const modelWarnings =
        modelFailure || defModelRef // settings not consulted for this launch
          ? []
          : isBuiltin
            ? checkDefaultModelWarnings(
                cfg[resolved.type].defaultModel,
                cfg.defaultModel,
                findModel,
                resolved.type,
              )
            : checkDefaultModelWarnings(undefined, cfg.defaultModel, findModel, "shared");
      if (modelFailure) {
        throw new Error(`Subagent type "${type}": ${modelFailure}`);
      }
      // Emit UI toast for each warning when the TUI is active.
      if (modelWarnings.length > 0 && ctx.hasUI) {
        for (const w of modelWarnings) {
          ctx.ui.notify(
            `Default ${w.scope} subagent model "${w.reference}" is ${w.type} — falling back`,
            "warning",
          );
        }
      }

      const thinking = isBuiltin
        ? resolveTypeThinkingLevel(
            cfg[resolved.type].thinkingLevel,
            cfg.thinkingLevel,
            resolved.type,
          )
        : resolveTypeThinkingLevel(undefined, cfg.thinkingLevel, "shared");

      const warnings: AgentWarning[] = [...modelWarnings, ...thinking.warnings];
      for (const w of thinking.warnings) {
        if (ctx.hasUI) ctx.ui.notify(`${w.setting} is malformed — falling back`, "warning");
      }

      // UI-only activity capture, mapped through one shared helper for both
      // modes. Foreground runs forward mapped entries as live tool-row
      // updates. A background run only retains its bounded Activity tail
      // (for persistence at settle): with no onUpdate, no live assistant
      // prose or tool activity can reach the parent context from a
      // background run.
      const streamEntries: StreamEntry[] = []; // foreground: full list; the tail bound applies at rendering
      const backgroundCapture = new ActivityCapture(); // background: bounded tail
      let streamRunId: string | undefined;
      const onStreamEvent: StreamCallback = (event: StreamEvent) => {
        // Parent cancelled (foreground): stop emitting transient stream
        // updates so the tool row freezes instead of showing a dead run. A
        // background run survives a cancelled parent turn, so its capture
        // keeps recording for the persisted tail.
        if (!background && ctx.signal?.aborted) return;
        const entry = entryFromStreamEvent(event);
        if (!entry) return;
        if (background) {
          backgroundCapture.push(event);
          return;
        }
        streamEntries.push(entry);
        const streamText = formatExpandedStream(streamEntries);
        onUpdate?.({
          content: [{ type: "text", text: streamText }],
          details: {
            streamText,
            streamEntries: [...streamEntries],
            ...(streamRunId ? { agentId: streamRunId } : {}),
            type,
            description: params.description,
            status: "running",
          },
        });
      };

      const exec = (stopSignal: AbortSignal) =>
        runSubagent({
          type,
          ...(agentDef ? { agentDef: { ...agentDef } } : {}),
          ...(preloadedSkills ? { preloadedSkills } : {}),
          prompt: params.prompt,
          cwd: ctx.cwd,
          model,
          thinkingLevel: thinking.winner?.level,
          onThinkingLevel: (effective) => {
            const winner = thinking.winner;
            if (!winner || winner.level === effective) return;
            warnings.push({
              scope: winner.scope,
              reference: winner.level,
              setting: winner.setting,
              type: "clamped",
              requested: winner.level,
              effective,
            });
            if (ctx.hasUI)
              ctx.ui.notify(
                `${winner.setting} requested "${winner.level}"; effective "${effective}" (Pi model capabilities)`,
                "warning",
              );
          },
          ...(resolved.kind === "builtin" && resolved.type === "explore"
            ? { tools: exploreTools }
            : {}),
          ...(isBuiltin ? { excludeExtraTools: cfg.general.excludeExtraTools } : {}),
          ...(!isBuiltin && customToolset ? { ...customToolset } : {}),
          onStreamEvent,
          // Foreground: the parent's tool-call cancellation stops the run.
          // Background: stop_subagent's per-run signal stops it.
          abortSignal: background ? stopSignal : mergedAbortSignal([ctx.signal, stopSignal]),
        });
      // Notify only for background settles — foreground returns its result
      // inline, so a toast would be duplicate noise. For background runs the
      // terminal outcome (and the retained activity tail) persists first —
      // persistence and delivery are distinct — and delivery happens once
      // per run through the coordinator; shutdown deactivates delivery
      // before any shutdown-stopped settle can fire, so replacement sessions
      // never receive a completion.
      const onSettled = background
        ? (rec: AgentRecord) => {
            persistence.record(rec, backgroundCapture.snapshotTail());
            if (sessionEnded) return;
            delivery.deliver(rec);
            if (ctx.hasUI) {
              try {
                ctx.ui.notify(
                  settledText(rec),
                  rec.status === "completed"
                    ? "info"
                    : rec.status === "stopped"
                      ? "warning"
                      : "error",
                );
              } catch {
                // Stale ctx after replacement: the toast target is gone.
              }
            }
          }
        : undefined;

      const { record, done } = manager.launch(
        { type, description: params.description, background },
        exec,
        onSettled,
      );
      // Attribute late streaming updates to the launched run id.
      streamRunId = record.id;

      if (background) {
        record.warnings = warnings;
        // Explicit diagnostic where the Pi mode cannot promise the later
        // continuation (print/json): keyed off ctx.mode, never off hasUI.
        const modeDiag = background ? modeDeliveryDiagnostic(ctx.mode) : undefined;
        // The finalized launch row is an identifiable receipt (type, short
        // task, run id, textual queued state); the separately attributed
        // completion message is the authoritative visible outcome.
        return textResult(
          backgroundReceiptText({ type, description: params.description, id: record.id }, modeDiag),
          {
            agent_id: record.id,
            agentId: record.id,
            // Structured receipt identity (dual result contract): revisit
            // reconstruction reads type/description from here instead of
            // reparsing the receipt row's display text.
            type,
            description: params.description,
            status: record.status,
            background: true,
            ...(modeDiag ? { delivery: { promised: false, mode: ctx.mode, note: modeDiag } } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(defDiagnostics.length > 0 ? { definitionDiagnostics: defDiagnostics } : {}),
          },
        );
      }

      const rec = await done; // foreground: block
      if (rec.status === "failed") {
        // The failure reason plus any captured assistant text, clearly marked
        // incomplete via the shared partial block (or an explicit "none
        // available"). Pi's aborted-parent semantics are untouched: when the
        // parent's turn was aborted the call never returns this at all.
        throw new Error(`Subagent failed: ${rec.error}${partialOutputBlock(rec)}`);
      }
      const retained = activityTail(streamEntries);
      return textResult(rec.result ?? "(no output)", {
        agent_id: rec.id,
        agentId: rec.id,
        type,
        description: params.description,
        status: rec.status,
        tokens: rec.tokens,
        toolUses: rec.toolUses,
        streamEntries: retained.entries,
        streamOmitted: retained.omitted,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(defDiagnostics.length > 0 ? { definitionDiagnostics: defDiagnostics } : {}),
      });
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "Subagent Stop",
    description:
      "Stop a queued or running background Subagent. A queued run never starts; a " +
      "running run is aborted. The response reports the outcome (stopped, or why the " +
      "stop did not apply because the run had already completed, failed, or been " +
      "stopped) and includes any partial assistant output, clearly marked " +
      "incomplete. Foreground runs cannot be stopped this way — cancel the Agent " +
      "tool call instead.",
    promptSnippet: "Stop a background Subagent run",
    promptGuidelines: [
      "Use stop_subagent to cancel obsolete background work. Supply the id from the background launch (details.agent_id). Already-terminal runs report their existing outcome unchanged.",
    ],
    parameters: stopParams,
    async execute(_toolCallId, params) {
      let outcome: StopOutcome;
      try {
        outcome = await manager.stop(params.agent_id);
      } catch (e) {
        // Only the unknown-id error is re-labeled; other failures (e.g. the
        // foreground-refusal guidance) pass through unchanged.
        const message = e instanceof Error ? e.message : String(e);
        if (!message.startsWith("No subagent")) throw e;
        throw new Error(
          `Unknown Subagent id "${params.agent_id}". Use the id returned when launching ` +
            `a Subagent with run_in_background (result details.agent_id). Nothing was stopped.`,
          { cause: e },
        );
      }
      return textResult(stopResultText(outcome), {
        agent_id: outcome.record.id,
        status: outcome.record.status,
        stopRequested: true,
        changed: outcome.action === "stopped",
        ...(outcome.record.stopReason ? { stopReason: outcome.record.stopReason } : {}),
      });
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Subagent Result",
    description: "Check status / retrieve the result of a background Subagent.",
    parameters: resultParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const rec = await manager.getResult(params.agent_id, params.wait ?? false);
        return textResult(retrievalText(rec), { ...rec });
      } catch {
        // Unknown to this live registry: on revisit (or after reload) the run
        // may exist on the current branch's history. Reconstruction is
        // read-only: a persisted outcome is explicitly retrievable here, a
        // receipt-only run reads "outcome unavailable", and neither ever
        // redelivers or starts a model turn — this explicit retrieval IS the
        // model turn its result answers.
        const view = reconstructBranchRuns(ctx.sessionManager.getBranch()).find(
          (v) => (v.receipt?.runId ?? v.record?.runId) === params.agent_id,
        );
        if (!view) {
          throw new Error(
            `Unknown Subagent id "${params.agent_id}". Use the id returned by the background ` +
              `launch (details.agent_id), or run /subagents to see what this branch recorded.`,
          );
        }
        const data = view.record;
        return textResult(reconstructedRetrievalText(view), {
          agent_id: params.agent_id,
          ...(data
            ? { status: data.status, tokens: data.tokens, toolUses: data.toolUses }
            : { outcome: "unavailable" }),
          reconstructed: true,
        });
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "List Subagents and their status",
    handler: async (_args, ctx) => {
      const lines = manager.list().map((r) => `${r.id}  ${r.type}  ${r.status}  ${r.description}`);
      const sections = [lines.length ? lines.join("\n") : "No subagents yet"];
      // Revisit listing: the current branch's history — records on THIS
      // branch only, receipts without records marked unavailable. Read-only:
      // no redelivery, no model turn; activity appears as counts only.
      const branchRuns = describeBranchRuns(reconstructBranchRuns(ctx.sessionManager.getBranch()));
      if (branchRuns) {
        sections.push("Background outcomes on this branch (from session history):\n" + branchRuns);
      }
      ctx.ui.notify(sections.join("\n"), "info");
    },
  });
}