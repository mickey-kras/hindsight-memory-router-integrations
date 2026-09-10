const { existsSync, readFileSync } = require("node:fs");
const { ReleaseError, resolve, validateRouter } = require("./release.cjs");

module.exports = async ({ github, context, core, inspect }) => {
  await resolve({ github, context, core, inspect });
  const branch = context.payload.pull_request?.base.ref || context.ref.replace("refs/heads/", "");
  if (branch.startsWith("release/")) {
    if (!existsSync("release.json")) throw new ReleaseError("Release manifest is missing");
    const manifest = JSON.parse(readFileSync("release.json", "utf8"));
    validateRouter(manifest.router);
    core.setOutput("router_sha", manifest.router.sha);
    core.setOutput("router_image", manifest.router.image);
    core.setOutput("router_version", manifest.router.version);
  } else {
    const { data } = await github.rest.repos.getCommit({
      owner: "mickey-kras",
      repo: "hindsight-memory-router",
      ref: "main",
    });
    if (!/^[a-f0-9]{40}$/.test(data.sha)) throw new ReleaseError("Invalid router main commit");
    core.setOutput("router_sha", data.sha);
    core.setOutput("router_image", "");
    core.setOutput("router_version", "");
  }
};
