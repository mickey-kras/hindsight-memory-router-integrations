export class RouterUrlError extends Error {
  constructor(reason: "missing" | "not-https" | "userinfo" | "invalid") {
    super(`routerUrl rejected: ${reason}`);
    this.name = "RouterUrlError";
  }
}

export function validateRouterUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RouterUrlError("missing");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RouterUrlError("invalid");
  }
  if (url.protocol !== "https:") {
    throw new RouterUrlError("not-https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RouterUrlError("userinfo");
  }
  return url.toString().replace(/\/$/, "");
}
