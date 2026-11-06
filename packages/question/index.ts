import type {
  ExtensionAPI,
  AgentToolResult,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderQuestionCall, renderQuestionResult, type QuestionResultDetails } from "./render.ts";
import {
  BoundedQuestionDialog,
  boundedEditorTitle,
  DONE_VALUE,
  FREE_TEXT_VALUE,
  presetOptionValue,
} from "./dialog.ts";
import type { SelectItem } from "@earendil-works/pi-tui";

function textResult(
  text: string,
  details: QuestionResultDetails,
): AgentToolResult<QuestionResultDetails> {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Question tool. Pi has no built-in interactive question tool; this adds one so
 * the grilling/review skills can ask structured questions with preset options
 * plus an automatic free-prose escape hatch.
 *
 * Interactive rendering is owned by the package: a BoundedQuestionDialog TUI
 * widget keeps the prompt and options inside the display budget (bounded header,
 * wrapped but untruncated option labels), and free prose is collected through
 * ctx.ui.editor under a short bounded title. Multi-select redraws the dialog
 * until the user picks Done.
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

/** First label that appears more than once, if any. */
function duplicateLabel(options: readonly Option[]): string | undefined {
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.label)) return option.label;
    seen.add(option.label);
  }
  return undefined;
}

function ordered(options: Option[]): Option[] {
  return [...options].toSorted((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
}

function display(o: Option): string {
  return `${o.label}${o.recommended ? "  (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`;
}

/**
 * Rejection reason for a question interrupted by Pi-level cancellation. Pi
 * aborts the run's signal (Escape/Ctrl+C during the turn); the tool follows the
 * built-in tools' convention of rejecting with an actionable error rather than
 * returning a plausible-looking answer nobody confirmed.
 */
function cancellationError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message) {
    return new Error(`Question cancelled: ${reason.message}`);
  }
  return new Error("Question cancelled");
}

/**
 * Show a BoundedQuestionDialog interactively, returning the selected display
 * string when the user confirms, or undefined when they cancel (Escape).
 *
 * Renders as a TUI widget and forwards terminal input until a choice is made.
 * Cancelling or aborting always removes the widget and the terminal input
 * handler, so later interaction is not fed into a dead dialog; an aborted
 * signal additionally rejects with a cancellation error.
 */
async function showBoundedDialog(
  ctx: ExtensionUIContext,
  dialog: BoundedQuestionDialog,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false;
    let unsubscribeInput: (() => void) | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      unsubscribeInput?.();
      ctx.setWidget("bounded-question-dialog", undefined);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(cancellationError(signal));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    unsubscribeInput = ctx.onTerminalInput((keyData) => {
      dialog.handleInput(keyData);
      return { consume: true };
    });

    dialog.onSelect = (item: SelectItem) => {
      cleanup();
      resolve(item.value);
    };
    dialog.onCancel = () => {
      cleanup();
      resolve(undefined);
    };

    ctx.setWidget("bounded-question-dialog", () => dialog);
  });
}

/**
 * Unconfirmed interaction result for a cancelled question: Escape reports "No
 * selection" exactly like a single-select cancellation, with no labels and no
 * free prose, because none of the discarded input counts as an answer.
 */
