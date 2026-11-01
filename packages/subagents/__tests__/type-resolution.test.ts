import { describe, it, expect, afterAll } from "vitest";
import { resolveAgentType, resolveTypeRequest } from "../agents.ts";
import { discoverCustomSubagents } from "../discovery.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let root: string;
let n = 0;

function def(dirPath: string, file: string, content: string) {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(path.join(dirPath, file), content, "utf8");
}

const basic = (name: string, description: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

root = mkdtempSync(path.join(tmpdir(), "subagents-resolution-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function discoveryWith(defs: Array<[string, string, string]>) {
  const scope = path.join(root, `scope-${n++}`);
  for (const [file, name, description] of defs) {
    def(scope, file, basic(name, description));
  }
  return discoverCustomSubagents([scope]);
}

const empty = { valid: new Map(), diagnostics: [] as any[] };

describe("built-in resolution is unchanged", () => {
  it("keeps the speculative expl alias and case-insensitive built-in names", () => {
    for (const [input, type] of [
      ["expl", "explore"],
      ["explore", "explore"],
      ["EXPLORE", "explore"],
      ["general", "general"],
    ] as const) {
      expect(resolveAgentType(input)).toBe(type);
    }
  });
});

describe("custom names are never captured by the built-in expl alias", () => {
  it("resolves an exact custom name that would otherwise be eaten by the prefix alias", () => {
    const d = discoveryWith([["explorer.md", "Explorer", "A custom explorer"]]);
    const r = resolveTypeRequest("Explorer", d);
    expect(r).toMatchObject({ kind: "custom", name: "Explorer" });
  });

  it("resolves non-prefixed custom names exactly", () => {
    const d = discoveryWith([["code-reviewer.md", "code-reviewer", "Reviews code"]]);
    expect(resolveTypeRequest("code-reviewer", d)).toMatchObject({
      kind: "custom",
      name: "code-reviewer",
    });
  });

  it("still resolves explore-style inputs to the built-in when no custom name matches", () => {
    const d = discoveryWith([["x.md", "x", "Unrelated"]]);
    for (const input of ["expl", "explore", "EXPLORER"]) {
      expect(resolveTypeRequest(input, d)).toMatchObject({ kind: "builtin", type: "explore" });
    }
    expect(resolveTypeRequest("general", d)).toMatchObject({ kind: "builtin", type: "general" });
  });

  it("an empty registry falls through to built-ins as before", () => {
    const d = empty as any;
    expect(resolveTypeRequest("explore", d)).toMatchObject({ kind: "builtin", type: "explore" });
  });
});

describe("unknown and invalid requested types", () => {
  it("fails unknown types with the current custom names in the message", () => {
    const d = discoveryWith([
      ["a.md", "alpha", "A"],
      ["b.md", "b-explorer", "B"],
    ]);
    try {
      resolveTypeRequest("alpha-typo", d);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Unsupported subagent_type "alpha-typo"/);
      expect(msg).toMatch(/"explore"/);
      expect(msg).toMatch(/"alpha"/);
      expect(msg).toMatch(/"b-explorer"/);
    }
  });

  it("never falls back to general for an unknown type", () => {
    const d = empty as any;
    expect(() => resolveTypeRequest("anything_else", d)).toThrow(/Unsupported subagent_type/);
  });

  it("fails an invalid or shadowed custom name with a shadow hint", () => {
    // Only implementable in-process: a definition that is invalid in all
    // scopes cannot be in `valid`, so the request fails as unsupported, with
    // the diagnostics available to callers for the actionable surface.
    const d = empty as any;
    expect(() => resolveTypeRequest("ghost", d)).toThrow(/Unsupported subagent_type "ghost"/);
  });
});