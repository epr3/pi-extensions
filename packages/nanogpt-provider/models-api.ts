/**
 * nanoGPT API model fetching and mapping.
 */
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { COMPLETIONS_BASE_URL } from "./constants";
import { type NanoGptTier, NANO_GPT_TIERS } from "./tier-config";

const API_BASE_URL = "https://nano-gpt.com";

const MODEL_PATHS: Record<NanoGptTier, string> = {
  canonical: "/api/v1/models",
  subscription: "/api/subscription/v1/models",
  paid: "/api/paid/v1/models",
};

type NanoGptModelsResponse = {
  data?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    vision?: boolean;
    context_window?: number;
    max_tokens?: number;
    pricing?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    };
  }>;
};

function getModelsUrl(tier: NanoGptTier): string {
  return `${API_BASE_URL}${MODEL_PATHS[tier]}?detailed=true`;
}

export async function fetchModels(
  apiKey: string,
  tier: NanoGptTier,
): Promise<ProviderModelConfig[]> {
  const response = await fetch(getModelsUrl(tier), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as NanoGptModelsResponse;
  const models = json.data ?? [];

  return models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning),
    input: model.vision ? ["text", "image"] : ["text"],
    cost: {
      input: model.pricing?.input ?? 0,
      output: model.pricing?.output ?? 0,
      cacheRead: model.pricing?.cache_read ?? 0,
      cacheWrite: model.pricing?.cache_write ?? 0,
    },
    contextWindow: model.context_window ?? 128000,
    maxTokens: model.max_tokens ?? 32000,
  }));
}

export { COMPLETIONS_BASE_URL, NANO_GPT_TIERS };