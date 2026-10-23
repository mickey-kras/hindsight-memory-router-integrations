const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const {
  CODING,
  PROVENANCE,
  INPUTS,
  MANIFESTS,
  hash,
  generatedPaths,
  bumpPackageInputs,
  packagePaths,
  validateChecksums,
  validateManifest,
  updateProvenance,
} = require("./dependency-files.cjs");
const {
  dependencyCommits,
  inspect,
  requestPreparation,
  publish,
  waitForPublishedHead,
} = require("./dependabot-preparation.cjs");
const { requestValidation, runPolicy, runDispatchedPolicy } = require("./dependabot-validation.cjs");
const { PATCH, UPSTREAM, codingDependencyPatch } = require("./coding-dependency-patch.cjs");

const prGuardScript = execFileSync(
  "python3",
  [
    "-c",
    "import sys,yaml; w=yaml.safe_load(open(sys.argv[1])); print(w['jobs']['guard']['steps'][-1]['with']['script'])",
    resolve(__dirname, "../workflows/pr-validation.yml"),
  ],
  { encoding: "utf8" },
);
const executePrGuard = new (Object.getPrototypeOf(async () => {}).constructor)(
  "github",
  "context",
  "core",
  "require",
  prGuardScript,
);
async function runPullRequestPolicy(github, event, core, trustedMainSha, policy) {
  await executePrGuard(github, event, core, (module) => {
    if (module === "node:child_process") return { execFileSync: () => trustedMainSha };
    if (module === "./automation/.github/scripts/dependabot-validation.cjs") {
      return { runPolicy: policy, runDispatchedPolicy };
    }
    throw new Error(`Unexpected workflow import: ${module}`);
  });
}

const bot = { login: "dependabot[bot]", id: 49699333 };
const owner = { login: "owner", id: 100 };
const actions = { login: "github-actions[bot]", id: 41898282 };
const releaseApp = { login: "mickey-kras-release-automation[bot]", id: 329687231 };
const head = "a".repeat(40);
const base = "b".repeat(40);
const generated = "c".repeat(40);
const manifest = {
  name: "@owner/root",
  version: "1.0.0",
  scripts: { build: "tsc" },
  devDependencies: { example: "1.0.0", "@types/node": "22.20.0" },
};
const coding = { ...manifest, name: "@owner/coding" };
const fixtureLock = (pkg) =>
  JSON.stringify(
    {
      version: pkg.version,
      packages: {
        "": { version: pkg.version },
        ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`node_modules/stable-${i}`, { version: "1.0.0" }])),
      },
    },
    null,
    2,
  );
