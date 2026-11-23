import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertUnlinkedTree } from "./install-transaction";

export function stageNativeKeychain(sourceRoot: string, targetRoot: string, required = true): boolean {
  const require = createRequire(join(sourceRoot, "package.json"));
  let packagePath: string;
  try { packagePath = require.resolve("@napi-rs/keyring/package.json"); } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return false;
    throw error;
  }
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
  for (const path of packages.values()) assertUnlinkedTree(path);
  if (packages.size < 2) {
    if (!required) return false;
    throw new Error("native keychain unavailable");
  }
  // The staged installer runs after the npm cache can have been removed. Copy the
  // lockfile-pinned native lock and its runtime dependencies alongside the keyring.
  for (const name of ["fs-native-extensions", "require-addon", "which-runtime", "bare-addon-resolve",
    "bare-host-parser", "bare-module-resolve", "bare-semver"]) {
    const root = require.resolve.paths(name)?.map(base => join(base, name))
      .find(path => existsSync(join(path, "package.json")));
    if (!root) throw new Error("native session lock unavailable");
    assertUnlinkedTree(root);
    packages.set(name, root);
  }
  const scope = join(targetRoot, "node_modules", "@napi-rs");
  if (existsSync(scope)) assertUnlinkedTree(scope);
  rmSync(scope, { recursive: true, force: true });
  mkdirSync(scope, { recursive: true });
  for (const [name, path] of packages) {
    const destination = join(targetRoot, "node_modules", name);
    if (existsSync(destination)) {
      assertUnlinkedTree(destination);
      rmSync(destination, { recursive: true });
    }
    cpSync(path, destination, { recursive: true });
  }
  return true;
}
