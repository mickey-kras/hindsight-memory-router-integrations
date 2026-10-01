const { hash, PROVENANCE } = require("./dependency-files.cjs");

const DOCKERFILE = "src/upstream/coding-agents/e2e/Dockerfile.base";
const ENTRY = "e2e/Dockerfile.base";

function dockerProvenance(before, after, provenance) {
  const pattern = /^FROM node:[A-Za-z0-9_.-]+@sha256:[0-9a-f]{64}$/gm;
  const oldPins = [...before.matchAll(pattern)];
  const newPins = [...after.matchAll(pattern)];
  if (
    oldPins.length !== 1 ||
    newPins.length !== 1 ||
    before === after ||
    before.replace(pattern, (line) => line.slice(0, -64)) !== after.replace(pattern, (line) => line.slice(0, -64))
  ) {
    throw new Error("Docker preparation requires only a Node image digest change");
  }
  if (provenance[ENTRY] !== hash(before)) throw new Error("Docker baseline provenance mismatch");
  return { ...provenance, [ENTRY]: hash(after) };
}

function dockerOnly(paths) {
  return paths.length === 1 && paths[0] === DOCKERFILE;
}

module.exports = { DOCKERFILE, PROVENANCE, dockerProvenance, dockerOnly };
