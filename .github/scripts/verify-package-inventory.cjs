const { readFileSync } = require("node:fs");
const { MANIFESTS, packagePaths, validateChecksums } = require("./dependency-files.cjs");

const tarballs = packagePaths(...MANIFESTS.map((path) => JSON.parse(readFileSync(path, "utf8"))));
validateChecksums(readFileSync("PACKAGE_SHA256", "utf8"), tarballs);
