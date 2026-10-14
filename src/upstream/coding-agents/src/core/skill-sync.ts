import { managedToolPrefix } from "@memory-router/coding-agents/runtime";
import { renderCompanionSkill, skillPrefix, toolBrand, ToolPrefixError } from "@memory-router/shared/tool-prefix";
/**
 * Companion-skill self-update: `npm update -g` refreshes the PACKAGE's skill/, but the copies the
 * installer placed in each host's skills directory would go stale. Every session start compares
 * the installed copy against the packaged one and re-copies on drift — so upgrading the plugin
 * upgrades the skill, no re-install needed.
 *
 * Presence-gated BY DEFAULT: a host where the skill was never installed (or was uninstalled) is
 * left alone, because for a hook harness the hook registration and the skill are installed by the
 * same command — our installer — so an absent skill is a decision.
 *
 * `install: true` flips that, and is what the persistent-plugin hosts pass (core/runtime.ts): those
 * can be wired by the HOST's own plugin manager — `dsh plugin add @vectorize-io/…`,
 * `cline plugin install`, a hand-written config entry — a route our installer never sees, so the
 * plugin loads with its tools registered and no skill anywhere (#4406). There the plugin BEING
 * LOADED is the installation signal: uninstalling removes the entry that loads us, so a running
 * plugin can only mean the host still wants us.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_DIRS } from "./skill-dirs";

/** The packaged skill dir (pkgRoot/skill): one level up from the flat `dist/` bundle, two from this
 *  file in the source tree — so the source tree resolves it too, and a test asserts on the real
 *  packaged SKILL.md rather than on a fixture that cannot notice a missing skill build. */
function packagedSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, "..", "skill");
  return existsSync(join(dist, "SKILL.md")) ? dist : join(here, "..", "..", "skill");
}

export function syncCompanionSkill(
  harness: string,
  opts: { home?: string; srcDir?: string; install?: boolean } = {}
): void {
  const prefix = managedToolPrefix(harness);
  try {
    const parts = SKILL_DIRS[harness];
    if (!parts) return; // host without a skills DIRECTORY (opencode, opencode2 — see skill-dirs.ts)
    const src = opts.srcDir ?? packagedSkillDir();
    const srcMd = join(src, "SKILL.md");
    if (!existsSync(srcMd)) return;
    const base = join(opts.home ?? homedir(), ...parts);
    assertInstalledSkillBrand(base, prefix);
    const dst = join(base, toolBrand(prefix).skillName);
    const dstMd = join(dst, "SKILL.md");
    const installed = existsSync(dstMd);
    if (!installed && !opts.install) return; // never installed here — not ours to decide
    const rendered = renderCompanionSkill(readFileSync(srcMd, "utf8"), prefix, installed ? readFileSync(dstMd, "utf8") : undefined);
    if (!installed || rendered !== readFileSync(dstMd, "utf8")) {
      cpSync(src, dst, { recursive: true });
      writeFileSync(dstMd, rendered); // recursive cpSync creates the skills root too
    }
  } catch (error) {
    if (error instanceof ToolPrefixError) throw error;
    /* best-effort — skill freshness must never break a session */
  }
}

/**
 * The packaged skill in the shape a host that registers skills IN MEMORY wants (opencode2's
 * `ctx.skill.transform`): the frontmatter `description` the host matches on, the body, and the
 * on-disk directory it came from. Read at setup, so `npm update -g` upgrades this copy too.
 */
export function readPackagedSkill(
  srcDir = packagedSkillDir(),
  harness = "opencode2"
): { location: string; description: string; content: string } | undefined {
  const prefix = managedToolPrefix(harness);
  try {
    const raw = renderCompanionSkill(readFileSync(join(srcDir, "SKILL.md"), "utf8"), prefix);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    return {
      location: srcDir,
      description: frontmatter ? (/^description:\s*(.+)$/m.exec(frontmatter[1])?.[1] ?? "") : "",
      content: frontmatter ? raw.slice(frontmatter[0].length) : raw,
    };
  } catch (error) {
    if (error instanceof ToolPrefixError) throw error;
    return undefined; // no packaged skill (a dev tree before `npm run skill:build`)
  }
}

/** Refuse a stale namespace before exposing tools, even when hook housekeeping is disabled. */
export function assertCompanionSkillPrefix(harness: string, prefix: string, home = homedir()): void {
  const parts = SKILL_DIRS[harness];
  if (!parts) return;
  const base = join(home, ...parts);
  assertInstalledSkillBrand(base, prefix);
  const path = join(base, toolBrand(prefix).skillName, "SKILL.md");
  if (existsSync(path)) renderCompanionSkill("", prefix, readFileSync(path, "utf8"));
}

export function ownedCompanionSkills(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const path = join(base, entry.name, "SKILL.md");
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    const prefix = skillPrefix(raw);
    if (prefix !== undefined && (toolBrand(prefix).skillName === entry.name || entry.name === "hindsight-coding-agent")) return [join(base, entry.name)];
    const normalized = raw.replace(/\r\n/g, "\n");
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1] ?? "";
    const generators = [
      "<!-- GENERATED from README.md (its skill:begin regions) + skill-src/preamble.md.\n     Edit those, then run: npm run skill:build -->",
      "<!-- GENERATED from skill-src/preamble.md + skill-src/managed-router.md.\n     Edit those, then run: node scripts/build-skill.mjs -->",
    ];
    if (entry.name === "hindsight-coding-agent" && /^name: hindsight-coding-agent$/m.test(frontmatter) &&
      generators.some(marker => normalized.includes(marker))) return [join(base, entry.name)];
    return [];
  });
}

export function assertInstalledSkillBrand(base: string, prefix: string): void {
  const desired = join(base, toolBrand(prefix).skillName);
  const owned = ownedCompanionSkills(base);
  if (existsSync(desired) && !owned.includes(desired)) throw new ToolPrefixError("unrelated skill name collision; choose another toolPrefix");
  if (owned.some(path => path !== desired)) throw new ToolPrefixError("installed skill/tool prefix mismatch; reinstall to migrate");
}
