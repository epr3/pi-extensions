import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSavedApiKey, setupProvider } from "./provider";

export default async function opencodeGoProviderExtension(pi: ExtensionAPI): Promise<void> {
	const apiKey = getSavedApiKey();
	await setupProvider(pi, apiKey);
}