function codingPatchFixture() {
  const directory = mkdtempSync(join(tmpdir(), "coding-patch-fixture-"));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  const packageJson = JSON.stringify({ ...coding, name: "@upstream/coding" });
  const shrinkwrap = fixtureLock(coding);
  try {
    git("init", "--quiet", "--object-format=sha1");
    writeFileSync(join(directory, "package.json"), packageJson);
    writeFileSync(join(directory, "package-lock.json"), shrinkwrap);
    git("add", ".");
    const tree = git("write-tree").trim();
    git("rm", "--cached", "package-lock.json");
    writeFileSync(join(directory, "package.json"), JSON.stringify(coding));
    writeFileSync(join(directory, "npm-shrinkwrap.json"), shrinkwrap);
    git("add", "package.json", "npm-shrinkwrap.json");
    return {
      patch: git(
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
        tree,
      ),
      upstream: { files: { "package.json": hash(packageJson), "package-lock.json": hash(shrinkwrap) } },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const codingFixture = codingPatchFixture();

test("coding dependency patch refresh is exact, deterministic and preserves unrelated adaptations", () => {
  const { readFileSync } = require("node:fs");
  const before = { packageJson: JSON.stringify(coding), shrinkwrap: fixtureLock(coding) };
  const after = {
    packageJson: `${JSON.stringify({ ...coding, version: "1.0.1" }, null, 2)}\n`,
    shrinkwrap: `${JSON.stringify({ ...JSON.parse(before.shrinkwrap), version: "1.0.1" }, null, 2)}\n`,
  };
  const unrelated =
    "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hello\n";
  const baseline = unrelated + codingFixture.patch;
  assert.equal(codingDependencyPatch(baseline, codingFixture.upstream, before, before), baseline);
  const result = codingDependencyPatch(baseline, codingFixture.upstream, before, after);
  assert.equal(result, codingDependencyPatch(baseline, codingFixture.upstream, before, after));
  assert.ok(result.startsWith(unrelated));
  const directory = mkdtempSync(join(tmpdir(), "coding-patch-apply-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ ...coding, name: "@upstream/coding" }));
    writeFileSync(join(directory, "package-lock.json"), before.shrinkwrap);
    execFileSync("git", ["apply", "-"], { cwd: directory, input: result });
    assert.equal(readFileSync(join(directory, "package.json"), "utf8"), after.packageJson);
    assert.equal(readFileSync(join(directory, "npm-shrinkwrap.json"), "utf8"), after.shrinkwrap);
    assert.equal(readFileSync(join(directory, "notes.txt"), "utf8"), "hello\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.throws(() => codingDependencyPatch(baseline, { files: {} }, before, after), /pristine hash mismatch/);
  assert.throws(() =>
    codingDependencyPatch(baseline, codingFixture.upstream, { ...before, packageJson: "unrelated bytes" }, after),
  );
});
const provenance = { "package.json": "old", "npm-shrinkwrap.json": "old", "src/index.ts": "preserved" };
const commit = { sha: head, author: bot, commit: { verification: { verified: true } } };
const context = { repo: { owner: "owner", repo: "repo" }, ref: "refs/heads/main", sha: base };
const pull = {
  number: 1,
  user: bot,
  state: "open",
  draft: false,
  author_association: "NONE",
  head: { sha: head, ref: "dependabot/npm_and_yarn/example-1.0.1", repo: { full_name: "owner/repo" } },
  base: { ref: "main", sha: base, repo: { owner } },
};

function harness() {
  const state = {
    pull: structuredClone(pull),
    commits: [structuredClone(commit)],
    files: [{ filename: `${CODING}/package.json`, status: "modified" }],
    runs: [],
    guardRuns: [],
    dispatches: [],
    comments: [],
    messages: [],
    published: [],
    reported: [],
    ahead: 0,
    generated: { parents: [{ sha: head }], files: [{ filename: PROVENANCE, status: "modified" }] },
  };
  const contents = {
    "package.json": JSON.stringify(manifest),
    [`${CODING}/package.json`]: JSON.stringify(coding),
    ...Object.fromEntries([manifest, coding].map((pkg, index) => [INPUTS[index * 2 + 1], fixtureLock(pkg)])),
    [PROVENANCE]: JSON.stringify(provenance),
    [PATCH]: codingFixture.patch,
    [UPSTREAM]: JSON.stringify(codingFixture.upstream),
  };
  const github = {
    graphql: async (query, input) => {
      if (query.startsWith("mutation")) {
        state.published.push(input);
        state.pull = { ...state.pull, head: { ...state.pull.head, sha: generated } };
        state.commits.push({
          sha: generated,
          author: actions,
          commit: {
            verification: { verified: true },
            message: `${input.input.message.headline}\n\n${input.input.message.body}`,
          },
        });
        state.generated = {
          parents: [{ sha: input.input.expectedHeadOid }],
          files: input.input.fileChanges.additions.map(({ path }) => ({ filename: path, status: "modified" })),
        };
        return { createCommitOnBranch: { commit: { oid: generated } } };
      }
      return { repository: { object: { signature: { isValid: true, wasSignedByGitHub: true } } } };
    },
    rest: {
      git: { getRef: async ({ ref }) => ({ data: { object: { sha: ref === "heads/main" ? base : generated } } }) },
      repos: {
        get: async (repo) => {
          assert.deepEqual(repo, context.repo);
          return { data: { default_branch: "main", full_name: "owner/repo" } };
        },
        getContent: async ({ path }) => ({
          data: { type: "file", encoding: "base64", content: Buffer.from(contents[path]).toString("base64") },
        }),
        getCommit: async () => ({ data: state.generated }),
        compareCommitsWithBasehead: async () => ({ data: { ahead_by: state.ahead } }),
      },
      pulls: { get: async () => ({ data: state.pull }), listCommits: "commits", listFiles: "files" },
      actions: { listWorkflowRuns: "runs", createWorkflowDispatch: async (input) => state.dispatches.push(input) },
      checks: {
        create: async (input) => {
          state.reported.push(input);
          return { data: { id: 10 } };
        },
        update: async (input) => state.reported.push(input),
      },
      issues: { listComments: "comments", createComment: async (input) => state.messages.push(input) },
    },
    paginate: async (endpoint, params) =>
      state[endpoint === "runs" && params.workflow_id === "dependabot-guard.yml" ? "guardRuns" : endpoint],
  };
  const paths = generatedPaths();
  // Tarballs are CI-built and gitignored; prepared commits carry text-only
  // artifacts whose hash pins the PR's own CI run byte-verifies.
  const artifacts = {
    ...Object.fromEntries(INPUTS.map((path) => [path, contents[path]])),
    [PATCH]: contents[PATCH],
    [PROVENANCE]: JSON.stringify(
      updateProvenance(provenance, contents[`${CODING}/package.json`], contents[`${CODING}/npm-shrinkwrap.json`]),
    ),
  };
  artifacts.PACKAGE_SHA256 = packagePaths(manifest, coding)
    .sort()
    .map((path, index) => `${String(index + 1).repeat(64)}  ${path}\n`)
    .join("");
  artifacts.PACKAGE_NIX_HASHES = `source=sha256-${hash("root archive", "base64")}\nnpm_deps=sha256-${hash("deps", "base64")}\n`;
  const payload = {
    number: 1,
    head,
    base,
    files: paths.map((path) => ({ path, contents: Buffer.from(artifacts[path]).toString("base64") })),
  };
  const metadata = () => [
    { updateType: "version-update:semver-patch", prevVersion: "1.0.0", newVersion: "1.0.1", compatScore: 75 },
  ];
  return { state, github, payload, metadata, contents };
}

test("dependency versions can change without reauthorizing scripts or package identity", () => {
  const updated = { ...manifest, devDependencies: { ...manifest.devDependencies, example: "1.0.1" } };
  assert.doesNotThrow(() => validateManifest(manifest, updated));
  for (const invalid of [
    { ...updated, scripts: { build: "untrusted" } },
    { ...updated, version: "2.0.0" },
    { ...updated, devDependencies: { ...updated.devDependencies, extra: "1.0.0" } },
    { ...updated, devDependencies: { example: "1.0.1" } },
    { ...updated, devDependencies: { ...updated.devDependencies, "@types/node": "26.4.1" } },
  ])
    assert.throws(() => validateManifest(manifest, invalid));
});

test("provenance refresh preserves every non-dependency hash", () => {
  const updated = updateProvenance(provenance, "package", "lock");
  assert.equal(updated["src/index.ts"], "preserved");
  assert.equal(updated["package.json"], hash("package"));
  assert.equal(updated["npm-shrinkwrap.json"], hash("lock"));
  assert.throws(() => updateProvenance({}, "package", "lock"));
});

test("dependency preparation bumps only changed packages and both shrinkwrap version fields", () => {
  const { contents } = harness();
  for (const index of [0, 1]) {
    const changed = { ...contents };
    const lockPath = INPUTS[index * 2 + 1];
    const lock = JSON.parse(changed[lockPath]);
    lock.packages["node_modules/example"] = { version: "1.0.1" };
    changed[lockPath] = JSON.stringify(lock);
    const bumped = bumpPackageInputs(contents, changed);
    for (const path of INPUTS) {
      if (![MANIFESTS[index], lockPath].includes(path)) assert.equal(bumped[path], contents[path]);
    }
    assert.equal(JSON.parse(bumped[MANIFESTS[index]]).version, "1.0.1");
    assert.equal(JSON.parse(bumped[lockPath]).version, "1.0.1");
    assert.equal(JSON.parse(bumped[lockPath]).packages[""].version, "1.0.1");
    assert.deepEqual(JSON.parse(bumped[lockPath]).packages["node_modules/example"], { version: "1.0.1" });
    assert.deepEqual(bumpPackageInputs(contents, changed), bumped);
  }
  assert.deepEqual(bumpPackageInputs(contents, contents), contents);
});

test("dependency preparation rejects prereleases and mismatched shrinkwrap versions", () => {
  const { contents } = harness();
  for (const version of ["1.0.0-beta.1", "01.0.0", "1.0.9007199254740991"]) {
    const changed = { ...contents, "package.json": JSON.stringify({ ...manifest, version }) };
    assert.throws(() => bumpPackageInputs(contents, changed), /stable package version|supported range/);
  }
  const changed = { ...contents, "package.json": JSON.stringify({ ...manifest, devDependencies: {} }) };
  changed["npm-shrinkwrap.json"] = JSON.stringify({ version: "0.9.0", packages: { "": { version: "1.0.0" } } });
  assert.throws(() => bumpPackageInputs(contents, changed), /versions differ/);
});

test("publication rejects package scripts, dependencies, and extra shrinkwrap edits", async () => {
  for (const [path, mutate] of [
    [
      "package.json",
      (pkg) => {
        pkg.scripts.build = "untrusted";
      },
    ],
    [
      "package.json",
      (pkg) => {
        pkg.version = "9.9.9";
      },
    ],
    [
      "package.json",
      (pkg) => {
        pkg.devDependencies.example = "9.9.9";
      },
    ],
    [
      "npm-shrinkwrap.json",
      (lock) => {
        lock.packages["node_modules/injected"] = { version: "9.9.9" };
      },
    ],
  ]) {
    const h = harness();
    const file = h.payload.files.find((file) => file.path === path);
    const value = JSON.parse(Buffer.from(file.contents, "base64"));
    mutate(value);
    file.contents = Buffer.from(JSON.stringify(value)).toString("base64");
    await assert.rejects(publish(h.github, context, h.payload, "unused", h.metadata), /patch bump/);
    assert.equal(h.state.published.length, 0);
  }
});

test("publication accepts patch bumps and validates their signed generated commit", async () => {
  for (const indexes of [[0], [1], [0, 1]]) {
    const h = harness();
    const original = { ...h.contents };
    const changed = { ...original };
    for (const index of indexes) {
      const path = INPUTS[index * 2 + 1];
      const lock = JSON.parse(changed[path]);
      lock.packages["node_modules/example"] = { version: "1.0.1" };
      changed[path] = JSON.stringify(lock);
    }
    const prepared = bumpPackageInputs(original, changed);
    const encoded = (value) => ({
      data: { type: "file", encoding: "base64", content: Buffer.from(value).toString("base64") },
    });
    h.github.rest.repos.getContent = async ({ path, ref }) =>
      encoded(
        path === PROVENANCE ? original[path] : (ref === base ? original : ref === head ? changed : prepared)[path],
      );
    const artifacts = {
      ...prepared,
      [PATCH]: codingDependencyPatch(
        original[PATCH],
        JSON.parse(original[UPSTREAM]),
        {
          packageJson: original[MANIFESTS[1]],
          shrinkwrap: original[INPUTS[3]],
        },
        { packageJson: prepared[MANIFESTS[1]], shrinkwrap: prepared[INPUTS[3]] },
      ),
      [PROVENANCE]: JSON.stringify(updateProvenance(provenance, prepared[MANIFESTS[1]], prepared[INPUTS[3]])),
      PACKAGE_SHA256: packagePaths(...MANIFESTS.map((path) => JSON.parse(prepared[path])))
        .sort()
        .map((path) => `${"a".repeat(64)}  ${path}\n`)
        .join(""),
      PACKAGE_NIX_HASHES: Buffer.from(
        h.payload.files.find((file) => file.path === "PACKAGE_NIX_HASHES").contents,
        "base64",
      ).toString(),
    };
    h.payload.files = generatedPaths().map((path) => ({
      path,
      contents: Buffer.from(artifacts[path]).toString("base64"),
    }));
    prepared[PATCH] = artifacts[PATCH];
    h.state.files = indexes.map((index) => ({ filename: INPUTS[index * 2 + 1], status: "modified" }));
    await publish(h.github, context, h.payload, "unused", h.metadata);
    assert.deepEqual(await dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits), [commit]);
    prepared[PATCH] = `${artifacts[PATCH]}\n`;
    await assert.rejects(
      dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits),
      /coding dependency patch unexpectedly/,
    );
    prepared[PATCH] = artifacts[PATCH];
    prepared[MANIFESTS[indexes[0]]] = JSON.stringify({
      ...JSON.parse(prepared[MANIFESTS[indexes[0]]]),
      scripts: { build: "untrusted" },
    });
    await assert.rejects(
      dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits),
      /more than the package patch version/,
    );
  }
});

test("publication rejects a changed reconstruction patch before creating a commit", async () => {
  const h = harness();
  h.payload.files.find((file) => file.path === PATCH).contents = Buffer.from(`${codingFixture.patch}\n`).toString(
    "base64",
  );
  await assert.rejects(publish(h.github, context, h.payload, "unused", h.metadata), /coding dependency patch differs/);
  assert.equal(h.state.published.length, 0);
});

test("publication and prepared-commit inspection read large patches through their pinned blob", async () => {
  const h = harness();
  const patch = `${codingFixture.patch}diff --git a/large.txt b/large.txt\n${" ".repeat(1024 * 1024)}\n`;
  const file = policyFileHarness(patch, true);
  h.contents[PATCH] = patch;
  h.payload.files.find((entry) => entry.path === PATCH).contents = Buffer.from(patch).toString("base64");
  const getContent = h.github.rest.repos.getContent;
  const reads = [];
  h.github.rest.repos.getContent = async (request) => {
    if (request.path !== PATCH) return getContent(request);
    reads.push(request);
    return { data: file.metadata };
  };
  const blobs = [];
  h.github.rest.git.getBlob = async (request) => {
    blobs.push(request);
    return { data: file.blob };
  };
  await publish(h.github, context, h.payload, "unused", h.metadata);
  assert.deepEqual(await dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits), [commit]);
  assert.deepEqual(
    reads.map(({ ref }) => ref),
    [base, generated, base],
  );
  assert.deepEqual(
    blobs,
    reads.map(() => ({ ...context.repo, file_sha: file.metadata.sha })),
  );
  file.blob.content = Buffer.from("different bytes").toString("base64");
  await assert.rejects(
    dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits),
    /Invalid blob content/,
  );
});

test("npm refresh emits a reconstruction patch for the prepared coding dependency inputs", () => {
  const { readFileSync, chmodSync } = require("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "coding-dependency-refresh-"));
  const source = join(directory, "source");
  const bin = join(directory, "bin");
  const output = join(directory, "artifacts.json");
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  try {
    mkdirSync(source);
    mkdirSync(bin);
    const baseline = {
      "package.json": JSON.stringify(manifest),
      "npm-shrinkwrap.json": fixtureLock(manifest),
      [`${CODING}/package.json`]: JSON.stringify(coding),
      [`${CODING}/npm-shrinkwrap.json`]: fixtureLock(coding),
      [PATCH]: codingFixture.patch,
      [UPSTREAM]: JSON.stringify(codingFixture.upstream),
      [PROVENANCE]: JSON.stringify(provenance),
      PACKAGE_NIX_HASHES: `source=sha256-${hash("old", "base64")}\nnpm_deps=sha256-${hash("deps", "base64")}\n`,
      PACKAGE_SHA256: "old\n",
      "scripts/verify-coding-upstream.mjs": "",
      "scripts/verify-openclaw-overlay.mjs": "",
    };
    for (const [path, contents] of Object.entries(baseline)) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), contents);
    }
    writeFileSync(join(source, ".gitignore"), "node_modules/\npackages/\n");
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("add", ".");
    git("commit", "--quiet", "-m", "baseline");
    const baseSha = git("rev-parse", "HEAD");
    writeFileSync(
      join(source, `${CODING}/package.json`),
      JSON.stringify({ ...coding, devDependencies: { ...coding.devDependencies, example: "1.0.1" } }),
    );
    git("commit", "--quiet", "-am", "dependency update");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(
      join(bin, "npm"),
      `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');
if(process.argv[2]==='--version') console.log('11.19.1');
else if(process.argv[2]==='pack') {const m=JSON.parse(fs.readFileSync('package.json'));fs.writeFileSync(p.join(process.argv[4],m.name.slice(1).replace('/','-')+'-'+m.version+'.tgz'),JSON.stringify(m));}\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    execFileSync(
      process.execPath,
      [join(__dirname, "refresh-dependency-artifacts.cjs"), source, "376", revision, baseSha, output],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" },
    );
    const payload = JSON.parse(readFileSync(output, "utf8"));
    const files = Object.fromEntries(
      payload.files.map(({ path, contents }) => [path, Buffer.from(contents, "base64").toString()]),
    );
    assert.equal(JSON.parse(files[`${CODING}/package.json`]).version, "1.0.1");
    assert.equal(
      files[PATCH],
      codingDependencyPatch(
        codingFixture.patch,
        codingFixture.upstream,
        {
          packageJson: baseline[`${CODING}/package.json`],
          shrinkwrap: baseline[`${CODING}/npm-shrinkwrap.json`],
        },
        { packageJson: files[`${CODING}/package.json`], shrinkwrap: files[`${CODING}/npm-shrinkwrap.json`] },
      ),
    );
    assert.notEqual(files[PATCH], codingFixture.patch);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preparation inspects only a current signed same-repository npm update", async () => {
  const h = harness();
  assert.equal((await inspect(h.github, context, 1, head)).pull.head.sha, head);
  for (const change of [
    { user: owner },
    { draft: true },
    { state: "closed" },
    { head: { ...pull.head, sha: base } },
    { head: { ...pull.head, repo: { full_name: "fork/repo" } } },
  ]) {
    h.state.pull = { ...pull, ...change };
    await assert.rejects(inspect(h.github, context, 1, head));
  }
  h.state.pull = pull;
  await assert.rejects(inspect(h.github, { ...context, ref: "refs/heads/feature" }, 1, head));
  h.state.files.push({ filename: "src/plugin.ts", status: "modified" });
  await assert.rejects(inspect(h.github, context, 1, head), /only accepts/);
  h.state.files = [{ filename: INPUTS[0], status: "renamed" }];
  await assert.rejects(inspect(h.github, context, 1, head), /only accepts/);
  h.state.files = [{ filename: INPUTS[0], status: "modified" }];
  h.state.commits[0].commit.verification.verified = false;
  await assert.rejects(inspect(h.github, context, 1, head), /signed/);
});

test("a signed preparation commit may only follow signed Dependabot commits and modify generated files", async () => {
  const h = harness();
  const prepared = {
    sha: generated,
    author: actions,
    commit: {
      verification: { verified: true },
      message: `Regenerate dependency artifacts [dependabot skip]\n\nDependabot-Head: ${head}`,
    },
  };
  const updated = { ...pull, head: { ...pull.head, sha: generated } };
  assert.deepEqual(await dependencyCommits(h.github, context.repo, updated, [commit, prepared]), [commit]);
  assert.deepEqual(await dependencyCommits(h.github, context.repo, updated, [commit, { ...prepared, author: owner }]), [
    commit,
  ]);
  assert.deepEqual(
    await dependencyCommits(h.github, context.repo, updated, [commit, { ...prepared, author: releaseApp }]),
    [commit],
  );
  for (const invalid of [
    { ...prepared, author: { login: "stranger", id: 200 } },
    { ...prepared, author: { login: "github-actions[bot]", id: 200 } },
    { ...prepared, author: { ...releaseApp, id: 200 } },
    { ...prepared, commit: { ...prepared.commit, verification: { verified: false } } },
    { ...prepared, commit: { ...prepared.commit, message: "unrelated commit" } },
    { ...prepared, commit: { ...prepared.commit, message: `Unrelated [dependabot skip]\n\nDependabot-Head: ${head}` } },
    { ...prepared, commit: { ...prepared.commit, message: `${prepared.commit.message}\n[skip ci]` } },
    { ...prepared, commit: { ...prepared.commit, message: prepared.commit.message.replace(head, base) } },
  ])
    await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, invalid]));
  h.state.generated.files = [{ filename: "src/plugin.ts", status: "modified" }];
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /outside/);
  h.state.generated.files = [{ filename: PROVENANCE, status: "removed" }];
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /outside/);
  h.state.generated.parents = [{ sha: base }];
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /outside/);
  h.state.generated = { parents: [{ sha: head }], files: [{ filename: PROVENANCE, status: "modified" }] };
  h.github.graphql = async () => ({
    repository: { object: { signature: { isValid: true, wasSignedByGitHub: false } } },
  });
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /signed by GitHub/);
});

test("preparation dispatches once per head and does not intercept action updates", async () => {
  const h = harness();
  const core = { info() {} };
  assert.equal(await requestPreparation(h.github, context, pull, core), true);
  assert.equal(h.state.dispatches[0].inputs.expected_head, head);
  h.state.runs.push({ display_title: `Prepare dependencies #1 at ${head}`, conclusion: "failure" });
  await requestPreparation(h.github, context, pull, core);
  assert.equal(h.state.dispatches.length, 1);
  h.state.files = [{ filename: ".github/workflows/ci.yml" }];
  assert.equal(await requestPreparation(h.github, context, pull, core), false);
});

test("publication limits files and uses expectedHeadOid for an atomic update", async () => {
  const h = harness();
  assert.equal(await publish(h.github, context, h.payload, "unused", h.metadata), generated);
  assert.equal(h.state.published[0].input.expectedHeadOid, head);
  assert.deepEqual(h.state.published[0].input.fileChanges.additions, h.payload.files);
});

test("preparation publishes only the commit with a scoped App client", async () => {
  const h = harness();
  h.github.graphql = async () => assert.fail("The default token must not publish the prepared commit");
  const publisher = {
    graphql: async (query, input) => {
      assert.match(query, /^mutation/);
      assert.equal(input.input.expectedHeadOid, head);
      h.state.pull.head.sha = generated;
      h.state.commits.push({ sha: generated });
      return { createCommitOnBranch: { commit: { oid: generated } } };
    },
  };
  assert.equal(await publish(h.github, context, h.payload, "unused", h.metadata, publisher), generated);
});

test("preparation App token is limited to this repository's contents", () => {
  const job = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))['jobs']['publish']))",
        resolve(__dirname, "../workflows/dependabot-preparation.yml"),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(job.environment, "release-automation");
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job.permissions.contents, "read");
  const token = job.steps.find((step) => step.name === "Scoped Release App token");
  assert.match(token.uses, /^actions\/create-github-app-token@[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(token.with).sort(), [
    "client-id",
    "owner",
    "permission-contents",
    "private-key",
    "repositories",
  ]);
  assert.equal(token.with["permission-contents"], "write");
  assert.equal(token.with.repositories, "${{ github.event.repository.name }}");
  const publishStep = job.steps.find((step) => step.name === "Publish generated files");
  assert.equal(publishStep.env.APP_TOKEN, "${{ steps.app.outputs.token }}");
  assert.match(publishStep.with.script, /getOctokit\(process\.env\.APP_TOKEN\)/);
});

