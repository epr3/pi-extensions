/**
 * nanoGPT provider extension - provides /nanogpt-tier command for selecting API endpoint tier.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { NANO_GPT_TIERS, type NanoGptTier, getNanoGptTier, setNanoGptTier } from "./tier-config";
import { getSavedApiKey, setupProvider } from "./provider";

export default async function nanogptProviderExtension(pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("nanogpt-tier", {
    description: "Set nanoGPT model tier (canonical, subscription, paid)",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      return NANO_GPT_TIERS.filter((tier) => tier.startsWith(prefix)).map((tier) => ({
        value: tier,
        label: tier,
        description: `Use nanoGPT ${tier} models endpoint`,
      }));
    },
    handler: async (args, ctx) => {
      const requestedTier = args.trim().toLowerCase();
      if (!requestedTier) {
        ctx.ui.notify(`Current nanoGPT tier: ${getNanoGptTier()}`, "info");
        return;
      }

      if (!(NANO_GPT_TIERS as readonly string[]).includes(requestedTier)) {
        ctx.ui.notify("Invalid tier. Use one of: canonical, subscription, paid", "error");
        return;
      }

      const tier = requestedTier as NanoGptTier;
      setNanoGptTier(tier);

      const apiKey = getSavedApiKey();
      const loadedModelCount = await setupProvider(pi, apiKey, tier);
      ctx.ui.notify(`nanoGPT tier set to '${tier}'. Loaded ${loadedModelCount} models.`, "info");
    },
  });

  const apiKey = getSavedApiKey();
  await setupProvider(pi, apiKey);
}