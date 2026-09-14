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

async function reviewSettings(appId, repository) {
  const { execFileSync } = require("node:child_process");
  const { checkRules, ReleaseError } = require("./release.cjs");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new ReleaseError("Use owner/repository");
  const api = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
  const path = `repos/${repository}/rulesets`;
  const summaries = JSON.parse(execFileSync("gh", ["api", `${path}?per_page=100`, "--paginate", "--slurp"], { encoding: "utf8" })).flat();
  const rules = summaries.map(({ id }) => api(`${path}/${id}`));
  delete process.env.RELEASE_SETTINGS_REVIEW;
  const github = {
    paginate: async () => summaries,
    rest: { repos: {
      getRepoRulesets() {},
      getRepoRuleset: async ({ ruleset_id }) => ({ data: rules.find(({ id }) => id === ruleset_id) }),
    } },
  };
  const [owner, repo] = repository.split("/");
  await checkRules(github, { owner, repo }, appId);
  const reviewed = rules.filter((rule) => ["Release branch creation", "Protect release branches", "Release tag creation", "Protect release tags"].includes(rule.name));
  for (const rule of reviewed) {
    if (!Object.hasOwn(rule, "bypass_actors") || typeof rule.updated_at !== "string") {
      throw new ReleaseError("Use the repository owner's gh login to read bypass actors and settings revisions");
    }
  }
  return { app_id: appId, immutable_releases: true, rulesets: Object.fromEntries(reviewed.map((rule) => [rule.id, rule.updated_at])) };
}

if (require.main === module && process.argv[2] === "--review-immutable-settings") {
  reviewSettings(Number(process.argv[3]), process.argv[4]).then(
    (review) => console.log(JSON.stringify(review)),
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
} else if (require.main === module) {
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
module.exports = { rulesets, reviewSettings };
