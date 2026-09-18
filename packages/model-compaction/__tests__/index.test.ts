import { describe, it, expect } from "vitest";
import type {
  CompactOptions,
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

// ─── Fake Pi API ─────────────────────────────────────────────────────────────

type TurnEndHandler = (event: unknown, ctx: ExtensionContext) => void;

function setup(
  initial: ContextUsage | undefined,
  compactImpl?: (options?: CompactOptions) => void,
) {
  const currentUsage = initial;
  let turnEnd: TurnEndHandler | undefined;
  const compactOptions: CompactOptions[] = [];

  const api = {
    on: (event: string, handler: unknown) => {
      if (event === "turn_end") turnEnd = handler as TurnEndHandler;
    },
  } as unknown as ExtensionAPI;

  extension(api);

  const ctx = {
    getContextUsage: () => currentUsage,
    compact: (options?: CompactOptions) => {
      compactOptions.push(options ?? {});
      compactImpl?.(options);
    },
  } as unknown as ExtensionContext;

  return {
    fireTurnEnd: () => turnEnd!({ type: "turn_end" }, ctx),
    compactOptions,
  };
}

function usage(tokens: number, contextWindow = 200_000): ContextUsage {
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

// ─── Trigger on completed turns ──────────────────────────────────────────────

describe("turn_end compaction trigger", () => {
  it("starts one compaction for a completed turn at the boundary", () => {
    const session = setup(usage(100_000));
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(1);
  });

  it("starts compaction above the boundary", () => {
    const session = setup(usage(180_000));
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(1);
  });

  it("does not start compaction below the boundary", () => {
    const session = setup(usage(99_999));
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(0);
  });

  it("does not start compaction on unknown context usage", () => {
    const session = setup(undefined);
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(0);
  });

  it("does not start a second compaction while the first request is active", () => {
    const session = setup(usage(180_000));
    session.fireTurnEnd();
    session.fireTurnEnd();
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(1);
  });

  it("starts another compaction after the active request completes", () => {
    const session = setup(usage(180_000));
    session.fireTurnEnd();
    session.compactOptions[0].onComplete?.({
      summary: "s",
      firstKeptEntryId: "e",
      tokensBefore: 180_000,
    });
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(2);
  });

  it("clears the in-progress guard when the request fails", () => {
    const session = setup(usage(180_000));
    session.fireTurnEnd();
    session.compactOptions[0].onError?.(new Error("boom"));
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(2);
  });

  it("clears the in-progress guard when the compaction call throws synchronously", () => {
    const session = setup(usage(180_000), () => {
      throw new Error("session inactive");
    });
    expect(() => session.fireTurnEnd()).not.toThrow();
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(2);
  });

  it("leaves the guard set while a request is genuinely pending", () => {
    const session = setup(usage(180_000));
    session.fireTurnEnd();
    // No callback fired yet: the request is still active.
    session.fireTurnEnd();
    expect(session.compactOptions).toHaveLength(1);
  });
});