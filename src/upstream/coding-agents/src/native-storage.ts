import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertUnlinkedTree } from "./install-transaction";

export function stageNativeKeychain(sourceRoot: string, targetRoot: string): void {
  const require = createRequire(join(sourceRoot, "package.json"));
  const packagePath = require.resolve("@napi-rs/keyring/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version: string; optionalDependencies: Record<string, string>;
  };
  const packages = new Map<string, string>([["@napi-rs/keyring", dirname(packagePath)]]);
  for (const [name, version] of Object.entries(manifest.optionalDependencies)) {
    if (!/^@napi-rs\/keyring-[a-z0-9-]+$/.test(name) || version !== manifest.version) throw new Error("invalid keychain package");
    let path: string;
    try { path = require.resolve(`${name}/package.json`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
    if ((JSON.parse(readFileSync(path, "utf8")) as { version: string }).version !== manifest.version) throw new Error("invalid keychain version");
    packages.set(name, dirname(path));
  }
  if (packages.size < 2) throw new Error("native keychain unavailable");
  for (const path of packages.values()) assertUnlinkedTree(path);
  const scope = join(targetRoot, "node_modules", "@napi-rs");
  if (existsSync(scope)) assertUnlinkedTree(scope);
  rmSync(scope, { recursive: true, force: true });
  mkdirSync(scope, { recursive: true });
  for (const [name, path] of packages) cpSync(path, join(targetRoot, "node_modules", name), { recursive: true });
}
