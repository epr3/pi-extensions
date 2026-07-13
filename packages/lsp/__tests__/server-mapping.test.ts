import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LspManager, type ServerDef } from "../tools.ts";

async function shippedServers(): Promise<Record<string, ServerDef>> {
	const raw = await readFile(path.join(import.meta.dirname, "..", "servers.json"), "utf8");
	return JSON.parse(raw) as Record<string, ServerDef>;
}

describe("shipped LSP server mappings", () => {
	it("include Vue single-file components through the external Vue language server", async () => {
		const servers = await shippedServers();

		expect(servers.vue).toEqual({
			cmd: "vue-language-server",
			args: ["--stdio"],
			extensions: [".vue"],
		});
	});

	it("route Vue single-file components to the Vue language id", async () => {
		const manager = new LspManager(await shippedServers(), process.cwd());

		expect(manager.langForFile("src/components/CheckoutButton.vue")).toBe("vue");
	});
});
