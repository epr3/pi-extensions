import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/**
 * Question tool. Pi has no built-in interactive question tool; this adds one so
 * the grilling/review skills can ask structured multiple-choice questions
 * instead of free prose. Backed by ctx.ui.select (single) — multi-select is
 * approximated by repeated selection until the user picks "Done".
 *
 * Shape mirrors AskUserQuestion / OpenCode's question: a header, a question,
 * 2-4 options, the recommended one marked and shown first.
 */

const optionSchema = Type.Object({
  label: Type.String({ description: "Short option label" }),
  description: Type.Optional(Type.String({ description: "One-line elaboration" })),
  recommended: Type.Optional(Type.Boolean({ description: "Mark as the suggested choice" })),
});

const parameters = Type.Object({
  question: Type.String({ description: "The question to ask" }),
  header: Type.Optional(Type.String({ description: "Short label shown above the question" })),
  options: Type.Array(optionSchema, { description: "2-4 mutually-exclusive options" }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing more than one" })),
});

type Option = { label: string; description?: string; recommended?: boolean };

function ordered(options: Option[]): Option[] {
  return [...options].toSorted((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
}

function display(o: Option): string {
  return `${o.label}${o.recommended ? "  (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user a structured multiple-choice question and block until they answer. " +
      "Prefer this over asking in prose. Provide 2-4 short, mutually-exclusive options and mark " +
      "the suggested one recommended:true. Set multiSelect:true when several answers can apply.",
    promptSnippet: "Ask the user a multiple-choice question",
    promptGuidelines: [
      "Use question when a skill needs a decision from the user with discrete options, instead of asking in prose.",
    ],
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = ordered(params.options as Option[]);
      if (options.length < 2) throw new Error("question: provide at least 2 options");

      if (!ctx.hasUI) {
        // No interactive UI (print/json mode): surface the question as text so
        // the workflow can still proceed (the model relays it to the user).
        const prose = `${params.header ? params.header + ": " : ""}${params.question}\n  · ${options.map(display).join("\n  · ")}`;
        return textResult(prose, { options });
      }

      const title = params.header ? `${params.header}: ${params.question}` : params.question;

      // Map selections back by index, not by re-parsing display strings —
      // labels may legitimately contain "—" or "(recommended)".
      const displays = options.map(display);
      const byDisplay = (sel: string): Option | undefined => options[displays.indexOf(sel)];

      if (params.multiSelect) {
        const DONE = "✓ Done";
        const chosen: Option[] = [];
        for (;;) {
          const remaining = displays.filter((_, i) => !chosen.includes(options[i]!));
          const sel = await ctx.ui.select(
            `${title}${chosen.length ? `  [chosen: ${chosen.map((o) => o.label).join(", ")}]` : ""}`,
            [...remaining, DONE],
          );
          if (sel === undefined || sel === DONE) break;
          const opt = byDisplay(sel);
          if (opt && !chosen.includes(opt)) chosen.push(opt);
        }
        const labels = chosen.map((o) => o.label);
        return textResult(`Selected: ${labels.join(", ") || "(none)"}`, { selected: labels });
      }

      const sel = await ctx.ui.select(title, displays);
      const selected = sel === undefined ? undefined : byDisplay(sel)?.label;
      return textResult(selected ? `Selected: ${selected}` : "No selection", { selected });
    },
  });
}
