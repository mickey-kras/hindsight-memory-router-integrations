import { readFileSync } from "node:fs";

const ALLOWED_ADVISORY = 1193734;
const EXPIRES_AT = Date.parse("2026-10-09T00:00:00Z");
const ISSUE_URL = "https://github.com/advisories/GHSA-vwc7-r8mq-g2x9";

const report = JSON.parse(readFileSync(0, "utf8"));
const vulnerabilities = report.vulnerabilities ?? {};

const isAllowedAdmZip = (name, vulnerability) =>
  name === "adm-zip" &&
  vulnerability.fixAvailable === false &&
  vulnerability.effects?.length === 1 &&
  vulnerability.effects[0] === "aislop" &&
  vulnerability.via?.length === 1 &&
  vulnerability.via[0]?.source === ALLOWED_ADVISORY &&
  vulnerability.via[0]?.url === ISSUE_URL;

const isAllowedAislopWrapper = (name, vulnerability) =>
  name === "aislop" &&
  vulnerability.isDirect === true &&
  vulnerability.fixAvailable === false &&
  vulnerability.via?.length === 1 &&
  vulnerability.via[0] === "adm-zip";

const blocked = Object.entries(vulnerabilities).filter(
  ([name, vulnerability]) =>
    !isAllowedAdmZip(name, vulnerability) &&
    !isAllowedAislopWrapper(name, vulnerability),
);

if (Date.now() >= EXPIRES_AT) {
  console.error(
    `Temporary adm-zip audit exception expired; review ${ISSUE_URL}`,
  );
  process.exit(1);
}

if (blocked.length > 0) {
  console.error(
    `npm audit reported blocked vulnerabilities: ${blocked.map(([name]) => name).join(", ")}`,
  );
  process.exit(1);
}

if (!("adm-zip" in vulnerabilities) && "aislop" in vulnerabilities) {
  console.error("npm audit returned an unexpected aislop vulnerability shape");
  process.exit(1);
}

if ("adm-zip" in vulnerabilities) {
  console.warn(
    `Temporarily allowing npm advisory ${ALLOWED_ADVISORY}; expires 2026-10-09`,
  );
}
