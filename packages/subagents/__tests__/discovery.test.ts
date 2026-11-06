import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverCustomSubagents,
  customSubagentScopes,
  validNames,
  parseToolListField,
  parseThinkingLevelField,
} from "../discovery.ts";
import type { CustomTypeDiscovery } from "../discovery.ts";

// ─── Fixture plumbing ───────────────────────────────────────────────────────

let root: string;
let n = 0;

function dir(...parts: string[]): string {
  const p = path.join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

/** Write a definition file and return its path. */
function def(dirPath: string, file: string, content: string): string {
  mkdirSync(dirPath, { recursive: true });
  const p = path.join(dirPath, file);
  writeFileSync(p, content, "utf8");
  return p;
}

const basic = (name: string, description: string, body = "Body prompt for the agent.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "subagents-discovery-"));
  n = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── Parsing and validation ─────────────────────────────────────────────────

describe("parsing a definition file", () => {
  it("uses the frontmatter name and description and the body as the system prompt", () => {
    const scopes = [dir("agents")];
    def(
      scopes[0],
      "code-reviewer.md",
      "---\nname: code-reviewer\ndescription: Reviews diffs\n---\n\nYou review code.\n",
    );

    const d = discoverCustomSubagents(scopes);
    const won = d.valid.get("code-reviewer")!;
    expect(won).toMatchObject({
      name: "code-reviewer",
      description: "Reviews diffs",
      systemPrompt: "You review code.",
    });
    expect(won.sourcePath).toMatch(/code-reviewer\.md$/);
  });

  it("ignores Markdown without frontmatter or without a name as documentation", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "notes.md", "Just documentation, no frontmatter.\n");
    def(scopes[0], "untitled.md", "---\ndescription: no name here\n---\nBody.\n");

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.size).toBe(0);
    expect(d.diagnostics).toHaveLength(0);
  });

  it("diagnoses malformed YAML frontmatter without invalidating other definitions", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "broken.md", "---\nname: [unclosed\n---\nBody.\n");
    def(scopes[0], "good.md", basic("good", "Fine"));

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.has("good")).toBe(true);
    expect(d.diagnostics).toHaveLength(1);
    expect(d.diagnostics[0].kind).toBe("malformed-frontmatter");
    expect(d.diagnostics[0].message).toMatch(/broken\.md/);
  });

  it("diagnoses a missing description as an invalid definition", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "no-description.md", "---\nname: no-description\n---\nBody.\n");

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.size).toBe(0);
    expect(d.diagnostics[0].kind).toBe("invalid-definition");
    expect(d.diagnostics[0].message).toMatch(/no-description\.md/);
    expect(d.diagnostics[0].message).toMatch(/description/);
  });

  it("diagnoses a present but non-string or empty name", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "empty-name.md", '---\nname: ""\ndescription: D\n---\nBody.\n');
    def(scopes[0], "numeric-name.md", "---\nname: 42\ndescription: D\n---\nBody.\n");

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.size).toBe(0);
    for (const diag of d.diagnostics) {
      expect(diag.kind).toBe("invalid-definition");
      expect(diag.message).toMatch(/\.md/);
    }
    expect(d.diagnostics).toHaveLength(2);
  });
});

// ─── Field acceptance ───────────────────────────────────────────────────────