test("publication waits for lagging PR metadata and commit lists", async () => {
  const h = harness();
  const pauses = [];
  h.github.rest.git.getRef = async () => ({ data: { object: { sha: pauses.length ? generated : head } } });
  await waitForPublishedHead(h.github, context.repo, pull, generated, async (ms) => {
    pauses.push(ms);
    h.state.pull = { ...pull, head: { ...pull.head, sha: generated } };
    if (pauses.length === 2) h.state.commits.push({ sha: generated });
  });
  assert.deepEqual(pauses, [2000, 2000]);
});

test("publication rejects genuine branch changes without retrying", async () => {
  for (const mutate of [
    (h) => {
      h.state.pull.head.sha = base;
    },
    (h) => {
      h.state.pull.state = "closed";
    },
    (h) => {
      h.state.pull.base.sha = head;
    },
    (h) => {
      h.github.rest.git.getRef = async () => ({ data: { object: { sha: base } } });
    },
  ]) {
    const h = harness();
    mutate(h);
    let sleeps = 0;
    await assert.rejects(
      waitForPublishedHead(h.github, context.repo, pull, generated, async () => {
        sleeps++;
      }),
      /PR changed/,
    );
    assert.equal(sleeps, 0);
  }
});

test("publication stops waiting after a bounded metadata delay", async () => {
  const h = harness();
  let sleeps = 0;
  await assert.rejects(
    waitForPublishedHead(h.github, context.repo, pull, generated, async () => {
      sleeps++;
    }),
    /not yet visible/,
  );
  assert.equal(sleeps, 9);
});

