/**
 * Question option identity tests — Vitest.
 *
 * Answer identity must not depend on formatted display text: duplicate labels
 * are rejected, distinct labels whose displays collide stay selectable, and no
 * preset option can act as the Done control or the free-prose escape hatch.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import questionExtension from "../index.ts";
import { BoundedQuestionDialog } from "../dialog.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

const FREE_PROSE_ROW = "✎ Type your answer — Write a custom response";

function registerQuestion(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  const api = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
    on: () => {},
  } as unknown as ExtensionAPI;
  questionExtension(api);
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

function noUICtx(): ExtensionContext {
  return { hasUI: false } as ExtensionContext;
}

/** Scripted interactive UI: the bounded dialog is driven with terminal keys. */
function scriptedCtx(responses: { editor?: string }[] = []): {
  ctx: ExtensionContext;
  sendKey: (data: string) => void;
  renderWidgetLines: (width: number) => string[];
} {
  const queue = [...responses];
  let inputHandler: ((data: string) => void) | undefined;
  let widgetRender: (() => Component) | undefined;
  const ui = {
    editor: async () => queue.shift()?.editor,
    onTerminalInput: (handler: (data: string) => { consume?: boolean }) => {
      inputHandler = handler;
      return () => {
        inputHandler = undefined;
      };
    },
    setWidget: (_id: string, render: (() => Component) | undefined) => {
      widgetRender = render;
    },
  } as unknown as ExtensionUIContext;
  return {
    ctx: { hasUI: true, ui } as ExtensionContext,
    sendKey: (data: string) => inputHandler?.(data),
    renderWidgetLines: (width: number) => {
      const dialog = widgetRender?.();
      return dialog ? dialog.render(width) : [];
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Single-select dialog whose preset options are the given labels. */
function singleSelectDialog(
  options: { label: string; recommended?: boolean }[],
): BoundedQuestionDialog {
  return new BoundedQuestionDialog({
    title: "Pick one",
    options,
    freeTextLabel: "Type your answer",
  });
}

describe("question option identity — duplicate labels", () => {
  it("rejects duplicate labels with an actionable error", async () => {
    const tool = registerQuestion();
    await expect(
      tool.execute(
        "tc",
        { question: "Pick one", options: [{ label: "Same" }, { label: "Same" }] },
        undefined,
        undefined,
        noUICtx(),
      ),
    ).rejects.toThrow(/duplicate option label "Same".*distinct/i);
  });

  it("rejects duplicate labels in multi-select before showing the dialog", async () => {
    const tool = registerQuestion();
    const { ctx, renderWidgetLines } = scriptedCtx();
    await expect(
      tool.execute(
        "tc",
        {
          question: "Pick any",
          multiSelect: true,
          options: [{ label: "A" }, { label: "Dup" }, { label: "Dup" }],
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/duplicate option label "Dup"/);
    expect(renderWidgetLines(80)).toEqual([]);
  });

  it("keeps non-duplicate labels working, including near-duplicates", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      {
        question: "Pick one",
        options: [{ label: "Same" }, { label: "same" }],
      },
      undefined,
      undefined,
      noUICtx(),
    );
    expect(
      (result.details as { options: { label: string }[] }).options.map((o) => o.label),
    ).toEqual(["Same", "same"]);
  });
});

describe("question option identity — colliding formatted displays", () => {
  it("returns the intended option when two distinct labels share a formatted display", async () => {
    const tool = registerQuestion();
    const { ctx, sendKey, renderWidgetLines } = scriptedCtx([]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick one",
        // Both labels have the same displayed text; focus must still make
        // their distinct option identities visible.
        options: [{ label: "A", recommended: true }, { label: "A  (recommended)" }],
      },
      undefined,
      undefined,
      ctx,
    );
    const initialRows = renderWidgetLines(80);
    expect(initialRows).toContain('→ "A"  (recommended)');
    expect(initialRows).toContain('  "A  (recommended)"');
    sendKey(ENTER);
    const firstResult = await resultPromise;
    expect((firstResult.details as { selectedLabels: string[] }).selectedLabels).toEqual(["A"]);

    const secondCtx = scriptedCtx([]);
    const secondPromise = tool.execute(
      "tc",
      {
        question: "Pick one",
        options: [{ label: "A", recommended: true }, { label: "A  (recommended)" }],
      },
      undefined,
      undefined,
      secondCtx.ctx,
    );
    expect(secondCtx.renderWidgetLines(80)).toContain('→ "A"  (recommended)');
    secondCtx.sendKey(DOWN);
    expect(secondCtx.renderWidgetLines(80)).toContain('→ "A  (recommended)"');
    secondCtx.sendKey(ENTER);
    const secondResult = await secondPromise;
    expect((secondResult.details as { selectedLabels: string[] }).selectedLabels).toEqual([
      "A  (recommended)",
    ]);
  });

  it("keeps an option labelled like Done selectable as itself in multi-select", async () => {
    const tool = registerQuestion();
    const { ctx, sendKey, renderWidgetLines } = scriptedCtx([]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick any",
        multiSelect: true,
        options: [{ label: "✓ Done" }, { label: "Other" }],
      },
      undefined,
      undefined,
      ctx,
    );

    // Confirming the ✓ Done-labelled option toggles it; it does not finish.
    sendKey(ENTER);
    await tick();
    expect(renderWidgetLines(80).join("\n")).toContain("→ ✓ ✓ Done");

    // Dialog 2: ✓ ✓ Done, ○ Other, ✎ Type..., ✓ Done. Finish from real Done.
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);
    const result = await resultPromise;
    const details = result.details as { interaction: string; selectedLabels: string[] };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["✓ Done"]);
  });

  it("keeps an option labelled like the free-prose row selectable as itself", async () => {
    const tool = registerQuestion();
    const { ctx, sendKey } = scriptedCtx([{ editor: "ignored" }]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick one",
        options: [{ label: FREE_PROSE_ROW }, { label: "Other" }],
      },
      undefined,
      undefined,
      ctx,
    );
    sendKey(ENTER);
    const result = await resultPromise;
    const details = result.details as {
      interaction: string;
      selectedLabels: string[];
      freeText?: string;
    };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual([FREE_PROSE_ROW]);
    expect(details.freeText).toBeUndefined();
  });

  it("still uses the free-prose row for free text when a preset label collides with it", async () => {
    const tool = registerQuestion();
    const { ctx, sendKey } = scriptedCtx([{ editor: "custom words" }]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick one",
        options: [{ label: FREE_PROSE_ROW }, { label: "Other" }],
      },
      undefined,
      undefined,
      ctx,
    );
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);
    const result = await resultPromise;
    const details = result.details as {
      interaction: string;
      selectedLabels: string[];
      freeText?: string;
    };
    expect(details.interaction).toBe("freeProse");
    expect(details.selectedLabels).toEqual([]);
    expect(details.freeText).toBe("custom words");
  });
});