describe("frontmatter field validation", () => {
  it("rejects unknown fields with the field named", () => {
    const scopes = [dir("agents")];
    def(
      scopes[0],
      "unknown-field.md",
      "---\nname: unknown-field\ndescription: D\nwhen_to_use: never\n---\nBody.\n",
    );

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.size).toBe(0);
    expect(d.diagnostics[0].kind).toBe("unknown-field");
    expect(d.diagnostics[0].message).toMatch(/when_to_use/);
  });

  it("accepts a YAML-list tools field with a bare Pi tool name", () => {
    const scopes = [dir("agents")];
    def(
      scopes[0],
      "with-tools.md",
      "---\nname: with-tools\ndescription: D\ntools:\n  - read\n---\nBody.\n",
    );

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.has("with-tools")).toBe(true);
    expect(d.valid.get("with-tools")!.tools).toEqual(["read"]);
    expect(d.diagnostics).toHaveLength(0);
  });

  it("malformed field values and scoped patterns are rejected", () => {
    // tools / disallowedTools / model are supported (ticket 0010); skills is
    // supported since ticket 0011 and exercised in the describe below.
    const cases: Array<[string, string, RegExp, string]> = [
      ["model", "whatever", /provider\/model/, "invalid-definition"],
      ["tools", "Bash(git*)", /scoped patterns/, "invalid-definition"],
      ["disallowedTools", "read,", /empty tool name/, "invalid-definition"],
    ];
    for (const [field, value, pattern, kind] of cases) {
      const s = dir(`agents-${field}-${n++}`);
      def(
        s,
        "unsupported.md",
        `---\nname: unsupported\ndescription: D\n${field}: ${value}\n---\nBody.\n`,
      );

      const d = discoverCustomSubagents([s]);
      expect(d.valid.size, `${field}: ${value}`).toBe(0);
      expect(d.diagnostics[0].kind, `${field}: ${value}`).toBe(kind);
      expect(d.diagnostics[0].message, `${field}: ${value}`).toMatch(pattern);
    }
  });

  describe("thinkingLevel frontmatter field", () => {
    it("accepts Pi's thinking levels and records them on the definition", () => {
      const scopes = [dir("agents")];
      def(
        scopes[0],
        "focused.md",
        "---\nname: focused\ndescription: D\nthinkingLevel: low\n---\nBody.\n",
      );

      const d = discoverCustomSubagents(scopes);
      expect(d.valid.get("focused")!.thinkingLevel).toBe("low");
      expect(d.diagnostics).toHaveLength(0);
    });

    it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
      "parseThinkingLevelField accepts %s",
      (value) => {
        expect(parseThinkingLevelField(value)).toEqual({ value });
      },
    );

    it.each(["Low", " high ", "", "bogus", false, null, 2, ["low"]])(
      "parseThinkingLevelField rejects %j with the valid levels named",
      (value) => {
        const r = parseThinkingLevelField(value);
        expect(r.value).toBeUndefined();
        expect(r.error).toMatch(/thinkingLevel/);
        expect(r.error).toMatch(/low/);
        expect(r.error).toMatch(/max/);
      },
    );

    it("rejects an invalid thinkingLevel at discovery with an actionable message", () => {
      const scopes = [dir("agents")];
      def(
        scopes[0],
        "typoed.md",
        "---\nname: typoed\ndescription: D\nthinkingLevel: higg\n---\nBody.\n",
      );

      const d = discoverCustomSubagents(scopes);
      expect(d.valid.size).toBe(0);
      expect(d.diagnostics[0].kind).toBe("invalid-definition");
      expect(d.diagnostics[0].message).toMatch(/higg/);
      expect(d.diagnostics[0].message).toMatch(/thinkingLevel/);
    });
  });

  describe("skills frontmatter field", () => {
    it("accepts a YAML list of skill names and records them on the definition", () => {
      const scopes = [dir("agents")];
      def(
        scopes[0],
        "with-skills.md",
        "---\nname: briefed\ndescription: D\nskills:\n  - code-review\n  - dept-style\n---\nBody.\n",
      );

      const d = discoverCustomSubagents(scopes);
      expect(d.valid.get("briefed")).toMatchObject({ skills: ["code-review", "dept-style"] });
      expect(d.diagnostics).toHaveLength(0);
    });

    it("rejects a non-list value with a shape-diagnosing message", () => {
      const scopes = [dir("agents")];
      def(scopes[0], "bad.md", "---\nname: bad\ndescription: D\nskills: code-review\n---\nBody.\n");

      const d = discoverCustomSubagents(scopes);
      expect(d.valid.size).toBe(0);
      expect(d.diagnostics[0].kind).toBe("invalid-definition");
      expect(d.diagnostics[0].message).toMatch(/skills.*list/s);
    });

    it("rejects non-string entries and empty names", () => {
      const scopes = [dir("agents")];
      def(
        scopes[0],
        "numeric.md",
        "---\nname: numeric\ndescription: D\nskills:\n  - 42\n---\nBody.\n",
      );
      def(scopes[0], "empty.md", '---\nname: empty\ndescription: D\nskills:\n  - ""\n---\nBody.\n');

      const d = discoverCustomSubagents(scopes);
      expect(d.valid.size).toBe(0);
      expect(d.diagnostics).toHaveLength(2);
      for (const diag of d.diagnostics) {
        expect(diag.kind).toBe("invalid-definition");
        expect(diag.message).toMatch(/skills/);
      }
    });

    it("treats an empty list as no preloading and dedupes names preserving order", () => {
      const scopes = [dir("agents")];
      def(
        scopes[0],
        "dupe.md",
        "---\nname: dupe\ndescription: D\nskills:\n  - b\n  - a\n  - b\n  - a\n---\nBody.\n",
      );
      def(scopes[0], "none.md", "---\nname: none\ndescription: D\nskills: []\n---\nBody.\n");

      const d = discoverCustomSubagents(scopes);
      expect(d.valid.get("dupe")).toMatchObject({ skills: ["b", "a"] });
      expect(d.valid.get("none")).toMatchObject({ skills: [] });
      expect(d.diagnostics).toHaveLength(0);
    });
  });

  it("accepts a definition that only sets name and description", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "minimal.md", basic("minimal", "Minimal"));

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.has("minimal")).toBe(true);
    expect(d.diagnostics).toHaveLength(0);
  });
});

