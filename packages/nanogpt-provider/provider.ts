/**
 * nanoGPT provider registration.
 */
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { PROVIDER_ID, ENV_API_KEY, COMPLETIONS_BASE_URL } from "./constants";
import { type NanoGptTier, getNanoGptTier } from "./tier-config";
import { fetchModels } from "./models-api";

export function getSavedApiKey(): string | undefined {
  const envApiKey = process.env[ENV_API_KEY];
  if (envApiKey) {
    return envApiKey;
  }

  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access?: string }>;
    return auth[PROVIDER_ID]?.access;
  } catch {
    return undefined;
  }
}

export async function setupProvider(
  pi: ExtensionAPI,
  apiKey?: string,
  tier?: NanoGptTier,
): Promise<number> {
  const selectedTier = tier ?? getNanoGptTier();
  let models: ProviderModelConfig[] = [];

  if (apiKey) {
    try {
      models = await fetchModels(apiKey, selectedTier);
    } catch {
      models = [];
    }
  }

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: COMPLETIONS_BASE_URL,
    api: "openai-completions",
    authHeader: true,
    models,
    oauth: {
      name: "nanoGPT",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const newApiKey = await callbacks.onPrompt({
          message: "Enter your nanoGPT API key",
          placeholder: "sk-...",
        });

        await setupProvider(pi, newApiKey);

        return {
          access: newApiKey,
          refresh: newApiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return credentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return String(credentials.access ?? "");
      },
    },
  });

  return models.length;
}