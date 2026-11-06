/**
 * Stub model provider for the real-Pi lifecycle smoke harness.
 *
 * Pi runs for real; only the model service is replaced. The stub speaks the
 * OpenAI chat-completions streaming protocol Pi already supports, so a real Pi
 * process exercises its own extension host, session store, tool loop and
 * lifecycle events while responses stay deterministic and credential-free.
 *
 * See `scripts/pi-smoke/scenarios.ts` for per-invocation response plans and
 * `scripts/pi-smoke/README.md` for what this does and does not prove.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describeChatRequest, type JsonRecord, type StubRequest } from "./evaluate.ts";

export type StubResponse =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; toolName: string; input: JsonRecord };

export type CapturedRequest = StubRequest & { body: JsonRecord };

export type StubProvider = {
  /** Base URL to put in the smoke agent's `models.json`. */
  baseUrl: string;
  /** Requests captured since the last `reset`. */
  requests: CapturedRequest[];
  /** Install the response plan for the next invocation. */
  reset(plan: StubResponse[]): void;
  close(): Promise<void>;
};

const MODEL_ID = "smoke-model";

function chunks(response: StubResponse) {
  if (response.kind === "text") {
    return {
      deltas: [{ delta: { content: response.text }, finish: null }],
      finishReason: "stop",
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    };
  }
  return {
    deltas: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "smoke-call-1",
              type: "function",
              function: { name: response.toolName, arguments: JSON.stringify(response.input) },
            },
          ],
        },
        finish: null,
      },
    ],
    finishReason: "tool_calls",
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  };
}

export async function startStubProvider(): Promise<StubProvider> {
  let plan: StubResponse[] = [];
  const requests: CapturedRequest[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "stub provider: unsupported route" }));
      return;
    }
    let raw = "";
    request.on("data", (part) => (raw += part));
    request.on("end", () => {
      let body: JsonRecord = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          body = parsed as JsonRecord;
      } catch {
        // Keep the record; an unparsable body is itself evidence worth seeing.
      }
      requests.push({ ...describeChatRequest(body, requests.length + 1), body });

      const chosen = plan[Math.min(requests.length - 1, plan.length - 1)];
      if (!chosen) {
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "stub provider: no response plan" }));
        return;
      }

      const { deltas, finishReason, usage } = chunks(chosen);
      const base = {
        id: `smoke-${requests.length}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      for (const delta of deltas) {
        send({ ...base, choices: [{ index: 0, delta: delta.delta, finish_reason: delta.finish }] });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("stub provider: could not bind a loopback port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    reset(nextPlan: StubResponse[]) {
      plan = nextPlan;
      requests.length = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** `models.json` content that registers the stub as a Pi provider. */
export function modelsJson(baseUrl: string): string {
  return `${JSON.stringify(
    {
      providers: {
        smoke: {
          baseUrl,
          api: "openai-completions",
          apiKey: "smoke-key-not-a-secret",
          models: [
            {
              id: MODEL_ID,
              name: "Smoke Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

export const STUB_MODEL = `smoke/${MODEL_ID}`;