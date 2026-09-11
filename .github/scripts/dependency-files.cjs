const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const CODING = "src/upstream/coding-agents";
const PROVENANCE = "integrations/coding-agents/LOCAL_CHANGES.json";
const INPUTS = ["package.json", "npm-shrinkwrap.json", `${CODING}/package.json`, `${CODING}/npm-shrinkwrap.json`];

function hash(content, encoding = "hex") {
  return createHash("sha256").update(content).digest(encoding);
}

function packagePath(manifest) {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(manifest.name) || !/^[0-9A-Za-z.+-]+$/.test(manifest.version)) {
    throw new Error("Invalid package identity");
  }
  return `packages/${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
}

function generatedPaths(root, coding) {
  return [PROVENANCE, "PACKAGE_SHA256", "PACKAGE_NIX_HASHES", packagePath(root), packagePath(coding)];
}

function validateManifest(before, after) {
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const baseline = { ...before };
  const candidate = { ...after };
  for (const section of sections) {
    const oldDeps = before[section] ?? {};
    const newDeps = after[section] ?? {};
    if (!isDeepStrictEqual(Object.keys(oldDeps).sort(), Object.keys(newDeps).sort())) {
      throw new Error(`Dependency additions or removals require review: ${section}`);
    }
    if (Object.values(newDeps).some((version) => typeof version !== "string")) {
      throw new Error(`Invalid dependency version in ${section}`);
    }
    delete baseline[section];
    delete candidate[section];
  }
  if (!isDeepStrictEqual(baseline, candidate)) throw new Error("Non-dependency manifest changes require review");
  const nodeTypes = after.devDependencies?.["@types/node"];
  if (nodeTypes !== undefined && !nodeTypes.startsWith("22.")) throw new Error("Node types must match Node 22");
}

function updateProvenance(before, packageJson, shrinkwrap) {
  if (!before["package.json"] || !before["npm-shrinkwrap.json"]) throw new Error("Missing dependency provenance");
  return {
    ...before,
    "package.json": hash(packageJson),
    "npm-shrinkwrap.json": hash(shrinkwrap),
  };
}

module.exports = { CODING, PROVENANCE, INPUTS, hash, packagePath, generatedPaths, validateManifest, updateProvenance };
