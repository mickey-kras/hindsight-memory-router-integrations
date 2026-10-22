const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { packageAssets } = require("./release.cjs");

const registry = "https://registry.npmjs.org";
const names = ["@mickey-kras/hindsight-memory-router-openclaw", "@mickey-kras/hindsight-memory-router-coding-agents"];

async function metadata(name, version) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm metadata request failed: HTTP ${response.status}`);
  return response.json();
}

function verifyPublished(pkg, published, integrity) {
  if (published.name !== pkg.name || published.version !== pkg.version || published.dist?.integrity !== integrity) {
    throw new Error(`npm integrity mismatch: ${pkg.name}@${pkg.version}`);
  }
  if (published.dist?.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
    throw new Error(`npm provenance missing: ${pkg.name}@${pkg.version}`);
  }
}

async function publishPackages({
  packages,
  read = readFileSync,
  lookup = metadata,
  publish = (args) => execFileSync("npm", args, { stdio: "inherit", timeout: 120_000 }),
  wait = sleep,
}) {
  if (
    !Array.isArray(packages) ||
    packages.length !== names.length ||
    names.some((name) => packages.filter((pkg) => pkg.name === name).length !== 1)
  )
    throw new Error("Invalid npm package inventory");
  const prepared = packages.map((pkg) => {
    const filename = `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz`;
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.path !== `packages/${filename}`) {
      throw new Error("Invalid npm package path or version");
    }
    const bytes = read(pkg.path);
    if (createHash("sha256").update(bytes).digest("hex") !== pkg.sha256) {
      throw new Error(`Release package checksum mismatch: ${pkg.name}`);
    }
    return { pkg, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  });
  // Check both packages before making either irreversible publication.
  for (const item of prepared) {
    item.existing = await lookup(item.pkg.name, item.pkg.version);
    if (item.existing) verifyPublished(item.pkg, item.existing, item.integrity);
  }
  for (const { pkg, integrity, existing } of prepared) {
    if (existing) continue;
    const latest = await lookup(pkg.name, "latest");
    const semver = require("semver");
    if (latest && !semver.valid(latest.version)) throw new Error("Invalid npm latest version");
    const tag = latest && semver.gt(latest.version, pkg.version) ? `release-${pkg.version}` : "latest";
    publish([
      "publish",
      resolve(pkg.path),
      "--registry",
      registry,
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
      "--tag",
      tag,
    ]);
    let published;
    for (let attempt = 0; attempt < 5; attempt++) {
      published = await lookup(pkg.name, pkg.version);
      if (published) break;
      if (attempt < 4) await wait(2000 * (attempt + 1));
    }
    if (!published) throw new Error(`npm publication not visible: ${pkg.name}@${pkg.version}`);
    verifyPublished(pkg, published, integrity);
  }
}

if (require.main === module) {
  const manifest = JSON.parse(readFileSync("release.json", "utf8"));
  const packages = packageAssets();
  if (JSON.stringify(packages) !== JSON.stringify(manifest.packages)) {
    throw new Error("Release package inventory changed");
  }
  publishPackages({ packages }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { publishPackages };