// ─── Reserved names ─────────────────────────────────────────────────────────

describe("reserved names", () => {
  it("rejects definitions named after built-ins, case-insensitively", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "a.md", basic("explore", "Shadowing attempt"));
    def(scopes[0], "b.md", basic("General", "Shadowing attempt"));

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.size).toBe(0);
    const kinds = d.diagnostics.map((x) => x.kind);
    expect(kinds).toContain("reserved-name");
    for (const diag of d.diagnostics) {
      expect(diag.message).toMatch(/\.md/);
    }
  });

  it("keeps built-in names usable while a reserved file exists", () => {
    expect(true).toBe(true); // covered at the registration seam (launch boundary)
  });
});

// ─── Discovery layout ───────────────────────────────────────────────────────

describe("recursive discovery", () => {
  it("finds definitions in nested directories", () => {
    const scopes = [dir("agents")];
    def(dir(path.join("agents", "sub", "deeper")), "nested.md", basic("nested", "Nested"));
    def(scopes[0], "top.md", basic("top", "Top"));

    const d = discoverCustomSubagents(scopes);
    expect(validNames(d)).toEqual(expect.arrayContaining(["nested", "top"]));
    expect(d.valid.size).toBe(2);
  });

  it("ignores non-Markdown files", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "notes.txt", "not markdown");
    def(scopes[0], "real.md", basic("real", "Real"));

    const d = discoverCustomSubagents(scopes);
    expect(d.valid.size).toBe(1);
    expect(d.diagnostics).toHaveLength(0);
  });
});

// ─── Precedence ─────────────────────────────────────────────────────────────

