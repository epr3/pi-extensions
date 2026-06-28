import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderQuestionCall, renderQuestionResult, type QuestionResultDetails } from "./render.ts";

function textResult(text: string, details: QuestionResultDetails): AgentToolResult<QuestionResultDetails> {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Question tool. Pi has no built-in interactive question tool; this adds one so
 * the grilling/review skills can ask structured questions with preset options
 * plus an automatic free-prose escape hatch. Backed by ctx.ui.select (single) —
 * multi-select is approximated by repeated selection until the user picks "Done".
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
  options: Type.Array(optionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "2-4 mutually-exclusive options",
  }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing more than one" })),
});

type Option = { label: string; description?: string; recommended?: boolean };

const FREE_TEXT_LABEL = "Type your answer";
const FREE_TEXT_DISPLAY = `✎ ${FREE_TEXT_LABEL} — Write a custom response`;
const DONE_DISPLAY = "✓ Done";

function uniqueDisplay(base: string, used: readonly string[]): string {
  let out = base;
  for (let i = 2; used.includes(out); i++) out = `${base} (${i})`;
  return out;
}

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
      "Ask the user a structured question and block until they answer. " +
      "Provide 2-4 short, mutually-exclusive preset options; the UI automatically adds a free-prose answer. " +
      "Mark the suggested option recommended:true. Set multiSelect:true when several preset answers can apply.",
    promptSnippet: "Ask the user a structured question with preset options and free prose",
    promptGuidelines: [
      "Use question when a skill needs a decision from the user with discrete options; the picker adds a free-prose escape hatch.",
    ],
    parameters,
    renderCall: renderQuestionCall,
    renderResult: renderQuestionResult,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = ordered(params.options as Option[]);
      if (options.length < 2 || options.length > 4) {
        throw new Error("question: provide 2-4 preset options");
      }

      const optionDisplays = options.map(display);
      const freeTextDisplay = uniqueDisplay(FREE_TEXT_DISPLAY, [...optionDisplays, DONE_DISPLAY]);

      if (!ctx.hasUI) {
        // No interactive UI (print/json mode): surface the question as text so
        // the workflow can still proceed (the model relays it to the user).
        const prose = `${params.header ? params.header + ": " : ""}${params.question}\n  · ${[...optionDisplays, freeTextDisplay].join("\n  · ")}`;
        return textResult(prose, {
          options,
          freeTextLabel: FREE_TEXT_LABEL,
          selectedLabels: [] as string[],
          interaction: "nonInteractive",
        });
      }

      const title = params.header ? `${params.header}: ${params.question}` : params.question;
      const collectFreeText = async (): Promise<string | undefined> =>
        (await ctx.ui.editor(`${title}: ${FREE_TEXT_LABEL}`, ""))?.trim() || undefined;

      // Map selections back by index, not by re-parsing display strings —
      // labels may legitimately contain "—" or "(recommended)".
      const byDisplay = (sel: string): Option | undefined => options[optionDisplays.indexOf(sel)];

      if (params.multiSelect) {
        const chosen: Option[] = [];
        let freeText: string | undefined;
        for (;;) {
          const remaining = optionDisplays.filter((_, i) => !chosen.includes(options[i]!));
          const selections = freeText
            ? [...remaining, DONE_DISPLAY]
            : [...remaining, freeTextDisplay, DONE_DISPLAY];
          const sel = await ctx.ui.select(
            `${title}${chosen.length ? `  [chosen: ${chosen.map((o) => o.label).join(", ")}]` : ""}`,
            selections,
          );
          if (sel === undefined || sel === DONE_DISPLAY) break;
          if (sel === freeTextDisplay) {
            freeText = await collectFreeText();
            continue;
          }
          const opt = byDisplay(sel);
          if (opt && !chosen.includes(opt)) chosen.push(opt);
        }
        const labels = chosen.map((o) => o.label);
        const hasFreeText = !!freeText;
        return textResult(
          [`Selected: ${labels.join(", ") || "(none)"}`, hasFreeText ? `Free text: ${freeText}` : ""]
            .filter(Boolean)
            .join("\n"),
          {
            options,
            freeTextLabel: FREE_TEXT_LABEL,
            selectedLabels: labels,
            ...(hasFreeText ? { freeText } : {}),
            interaction: labels.length > 0 ? ("preset" as const) : hasFreeText ? ("freeProse" as const) : ("none" as const),
          },
        );
      }

      const sel = await ctx.ui.select(title, [...optionDisplays, freeTextDisplay]);
      if (sel === freeTextDisplay) {
        const freeText = await collectFreeText();
        const hasText = !!freeText;
        return textResult(
          hasText ? `Free text: ${freeText}` : "No selection",
          {
            options,
            freeTextLabel: FREE_TEXT_LABEL,
            selectedLabels: [] as string[],
            freeText: hasText ? freeText : undefined,
            interaction: hasText ? ("freeProse" as const) : ("none" as const),
          },
        );
      }
      const selected = sel === undefined ? undefined : byDisplay(sel)?.label;
      const hasSelection = !!selected;
      return textResult(
        hasSelection ? `Selected: ${selected}` : "No selection",
        {
          options,
          freeTextLabel: FREE_TEXT_LABEL,
          selectedLabels: hasSelection ? [selected!] : ([] as string[]),
          interaction: hasSelection ? ("preset" as const) : ("none" as const),
        },
      );
    },
  });
}