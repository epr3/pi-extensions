import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { AgentManager, type SpawnOptions } from "./agent-manager.ts";
import { resolveAgentType, setCustomTypeConfigs } from "./agent-types.ts";
import { loadSettings } from "./settings.ts";
import { loadCustomTypeConfigs } from "./custom-types.ts";
import { writeTranscript } from "./transcripts.ts";

export function normalizeMaxTurns(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `Invalid max_turns: ${raw}. Must be a non-negative integer, 0 or undefined for unlimited.`,
    );
  }
  return raw > 0 ? raw : undefined;
}

const agentSchema = Type.Object({
  prompt: Type.String({
    minLength: 1,
    maxLength: 32000,
    description: "Task description for the subagent",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "Concise label for the subagent run",
  }),
  subagent_type: Type.String({
    minLength: 1,
    description: "Subagent type: plan, explore, general-purpose, or custom",
  }),
  run_in_background: Type.Optional(
    Type.Boolean({ description: "Execute in background (default: false)" }),
  ),
  max_turns: Type.Optional(
    Type.Number({
      description: "Maximum turns before stopping. 0 or undefined = unlimited",
    }),
  ),
  inherit_context: Type.Optional(
    Type.Boolean({
      description: "Inherit parent context. Default: true for general-purpose, false for plan/explore",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model identifier (provider/modelId)" }),
  ),
  allow_outside_cwd: Type.Optional(
    Type.Boolean({ description: "Allow reading outside working directory (default: false)" }),
  ),
  save_transcript: Type.Optional(
    Type.Boolean({ description: "Save transcript to .pi/subagents/runs/ (default: false)" }),
  ),
});

const getResultSchema = Type.Object({
  agent_id: Type.String({ description: "Agent ID returned by Agent tool" }),
  wait: Type.Optional(
    Type.Boolean({ description: "Wait for completion (default: false)" }),
  ),
  wait_ms: Type.Optional(
    Type.Number({ description: "Wait timeout in ms (default: 10000, max: 120000)" }),
  ),
  include_partial: Type.Optional(
    Type.Boolean({ description: "Include partial output for running subagents (default: false)" }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Include metadata in result (default: false)" }),
  ),
});

const listSchema = Type.Object({
  status: Type.Optional(
    Type.String({
      description: "Filter by status: queued, running, completed, error, stopped, or all (default)",
    }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Include detailed metadata (default: false)" }),
  ),
});

const stopSchema = Type.Object({
  agent_id: Type.String({ description: "Agent ID returned by Agent tool" }),
  reason: Type.Optional(
    Type.String({ description: "Optional reason for stopping" }),
  ),
});

const steerSchema = Type.Object({
  agent_id: Type.String({ description: "Agent ID of a running subagent" }),
  message: Type.String({
    minLength: 1,
    description: "Steering message to inject",
  }),
  priority: Type.Optional(
    Type.String({
      description: "Steering priority: normal or urgent (default: normal)",
    }),
  ),
});

// Lazy per-cwd manager + init state
const managerMap = new Map<string, AgentManager>();
const initMap = new Map<string, Promise<void>>();

async function ensureManager(cwd: string): Promise<AgentManager> {
  let manager = managerMap.get(cwd);
  if (manager) return manager;

  const pending = initMap.get(cwd);
  if (pending) {
    await pending;
    return managerMap.get(cwd)!;
  }

  const p = (async () => {
    const { settings, errors: _settingsErrors } = await loadSettings(cwd);
    if (settings.allowCustomSubagents) {
      const { configs, errors: _customErrors } = await loadCustomTypeConfigs(cwd);
      setCustomTypeConfigs(configs);
    }
    const mgr = new AgentManager(undefined, settings);
    managerMap.set(cwd, mgr);
  })();

  initMap.set(cwd, p);
  await p;
  initMap.delete(cwd);
  return managerMap.get(cwd)!;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "Spawn a subagent to complete a task. Supports foreground and background execution. Custom types from .pi/agents/*.md are available when allowCustomSubagents is enabled.",
    promptSnippet:
      "Use Agent to delegate tasks to a specialized subagent. Available types: plan, explore, general-purpose.",
    promptGuidelines: [
      "Use the subagent_type parameter to choose the subagent type",
      "Set run_in_background=true to run the subagent in the background",
      "Use get_subagent_result to retrieve background subagent results",
      "Use list_subagents to discover active subagent IDs",
      "Use stop_subagent to cancel queued or running background subagents",
      "plan and explore subagents are read-only; general-purpose has full tool access",
    ],
    parameters: agentSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const {
        prompt,
        description,
        subagent_type,
        run_in_background,
        max_turns: rawMaxTurns,
        inherit_context: rawInheritContext,
        model: modelStr,
        allow_outside_cwd,
        save_transcript: rawSaveTranscript,
      } = params as {
        prompt: string;
        description: string;
        subagent_type: string;
        run_in_background?: boolean;
        max_turns?: number;
        inherit_context?: boolean;
        model?: string;
        allow_outside_cwd?: boolean;
        save_transcript?: boolean;
      };

      if (!prompt || !prompt.trim()) {
        throw new Error("Agent prompt must be non-empty.");
      }
      if (!description || !description.trim()) {
        throw new Error("Agent description must be non-empty.");
      }
      if (prompt.length > 32000) {
        throw new Error("Agent prompt exceeds maximum length (32000 characters).");
      }
      if (description.length > 200) {
        throw new Error("Agent description exceeds maximum length (200 characters).");
      }

      const manager = await ensureManager(ctx.cwd);
      const { config, fallback } = resolveAgentType(subagent_type);

      const maxTurns = normalizeMaxTurns(rawMaxTurns);
      const inheritContext = rawInheritContext ?? (config.name === "general-purpose");

      let resolvedModel = ctx.model;
      let resolvedModelName: string | undefined;
      if (modelStr) {
        const slashIdx = modelStr.indexOf("/");
        if (slashIdx === -1) {
          throw new Error(`Invalid model format "${modelStr}". Expected "provider/modelId".`);
        }
        const provider = modelStr.slice(0, slashIdx);
        const modelId = modelStr.slice(slashIdx + 1);
        resolvedModel = ctx.modelRegistry.find(provider, modelId);
        if (!resolvedModel) {
          throw new Error(`Model "${modelStr}" not found in registry.`);
        }
        resolvedModelName = modelStr;
      }

      const saveTranscript = rawSaveTranscript ?? false;

      const spawnOpts: SpawnOptions = {
        description,
        prompt,
        subagentType: subagent_type,
        parentSystemPrompt: ctx.getSystemPrompt(),
        cwd: ctx.cwd,
        model: resolvedModel,
        modelName: resolvedModelName,
        modelRegistry: ctx.modelRegistry,
        maxTurns,
        inheritContext,
        allowOutsideCwd: allow_outside_cwd ?? false,
        signal,
        saveTranscript,
        onUpdate: (status: string) => {
          if (onUpdate) {
            onUpdate({
              content: [{ type: "text" as const, text: `Subagent ${status}...` }],
              details: undefined as any,
            });
          }
        },
      };

      if (run_in_background) {
        const agentId = manager.spawn(spawnOpts);
        const parts: string[] = [
          "Subagent started in background.",
          `Agent ID: ${agentId}`,
          "Use get_subagent_result to retrieve results.",
        ];
        if (fallback) {
          parts.push(`Note: Unknown subagent type "${subagent_type}" — falling back to general-purpose.`);
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { agentId },
        };
      }

      const { id, result } = await manager.spawnAndWait(spawnOpts);

      if (result.error && result.error !== "aborted") {
        const errorMsg = [`Subagent error.`, `Agent ID: ${id}`];
        if (result.text) {
          errorMsg.push(`Partial output:`, result.text);
        }
        errorMsg.push(`Error: ${result.error}`);
        throw new Error(errorMsg.join("\n"));
      }

      const output: string[] = [
        "Subagent completed.",
        `Agent ID: ${id}`,
        `Type: ${subagent_type}`,
        `Description: ${description}`,
        "Result:",
        result.text || "(no output)",
      ];

      if (fallback) {
        output.push(`Note: Unknown subagent type "${subagent_type}" — falling back to general-purpose.`);
      }
      if (result.wasLimited) {
        output.push(`Note: Subagent stopped — max_turns (${maxTurns}) reached.`);
      }

      // Write transcript if requested
      const run = manager.getRun(id);
      if (run && saveTranscript) {
        try {
          const path = await writeTranscript(ctx.cwd, run, prompt);
          run.transcriptPath = path;
          output.push(`Transcript saved: ${path}`);
        } catch { /* best effort */ }
      }

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
        details: { agentId: id, turnCount: result.turnCount },
      };
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "get_subagent_result",
    description: "Retrieve the result of a background subagent run by its agent ID. Optionally wait for completion.",
    parameters: getResultSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agent_id, wait, wait_ms, include_partial, verbose } = params as {
        agent_id: string;
        wait?: boolean;
        wait_ms?: number;
        include_partial?: boolean;
        verbose?: boolean;
      };

      const manager = await ensureManager(ctx.cwd);
      const run = manager.getRun(agent_id);
      if (!run) {
        throw new Error(`Unknown agent ID: ${agent_id}. The subagent may have expired or never existed.`);
      }

      const elapsed = Date.now() - run.startedAt;
      const isPending = run.status === "queued" || run.status === "running";

      if (isPending && wait) {
        const timeout = (typeof wait_ms === "number" && Number.isFinite(wait_ms) && wait_ms > 0)
          ? Math.min(wait_ms, 120_000)
          : 10_000;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline && (run.status === "queued" || run.status === "running")) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      const statusLine = `Status: ${run.status} (${formatDuration(elapsed)} elapsed)`;

      if (run.status === "queued" || run.status === "running") {
        const parts: string[] = [statusLine];
        if (include_partial && run.partialOutput) {
          parts.push("", "Partial output:", run.partialOutput);
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {} as any,
        };
      }

      const parts: string[] = [statusLine];

      if (run.status === "stopped") {
        if (run.stopReason) {
          parts.push(`Stop reason: ${run.stopReason}`);
        }
        if (run.partialOutput) {
          parts.push("", "Partial output:", run.partialOutput);
        }
        if (verbose) {
          parts.push("", formatVerboseMeta(run));
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {} as any,
        };
      }

      if (run.status === "completed") {
        if (run.result) {
          parts.push("", "Result:", run.result);
        }
        if (verbose) {
          parts.push("", formatVerboseMeta(run));
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {} as any,
        };
      }

      if (run.status === "error") {
        parts.push(`Error: ${run.error || "Unknown error"}`);
        if (run.result) {
          parts.push("", "Partial output:", run.result);
        }
        if (verbose) {
          parts.push("", formatVerboseMeta(run));
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {} as any,
        };
      }

      return {
        content: [{ type: "text" as const, text: statusLine }],
        details: {} as any,
      };
    },
  });

  pi.registerTool({
    name: "list_subagents",
    label: "list_subagents",
    description: "List active, queued, completed, errored, and stopped subagent runs.",
    parameters: listSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { status, verbose } = params as {
        status?: string;
        verbose?: boolean;
      };
      const filterStatus = (status ?? "all") as any;
      const manager = await ensureManager(ctx.cwd);
      const runs = manager.listRuns(filterStatus);

      if (runs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagent runs found." }],
          details: {} as any,
        };
      }

      const lines: string[] = [];
      const activeCount = manager.getActiveCount();
      const queuedCount = manager.getQueuedCount();

      for (const run of runs) {
        const elapsed = Date.now() - run.startedAt;
        const shortId = run.id.length > 24 ? run.id.slice(0, 24) + "…" : run.id;
        const desc = run.description.length > 40 ? run.description.slice(0, 40) + "…" : run.description;
        lines.push(`${run.status.padEnd(12)} ${shortId.padEnd(28)} ${run.type.padEnd(18)} ${formatDuration(elapsed).padEnd(8)} ${desc}`);

        if (verbose) {
          lines.push(`  Requested: ${run.requestedType}, Turns: ${run.turnCount}, Limited: ${run.wasLimited}`);
          if (run.stopReason) lines.push(`  Stop reason: ${run.stopReason}`);
          if (run.parentId) lines.push(`  Parent: ${run.parentId}, Depth: ${run.depth}`);
          if (run.model) lines.push(`  Model: ${run.model}`);
          if (run.transcriptPath) lines.push(`  Transcript: ${run.transcriptPath}`);
          if (run.error) lines.push(`  Error: ${run.error}`);
          lines.push(`  Started: ${new Date(run.startedAt).toISOString()}`);
          if (run.completedAt) lines.push(`  Completed: ${new Date(run.completedAt).toISOString()}`);
        }
      }

      const summary = activeCount > 0 || queuedCount > 0
        ? `${runs.length} run(s) shown. ${activeCount} active, ${queuedCount} queued.`
        : `${runs.length} run(s) shown.`;

      const header = verbose
        ? `ID                              Type               Elapsed  Description`
        : `Status       ID                            Type               Elapsed  Description`;

      return {
        content: [{ type: "text" as const, text: [header, ...lines, "", summary].join("\n") }],
        details: { count: runs.length, activeCount, queuedCount },
      };
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "stop_subagent",
    description: "Cancel a queued or running background subagent run.",
    parameters: stopSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agent_id, reason } = params as { agent_id: string; reason?: string };
      const manager = await ensureManager(ctx.cwd);
      const result = manager.stop(agent_id, reason);

      if (!result.ok) {
        throw new Error(result.message);
      }

      return {
        content: [{ type: "text" as const, text: result.message }],
        details: { agentId: agent_id, stopped: result.run?.status === "stopped" } as any,
      };
    },
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "steer_subagent",
    description: "Send a steering message to a running subagent. Only works if the Pi SDK session supports the steer API.",
    parameters: steerSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agent_id, message, priority } = params as {
        agent_id: string;
        message: string;
        priority?: string;
      };

      const manager = await ensureManager(ctx.cwd);
      const prio = priority === "urgent" ? "urgent" : "normal";
      const result = await manager.steer(agent_id, message, prio);

      if (!result.ok) {
        throw new Error(result.message);
      }

      return {
        content: [{ type: "text" as const, text: result.message }],
        details: { agentId: agent_id } as any,
      };
    },
  });

  pi.registerCommand("agents", {
    description: "Show subagent status overview",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const manager = await ensureManager(ctx.cwd);
      const runs = manager.listRuns("all");
      const active = manager.getActiveCount();
      const queued = manager.getQueuedCount();
      const running = runs.filter((r) => r.status === "running");
      const completed = runs.filter((r) => r.status === "completed");
      const error = runs.filter((r) => r.status === "error");
      const stopped = runs.filter((r) => r.status === "stopped");

      const lines = [
        "Subagent Status:",
        `  Active: ${active}   Queued: ${queued}`,
        `  Total runs: ${runs.length}`,
        `  Running: ${running.length}`,
        `  Completed: ${completed.length}`,
        `  Errored: ${error.length}`,
        `  Stopped: ${stopped.length}`,
      ];

      if (running.length > 0) {
        lines.push("", "Currently running:");
        for (const r of running) {
          const elapsed = Date.now() - r.startedAt;
          lines.push(`  ${r.id} — ${r.description} (${formatDuration(elapsed)})`);
        }
      }

      pi.sendMessage(
        { customType: "subagents-status", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
    },
  });

  pi.on("session_shutdown", () => {
    for (const [, manager] of managerMap) {
      manager.shutdown();
    }
    managerMap.clear();
    initMap.clear();
  });
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatVerboseMeta(run: {
  id: string;
  requestedType: string;
  type: string;
  status: string;
  toolUses: number;
  turnCount: number;
  wasLimited: boolean;
  startedAt: number;
  completedAt?: number;
  error?: string;
  stopReason?: string;
  parentId?: string;
  depth?: number;
  model?: string;
  transcriptPath?: string;
}): string {
  const lines: string[] = [
    "Metadata:",
    `  ID: ${run.id}`,
    `  Requested type: ${run.requestedType}`,
    `  Resolved type: ${run.type}`,
    `  Status: ${run.status}`,
    `  Tool uses: ${run.toolUses}`,
    `  Turn count: ${run.turnCount}`,
    `  Was limited: ${run.wasLimited}`,
    `  Started: ${new Date(run.startedAt).toISOString()}`,
  ];
  if (run.completedAt) {
    lines.push(`  Completed: ${new Date(run.completedAt).toISOString()}`);
  }
  if (run.error) {
    lines.push(`  Error: ${run.error}`);
  }
  if (run.stopReason) {
    lines.push(`  Stop reason: ${run.stopReason}`);
  }
  if (run.parentId) {
    lines.push(`  Parent: ${run.parentId}, Depth: ${run.depth ?? 0}`);
  }
  if (run.model) {
    lines.push(`  Model: ${run.model}`);
  }
  if (run.transcriptPath) {
    lines.push(`  Transcript: ${run.transcriptPath}`);
  }
  return lines.join("\n");
}
