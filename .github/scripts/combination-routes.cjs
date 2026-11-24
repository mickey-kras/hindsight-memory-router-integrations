// The router decides access by scope. The HTTP method and the facade read flag do not.
const ACCESS_BY_SCOPE = {
  "memory.recall": "read",
  "memory.reflect": "read",
  "bank.config.read": "read",
  "memory.retain": "write",
  "bank.config.write": "write",
  "bank.admin": "write",
};

const key = ({ method, route }) => `${method} /${route}`;
const suffixOf = (route) => (route ? `/${route.replace(/\{\w+\}/g, "id")}` : "");

/**
 * Compares the client contract table with the routes of the resolved router and
 * with the packaged client classifier. Returns one message for each difference.
 */
function compareRoutes(table, router, classify) {
  const errors = [];
  const expected = new Map(table.map((entry) => [key(entry), entry]));
  const served = new Map(router.map((entry) => [key(entry), entry]));
  if (expected.size !== table.length) errors.push("contract table has duplicate routes");
  for (const [name, entry] of expected) {
    const route = served.get(name);
    if (!route) {
      errors.push(`${name}: the router does not serve this route; remove it from the contract table`);
      continue;
    }
    for (const field of ["scope", "payloadScope"]) {
      if (entry[field] !== route[field]) {
        errors.push(`${name}: ${field} is ${route[field]} in the router, ${entry[field]} in the contract table`);
      }
    }
    const access = ACCESS_BY_SCOPE[route.scope];
    if (!access) errors.push(`${name}: unknown router scope ${route.scope}`);
    else if (entry.access !== "excluded" && entry.access !== access) {
      errors.push(`${name}: expected ${access} for router scope ${route.scope}, contract table says ${entry.access}`);
    }
    const actual = classify(entry.method, suffixOf(entry.route));
    if (actual !== entry.access) errors.push(`${name}: expected ${entry.access}, packaged client says ${actual}`);
  }
  for (const [name, route] of served) {
    if (!expected.has(name)) {
      errors.push(`${name}: router route with scope ${route.scope} has no classification or exclusion`);
    }
  }
  return errors;
}

module.exports = { compareRoutes };