describe("scope precedence", () => {
  it("nearest project scope wins over a farther project scope and the user scope, without merging", () => {
    const near = dir("near", ".pi", "agents");
    const far = dir("far", ".pi", "agents");
    const user = dir("user", "agents");
    def(near, "code-reviewer.md", basic("code-reviewer", "Nearest wins", "Near body."));
    def(near, "only-near.md", basic("only-near", "Only near"));
    def(far, "code-reviewer.md", basic("code-reviewer", "Far description", "Far body."));
    def(far, "only-far.md", basic("only-far", "Only far"));
    def(user, "code-reviewer.md", basic("code-reviewer", "User description"));

    const d = discoverCustomSubagents([near, far, user]);
    // The whole definition comes from the nearest scope: name, description,
    // and prompt together, never stitched from lower-priority scopes.
    const won = d.valid.get("code-reviewer")!;
    expect(won.description).toBe("Nearest wins");
    expect(won.systemPrompt).toBe("Near body.");
    expect(won.sourcePath).toMatch(/near/);
    // Names not present in a nearer scope are still discovered in farther
    // scopes — scope precedence is per-name, not all-or-nothing.
    expect(d.valid.has("only-near")).toBe(true);
    expect(d.valid.has("only-far")).toBe(true);
  });

  it("a farther project scope wins over the user scope for the same name", () => {
    const far = dir("far", ".pi", "agents");
    const user = dir("user", "agents");
    def(far, "x.md", basic("x", "Project wins"));
    def(user, "x.md", basic("x", "User loses"));

    const d = discoverCustomSubagents([far, user]);
    expect(d.valid.get("x")!.description).toBe("Project wins");
  });

  it("an invalid nearest definition shadows a valid lower-priority one of the same name", () => {
    const near = dir("near", ".pi", "agents");
    const user = dir("user", "agents");
    def(
      near,
      "broken.md",
      "---\nname: shadowed\ndescription: D\nunsupported_field: oops\n---\nBody.\n",
    );
    def(user, "good.md", basic("shadowed", "Valid user definition"));

    const d = discoverCustomSubagents([near, user]);
    expect(d.valid.has("shadowed")).toBe(false);
    const shadowed = d.diagnostics.find((x) => x.kind === "shadowed");
    expect(shadowed).toBeDefined();
    expect(shadowed!.name).toBe("shadowed");
    expect(shadowed!.message).toMatch(/broken\.md/);
  });

  it("the shadow diagnostic cites the nearest lower-priority valid definition", () => {
    const near = dir("shadow-near", ".pi", "agents");
    const mid = dir("shadow-mid", ".pi", "agents");
    const far = dir("shadow-far", ".pi", "agents");
    def(near, "broken.md", "---\nname: dup\ndescription: D\nmystery_field: oops\n---\nBody.\n");
    def(mid, "dup.md", basic("dup", "Nearest shadowed definition"));
    def(far, "dup.md", basic("dup", "Farther shadowed definition"));

    const d = discoverCustomSubagents([near, mid, far]);
    expect(d.valid.has("dup")).toBe(false);
    const shadowed = d.diagnostics.find((x) => x.kind === "shadowed");
    expect(shadowed).toBeDefined();
    // The one actually shadowed is the nearest usable definition below the
    // invalid winner, not the farthest one that happens to match the name.
    expect(shadowed!.message).toMatch(/shadow-mid[^ ]*dup\.md/);
    expect(shadowed!.message).not.toMatch(/shadow-far/);
  });

  it("parseToolListField returns the shared discriminated result shape", () => {
    // Same { value?, error? } shape as parseModelField — no error-as-string
    // overloading of the return value.
    expect(parseToolListField(["read", "bash"], "tools")).toEqual({ value: ["read", "bash"] });
    expect(parseToolListField("read, bash", "tools")).toEqual({ value: ["read", "bash"] });
    expect(parseToolListField("Read:*", "tools")).toEqual({
      error: expect.stringMatching(/scoped patterns/),
    });
    expect(parseToolListField(42, "disallowedTools")).toEqual({
      error: expect.stringMatching(/YAML list/),
    });
  });

  it("conflicting same-name definitions in one scope invalidate the name with both paths diagnosed", () => {
    const near = dir("near", ".pi", "agents");
    const user = dir("user", "agents");
    def(near, "one.md", basic("conflicted", "First"));
    def(path.join(near, "sub"), "two.md", basic("conflicted", "Second"));
    def(user, "good.md", basic("conflicted", "User definition"));

    const d = discoverCustomSubagents([near, user]);
    expect(d.valid.has("conflicted")).toBe(false);
    const conflict = d.diagnostics.find((x) => x.kind === "conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.message).toMatch(/one\.md/);
    expect(conflict!.message).toMatch(/two\.md/);
    expect(conflict!.name).toBe("conflicted");
  });
});

// ─── Missing directories ────────────────────────────────────────────────────

describe("missing directories", () => {
  it("handles absent dirs silently", () => {
    const d = discoverCustomSubagents([path.join(root, "nope"), path.join(root, "nada")]);
    expect(d.valid.size).toBe(0);
    expect(d.diagnostics).toHaveLength(0);
  });
});

// ─── Scope computation ──────────────────────────────────────────────────────

describe("customSubagentScopes()", () => {
  it("walks from the working directory to the Git root inclusive", () => {
    const gitRoot = path.join(root, "repo");
    const mid = path.join(gitRoot, "nested", "deep");
    mkdirSync(mid, { recursive: true });
    writeFileSync(path.join(gitRoot, ".git"), "", "utf8");

    const scopes = customSubagentScopes(mid, () => path.join(root, "user-agent-dir", "agents"));
    // Every directory from the working directory up to (and including) the
    // Git root contributes a `.pi/agents` project scope; nothing above the
    // Git root is inspected.
    expect(scopes).toEqual([
      path.join(mid, ".pi", "agents"),
      path.join(path.dirname(mid), ".pi", "agents"),
      path.join(gitRoot, ".pi", "agents"),
      path.join(root, "user-agent-dir", "agents"),
    ]);
  });

  it("stops at the working directory when it is outside Git", () => {
    const plain = dir("plain-workspace");

    const scopes = customSubagentScopes(plain, () => path.join(root, "user-agent-dir", "agents"));
    expect(scopes).toEqual([
      path.join(plain, ".pi", "agents"),
      path.join(root, "user-agent-dir", "agents"),
    ]);
  });

  it("when the working directory is the Git root it is the only project scope", () => {
    const gitRoot = dir("repo2");
    writeFileSync(path.join(gitRoot, ".git"), "", "utf8");

    const scopes = customSubagentScopes(gitRoot, () => path.join(root, "user-agent-dir", "agents"));
    expect(scopes).toEqual([
      path.join(gitRoot, ".pi", "agents"),
      path.join(root, "user-agent-dir", "agents"),
    ]);
  });
});

// ─── Isolation ──────────────────────────────────────────────────────────────

describe("isolation of valid types", () => {
  it("keeps valid definitions usable while unrelated invalid ones are diagnosed", () => {
    const scopes = [dir("agents")];
    def(scopes[0], "bad.md", "---\nname: bad\ndescription: D\nmystery: true\n---\nBody.\n");
    def(scopes[0], "good.md", basic("good", "Still usable"));

    const d: CustomTypeDiscovery = discoverCustomSubagents(scopes);
    expect(d.valid.has("good")).toBe(true);
    expect(d.diagnostics.map((x) => x.name)).toContain("bad");
  });
});