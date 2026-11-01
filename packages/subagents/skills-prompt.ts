// Composition of the preloaded-skills section appended to a Subagent's
// initial context (system prompt). Pure formatting — the loader wiring in
// `runner.ts` stays thin.
import type { PreloadedSkill } from "./skills.ts";

/**
 * Format resolved skills into a system-prompt section with each skill's
 * complete SKILL.md content. Empty input yields "" (no section).
 *
 * The section states that preloading is not an access restriction: the
 * sub-session still discovers its own skills and may read any of them on
 * demand; preloaded content is a startup convenience, not a permission.
 */
export function preloadedSkillsSection(skills?: PreloadedSkill[]): string {
  if (!skills || skills.length === 0) return "";
  const lines: string[] = [
    "## Preloaded skills",
    "",
    "The complete instructions of the following skills are preloaded below. Preloading is not an access restriction: any other available skill is still discoverable and readable on demand.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`<skill name="${skill.name}" file="${skill.filePath}">`);
    lines.push(skill.content);
    lines.push("</skill>");
  }
  return lines.join("\n");
}

/**
 * The sub-session's effective system-prompt override: the custom definition's
 * body (when it has one) followed by the preloaded-skills section. Returns
 * undefined when neither contributes anything, so the normal prompt applies.
 */
export function composeCustomSystemPrompt(
  body: string | undefined,
  skills?: PreloadedSkill[],
): string | undefined {
  const merged = [body, preloadedSkillsSection(skills)]
    .filter((s): s is string => Boolean(s && s.length))
    .join("\n\n");
  return merged.length > 0 ? merged : undefined;
}