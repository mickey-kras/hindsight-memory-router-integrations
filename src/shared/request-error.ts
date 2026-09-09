export function isAuthorizationError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return status === 401 || status === 403;
}

export function isTransientRequestError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  if (error instanceof DOMException) {
    return ["AbortError", "NetworkError", "TimeoutError"].includes(error.name);
  }
  if (error instanceof TypeError) return error.message === "fetch failed";
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}