test("the PR guard checkout can execute its trusted policy without application code", () => {
  const root = resolve(__dirname, "../..");
  const directory = mkdtempSync(join(tmpdir(), "refresh-checkout-"));
  try {
    const selection = execFileSync(
      "python3",
      [
        "-c",
        [
          "import sys, yaml",
          "with open(sys.argv[1]) as handle: workflow = yaml.safe_load(handle)",
          "job = workflow['jobs']['guard']",
          "assert job['name'] == 'guard' and job['if'] == 'always()'",
          "assert job['needs'] == ['docs-ste']",
          "assert set(workflow.get('on', workflow.get(True))) == {'pull_request', 'workflow_dispatch'}",
          "assert job['permissions'] == {'contents': 'read', 'pull-requests': 'read'}",
          "step = next(s for s in job['steps'] if s.get('name') == 'Read the trusted main policy')",
          "assert step['with']['ref'] == 'main' and step['with']['persist-credentials'] is False",
          "print(step['with']['sparse-checkout'])",
        ].join("\n"),
        join(root, ".github/workflows/pr-validation.yml"),
      ],
      { encoding: "utf8" },
    );
    const checkout = join(directory, "automation");
    for (const path of selection.trim().split("\n")) {
      cpSync(join(root, path), join(checkout, path), { recursive: true });
    }
    const fixture = join(directory, "fixture");
    mkdirSync(fixture);
    for (const [name, value] of Object.entries({
      "files.json": "[]",
      head_sha: generated,
      author_association: "NONE",
      author_login: bot.login,
    }))
      writeFileSync(join(fixture, name), value);
    const result = execFileSync("python3", [join(checkout, ".github/scripts/verify-prepared-policy.py"), fixture], {
      encoding: "utf8",
    });
    assert.match(result, /Policy guard passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function preparedHarness() {
  const h = harness();
  h.state.pull.head.sha = generated;
  h.state.commits.push({
    sha: generated,
    author: actions,
    commit: {
      verification: { verified: true },
      message: `Regenerate dependency artifacts\n\nDependabot-Head: ${head}`,
    },
  });
  return h;
}

const dispatchedContext = {
  ...context,
  eventName: "workflow_dispatch",
  sha: generated,
  ref: `refs/heads/${pull.head.ref}`,
  payload: { inputs: { number: "1", expected_head: generated } },
};

function pullRequestContext(current) {
  return {
    repo: context.repo,
    eventName: "pull_request",
    ref: "refs/pull/1/merge",
    payload: { pull_request: structuredClone(current) },
  };
}

test("PR validation evaluates regular and prepared heads with trusted main policy", async () => {
  for (const create of [harness, preparedHarness]) {
    const h = create();
    let evaluated;
    await runPullRequestPolicy(
      h.github,
      pullRequestContext(h.state.pull),
      { info() {} },
      base,
      async (_github, repo, current, files) => {
        assert.deepEqual(repo, context.repo);
        assert.equal(files, h.state.files);
        evaluated = current.head.sha;
      },
    );
    assert.equal(evaluated, h.state.pull.head.sha);
    assert.deepEqual(h.state.reported, []);
  }
});

test("PR validation rejects stale events and untrusted policy revisions", async () => {
  for (const change of [
    (event) => {
      event.eventName = "push";
    },
    (event) => {
      event.ref = "refs/heads/main";
    },
    (event) => {
      event.payload.pull_request.head.sha = generated;
    },
    (event) => {
      event.payload.pull_request.base.sha = generated;
    },
  ]) {
    const h = harness();
    const event = pullRequestContext(h.state.pull);
    change(event);
    await assert.rejects(runPullRequestPolicy(h.github, event, { info() {} }, base, async () => assert.fail()));
  }
  const h = harness();
  await assert.rejects(
    runPullRequestPolicy(h.github, pullRequestContext(h.state.pull), { info() {} }, head, async () => assert.fail()),
  );
});

test("PR policy failures and changes during evaluation fail the guard", async () => {
  for (const evaluate of [
    async () => {
      throw new Error("Policy failed");
    },
    async (h) => {
      h.state.pull = { ...h.state.pull, head: { ...h.state.pull.head, sha: generated } };
    },
    async (h) => {
      h.state.pull = { ...h.state.pull, base: { ...h.state.pull.base, sha: generated } };
    },
    async (h) => {
      h.state.pull = { ...h.state.pull, state: "closed" };
    },
  ]) {
    const h = harness();
    await assert.rejects(
      runPullRequestPolicy(h.github, pullRequestContext(h.state.pull), { info() {} }, base, async () => evaluate(h)),
    );
  }
});

test("prepared updates dispatch validation without posting checks into an approval-pending suite", async () => {
  const h = preparedHarness();
  await requestValidation(h.github, context, h.state.pull, { info() {} });
  assert.deepEqual(h.state.reported, []);
  assert.deepEqual(h.state.dispatches, [
    {
      ...context.repo,
      workflow_id: "pr-validation.yml",
      ref: pull.head.ref,
      inputs: { number: "1", expected_head: generated },
    },
  ]);
});

test("the dispatched job evaluates the prepared SHA with the trusted main policy", async () => {
  const h = preparedHarness();
  let evaluated;
  await runDispatchedPolicy(h.github, dispatchedContext, { info() {} }, base, async (_github, _repo, current) => {
    evaluated = current.head.sha;
  });
  assert.equal(evaluated, generated);
  assert.deepEqual(h.state.reported, []);
  assert.deepEqual(h.state.dispatches, []);
});

test("the dispatched policy preserves the Actions context repository getter", async () => {
  const h = preparedHarness();
  class ActionsContext {
    get repo() {
      return context.repo;
    }
  }
  const { repo, ...fields } = dispatchedContext;
  const actual = Object.assign(new ActionsContext(), fields);
  assert.equal(Object.hasOwn(actual, "repo"), false);
  let evaluated = false;
  await runDispatchedPolicy(h.github, actual, { info() {} }, base, async (_github, repository) => {
    assert.deepEqual(repository, repo);
    evaluated = true;
  });
  assert.equal(evaluated, true);
});

test("prepared updates reuse PR validation including its guard", async () => {
  for (const conclusion of [null, "success", "failure"]) {
    const h = preparedHarness();
    h.state.runs = [{ head_sha: generated, event: "pull_request", conclusion }];
    await requestValidation(h.github, context, h.state.pull, { info() {} });
    assert.deepEqual(h.state.dispatches, []);
  }
});

test("cancelled or approval-blocked validation is recovered without replacing failed gates", async () => {
  for (const conclusion of ["cancelled", "skipped", "action_required", "stale"]) {
    const h = preparedHarness();
    h.state.runs = [{ head_sha: generated, event: "pull_request", conclusion }];
    h.state.guardRuns = [{ head_sha: generated, event: "workflow_dispatch", conclusion: "failure" }];
    await requestValidation(h.github, context, h.state.pull, { info() {} });
    assert.deepEqual(
      h.state.dispatches.map((dispatch) => dispatch.workflow_id),
      ["pr-validation.yml"],
    );
  }
});

test("a failed policy fails the dispatched job", async () => {
  const h = preparedHarness();
  await assert.rejects(
    runDispatchedPolicy(h.github, dispatchedContext, { info() {} }, base, async () => {
      throw new Error("Policy guard failed");
    }),
    /Policy guard failed/,
  );
  assert.deepEqual(h.state.reported, []);
  assert.deepEqual(h.state.dispatches, []);
});

test("a head or base change or closed PR during policy evaluation fails the job", async () => {
  for (const mutate of [
    (h) => {
      h.state.pull = { ...h.state.pull, head: { ...h.state.pull.head, sha: head } };
    },
    (h) => {
      h.state.pull = { ...h.state.pull, base: { ...h.state.pull.base, sha: head } };
    },
    (h) => {
      h.state.pull = { ...h.state.pull, state: "closed" };
    },
  ]) {
    const h = preparedHarness();
    await assert.rejects(
      runDispatchedPolicy(h.github, dispatchedContext, { info() {} }, base, async () => mutate(h)),
      /changed during/,
    );
  }
});

test("refresh recovers a missing dispatch and reuses active, successful and failed validation runs", async () => {
  const h = preparedHarness();
  await requestValidation(h.github, context, h.state.pull, { info() {} });
  assert.equal(h.state.dispatches.length, 1);
  for (const conclusion of [null, "success", "failure"]) {
    h.state.runs = [{ head_sha: generated, conclusion, event: "workflow_dispatch" }];
    h.state.guardRuns = h.state.runs;
    await requestValidation(h.github, context, h.state.pull, { info() {} });
    assert.equal(h.state.dispatches.length, 1);
  }
  assert.deepEqual(h.state.reported, []);
});

test("the policy job rejects mismatched events, refs, inputs, heads and trusted main revisions", async () => {
  for (const override of [
    { eventName: "pull_request" },
    { ref: "refs/heads/main" },
    { sha: head },
    { payload: { inputs: { number: "1; false", expected_head: generated } } },
    { payload: { inputs: { number: "1", expected_head: head } } },
    { payload: {} },
  ]) {
    const h = preparedHarness();
    let evaluated = false;
    await assert.rejects(
      runDispatchedPolicy(h.github, { ...dispatchedContext, ...override }, { info() {} }, base, async () => {
        evaluated = true;
      }),
    );
    assert.equal(evaluated, false);
  }
  const h = preparedHarness();
  await assert.rejects(
    runDispatchedPolicy(h.github, dispatchedContext, { info() {} }, head, async () => {}),
    /current same-repository/,
  );
});

test("dispatch refuses workflow changes, forged artifact commits and stale heads", async () => {
  for (const mutate of [
    (h) => h.state.files.push({ filename: ".github/workflows/pr-validation.yml", status: "modified" }),
    (h) => {
      h.state.commits[1].author = bot;
    },
    (h) => {
      h.state.pull.head.sha = head;
    },
  ]) {
    const h = preparedHarness();
    const snapshot = structuredClone(h.state.pull);
    mutate(h);
    await assert.rejects(requestValidation(h.github, context, snapshot, { info() {} }, async () => {}));
    await assert.rejects(runDispatchedPolicy(h.github, dispatchedContext, { info() {} }, base, async () => {}));
    assert.deepEqual(h.state.reported, []);
    assert.deepEqual(h.state.dispatches, []);
  }
});

test("dispatch outside main is rejected before any check is reported", async () => {
  const h = preparedHarness();
  await assert.rejects(
    requestValidation(h.github, { ...context, ref: "refs/heads/feature" }, h.state.pull, { info() {} }),
  );
  assert.deepEqual(h.state.reported, []);
});

for (const [name, mutate] of [
  [
    "head race",
    (h) => {
      h.state.pull.head.sha = generated;
    },
  ],
  [
    "base race",
    (h) => {
      h.state.pull.base.sha = generated;
    },
  ],
  [
    "extra file",
    (h) => {
      h.payload.files.push({ path: ".github/workflows/main.yml", contents: "" });
    },
  ],
  [
    "duplicate file",
    (h) => {
      h.payload.files[0] = h.payload.files[1];
    },
  ],
  [
    "source provenance rewrite",
    (h) => {
      h.payload.files[0].contents = Buffer.from(JSON.stringify({ ...provenance, "src/index.ts": "changed" })).toString(
        "base64",
      );
    },
  ],
  [
    "incorrect checksum",
    (h) => {
      h.payload.files[1].contents = Buffer.from("wrong").toString("base64");
    },
  ],
  [
    "checksum entries for unknown packages",
    (h) => {
      h.payload.files[1].contents = Buffer.from(
        `${"9".repeat(64)}  packages/owner-unknown-9.9.9.tgz\n${"8".repeat(64)}  packages/owner-coding-1.0.0.tgz\n`,
      ).toString("base64");
    },
  ],
  [
    "malformed Nix source hash",
    (h) => {
      h.payload.files[2].contents = Buffer.from(
        `source=sha256-untrusted\nnpm_deps=sha256-${hash("deps", "base64")}\n`,
      ).toString("base64");
    },
  ],
  [
    "extra Nix hash field",
    (h) => {
      h.payload.files[2].contents = Buffer.from(
        `${Buffer.from(h.payload.files[2].contents, "base64")}extra=value\n`,
      ).toString("base64");
    },
  ],
  [
    "ineligible metadata",
    (h) => {
      h.metadata = () => [];
    },
  ],
]) {
  test(`publication rejects ${name}`, async () => {
    const h = harness();
    mutate(h);
    await assert.rejects(publish(h.github, context, h.payload, "unused", h.metadata));
    assert.equal(h.state.published.length, 0);
  });
}

test("coding-agent dependency updates dispatch preparation and retain both checksum pins", async () => {
  const h = harness();
  h.state.files = [`${CODING}/package.json`, `${CODING}/npm-shrinkwrap.json`].map((filename) => ({
    filename,
    status: "modified",
  }));
  assert.equal(await requestPreparation(h.github, context, pull, { info() {} }), true);
  assert.equal(h.state.dispatches.length, 1);
  await inspect(h.github, context, 1, head);
  assert.equal(await publish(h.github, context, h.payload, "unused", h.metadata), generated);
  const checksums = h.payload.files.find((file) => file.path === "PACKAGE_SHA256");
  assert.match(Buffer.from(checksums.contents, "base64").toString(), /owner-coding-1\.0\.0\.tgz/);
});

test("checksum inventory rejects missing, duplicate, substituted, and malformed package pins", async () => {
  const paths = packagePaths(manifest, coding);
  const valid = paths.map((path) => `${"a".repeat(64)}  ${path}\n`).join("");
  assert.doesNotThrow(() => validateChecksums(valid, paths));
  for (const invalid of [
    `${valid.split("\n").slice(0, 1).join("\n")}\n`,
    valid.replace(paths[1], paths[0]),
    valid.replace(paths[1], "packages/owner-untrusted-1.0.0.tgz"),
    valid.replace(/^a/, "z"),
  ]) {
    const h = harness();
    h.payload.files.find((file) => file.path === "PACKAGE_SHA256").contents = Buffer.from(invalid).toString("base64");
    await assert.rejects(publish(h.github, context, h.payload, "unused", h.metadata), /checksum/);
    assert.equal(h.state.published.length, 0);
  }
  assert.throws(() => packagePaths(manifest), /inventory/);
});

test("coding-agent dependency preparation still rejects script changes", async () => {
  const h = harness();
  const original = h.github.rest.repos.getContent;
  h.github.rest.repos.getContent = async (args) =>
    args.path === MANIFESTS[1] && args.ref === head
      ? {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify({ ...coding, scripts: { build: "untrusted" } })).toString("base64"),
          },
        }
      : original(args);
  await assert.rejects(inspect(h.github, context, 1, head), /Non-dependency/);
});

test("generated artifact commits allow Dependabot rebasing and the new bot head gets fresh pins", async () => {
  const h = harness();
  const core = { info() {} };
  await requestPreparation(h.github, context, h.state.pull, core);
  await publish(h.github, context, h.payload, "unused", h.metadata);
  assert.deepEqual(h.state.published[0].input.message, {
    headline: "Regenerate dependency artifacts [dependabot skip]",
    body: `Dependabot-Head: ${head}`,
  });
  assert.deepEqual(await dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits), [commit]);
  h.state.runs.push({ display_title: `Prepare dependencies #1 at ${head}`, conclusion: "success" });
  const updatedHead = "d".repeat(40);
  const updatedBase = "e".repeat(40);
  h.state.pull = { ...pull, head: { ...pull.head, sha: updatedHead }, base: { ...pull.base, sha: updatedBase } };
  h.state.commits = [{ ...commit, sha: updatedHead }];
  h.state.files = ["package.json", "npm-shrinkwrap.json"].map((filename) => ({ filename, status: "modified" }));
  const current = { ...context, sha: updatedBase };
  await requestPreparation(h.github, current, h.state.pull, core);
  assert.deepEqual(h.state.dispatches.at(-1).inputs, { number: "1", expected_head: updatedHead });
  await assert.rejects(publish(h.github, current, h.payload, "unused", h.metadata), /current same-repository/);
  const payload = { ...h.payload, head: updatedHead, base: updatedBase };
  payload.files = payload.files.map((file) =>
    file.path === "PACKAGE_NIX_HASHES"
      ? {
          ...file,
          contents: Buffer.from(
            `source=sha256-${hash("updated root archive", "base64")}\nnpm_deps=sha256-${hash("updated dependencies", "base64")}\n`,
          ).toString("base64"),
        }
      : file.path === "PACKAGE_SHA256"
        ? {
            ...file,
            contents: Buffer.from(
              packagePaths(manifest, coding)
                .sort()
                .map((path) => `${hash(`updated ${path}`)}  ${path}\n`)
                .join(""),
            ).toString("base64"),
          }
        : file,
  );
  await publish(h.github, current, payload, "unused", h.metadata);
  const published = h.state.published.at(-1).input;
  assert.equal(published.branch.branchName, pull.head.ref);
  assert.equal(published.expectedHeadOid, updatedHead);
  assert.deepEqual(published.fileChanges.additions, payload.files);
  h.state.files.push(...generatedPaths().map((filename) => ({ filename, status: "modified" })));
  await requestValidation(h.github, current, h.state.pull, core);
  assert.deepEqual(h.state.dispatches.at(-1), {
    ...context.repo,
    workflow_id: "pr-validation.yml",
    ref: pull.head.ref,
    inputs: { number: "1", expected_head: generated },
  });
});

const { DOCKERFILE, dockerProvenance } = require("./docker-provenance.cjs");
const dockerBefore = `FROM node:22-bookworm-slim@sha256:${"1".repeat(64)}\nRUN echo unchanged\n`;
const dockerAfter = dockerBefore.replace("1".repeat(64), "2".repeat(64));
const dockerBaseline = { ...provenance, "e2e/Dockerfile.base": hash(dockerBefore) };

function dockerHarness() {
  const h = harness();
  h.state.files = [{ filename: DOCKERFILE, status: "modified" }];
  h.payload.files = [
    {
      path: PROVENANCE,
      contents: Buffer.from(JSON.stringify(dockerProvenance(dockerBefore, dockerAfter, dockerBaseline))).toString(
        "base64",
      ),
    },
  ];
  h.github.rest.git.getTree = async () => ({
    data: { truncated: false, tree: [DOCKERFILE, PROVENANCE].map((path) => ({ path, type: "blob", mode: "100644" })) },
  });
  const getContent = h.github.rest.repos.getContent;
  h.github.rest.repos.getContent = async (args) => {
    let value;
    if (args.path === DOCKERFILE) value = args.ref === base ? dockerBefore : dockerAfter;
    if (args.path === PROVENANCE)
      value =
        args.ref === generated
          ? Buffer.from(h.payload.files[0].contents, "base64").toString()
          : JSON.stringify(dockerBaseline);
    return value === undefined
      ? getContent(args)
      : {
          data: { type: "file", encoding: "base64", content: Buffer.from(value).toString("base64") },
        };
  };
  return h;
}

test("Docker digest updates prepare only provenance and dispatch guarded validation", async () => {
  const h = dockerHarness();
  assert.equal(await requestPreparation(h.github, context, h.state.pull, { info() {} }), true);
  assert.deepEqual((await inspect(h.github, context, 1, head)).paths, [PROVENANCE]);
  assert.equal(await publish(h.github, context, h.payload, "unused", h.metadata), generated);
  h.state.files.push({ filename: PROVENANCE, status: "modified" });
  assert.deepEqual(await dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits), [commit]);
  await requestValidation(h.github, context, h.state.pull, { info() {} });
  assert.equal(h.state.dispatches.at(-1).workflow_id, "pr-validation.yml");
});