function noSelectionResult(options: Option[]): AgentToolResult<QuestionResultDetails> {
  return textResult("No selection", {
    options,
    freeTextLabel: FREE_TEXT_LABEL,
    selectedLabels: [] as string[],
    interaction: "none" as const,
  });
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const options = ordered(params.options as Option[]);
      if (options.length < 2 || options.length > 4) {
        throw new Error("question: provide 2-4 preset options");
      }
      const duplicate = duplicateLabel(options);
      if (duplicate !== undefined) {
        throw new Error(
          `question: duplicate option label ${JSON.stringify(duplicate)} — every preset option needs a distinct label so answers stay unambiguous`,
        );
      }

      const optionDisplays = options.map(display);

      if (!ctx.hasUI) {
        // No interactive UI (print/json mode): surface the question as text so
        // the workflow can still proceed (the model relays it to the user).
        const prose = `${params.header ? params.header + ": " : ""}${params.question}\n  · ${[...optionDisplays, FREE_TEXT_DISPLAY].join("\n  · ")}`;
        return textResult(prose, {
          options,
          freeTextLabel: FREE_TEXT_LABEL,
          selectedLabels: [] as string[],
          interaction: "nonInteractive",
        });
      }

      const title = params.header ? `${params.header}: ${params.question}` : params.question;
      const boundedTitle = boundedEditorTitle(params.header, params.question);
      const collectFreeText = async (): Promise<string | undefined> =>
        (await ctx.ui.editor(`${boundedTitle}: ${FREE_TEXT_LABEL}`, ""))?.trim() || undefined;

      // Map selections back by item identity, not by re-parsing display
      // strings — labels may legitimately contain "—", "(recommended)", or
      // even control text like Done.
      const byValue = new Map(options.map((option, index) => [presetOptionValue(index), option]));

      if (params.multiSelect) {
        const chosen: Option[] = [];
        let freeText: string | undefined;
        // Value of the item that should start focused when the dialog is
        // recreated: the just-toggled preset option, or Done after the
        // free-prose row is removed.
        let initialFocusValue: string | undefined;
        for (;;) {
          const boundedDialog = new BoundedQuestionDialog({
            title,
            options,
            freeTextLabel: FREE_TEXT_LABEL,
            multiSelect: true,
            chosenLabels: chosen.map((o) => o.label),
            hasFreeText: !!freeText,
            initialFocusValue,
          });
          const sel = await showBoundedDialog(ctx.ui, boundedDialog, signal);
          // Only Done confirms. Escape (undefined) discards every choice and
          // free-prose answer collected during this interaction.
          if (sel === undefined) {
            return noSelectionResult(options);
          }
          if (sel === DONE_VALUE) break;
          if (sel === FREE_TEXT_VALUE) {
            freeText = await collectFreeText();
            initialFocusValue = DONE_VALUE;
            continue;
          }
          const opt = byValue.get(sel);
          if (opt) {
            const idx = chosen.indexOf(opt);
            if (idx >= 0) {
              chosen.splice(idx, 1); // deselect
            } else {
              chosen.push(opt); // select
            }
            initialFocusValue = sel;
          } else {
            initialFocusValue = undefined;
          }
        }
        const labels = chosen.map((o) => o.label);
        const hasFreeText = !!freeText;
        return textResult(
          [
            `Selected: ${labels.join(", ") || "(none)"}`,
            hasFreeText ? `Free text: ${freeText}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          {
            options,
            freeTextLabel: FREE_TEXT_LABEL,
            selectedLabels: labels,
            ...(hasFreeText ? { freeText } : {}),
            interaction:
              labels.length > 0
                ? ("preset" as const)
                : hasFreeText
                  ? ("freeProse" as const)
                  : ("none" as const),
          },
        );
      }

      const boundedDialog = new BoundedQuestionDialog({
        title,
        options,
        freeTextLabel: FREE_TEXT_LABEL,
      });
      const sel = await showBoundedDialog(ctx.ui, boundedDialog, signal);
      if (sel === undefined) {
        return noSelectionResult(options);
      }
      if (sel === FREE_TEXT_VALUE) {
        const freeText = await collectFreeText();
        const hasText = !!freeText;
        return textResult(hasText ? `Free text: ${freeText}` : "No selection", {
          options,
          freeTextLabel: FREE_TEXT_LABEL,
          selectedLabels: [] as string[],
          freeText: hasText ? freeText : undefined,
          interaction: hasText ? ("freeProse" as const) : ("none" as const),
        });
      }
      const selected = byValue.get(sel)?.label;
      const hasSelection = !!selected;
      return textResult(hasSelection ? `Selected: ${selected}` : "No selection", {
        options,
        freeTextLabel: FREE_TEXT_LABEL,
        selectedLabels: hasSelection ? [selected!] : ([] as string[]),
        interaction: hasSelection ? ("preset" as const) : ("none" as const),
      });
    },
  });
}