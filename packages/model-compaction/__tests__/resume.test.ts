import { describe, it, expect } from "vitest";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_CONTEXT, isInterruptedWork } from "../resume.ts";

function turn(toolResults: unknown[]): Pick<TurnEndEvent, "toolResults"> {
  return { toolResults } as Pick<TurnEndEvent, "toolResults">;
}

describe("interrupted-work continuation decision", () => {
  it("treats a turn that produced tool results as interrupted work", () => {
    expect(isInterruptedWork(turn([{ role: "toolResult", toolName: "bash" }]))).toBe(true);
  });

  it("treats a text-only turn as complete", () => {
    expect(isInterruptedWork(turn([]))).toBe(false);
  });

  it("carries non-empty continuation text", () => {
    expect(CONTINUATION_CONTEXT.trim().length).toBeGreaterThan(0);
  });
});