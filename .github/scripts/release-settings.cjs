// Generate importable rulesets; this command does not change GitHub settings.
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function rulesets(appId) {
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error("A numeric release App ID is required");
  const make = (name, target, pattern, types, creation = false) => ({
    name,
    target,
    enforcement: "active",
    bypass_actors: creation ? [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }] : [],
    conditions: { ref_name: { exclude: [], include: [pattern] } },
    rules: types.map((type) => ({ type })),
  });
  return [
    make("Release branch creation", "branch", "refs/heads/release/*", ["creation"], true),
    JSON.parse(readFileSync(".github/rulesets/protect-release-branches.json", "utf8")),
    make("Release tag creation", "tag", "refs/tags/v*", ["creation"], true),
    make("Protect release tags", "tag", "refs/tags/v*", ["update", "deletion", "non_fast_forward"]),
  ];
}

if (require.main === module) {
  const [, , id, directory] = process.argv;
  if (!directory) throw new Error("Usage: node .github/scripts/release-settings.cjs APP_ID OUTPUT_DIRECTORY");
  const generated = rulesets(Number(id));
  mkdirSync(directory, { recursive: true });
  for (const rule of generated) {
    writeFileSync(
      join(directory, `${rule.name.toLowerCase().replaceAll(" ", "-")}.json`),
      `${JSON.stringify(rule, null, 2)}\n`,
    );
  }
}
module.exports = { rulesets };
