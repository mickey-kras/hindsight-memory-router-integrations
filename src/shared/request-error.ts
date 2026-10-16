export function isAuthorizationError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return status === 401 || status === 403;
}

export function isTransientRequestError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  if (error instanceof DOMException) {
    return ["AbortError", "NetworkError", "TimeoutError"].includes(error.name);
  }
  if (error instanceof TypeError) {
    if (error.message === "fetch failed") return true;
    // Body reads can fail after headers arrive; require a known transport cause.
    const cause = error.cause as { code?: unknown } | undefined;
    return (
      error.message === "terminated" &&
      typeof cause?.code === "string" &&
      [
        "UND_ERR_SOCKET",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
      ].includes(cause.code)
    );
  }
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}
