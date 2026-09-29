const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const CODING = "src/upstream/coding-agents";
const PROVENANCE = "integrations/coding-agents/LOCAL_CHANGES.json";
const PACKAGES = ["", CODING, "src/mcp"];
const MANIFESTS = PACKAGES.map((directory) => (directory ? `${directory}/package.json` : "package.json"));
const INPUTS = PACKAGES.flatMap((directory) =>
  ["package.json", "npm-shrinkwrap.json"].map((file) => (directory ? `${directory}/${file}` : file)),
);

function hash(content, encoding = "hex") {
  return createHash("sha256").update(content).digest(encoding);
}

function packagePath(manifest) {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(manifest.name) || !/^[0-9A-Za-z.+-]+$/.test(manifest.version)) {
    throw new Error("Invalid package identity");
  }
  return `packages/${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
}

// Generated artifacts committed to Dependabot branches are text-only: package
// tarballs are CI-built from source and pinned by their hashes, never committed.
function generatedPaths() {
  return [PROVENANCE, "PACKAGE_SHA256", "PACKAGE_NIX_HASHES", ...INPUTS];
}

function bumpPackageInputs(before, after) {
  const result = { ...after };
  for (let index = 0; index < PACKAGES.length; index++) {
    const manifestPath = MANIFESTS[index];
    const lockPath = INPUTS[index * 2 + 1];
    if ([manifestPath, lockPath].every((path) => before[path] === after[path])) continue;
    const manifest = JSON.parse(after[manifestPath]);
    const lock = JSON.parse(after[lockPath]);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
      throw new Error("Dependency preparation requires a stable package version");
    }
    const parts = manifest.version.split(".").map(Number);
    if (!parts.every(Number.isSafeInteger) || !Number.isSafeInteger(parts[2] + 1)) {
      throw new Error("Package version exceeds the supported range");
    }
    if (lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) {
      throw new Error("Package and shrinkwrap versions differ");
    }
    const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    manifest.version = next;
    lock.version = next;
    lock.packages[""].version = next;
    result[manifestPath] = `${JSON.stringify(manifest, null, 2)}\n`;
    result[lockPath] = `${JSON.stringify(lock, null, 2)}\n`;
  }
  return result;
}

function packagePaths(...manifests) {
  if (manifests.length !== PACKAGES.length) throw new Error("Incomplete package inventory");
  return manifests.map(packagePath);
}

function validateChecksums(checksums, tarballs) {
  const lines = checksums.split("\n");
  if (
    lines.length !== tarballs.length + 1 ||
    lines.at(-1) !== "" ||
    !lines.slice(0, -1).every((line) => /^[0-9a-f]{64} {2}packages\/[a-z0-9.-]+\.tgz$/.test(line))
  ) {
    throw new Error("Invalid package checksums");
  }
  const listed = lines.slice(0, -1).map((line) => line.slice(66));
  if (!isDeepStrictEqual(listed.sort(), tarballs.slice().sort())) throw new Error("Package checksum mismatch");
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

module.exports = {
  CODING,
  PACKAGES,
  MANIFESTS,
  PROVENANCE,
  INPUTS,
  hash,
  packagePath,
  packagePaths,
  validateChecksums,
  generatedPaths,
  bumpPackageInputs,
  validateManifest,
  updateProvenance,
};
