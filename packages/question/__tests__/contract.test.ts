/**
 * Question tool contract tests — Vitest.
 *
 * Verifies tool metadata, the 2-4 preset option validation rule, and the
 * non-interactive fallback behaviour.
 */

import { describe, it, expect } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import questionExtension from "../index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => {
      captured.push(tool as ToolDefinition);
    },
    on: () => {},
  } as unknown as ExtensionAPI;
}

function registerQuestion(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  questionExtension(makeFakeApi(tools));
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

function noUICtx(): ExtensionContext {
  return { hasUI: false } as ExtensionContext;
}

/**
 * Queue-based fake UI: each select/editor call returns the next scripted response.
 * Also provides no-op onTerminalInput and setWidget for the bounded dialog path.
 * Captured input handlers can be accessed via `sendKey`.
 * Captured editor calls (title + initial) are recorded in `capturedEditorCalls`.
 */
function scriptedCtx(responses: { select?: string; editor?: string }[]): {
  ctx: ExtensionContext;
  sendKey: (data: string) => void;
  capturedEditorCalls: { title: string; initial: string }[];
} {
  const queue = [...responses];
  const capturedEditorCalls: { title: string; initial: string }[] = [];
  let inputHandler: ((data: string) => void) | undefined;
  const ui = {
    select: async () => queue.shift()?.select,
    editor: async (title: string, initial: string) => {
      capturedEditorCalls.push({ title, initial });
      return queue.shift()?.editor;
    },
    onTerminalInput: (handler: (data: string) => { consume?: boolean }) => {
      inputHandler = handler;
      return () => {
        inputHandler = undefined;
      };
    },
    setWidget: () => {},
  } as unknown as ExtensionUIContext;
  return {
    ctx: { hasUI: true, ui } as ExtensionContext,
    sendKey: (data: string) => inputHandler?.(data),
    capturedEditorCalls,
  };
}

describe("question tool contract", () => {
  it("registers under the name 'question' with the 'Question' label", () => {
    const tool = registerQuestion();
    expect(tool.name).toBe("question");
    expect(tool.label).toBe("Question");
  });

  it("description advertises 2-4 options, free prose, and multi-select", () => {
    const tool = registerQuestion();
    expect(tool.description).toMatch(/2-4/);
    expect(tool.description).toMatch(/free[- ]prose/);
    expect(tool.description).toMatch(/multi[- ]?select/i);
  });

  it("parameter schema enforces exactly 2-4 preset options", () => {
    const tool = registerQuestion();
    const optionsSchema = (
      tool.parameters as {
        properties: { options: { minItems: number; maxItems: number; description: string } };
      }
    ).properties.options;
    expect(optionsSchema.minItems).toBe(2);
    expect(optionsSchema.maxItems).toBe(4);
    expect(optionsSchema.description).toMatch(/2-4/);
  });

  it("rejects a single preset option", async () => {
    const tool = registerQuestion();
    await expect(
      tool.execute(
        "tc",
        { question: "Pick one", options: [{ label: "Only" }] },
        undefined,
        undefined,
        noUICtx(),
      ),
    ).rejects.toThrow(/2-4 preset options/);
  });

  it("rejects five preset options", async () => {
    const tool = registerQuestion();
    await expect(
      tool.execute(
        "tc",
        {
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }],
        },
        undefined,
        undefined,
        noUICtx(),
      ),
    ).rejects.toThrow(/2-4 preset options/);
  });

  it("accepts exactly two preset options and surfaces a non-interactive fallback", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      undefined,
      undefined,
      noUICtx(),
    );
    expect(Array.isArray(result.content)).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Pick one");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  it("non-interactive fallback reports interaction: 'nonInteractive' and empty selectedLabels", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      undefined,
      undefined,
      noUICtx(),
    );
    const details = result.details as {
      interaction: string;
      selectedLabels: string[];
      options: unknown[];
    };
    expect(details.interaction).toBe("nonInteractive");
    expect(details.selectedLabels).toEqual([]);
    expect(details.options).toHaveLength(2);
  });

  it("single-select returns the selected label and interaction: 'preset'", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const { ctx, sendKey } = scriptedCtx([]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick one",
        header: "Size",
        options: [
          { label: "Right", description: "feels right", recommended: true },
          { label: "Wrong", description: "feels off" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    // Confirm the first (recommended) option via the bounded dialog
    sendKey(ENTER);
    const result = await resultPromise;
    const details = result.details as { interaction: string; selectedLabels: string[] };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["Right"]);
  });

  it("selecting the first option returns the recommended label", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const { ctx, sendKey } = scriptedCtx([]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick one",
        options: [{ label: "Second" }, { label: "First", recommended: true }],
      },
      undefined,
      undefined,
      ctx,
    );
    // The first (default-selected) option is the recommended one
    sendKey(ENTER);
    const result = await resultPromise;
    const details = result.details as { interaction: string; selectedLabels: string[] };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["First"]);
  });

  it("single-select free prose returns the typed answer and interaction: 'freeProse'", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const DOWN = "\x1b[B";
    const { ctx, sendKey } = scriptedCtx([
      // After selecting the free-text option, the tool opens an editor
      { editor: "  something custom  " },
    ]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "What now?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      undefined,
      undefined,
      ctx,
    );
    // Navigate to the free-text option (last of 3 items) and confirm
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);
    const result = await resultPromise;
    const details = result.details as {
      interaction: string;
      freeText?: string;
      selectedLabels: string[];
    };
    expect(details.interaction).toBe("freeProse");
    expect(details.freeText).toBe("something custom");
    expect(details.selectedLabels).toEqual([]);
  });

  it("free-prose editor title uses header when present, not unbounded question", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const DOWN = "\x1b[B";
    const { ctx, sendKey, capturedEditorCalls } = scriptedCtx([
      { editor: "  custom text  " },
    ]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "A very long question that would exceed any reasonable display budget if used as the editor title without capping",
        header: "Size",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      undefined,
      undefined,
      ctx,
    );
    // Navigate to the free-text option (last of 3 items) and confirm
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);
    await resultPromise;

    // The editor should have been called exactly once
    expect(capturedEditorCalls).toHaveLength(1);
    const editorTitle = capturedEditorCalls[0]!.title;
    // The title should be derived from the header, not the full question
    expect(editorTitle).toContain("Size");
    expect(editorTitle).not.toContain("long question that would exceed");
    // Should be significantly shorter than the unbounded question text
    const suffix = ": Type your answer";
    expect(editorTitle).toBe("Size" + suffix);
  });

  it("free-prose editor title caps the question when no header is given", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const DOWN = "\x1b[B";
    const { ctx, sendKey, capturedEditorCalls } = scriptedCtx([
      { editor: "  typed answer  " },
    ]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Are you absolutely, positively, without-a-doubt sure that you want to proceed with this action right now, here, today?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      undefined,
      undefined,
      ctx,
    );
    // Navigate to the free-text option (last of 3 items) and confirm
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);
    await resultPromise;

    // The editor should have been called exactly once
    expect(capturedEditorCalls).toHaveLength(1);
    const editorTitle = capturedEditorCalls[0]!.title;
    // The title should be a capped version, not the full question
    expect(editorTitle).not.toContain("today?");  // the full question ends with this
    expect(editorTitle).not.toContain("right now"); // middle section beyond cap
    // The bounded portion (before ': Type your answer') should be ≤ 60 chars
    const suffix = ": Type your answer";
    expect(editorTitle).toContain(suffix);
    const boundedPortion = editorTitle.slice(0, -suffix.length);
    expect(boundedPortion.length).toBeLessThanOrEqual(60);
    // Should end with the truncation suffix
    expect(boundedPortion).toMatch(/…$/);
  });

  it("multi-select collects several preset picks and reports interaction: 'preset'", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const DOWN = "\x1b[B";
    const { ctx, sendKey } = scriptedCtx([]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick any",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
      undefined,
      undefined,
      ctx,
    );

    // Dialog 1: ○ A, ○ B, ○ C, ✎ Type..., ✓ Done
    // Select A (first item, already focused)
    sendKey(ENTER);
    await new Promise((r) => setTimeout(r, 5));

    // Dialog 2: ✓ A, ○ B, ○ C, ✎ Type..., ✓ Done
    // Select B (navigate down once)
    sendKey(DOWN);
    sendKey(ENTER);
    await new Promise((r) => setTimeout(r, 5));

    // Dialog 3: ✓ A, ✓ B, ○ C, ✎ Type..., ✓ Done
    // Navigate to Done (4 downs from first item)
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);

    const result = await resultPromise;
    const details = result.details as { interaction: string; selectedLabels: string[] };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["A", "B"]);
  });

  it("multi-select with free prose includes the typed answer alongside preset labels", async () => {
    const tool = registerQuestion();
    const ENTER = "\r";
    const DOWN = "\x1b[B";
    const { ctx, sendKey } = scriptedCtx([
      { editor: "my own" },
    ]);
    const resultPromise = tool.execute(
      "tc",
      {
        question: "Pick any",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }],
      },
      undefined,
      undefined,
      ctx,
    );

    // Dialog 1: ○ A, ○ B, ✎ Type..., ✓ Done (4 items, cursor at A)
    // Navigate to free text (index 2, need 2 downs) and confirm
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);
    await new Promise((r) => setTimeout(r, 5));

    // Tool collected free text via editor ("my own" from queue)
    // Dialog 2 (hasFreeText=true): ○ A, ○ B, ✓ Done (3 items, cursor at A)
    // Select A
    sendKey(ENTER);
    await new Promise((r) => setTimeout(r, 5));

    // Dialog 3: ✓ A, ○ B, ✓ Done (3 items, cursor at A)
    // Navigate to Done (index 2, need 2 downs)
    sendKey(DOWN);
    sendKey(DOWN);
    sendKey(ENTER);

    const result = await resultPromise;
    const details = result.details as {
      interaction: string;
      selectedLabels: string[];
      freeText?: string;
    };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["A"]);
    expect(details.freeText).toBe("my own");
  });
});