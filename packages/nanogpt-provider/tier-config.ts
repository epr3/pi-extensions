/**
 * nanoGPT tier configuration persistence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const NANO_GPT_TIERS = ["canonical", "subscription", "paid"] as const;
export type NanoGptTier = (typeof NANO_GPT_TIERS)[number];

export const DEFAULT_TIER: NanoGptTier = "subscription";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "nanogpt-config.json");

type NanoGptConfig = {
  tier?: string;
};

function isNanoGptTier(value: unknown): value is NanoGptTier {
  return typeof value === "string" && (NANO_GPT_TIERS as readonly string[]).includes(value);
}

export function getNanoGptTier(): NanoGptTier {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return DEFAULT_TIER;
    }

    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as NanoGptConfig;
    return isNanoGptTier(config.tier) ? config.tier : DEFAULT_TIER;
  } catch {
    return DEFAULT_TIER;
  }
}

export function setNanoGptTier(tier: NanoGptTier): void {
  const config: NanoGptConfig = { tier };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}