const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync, lstatSync } = require("node:fs");
const { join, resolve } = require("node:path");
const {
  CODING,
  PROVENANCE,
  INPUTS,
  hash,
  generatedPaths,
  validateManifest,
  updateProvenance,
} = require("./dependency-files.cjs");

function refresh(directory, number, head, base, output) {
  const root = resolve(directory);
  const run = (command, args, cwd = root) =>
    execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
  const read = (path) => readFileSync(join(root, path));
  if (!Number.isSafeInteger(number) || number <= 0 || !/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(base)) {
    throw new Error("Invalid dependency update identity");
  }
  if (run("git", ["rev-parse", "HEAD"]).trim() !== head || run("git", ["status", "--porcelain"]).trim()) {
    throw new Error("Preparation requires a clean checkout of the expected head");
  }
  run("git", ["merge-base", "--is-ancestor", base, head]);
  const changed = run("git", ["diff", "--name-only", base, head]).trim().split("\n");
  if (!changed.length || changed.some((path) => !INPUTS.includes(path)))
    throw new Error("Unexpected dependency input files");
  for (const path of ["package.json", `${CODING}/package.json`]) {
    validateManifest(JSON.parse(run("git", ["show", `${base}:${path}`])), JSON.parse(read(path)));
  }
  const paths = generatedPaths(JSON.parse(read("package.json")), JSON.parse(read(`${CODING}/package.json`)));
  const provenance = updateProvenance(
    JSON.parse(read(PROVENANCE)),
    read(`${CODING}/package.json`),
    read(`${CODING}/npm-shrinkwrap.json`),
  );
  writeFileSync(join(root, PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`);
  run("node", ["scripts/verify-coding-upstream.mjs"]);
  run("node", ["scripts/verify-openclaw-overlay.mjs"]);
  run("npm", ["ci"]);
  run("npm", ["ci"], join(root, CODING));
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:coding-agents"]);
  run("npm", ["pack", "--pack-destination", join(root, "packages"), "--silent"]);
  run("npm", ["pack", "--pack-destination", join(root, "packages"), "--silent"], join(root, CODING));
  writeFileSync(
    join(root, "PACKAGE_SHA256"),
    paths
      .filter((path) => path.endsWith(".tgz"))
      .sort()
      .map((path) => `${hash(read(path))}  ${path}\n`)
      .join(""),
  );
  const previous = read("PACKAGE_NIX_HASHES")
    .toString()
    .match(/^npm_deps=(sha256-[A-Za-z0-9+/]{43}=)$/m)?.[1];
  if (!previous) throw new Error("Missing previous Nix dependency hash");
  const deps = changed.includes("npm-shrinkwrap.json")
    ? run("nix", [
        "run",
        "github:NixOS/nixpkgs/e7a3ca8092b61ff85b6a45bf863ea2b2d6a661b3#prefetch-npm-deps",
        "--",
        "npm-shrinkwrap.json",
      ]).trim()
    : previous;
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(deps)) throw new Error("Invalid regenerated Nix dependency hash");
  writeFileSync(
    join(root, "PACKAGE_NIX_HASHES"),
    `source=sha256-${hash(read(paths[3]), "base64")}\nnpm_deps=${deps}\n`,
  );
  const modified = run("git", ["diff", "--name-only", "HEAD"]).trim().split("\n");
  if (modified.some((path) => !paths.includes(path))) throw new Error("Build modified non-generated files");
  run("node", ["scripts/verify-coding-upstream.mjs"]);
  run("node", ["scripts/verify-openclaw-overlay.mjs"]);
  const files = paths.map((path) => {
    if (!lstatSync(join(root, path)).isFile()) throw new Error(`Generated artifact is not a regular file: ${path}`);
    return { path, contents: read(path).toString("base64") };
  });
  writeFileSync(output, JSON.stringify({ number, head, base, files }));
}

module.exports = { refresh };
if (require.main === module)
  refresh(process.argv[2], Number(process.argv[3]), process.argv[4], process.argv[5], process.argv[6]);
