import { describe, expect, it, vi } from "vitest";
import { readSettingsFiles } from "../index.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});
import { readFileSync } from "node:fs";

const read = vi.mocked(readFileSync);

describe("startup settings loading", () => {
  it("retains valid global settings when project JSON is malformed", () => {
    read.mockImplementation((file) => {
      if (String(file) === "global")
        return '{"modelPresets":{"cycle":["global"],"presets":{"global":{}}}}';
      return "{";
    });
    const result = readSettingsFiles(["global", "project"]);
    expect(result.settings.cycle).toEqual(["global"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("Invalid JSON in settings file project");
  });

  it("silently ignores missing optional files", () => {
    read.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(readSettingsFiles(["global", "project"])).toEqual({ settings: {}, issues: [] });
  });

  it("shallowly overrides global catalog fields with the project catalog", () => {
    read.mockImplementation((file) =>
      String(file) === "global"
        ? '{"modelPresets":{"cycle":["global"],"presets":{"global":{}}}}'
        : '{"modelPresets":{"cycle":["project"]}}',
    );
    expect(readSettingsFiles(["global", "project"]).settings).toEqual({
      cycle: ["project"],
      presets: { global: {} },
    });
  });
});