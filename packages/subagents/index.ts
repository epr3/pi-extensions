import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolveAgentType, exploreToolset, researcherToolset } from "./agents.ts";
import { runSubagent, type StreamEvent, type StreamCallback } from "./runner.ts";
import { AgentManager, type AgentRecord } from "./manager.ts";
import { resolveTypeDefaultModel, checkDefaultModelWarnings } from "./model-ref.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

// ─── Foreground stream rendering ───────────────────────────────────────────

/** Maximum number of stream entries to include in expanded partial rendering.
 *  Prevents long Subagent runs from producing unbounded tool rows in the TUI. */
export const EXPANDED_TAIL_LIMIT = 50;

export type StreamEntry =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; error: boolean };

export interface AgentStreamDetails {
  streamEntries?: StreamEntry[];
  streamText?: string;
}

function toolMarker(entry: Extract<StreamEntry, { type: "tool_start" | "tool_end" }>): string {
  return entry.type === "tool_start" ? "▶" : entry.error ? "✗" : "✓";
}

function formatExpandedStream(entries: StreamEntry[]): string {
  // Keep only the tail of the stream to avoid unbounded rendering
  const tail = entries.length > EXPANDED_TAIL_LIMIT
    ? entries.slice(-EXPANDED_TAIL_LIMIT)
    : entries;

  const lines: string[] = [];
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
    lines.push(`${toolMarker(e)} ${e.name}`);
  }
  if (textBuffer) lines.push(textBuffer);
  return lines.join("\n");
}

function formatCollapsedStream(entries: StreamEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "tool_start") return `▶ ${e.name}`;
    if (e.type === "tool_end") return e.error ? `✗ ${e.name}` : `✓ ${e.name}`;
    if (e.type === "text" && e.text.trim()) {
      const lastLine = e.text.split("\n").pop() ?? "";
      return lastLine.length > 60 ? `…${lastLine.slice(-60)}` : lastLine;
    }
  }
  return "";
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
): Text {
  if (!options.isPartial) {
    const text = result.content
      .filter(isTextContent)
      .map((c) => c.text)
      .join("\n");
    return new Text(theme.fg("toolOutput", text), 0, 0);
  }
  const entries = result.details?.streamEntries;
  if (!entries || entries.length === 0) return new Text("", 0, 0);
  const text = options.expanded ? formatExpandedStream(entries) : formatCollapsedStream(entries);
  return new Text(theme.fg("toolOutput", text), 0, 0);
}

/**
 * Subagent extension. Two types for context hygiene — `explore` (read-only
 * discovery) and `general` (scoped read/write). The Agent tool surface follows
 * @tintinweb/pi-subagents loosely (not verbatim): Agent + get_subagent_result +
 * a concurrency queue; no Plan agent, steering, resume, or custom .pi/agents.
 *
 * Scheduling/records/concurrency live in AgentManager; this file only wires Pi
 * tools to it and supplies the env-bound exec thunk.
 */

