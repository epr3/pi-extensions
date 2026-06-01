import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { API_BASE_URL, MODEL_API_MAP } from "./constants";

type OpenCodeGoModelsResponse = {
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

export async function fetchModels(apiKey: string): Promise<ProviderModelConfig[]> {
	const response = await fetch(`${API_BASE_URL}/models`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
	}

	const json = (await response.json()) as OpenCodeGoModelsResponse;
	const models = json.data ?? [];

	return models.map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		reasoning: Boolean(model.reasoning),
		input: model.vision ? (["text", "image"] as const) : (["text"] as const),
		cost: {
			input: model.pricing?.input ?? 0,
			output: model.pricing?.output ?? 0,
			cacheRead: model.pricing?.cache_read ?? 0,
			cacheWrite: model.pricing?.cache_write ?? 0,
		},
		contextWindow: model.context_window ?? 128000,
		maxTokens: model.max_tokens ?? 32000,
		api: (MODEL_API_MAP[model.id] ?? "openai-completions") as ProviderModelConfig["api"],
	}));
}

export function getFallbackModels(): ProviderModelConfig[] {
	return Object.entries(MODEL_API_MAP).map(([id, api]) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text"] as const,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 32000,
		api: api as ProviderModelConfig["api"],
	}));
}
