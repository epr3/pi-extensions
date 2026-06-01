export const PROVIDER_ID = "opencode-go";
export const ENV_API_KEY = "OPENCODE_GO_API_KEY";
export const API_BASE_URL = "https://opencode.ai/zen/go/v1";

export type ModelApiType = "openai-completions" | "anthropic-messages";

export const MODEL_API_MAP: Record<string, ModelApiType> = {
	"glm-5.1": "openai-completions",
	"glm-5": "openai-completions",
	"kimi-k2.5": "openai-completions",
	"kimi-k2.6": "openai-completions",
	"deepseek-v4-pro": "openai-completions",
	"deepseek-v4-flash": "openai-completions",
	"mimo-v2.5": "openai-completions",
	"mimo-v2.5-pro": "openai-completions",
	"minimax-m3": "anthropic-messages",
	"minimax-m2.7": "anthropic-messages",
	"minimax-m2.5": "anthropic-messages",
	"qwen3.7-max": "anthropic-messages",
	"qwen3.6-plus": "anthropic-messages",
};
