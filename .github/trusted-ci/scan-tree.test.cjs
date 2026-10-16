const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { prepare } = require("./scan-tree.cjs");
test("the tracked scanner implementation prepares its own candidate tree", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-scanner-self-"));
  try {
    const source = path.resolve(__dirname, "../..");
    const output = path.join(temporary, "scan");
    prepare(source, output);
    assert.equal(
      fs.readFileSync(path.join(output, ".github/trusted-ci/scan-tree.cjs"), "utf8"),
      fs.readFileSync(path.join(__dirname, "scan-tree.cjs"), "utf8"),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-scanner-"));
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  const write = (name, text) => {
    const target = path.join(source, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  try {
    run({ source, output: path.join(dir, "output"), write, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("candidate config and nested overrides cannot weaken trusted scanner controls", () =>
  fixture(({ source, output, write }) => {
    for (const file of [
      ".aislop/config.yml",
      ".aislop/rules.yml",
      ".aislopignore",
      "biome.json",
      "nested/biome.jsonc",
      ".semgrepignore",
      ".npmrc",
    ])
      write(file, "malicious");
    write("src/code.ts", "export const value = 1;");
    write("package.json", JSON.stringify({ scripts: { preinstall: "touch NEVER" } }));
    prepare(source, output);
    assert.equal(fs.readFileSync(path.join(output, "src/code.ts"), "utf8"), "export const value = 1;");
    assert.equal(
      fs.readFileSync(path.join(output, "biome.json"), "utf8"),
      fs.readFileSync(path.join(__dirname, "biome-config.json"), "utf8"),
    );
    assert.equal(
      fs.readFileSync(path.join(output, ".aislop/config.yml"), "utf8"),
      fs.readFileSync(path.join(__dirname, ".aislop/config.yml"), "utf8"),
    );
    for (const name of [".aislop/rules.yml", "nested/biome.jsonc", ".semgrepignore", ".npmrc", "NEVER"])
      assert.equal(fs.existsSync(path.join(output, name)), false);
  }));
test("all candidate Knip dependency declarations fail before scanner invocation", () => {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    fixture(({ source, output, write }) => {
      write("nested/package.json", JSON.stringify({ [section]: { knip: "1" } }));
      write("knip.config.js", 'throw new Error("must never execute");');
      assert.throws(() => prepare(source, output), /Knip execution/);
    });
  }
});
test("candidate inline scanner suppressions fail before scanner invocation", () => {
  const directive = "aislop" + "-ignore";
  for (const marker of ["//", "/*", "/***", "#", "<!--", "*"]) {
    for (const scope of ["", "-file", "-line", "-next-line"]) {
      for (const rule of ["", " unsafe-type-assertion -- reason"]) {
        fixture(({ source, output, write }) => {
          write(
            "nested/bad.ts",
            `${marker} ${directive}${scope}${rule}\nexport const answer = JSON.parse("null") as any;`,
          );
          assert.throws(() => prepare(source, output), /inline scanner suppression/);
          assert.equal(fs.existsSync(path.join(output, "nested/bad.ts")), false);
        });
      }
    }
  }
  for (const text of [
    `export const answer = JSON.parse("null") as any; // ${directive}`,
    `const example = "// ${directive}-file";`,
  ]) {
    fixture(({ source, output, write }) => {
      write("bad.ts", text);
      assert.throws(() => prepare(source, output), /inline scanner suppression/);
    });
  }
});
test("symlinks and reused destinations fail closed without altering outside files", () =>
  fixture(({ source, output, write, dir }) => {
    write("source.txt", "safe");
    const outside = path.join(dir, "outside");
    fs.writeFileSync(outside, "unchanged");
    fs.symlinkSync(outside, path.join(source, "biome.json"));
    assert.throws(() => prepare(source, output), /symlink/);
    assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
    fs.unlinkSync(path.join(source, "biome.json"));
    assert.throws(() => prepare(source, output), /fresh/);
    assert.throws(() => prepare(source, path.join(source, "nested")));
  }));

test("ESLint ignore controls cannot remove source from the confined scan tree", () =>
  fixture(({ source, output, write }) => {
    const names = [
      "eslint.config.js",
      "eslint.config.cjs",
      "eslint.config.mjs",
      "eslint.config.ts",
      "eslint.config.cts",
      "eslint.config.mts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yaml",
      ".eslintrc.yml",
      ".eslintignore",
    ];
    for (const directory of ["", "nested/"]) {
      write(`${directory}unsafe.js`, "const unused = 1;");
      for (const name of names) write(`${directory}${name}`, 'export default [{ ignores: ["**"] }];');
    }
    prepare(source, output);
    for (const directory of ["", "nested/"]) {
      assert.equal(fs.readFileSync(path.join(output, `${directory}unsafe.js`), "utf8"), "const unused = 1;");
      for (const name of names) assert.equal(fs.existsSync(path.join(output, `${directory}${name}`)), false);
    }
  }));
