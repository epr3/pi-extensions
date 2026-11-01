// Resolution of a custom Subagent definition's `skills` frontmatter list.
//
// Names are resolved through the same `DefaultResourceLoader` discovery the
// sub-session itself uses — default skill locations (user scope, then project
// `.pi/skills`) plus settings-, CLI-, and package-derived skill paths, with
// Pi's first-load-wins per name. Each resolved skill's complete SKILL.md is
// read for preloading into the run's initial context. A name that cannot be
// resolved or read is reported as a problem so the calling launch can fail
// with an actionable diagnostic — only that launch fails; unrelated
// definitions are unaffected.
//
// Preloading is not an access restriction: the sub-session still discovers
// skills normally and can read any other skill on demand.
import { readFileSync } from "node:fs";
import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export interface PreloadedSkill {
  name: string;
  filePath: string;
  /** The complete SKILL.md content, frontmatter included. */
  content: string;
}

export type SkillProblem =
  | { kind: "missing"; name: string; message: string }
  | { kind: "unreadable"; name: string; message: string };

export interface SkillPreloadResult {
  skills: PreloadedSkill[];
  problems: SkillProblem[];
}

export type SkillsLoaderFactory = () => ResourceLoader | Promise<ResourceLoader>;

/**
 * Resolve `skillNames` through Pi's normal skill discovery for `cwd` and read
 * each skill's complete SKILL.md. Names are matched exactly against Pi's
 * resolved skill names (frontmatter `name`, or the directory name) under
 * Pi's inherent precedence. Unknown names and unreadable files become
 * problems — they never silently preload a partial set.
 */
export async function resolveSkillPreloads(options: {
  cwd: string;
  skillNames: readonly string[];
  /** Overridable for tests; creates Pi's own resource loader by default. */
  createSkillsLoader?: SkillsLoaderFactory;
  agentDir?: string;
}): Promise<SkillPreloadResult> {
  const { cwd, skillNames, createSkillsLoader, agentDir: agentDirOverride } = options;
  const agentDir = agentDirOverride ?? getAgentDir();
  const locations = `${agentDir}/skills and <cwd>/.pi/skills`;

  const loader = createSkillsLoader
    ? await createSkillsLoader()
    : new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const { skills: discovered } = loader.getSkills();
  const byName = new Map(discovered.map((s) => [s.name, s]));

  const skills: PreloadedSkill[] = [];
  const problems: SkillProblem[] = [];
  const seen = new Set<string>();
  for (const requested of skillNames) {
    if (seen.has(requested)) continue; // definition parse already dedupes; belt for direct callers
    seen.add(requested);
    const skill = byName.get(requested);
    if (!skill) {
      problems.push({
        kind: "missing",
        name: requested,
        message:
          `skill "${requested}" was not found in Pi skill discovery (default locations: ${locations}, plus configured skill paths) — ` +
          `create it, or remove it from the definition's \`skills\` list`,
      });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(skill.filePath, "utf8");
    } catch (e) {
      problems.push({
        kind: "unreadable",
        name: requested,
        message:
          `skill "${requested}" file at ${skill.filePath} is unreadable (${(e as Error).message}) — ` +
          `fix the file's permissions or remove it from the definition's \`skills\` list`,
      });
      continue;
    }
    skills.push({ name: skill.name, filePath: skill.filePath, content });
  }

  return { skills, problems };
}