test("Docker preparation rejects source edits, tag changes, malformed and ambiguous pins", () => {
  for (const after of [
    dockerBefore,
    dockerAfter.replace("22-bookworm", "26-bookworm"),
    dockerAfter.replace("echo unchanged", "curl attacker"),
    dockerAfter.replace("2".repeat(64), "2".repeat(63)),
    dockerAfter.replace("2".repeat(64), "G".repeat(64)),
    dockerAfter.replace("FROM node", "FROM attacker/node"),
    dockerAfter.replace("FROM node", "FROM \\\nnode"),
    `${dockerAfter}FROM node:22-bookworm-slim@sha256:${"3".repeat(64)}\n`,
    dockerAfter.replace("@sha256:", "@sha512:"),
  ])
    assert.throws(() => dockerProvenance(dockerBefore, after, dockerBaseline));
  assert.throws(() => dockerProvenance(dockerBefore, dockerAfter, provenance), /baseline provenance/);
});

test("Docker publication rejects unrelated provenance and artifacts, mixed inputs and stale identity", async () => {
  for (const mutate of [
    (h) => {
      h.payload.files[0].contents = Buffer.from(
        JSON.stringify({ ...dockerBaseline, "src/index.ts": "forged" }),
      ).toString("base64");
    },
    (h) => {
      h.payload.files.push({ path: "PACKAGE_SHA256", contents: "" });
    },
    (h) => {
      h.state.files.push({ filename: INPUTS[0], status: "modified" });
    },
    (h) => {
      h.state.files[0].status = "renamed";
    },
    (h) => {
      h.github.rest.git.getTree = async () => ({
        data: { tree: [{ path: DOCKERFILE, type: "blob", mode: "100755" }] },
      });
    },
    (h) => {
      h.github.rest.git.getTree = async () => ({ data: { truncated: true, tree: [] } });
    },
    (h) => {
      h.state.pull.base.sha = generated;
    },
    (h) => {
      h.state.pull.head.sha = generated;
    },
    (h) => {
      h.state.commits[0].commit.verification.verified = false;
    },
  ]) {
    const h = dockerHarness();
    mutate(h);
    await assert.rejects(publish(h.github, context, h.payload, "unused", h.metadata));
    assert.equal(h.state.published.length, 0);
  }
});