export const agentParams = Type.Object({
  subagent_type: StringEnum(["explore", "general", "researcher"] as const),
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

function settledText(rec: AgentRecord): string {
  return rec.status === "completed"
    ? `\u2713 ${rec.type} (${rec.description}) \u2014 ${rec.toolUses} tool uses`
    : `\u2717 ${rec.type} (${rec.description}) ${rec.status}: ${rec.error ?? ""}`;
}

/**
 * Render the Agent tool call row, showing the subagent type and description.
 * Exported for testing with a fake theme.
 */
export function renderAgentCall(
  args: { subagent_type: string; description: string },
  theme: Theme,
): Text {
  const type = resolveAgentType(args.subagent_type);
  const text =
    theme.fg("toolTitle", theme.bold("Agent ")) +
    theme.fg("accent", type) +
    theme.fg("muted", `  ${args.description}`);
  return new Text(text, 0, 0);
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
      Object.assign(out, JSON.parse(readFileSync(f, "utf8"))["subagents"] ?? {});
    } catch {
      /* missing or malformed file: defaults stand */
    }
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  const raw = settingsKey();
  const cfg = {
    maxConcurrency: Number(raw.maxConcurrency) > 0 ? Number(raw.maxConcurrency) : 4,
    explore: {
      extraTools: Array.isArray(raw.explore?.extraTools) ? raw.explore.extraTools : [],
      defaultModel: String(raw.explore?.defaultModel ?? "").trim() || undefined,
    },
    researcher: {
      extraTools: Array.isArray(raw.researcher?.extraTools) ? raw.researcher.extraTools : [],
      defaultModel: String(raw.researcher?.defaultModel ?? "").trim() || undefined,
    },
    defaultModel: String(raw.defaultModel ?? "").trim() || undefined,
    general: {
      excludeExtraTools: Array.isArray(raw.general?.excludeExtraTools)
        ? raw.general.excludeExtraTools
        : [],
      defaultModel: String(raw.general?.defaultModel ?? "").trim() || undefined,
    },
  };
  const exploreTools = exploreToolset(cfg.explore.extraTools);
  const researcherTools = researcherToolset(cfg.researcher.extraTools);

  const manager = new AgentManager({
    maxConcurrency: Number(process.env.PI_SUBAGENT_CONCURRENCY) || cfg.maxConcurrency,
    onEvent: (name, record) => pi.events.emit(`subagents:${name}`, { ...record }),
  });

  pi.registerTool({
    name: "Agent",
    label: "Subagent",
    description:
      "Launch a Subagent in an isolated session to keep the main context clean. " +
      "subagent_type='explore' is read-only codebase discovery (read/grep/find/ls); 'researcher' is " +
      "read-only web research (web_search/web_fetch + read); 'general' has full tools. " +
      "Foreground (default) blocks and returns the result; run_in_background:true returns an id you " +
      "poll with get_subagent_result.",
    promptSnippet:
      "Run an explore (read-only), researcher (web), or general Subagent in an isolated context",
    promptGuidelines: [
      "Use subagent_type='explore' to gather codebase context and 'researcher' to gather web/external context without polluting the main context; use 'general' for off-context work that writes.",
      "For independent delegated tasks of the same subagent type, issue multiple foreground Agent calls in the same assistant turn (same-turn fan-out) — one call per task, each with its own prompt and description. Do not use a batch parameter or aggregate result API; each call returns its own result.",
    ],
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
    parameters: agentParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const type = resolveAgentType(params.subagent_type);
      const background = !!params.run_in_background;
      // Resolve model: type-specific override → shared default → parent model.
      // Each level: unconfigured, invalid syntax, or registry miss → fall through.
      const model = resolveTypeDefaultModel(
        {
          explore: cfg.explore.defaultModel,
          researcher: cfg.researcher.defaultModel,
          general: cfg.general.defaultModel,
        },
        type,
        cfg.defaultModel,
        (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
        ctx.model,
      );
      // Compute warnings for any configured-but-broken model refs.
      const warnings = checkDefaultModelWarnings(
        cfg[type].defaultModel,
        cfg.defaultModel,
        (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
        type,
      );
      // Emit UI toast for each warning when the TUI is active.
      if (warnings.length > 0 && ctx.hasUI) {
        for (const w of warnings) {
          ctx.ui.notify(
            `Default ${w.scope} subagent model "${w.reference}" is ${w.type} — falling back`,
            "warning",
          );
        }
      }

      // Foreground runs stream child assistant text and compact tool activity
      // via onUpdate. Background runs skip streaming — only start-id + poll.
      const streamEntries: StreamEntry[] = [];
      const onStreamEvent: StreamCallback | undefined = background
        ? undefined
        : (event: StreamEvent) => {
            // Parent cancelled: stop emitting transient stream updates so the
            // tool row freezes instead of continuing to show a dead run.
            if (ctx.signal?.aborted) return;
            if (event.type === "text_delta") {
              if (!event.delta) return;
              streamEntries.push({ type: "text", text: event.delta });
            } else if (event.type === "tool_start") {
              streamEntries.push({ type: "tool_start", name: event.name });
            } else if (event.type === "tool_end") {
              streamEntries.push({ type: "tool_end", name: event.name, error: !!event.error });
            }
            const streamText = formatExpandedStream(streamEntries);
            onUpdate?.({
              content: [{ type: "text", text: streamText }],
              details: { streamText, streamEntries: [...streamEntries] },
            });
          };

      const exec = () =>
        runSubagent({
          type,
          prompt: params.prompt,
          cwd: ctx.cwd,
          model,
          ...(type === "explore"
            ? { tools: exploreTools }
            : type === "researcher"
              ? { tools: researcherTools }
              : {}),
          excludeExtraTools: cfg.general.excludeExtraTools,
          onStreamEvent,
          abortSignal: background ? undefined : ctx.signal,
        });
      // Notify only for background settles — foreground returns its result
      // inline, so a toast would be duplicate noise.
      const onSettled =
        background && ctx.hasUI
          ? (rec: AgentRecord) =>
              ctx.ui.notify(settledText(rec), rec.status === "completed" ? "info" : "error")
          : undefined;

      const { record, done } = manager.launch(
        { type, description: params.description, background },
        exec,
        onSettled,
      );

      if (background) {
        record.warnings = warnings;
        return textResult(
          `Started ${type} Subagent ${record.id} (background). Poll with get_subagent_result.`,
          {
            agent_id: record.id,
            status: record.status,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        );
      }

      const rec = await done; // foreground: block
      if (rec.status === "failed") throw new Error(`Subagent failed: ${rec.error}`);
      return textResult(rec.result ?? "(no output)", {
        agent_id: rec.id,
        status: rec.status,
        tokens: rec.tokens,
        toolUses: rec.toolUses,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Subagent Result",
    description: "Check status / retrieve the result of a background Subagent.",
    parameters: resultParams,
    async execute(_toolCallId, params) {
      const rec = await manager.getResult(params.agent_id, params.wait ?? false);
      const text =
        rec.status === "completed"
          ? (rec.result ?? "(no output)")
          : rec.status === "failed"
            ? `failed: ${rec.error}`
            : `status: ${rec.status}`;
      return textResult(text, { ...rec });
    },
  });

  pi.registerCommand("subagents", {
    description: "List Subagents and their status",
    handler: async (_args, ctx) => {
      const lines = manager.list().map((r) => `${r.id}  ${r.type}  ${r.status}  ${r.description}`);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No subagents yet", "info");
    },
  });
}