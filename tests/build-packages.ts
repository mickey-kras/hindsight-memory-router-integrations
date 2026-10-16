import { execFileSync } from "node:child_process";

// Always build from source, including standalone Vitest runs. CI reuses this
// output only after this invocation succeeds; existing dist is never a cache.
export default function buildPackages(): void {
  execFileSync("npm", ["run", "build", "--silent"], { stdio: "inherit" });
  execFileSync("npm", ["run", "build:coding-agents", "--silent"], { stdio: "inherit" });
}