test("signed Docker preparation commits cannot rewrite unrelated provenance or package pins", async () => {
  for (const mutate of [
    (h) => {
      h.payload.files[0].contents = Buffer.from(JSON.stringify(dockerBaseline)).toString("base64");
    },
    (h) => {
      h.state.generated.files.push({ filename: "PACKAGE_SHA256", status: "modified" });
    },
  ]) {
    const h = dockerHarness();
    await publish(h.github, context, h.payload, "unused", h.metadata);
    h.state.files.push({ filename: PROVENANCE, status: "modified" });
    mutate(h);
    await assert.rejects(dependencyCommits(h.github, context.repo, h.state.pull, h.state.commits));
  }
});

test("Docker refresh emits only the verified provenance without running package or Docker commands", () => {
  const { readFileSync } = require("node:fs");
  const { refresh } = require("./refresh-dependency-artifacts.cjs");
  const directory = mkdtempSync(join(tmpdir(), "docker-preparation-"));
  const output = join(tmpdir(), `docker-preparation-${process.pid}.json`);
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(join(directory, "src/upstream/coding-agents/e2e"), { recursive: true });
    mkdirSync(join(directory, "integrations/coding-agents"), { recursive: true });
    writeFileSync(join(directory, DOCKERFILE), dockerBefore);
    writeFileSync(join(directory, PROVENANCE), JSON.stringify(dockerBaseline));
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("add", ".");
    git("commit", "-m", "baseline");
    const baseline = git("rev-parse", "HEAD");
    writeFileSync(join(directory, DOCKERFILE), dockerAfter);
    git("commit", "-am", "digest update");
    const revision = git("rev-parse", "HEAD");
    refresh(directory, 193, revision, baseline, output);
    const payload = JSON.parse(readFileSync(output));
    assert.deepEqual(payload, {
      number: 193,
      head: revision,
      base: baseline,
      files: [
        {
          path: PROVENANCE,
          contents: Buffer.from(
            `${JSON.stringify(dockerProvenance(dockerBefore, dockerAfter, dockerBaseline), null, 2)}\n`,
          ).toString("base64"),
        },
      ],
    });
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { force: true });
  }
});

