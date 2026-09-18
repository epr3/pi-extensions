import { describe, it, expect } from "vitest";
import type {
  CompactOptions,
  CompactionResult,
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { CONTINUATION_CONTEXT } from "../resume.ts";

// ─── Fake Pi API ─────────────────────────────────────────────────────────────

type TurnEndHandler = (event: unknown, ctx: ExtensionContext) => void;

interface SentMessage {
  message: { customType: string; content: unknown; display: boolean };
  options: { triggerTurn?: boolean } | undefined;
}

interface Notification {
  message: string;
  type: string | undefined;
}

function setup(
  initial: ContextUsage | undefined,
  compactImpl?: (options?: CompactOptions) => void,
) {
  let currentUsage = initial;
  let turnEnd: TurnEndHandler | undefined;
  const compactOptions: CompactOptions[] = [];
  const sentMessages: SentMessage[] = [];
  const notifications: Notification[] = [];

  const api = {
    on: (event: string, handler: unknown) => {
      if (event === "turn_end") turnEnd = handler as TurnEndHandler;
    },
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  extension(api);

  const ctx = {
    getContextUsage: () => currentUsage,
    compact: (options?: CompactOptions) => {
      compactOptions.push(options ?? {});
      compactImpl?.(options);
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;

  return {
    fireTurnEnd: (toolResults: unknown[] = []) => turnEnd!({ type: "turn_end", toolResults }, ctx),
    setUsage: (next: ContextUsage | undefined) => {
      currentUsage = next;
    },
    compactOptions,
    sentMessages,
    notifications,
  };
}

function usage(tokens: number, contextWindow = 200_000): ContextUsage {
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

const TOOL_RESULT = { role: "toolResult", toolName: "bash" };

function compactionResult(): CompactionResult {
  return {
    summary: "condensed history",
    firstKeptEntryId: "entry-1",
    tokensBefore: 180_000,
    estimatedTokensAfter: 10_000,
  };
}

/** Start a compaction for a completed turn and return its callbacks. */
function startCompaction(
  session: ReturnType<typeof setup>,
  toolResults: unknown[] = [],
): CompactOptions {
  session.fireTurnEnd(toolResults);
  return session.compactOptions[session.compactOptions.length - 1];
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
    session.compactOptions[0].onComplete?.(compactionResult());
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

// ─── Continuation after successful compaction ───────────────────────────────

describe("continuation after successful compaction", () => {
  it("injects hidden continuation context after a tool-result turn compacts", () => {
    const session = setup(usage(180_000));
    startCompaction(session, [TOOL_RESULT]).onComplete?.(compactionResult());

    expect(session.sentMessages).toHaveLength(1);
    expect(session.sentMessages[0].message.customType).toBe("model-compaction-continuation");
    expect(session.sentMessages[0].message.content).toBe(CONTINUATION_CONTEXT);
    expect(session.sentMessages[0].message.display).toBe(false);
    expect(session.sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  it("does not inject a continuation after a text-only turn compacts", () => {
    const session = setup(usage(180_000));
    startCompaction(session).onComplete?.(compactionResult());

    expect(session.sentMessages).toHaveLength(0);
  });

  it("does not inject a continuation when compaction fails", () => {
    const session = setup(usage(180_000));
    startCompaction(session, [TOOL_RESULT]).onError?.(new Error("boom"));

    expect(session.sentMessages).toHaveLength(0);
  });

  it("scopes the continuation to the turn that triggered the compaction", () => {
    const session = setup(usage(180_000));
    startCompaction(session, [TOOL_RESULT]).onComplete?.(compactionResult());
    startCompaction(session).onComplete?.(compactionResult());

    expect(session.sentMessages).toHaveLength(1);
  });
});

// ─── Failure visibility and retry ────────────────────────────────────────────

describe("failure visibility and retry", () => {
  it("notifies the user when compaction fails", () => {
    const session = setup(usage(180_000));
    startCompaction(session).onError?.(new Error("provider down"));

    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0].type).toBe("error");
    expect(session.notifications[0].message).toContain("provider down");
  });

  it("does not notify the user on success", () => {
    const session = setup(usage(180_000));
    startCompaction(session).onComplete?.(compactionResult());

    expect(session.notifications).toHaveLength(0);
  });

  it("retries after a later completed turn still at or above the threshold", () => {
    const session = setup(usage(180_000));
    startCompaction(session).onError?.(new Error("boom"));

    session.setUsage(usage(150_000));
    session.fireTurnEnd();

    expect(session.compactOptions).toHaveLength(2);
  });

  it("does not retry on a later completed turn below the threshold", () => {
    const session = setup(usage(180_000));
    startCompaction(session).onError?.(new Error("boom"));

    session.setUsage(usage(99_999));
    session.fireTurnEnd();

    expect(session.compactOptions).toHaveLength(1);
  });
});

// ─── Continuation and retry keep the model-aware boundary ────────────────────

describe("continuation preserves the model-aware boundary", () => {
  it("does not compact a later turn below the threshold after continuing", () => {
    const session = setup(usage(180_000));
    startCompaction(session, [TOOL_RESULT]).onComplete?.(compactionResult());

    session.setUsage(usage(99_999));
    session.fireTurnEnd();

    expect(session.compactOptions).toHaveLength(1);
  });

  it("compacts a later turn at the threshold after continuing", () => {
    const session = setup(usage(180_000));
    startCompaction(session, [TOOL_RESULT]).onComplete?.(compactionResult());

    session.setUsage(usage(100_000));
    session.fireTurnEnd();

    expect(session.compactOptions).toHaveLength(2);
  });
});