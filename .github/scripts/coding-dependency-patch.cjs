const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PATCH = "integrations/coding-agents/router.patch";
const UPSTREAM = "integrations/coding-agents/UPSTREAM.json";
const MANIFEST = "diff --git a/package.json b/package.json\n";
const LOCK = "diff --git a/package-lock.json b/npm-shrinkwrap.json\n";

// Only dependency-file sections may change. Recover their pristine inputs from
// the trusted baseline patch; no upstream checkout or network fetch is needed.
function codingDependencyPatch(patch, upstream, before, after) {
  const sections = patch.split(/(?=^diff --git )/m);
  const dependencies = sections.filter((section) => section.startsWith(MANIFEST) || section.startsWith(LOCK));
  if (
    dependencies.length !== 2 ||
    !dependencies.some((section) => section.startsWith(MANIFEST)) ||
    !dependencies.some((section) => section.startsWith(LOCK))
  ) {
    throw new Error("Missing coding dependency patch sections");
  }
  const directory = mkdtempSync(join(tmpdir(), "coding-dependency-patch-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
  const git = (args, input) =>
    execFileSync(
      "git",
      ["--no-lazy-fetch", "-C", directory, "-c", "core.autocrlf=false", "-c", "core.attributesFile=/dev/null", ...args],
      { env, input, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
    );
  try {
    writeFileSync(join(directory, "package.json"), before.packageJson);
    writeFileSync(join(directory, "npm-shrinkwrap.json"), before.shrinkwrap);
    git(["apply", "--reverse", "--binary", "-"], dependencies.join(""));
    if (readdirSync(directory).sort().join(",") !== "package-lock.json,package.json") {
      throw new Error("Unexpected reconstructed coding dependency files");
    }
    const pristine = Object.fromEntries(
      ["package.json", "package-lock.json"].map((path) => {
        const bytes = readFileSync(join(directory, path));
        if (createHash("sha256").update(bytes).digest("hex") !== upstream.files[path]) {
          throw new Error(`Coding dependency pristine hash mismatch: ${path}`);
        }
        return [path, bytes];
      }),
    );
    git(["init", "-q", "--object-format=sha1"]);
    function tree(files) {
      git(["read-tree", "--empty"]);
      const entries = Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => {
          const sha = git(["hash-object", "-w", "--no-filters", "--stdin"], bytes).toString().trim();
          return `100644 blob ${sha}\t${path}\0`;
        });
      git(["update-index", "-z", "--index-info"], entries.join(""));
      return git(["write-tree"]).toString().trim();
    }
    const base = tree(pristine);
    function diff(inputs) {
      tree({ "package.json": inputs.packageJson, "npm-shrinkwrap.json": inputs.shrinkwrap });
      return git([
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=50%",
        "-l1000",
        "--no-color",
        "--abbrev=7",
        "--unified=1",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        base,
      ]).toString();
    }
    // Reject drift rather than silently accepting a noncanonical baseline.
    if (diff(before) !== dependencies.join("")) throw new Error("Coding dependency baseline patch differs");
    const replacements = diff(after)
      .split(/(?=^diff --git )/m)
      .filter(Boolean);
    if (
      replacements.length !== 2 ||
      !replacements.some((part) => part.startsWith(MANIFEST)) ||
      !replacements.some((part) => part.startsWith(LOCK))
    )
      throw new Error("Unexpected coding dependency diff");
    return sections
      .map((section) => {
        if (section.startsWith(MANIFEST)) return replacements.find((part) => part.startsWith(MANIFEST));
        if (section.startsWith(LOCK)) return replacements.find((part) => part.startsWith(LOCK));
        return section;
      })
      .join("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { PATCH, UPSTREAM, codingDependencyPatch };
