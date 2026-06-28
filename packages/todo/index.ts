import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/**
 * Todo extension. A persistent checklist so the agent can break an issue into
 * steps (or a plan into slices) and track progress. Pi omits the TodoWrite
 * facility Claude Code provides; this restores it.
 *
 * State lives in tool-result `details` (the documented branch-safe pattern) and
 * is reconstructed from the session branch on session_start, so it survives
 * turns, reloads, and tree navigation.
 */

type Status = "pending" | "in_progress" | "completed";
type Item = { content: string; status: Status };

const writeParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "What the step is" }),
      status: StringEnum(["pending", "in_progress", "completed"] as const),
    }),
    { description: "The full list (replaces the previous one)" },
  ),
});

const readParams = Type.Object({});

function summary(items: Item[]): string {
  const done = items.filter((t) => t.status === "completed").length;
  return `${done}/${items.length} done`;
}

function fmt(items: Item[]): string {
  const mark = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return items.map((t) => `${mark[t.status]} ${t.content}`).join("\n") || "(empty)";
}

export default function (pi: ExtensionAPI) {
  let items: Item[] = [];

  // Reconstruct from the latest todo_write result on the current branch.
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "todo_write"
      ) {
        items = (entry.message.details?.items as Item[]) ?? items;
      }
    }
  });

  pi.registerTool({
    name: "todo_write",
    label: "Write Todos",
    description:
      "Replace the todo list. Use to break an issue into steps or a plan into vertical slices, then " +
      "keep it current. Keep exactly one item in_progress at a time; mark items completed as you finish.",
    promptSnippet: "Track a checklist of steps/slices",
    promptGuidelines: [
      "Use todo_write to plan multi-step work (breaking an issue into steps or a plan into slices) and keep the list updated as you progress.",
    ],
    parameters: writeParams,
    async execute(_toolCallId, params) {
      items = (params.todos as Item[]).map((t) => ({ content: t.content, status: t.status }));
      const active = items.filter((t) => t.status === "in_progress").length;
      const text =
        `${summary(items)}\n${fmt(items)}` + (active > 1 ? "\n(warning: more than one in_progress)" : "");
      return textResult(text, { items: [...items] });
    },
  });

  pi.registerTool({
    name: "todo_read",
    label: "Read Todos",
    description: "Read the current todo list and a done/total summary.",
    parameters: readParams,
    async execute() {
      return textResult(`${summary(items)}\n${fmt(items)}`, { items: [...items] });
    },
  });
}