test("refresh prepares Docker digests without semver metadata but never queues unknown updates", async () => {
  const { run } = require("./dependabot-auto-merge.cjs");
  const h = dockerHarness();
  h.github.rest.repos.getBranch = async () => ({ data: { commit: { sha: base } } });
  h.github.rest.repos.listPullRequestsAssociatedWithCommit = "associated";
  h.state.associated = [];
  const options = {
    github: h.github,
    context: { ...context, eventName: "pull_request_target", payload: { pull_request: h.state.pull } },
    core: { info() {}, warning: assert.fail, setFailed: assert.fail },
    metadata: () => [{ dependencyName: "node", newVersion: "22-bookworm-slim" }],
    isCurrent: async () => true,
    merge: () => assert.fail("Unknown Docker metadata must never enable auto-merge"),
  };
  await run(options);
  assert.equal(h.state.dispatches[0].workflow_id, "dependabot-preparation.yml");
  await publish(h.github, context, h.payload, "unused", options.metadata);
  h.state.files.push({ filename: PROVENANCE, status: "modified" });
  await run(options);
  assert.equal(h.state.dispatches.at(-1).workflow_id, "pr-validation.yml");
});

test("trusted policy enforces source contracts while allowing benign implementation edits", () => {
  const { readFileSync } = require("node:fs");
  const root = resolve(__dirname, "../..");
  const mutations = {
    ".github/scripts/docker-provenance.cjs": ["function dockerProvenance(", "function renamedDockerProvenance("],
    ".github/scripts/dependabot-auto-merge.cjs": ["const MINIMUM_SCORE = 75;", "const MINIMUM_SCORE = 0;"],
    ".github/scripts/dependency-files.cjs": ["function validateChecksums(", "function renamedValidateChecksums("],
    ".github/scripts/dependabot-preparation.cjs": ["expectedHeadOid: payload.head,", "expectedHeadOid: undefined,"],
    ".github/scripts/refresh-dependency-artifacts.cjs": [
      'run("git", ["merge-base", "--is-ancestor", base, head]);',
      'run("git", ["merge-base", base, head]);',
    ],
    ".github/scripts/dependabot-validation.cjs": ["context.sha !== current.base.sha ||", "false ||"],
    ".github/scripts/verify-prepared-policy.py": [
      'if not run.startswith(prefix) or not run.endswith("POLICY_SOURCE\\n"):',
      "if False:",
    ],
  };
  const workflow = ".github/workflows/dependabot-preparation.yml";
  const files = [...Object.keys(mutations), workflow];
  const directory = mkdtempSync(join(tmpdir(), "preparation-contracts-"));
  try {
    for (const path of files) {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      cpSync(join(root, path), join(directory, path));
    }
    for (const [name, value] of Object.entries({
      head_sha: head,
      author_association: "OWNER",
      author_login: "owner",
    }))
      writeFileSync(join(directory, name), value);
    const setFiles = (entries = files.map((filename) => ({ filename, status: "modified" }))) =>
      writeFileSync(join(directory, "files.json"), JSON.stringify(entries));
    const check = () =>
      execFileSync("python3", [join(root, ".github/scripts/verify-prepared-policy.py"), directory], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    setFiles();
    assert.match(check(), /Policy guard passed/);
    for (const [path, [before, after]] of Object.entries(mutations)) {
      const original = readFileSync(join(directory, path), "utf8");
      writeFileSync(
        join(directory, path),
        `${original}\n${path.endsWith(".py") ? "#" : "//"} benign maintenance comment\n`,
      );
      assert.match(check(), /Policy guard passed/);
      assert.ok(original.includes(before), path);
      writeFileSync(join(directory, path), original.replace(before, before.replaceAll(" ", "  ")));
      assert.match(check(), /Policy guard passed/);
      writeFileSync(join(directory, path), original.replace(before, after));
      assert.throws(check, /Command failed/, path);
      writeFileSync(join(directory, path), original);
      for (const status of ["removed", "renamed"]) {
        setFiles([{ filename: status === "renamed" ? `${path}.renamed` : path, previous_filename: path, status }]);
        assert.throws(check, /Command failed/, `${path} ${status}`);
      }
      setFiles();
    }
    const originalWorkflow = readFileSync(join(directory, workflow), "utf8");
    writeFileSync(
      join(directory, workflow),
      originalWorkflow.replace("core.setOutput('base',", "core.warning('base',"),
    );
    assert.throws(check, /Command failed/);
    writeFileSync(join(directory, workflow), originalWorkflow);
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      writeFileSync(join(directory, "author_association"), association);
      assert.match(check(), /Policy guard passed/);
    }
    for (const [association, login] of [
      ["NONE", "outside"],
      ["NONE", "dependabot[bot]"],
      ["OWNER", "dependabot[bot]"],
    ]) {
      writeFileSync(join(directory, "author_association"), association);
      writeFileSync(join(directory, "author_login"), login);
      assert.throws(check, /Command failed/);
    }
    writeFileSync(join(directory, "author_association"), "NONE");
    writeFileSync(join(directory, "author_login"), "dependabot[bot]");
    setFiles([{ filename: "src/upstream/coding-agents/npm-shrinkwrap.json", status: "modified" }]);
    assert.match(check(), /Policy guard passed/);
    setFiles([{ filename: workflow, status: "modified" }]);
    writeFileSync(join(directory, workflow), originalWorkflow.replace(/@[0-9a-f]{40}/, `@${"a".repeat(40)}`));
    assert.match(check(), /Policy guard passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("npm refresh rejects an unexpected packaging client before changing files", () => {
  const { readFileSync, chmodSync, existsSync } = require("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "npm-preparation-version-"));
  const source = join(directory, "source");
  const bin = join(directory, "bin");
  const output = join(directory, "artifacts.json");
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  try {
    mkdirSync(source);
    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\nprintf "11.9.0\\n"\n');
    chmodSync(join(bin, "npm"), 0o755);
    git("init", "--quiet");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
    git("add", ".");
    git("commit", "--quiet", "-m", "baseline");
    const baseline = git("rev-parse", "HEAD");
    const updated = JSON.stringify({ ...manifest, devDependencies: { ...manifest.devDependencies, example: "1.0.1" } });
    writeFileSync(join(source, "package.json"), updated);
    git("commit", "--quiet", "-am", "dependency update");
    const revision = git("rev-parse", "HEAD");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [join(__dirname, "refresh-dependency-artifacts.cjs"), source, "285", revision, baseline, output],
          { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" },
        ),
      (error) => error.stderr.toString().includes("Dependency preparation requires npm 11.19.1"),
    );
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(readFileSync(join(source, "package.json"), "utf8"), updated);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every packaging job selects and verifies the same npm before install, tests or packing", () => {
  const workflows = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,pathlib,yaml; print(json.dumps({p.name: yaml.safe_load(p.read_text()) for p in pathlib.Path('.github/workflows').glob('*.yml')}))",
      ],
      { cwd: resolve(__dirname, "../.."), encoding: "utf8" },
    ),
  );
  const expectedJobs = new Set([
    ...(workflows["main.yml"].jobs.quality.uses.includes("trusted-ci.yml@")
      ? []
      : ["ci.yml/checks", "ci.yml/combination"]),
    "trusted-ci.yml/build",
    "trusted-ci.yml/combination",
    "main.yml/publish",
    "release.yml/prepare-release",
    "dependabot-preparation.yml/build",
  ]);
  const observed = new Set();
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps || [];
      const scripts = steps.map((step) => step.run || "");
      if (
        !scripts.some((script) =>
          /(?:^\s*|="\$\(|&& )npm pack|^\s*node .*refresh-dependency-artifacts\.cjs/m.test(script),
        )
      )
        continue;
      const key = `${name}/${jobName}`;
      observed.add(key);
      const install = scripts.findIndex((script) => script.includes("npm install --global npm@11.19.1 "));
      assert.notEqual(install, -1, `${key}: missing npm selection`);
      assert.match(scripts[install], /test "\$\(npm --version\)" = 11\.19\.1/, `${key}: missing version assertion`);
      const assertion = scripts[install].indexOf('test "$(npm --version)" = 11.19.1');
      assert.ok(assertion > scripts[install].indexOf("npm install --global npm@11.19.1 "));
      const earlier = [...scripts.slice(0, install), scripts[install].slice(0, assertion)].join("\n");
      assert.doesNotMatch(
        earlier,
        /npm (?:ci|pack|test|run)|refresh-dependency-artifacts\.cjs/,
        `${key}: uses npm before selection`,
      );
    }
  }
  assert.deepEqual(observed, expectedJobs);
});

function policyFileHarness(text, large = false) {
  const bytes = Buffer.from(text);
  const sha = execFileSync("git", ["hash-object", "--stdin"], { input: bytes, encoding: "utf8" }).trim();
  const blob = { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") };
  const metadata = { ...blob, type: "file", ...(large ? { encoding: "none", content: "" } : {}) };
  const requests = [];
  const github = {
    rest: {
      repos: {
        getContent: async (request) => {
          requests.push({ operation: "contents", ...request });
          return { data: metadata };
        },
      },
      git: {
        getBlob: async (request) => {
          requests.push({ operation: "blob", ...request });
          return { data: blob };
        },
      },
    },
  };
  const run = () => runPolicy(github, context.repo, pull, [{ filename: "package.json", status: "modified" }]);
  return { run, github, metadata, blob, requests };
}

const policyPackage = JSON.stringify({
  scripts: { "aislop:ci": "aislop ci", "test:coverage": "vitest run --coverage" },
});

test("policy reads inline base64 at the exact PR head without a blob request", async () => {
  const h = policyFileHarness(policyPackage);
  h.metadata.content = `${h.metadata.content.match(/.{1,60}/g).join("\n")}\n`;
  await h.run();
  assert.deepEqual(h.requests, [{ operation: "contents", ...context.repo, path: "package.json", ref: head }]);
});

test("policy reads a large file by its immutable blob and evaluates its trailing contents", async () => {
  const h = policyFileHarness(`${" ".repeat(1024 * 1024)}${policyPackage}`, true);
  await h.run();
  assert.deepEqual(h.requests, [
    { operation: "contents", ...context.repo, path: "package.json", ref: head },
    { operation: "blob", ...context.repo, file_sha: h.metadata.sha },
  ]);
  const invalid = policyFileHarness(`${" ".repeat(1024 * 1024)}{"scripts":{}}`, true);
  await assert.rejects(invalid.run, (error) => error.stdout.includes("coverage test command must stay configured"));
});

test("policy rejects non-files and malformed contents metadata before blob lookup", async () => {
  for (const metadata of [
    null,
    [],
    { type: "dir" },
    { type: "symlink" },
    { type: "file", encoding: "none", submodule_git_url: "https://example.invalid/repo" },
    { type: "file", encoding: "none", target: "package.json" },
    { type: "file", encoding: "none", sha: "not-a-sha", size: 2, content: "" },
    { type: "file", encoding: "none", sha: head, size: -1, content: "" },
    { type: "file", encoding: "none", sha: head, size: "2", content: "" },
    { type: "file", encoding: "none", sha: head, size: 2, content: "unexpected" },
    { type: "file", encoding: "base64", content: null },
    { type: "file", encoding: "base64", content: "!!!" },
    { type: "file", encoding: "utf-8", content: policyPackage },
  ]) {
    const h = policyFileHarness(policyPackage);
    h.github.rest.repos.getContent = async () => ({ data: metadata });
    await assert.rejects(h.run, /Not a regular file|Invalid file/);
    assert.deepEqual(h.requests, []);
  }
});

test("policy rejects malformed or mismatched blobs instead of accepting omitted file contents", async () => {
  for (const mutate of [
    (blob) => {
      blob.sha = base;
    },
    (blob) => {
      blob.size += 1;
    },
    (blob) => {
      blob.encoding = "none";
    },
    (blob) => {
      blob.content = undefined;
    },
    (blob) => {
      blob.content += "!";
    },
    (blob) => {
      blob.content = Buffer.from("x").toString("base64");
    },
    (blob) => {
      blob.content = Buffer.from(policyPackage.replace("aislop ci", "aislop xx")).toString("base64");
    },
  ]) {
    const h = policyFileHarness(policyPackage, true);
    mutate(h.blob);
    await assert.rejects(h.run, /Invalid (?:blob|file)/);
    assert.equal(h.requests.length, 2);
  }
  const h = policyFileHarness(policyPackage, true);
  h.github.rest.git.getBlob = async () => ({ data: null });
  await assert.rejects(h.run, /Invalid blob metadata/);
});

test("policy propagates content and blob retrieval failures without fallback or success", async () => {
  for (const operation of ["getContent", "getBlob"]) {
    const h = policyFileHarness(policyPackage, true);
    const failure = new Error("GitHub request failed");
    h.github.rest[operation === "getContent" ? "repos" : "git"][operation] = async () => {
      throw failure;
    };
    await assert.rejects(h.run, (error) => error === failure);
    assert.equal(h.requests.length, operation === "getContent" ? 0 : 1);
  }
});

function runTrustedScannerTests(files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return execFileSync(process.execPath, ["--test", ...files], { encoding: "utf8", env });
}

// Keep the bootstrap boundary suite in an existing required workflow before the
// immutable reusable workflows are activated.
test("trusted scanner boundary suite passes before activation", () => {
  runTrustedScannerTests(
    ["identity", "scan-tree", "safe-path", "workflows"].map((name) =>
      resolve(__dirname, `../trusted-ci/${name}.test.cjs`),
    ),
  );
});

test("trusted scanner boundary runner propagates child test failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "trusted-scanner-failure-"));
  try {
    const sentinel = join(directory, "sentinel.test.cjs");
    writeFileSync(
      sentinel,
      'require("node:test")("child failure sentinel", () => { throw new Error("trusted scanner sentinel failed"); });\n',
    );
    assert.throws(
      () => runTrustedScannerTests([sentinel]),
      (error) => error.status === 1 && error.stdout.includes("trusted scanner sentinel failed"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
