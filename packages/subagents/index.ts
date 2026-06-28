import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolveAgentType, exploreToolset, researcherToolset } from "./agents.ts";
import { runSubagent } from "./runner.ts";
import { AgentManager, type AgentRecord } from "./manager.ts";
import { resolveTypeDefaultModel, checkDefaultModelWarnings } from "./model-ref.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/**
 * Sub-agent extension. Two types for context hygiene — `explore` (read-only
 * discovery) and `general` (scoped read/write). The Agent tool surface follows
 * @tintinweb/pi-subagents loosely (not verbatim): Agent + get_subagent_result +
 * a concurrency queue; no Plan agent, steering, resume, or custom .pi/agents.
 *
 * Scheduling/records/concurrency live in AgentManager; this file only wires Pi
 * tools to it and supplies the env-bound exec thunk.
 */

const agentParams = Type.Object({
  subagent_type: StringEnum(["explore", "general", "researcher"] as const),
  prompt: Type.String({ description: "The task for the sub-agent" }),
  description: Type.String({ description: "Short 3-5 word summary shown in UI" }),
  run_in_background: Type.Optional(Type.Boolean({ description: "Return an id immediately instead of blocking" })),
});

const resultParams = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean({ description: "Block until the agent finishes" })),
});

function settledText(rec: AgentRecord): string {
  return rec.status === "completed"
    ? `\u2713 ${rec.type} (${rec.description}) \u2014 ${rec.toolUses} tool uses`
    : `\u2717 ${rec.type} (${rec.description}) ${rec.status}: ${rec.error ?? ""}`;
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
      excludeExtraTools: Array.isArray(raw.general?.excludeExtraTools) ? raw.general.excludeExtraTools : [],
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
    label: "Sub-agent",
    description:
      "Launch a sub-agent in an isolated session to keep the main context clean. " +
      "subagent_type='explore' is read-only codebase discovery (read/grep/find/ls); 'researcher' is " +
      "read-only web research (web_search/web_fetch + read); 'general' has full tools. " +
      "Foreground (default) blocks and returns the result; run_in_background:true returns an id you " +
      "poll with get_subagent_result.",
    promptSnippet: "Run an explore (read-only), researcher (web), or general sub-agent in an isolated context",
    promptGuidelines: [
      "Use subagent_type='explore' to gather codebase context and 'researcher' to gather web/external context without polluting the main context; use 'general' for off-context work that writes.",
    ],
    parameters: agentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      const exec = () =>
        runSubagent({
          type,
          prompt: params.prompt,
          cwd: ctx.cwd,
          model,
          ...(type === "explore" ? { tools: exploreTools } : type === "researcher" ? { tools: researcherTools } : {}),
          excludeExtraTools: cfg.general.excludeExtraTools,
        });
      // Notify only for background settles — foreground returns its result
      // inline, so a toast would be duplicate noise.
      const onSettled =
        background && ctx.hasUI
          ? (rec: AgentRecord) => ctx.ui.notify(settledText(rec), rec.status === "completed" ? "info" : "error")
          : undefined;

      const { record, done } = manager.launch(
        { type, description: params.description, background },
        exec,
        onSettled,
      );

      if (background) {
        record.warnings = warnings;
        return textResult(`Started ${type} sub-agent ${record.id} (background). Poll with get_subagent_result.`, {
          agent_id: record.id,
          status: record.status,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      }

      const rec = await done; // foreground: block
      if (rec.status === "failed") throw new Error(`Sub-agent failed: ${rec.error}`);
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
    label: "Sub-agent Result",
    description: "Check status / retrieve the result of a background sub-agent.",
    parameters: resultParams,
    async execute(_toolCallId, params) {
      const rec = await manager.getResult(params.agent_id, params.wait ?? false);
      const text =
        rec.status === "completed"
          ? rec.result ?? "(no output)"
          : rec.status === "failed"
            ? `failed: ${rec.error}`
            : `status: ${rec.status}`;
      return textResult(text, { ...rec });
    },
  });

  pi.registerCommand("subagents", {
    description: "List sub-agents and their status",
    handler: async (_args, ctx) => {
      const lines = manager.list().map((r) => `${r.id}  ${r.type}  ${r.status}  ${r.description}`);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No sub-agents yet", "info");
    },
  });
}