describe("BoundedQuestionDialog item values", () => {
  it("reports item identity rather than display text for preset options", () => {
    const preset = singleSelectDialog([{ label: "Right", recommended: true }, { label: "Wrong" }]);
    const onSelect = vi.fn();
    preset.onSelect = onSelect;
    preset.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toBe("option:0");
    expect(onSelect.mock.calls[0]![0].label).toBe("Right  (recommended)");
  });

  it("keeps colliding display strings apart by item identity", () => {
    const colliding = singleSelectDialog([
      { label: "A", recommended: true },
      { label: "A  (recommended)" },
    ]);
    const onSelect = vi.fn();
    colliding.onSelect = onSelect;
    colliding.handleInput(DOWN);
    colliding.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toBe("option:1");
  });

  it("gives the free-prose row and Done distinct control identities", () => {
    const preset = singleSelectDialog([{ label: "✓ Done" }, { label: "Other" }]);
    const onSelect = vi.fn();
    preset.onSelect = onSelect;
    preset.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toBe("option:0");

    const multi = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
    });
    const onMultiSelect = vi.fn();
    multi.onSelect = onMultiSelect;
    multi.handleInput(DOWN);
    multi.handleInput(DOWN);
    multi.handleInput(ENTER);
    expect(onMultiSelect.mock.calls[0]![0].value).toBe("freeText");
    expect(onMultiSelect.mock.calls[0]![0].label).toBe(
      "✎ Type your answer — Write a custom response",
    );

    // Done keeps its own identity instead of sharing an option's.
    const done = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
    });
    const onDone = vi.fn();
    done.onSelect = onDone;
    for (let press = 0; press < 3; press++) done.handleInput(DOWN);
    done.handleInput(ENTER);
    expect(onDone.mock.calls[0]![0].value).toBe("done");
    expect(onDone.mock.calls[0]![0].label).toBe("✓ Done");
  });
});