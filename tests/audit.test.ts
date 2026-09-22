import { describe, expect, it } from "vitest";
import { formatMemoryOperationAudit, memoryOperationErrorClass } from "../src/shared/audit.js";
import { AccessDeniedError } from "../src/shared/bank-access.js";
import { CredentialResolutionError, UnknownPrincipalError } from "../src/shared/principal-credential-resolver.js";
import { RecallAuthorizationError } from "../src/shared/recall-coordinator.js";
import { RouterRequestError } from "../src/shared/router-transport.js";
import { RetainAuthorizationError } from "../src/shared/retain-coordinator.js";

describe("memoryOperationErrorClass", () => {
  it.each([
    [new AccessDeniedError(), "access_denied"],
    [new RecallAuthorizationError("bank"), "access_denied"],
    [new RetainAuthorizationError("bank"), "access_denied"],
    [new RouterRequestError(503), "router_request_failed"],
    [new UnknownPrincipalError("ghost"), "identity_resolution_failed"],
    [new CredentialResolutionError("missing-token"), "identity_resolution_failed"],
    [new Error("boom"), "operation_failed"],
    ["boom", "operation_failed"],
  ])("maps %s to %s", (error, expected) => {
    expect(memoryOperationErrorClass(error)).toBe(expected);
  });
});

describe("formatMemoryOperationAudit", () => {
  it("emits single-line JSON with a timestamp and drops unset metadata", () => {
    const line = formatMemoryOperationAudit(
      { principal: "agent", op: "memory_router_retain", outcome: "success" },
      new Date("2026-09-19T00:00:00Z"),
    );
    expect(line).toBe(
      '{"at":"2026-09-19T00:00:00.000Z","principal":"agent","op":"memory_router_retain","outcome":"success"}',
    );
  });

  it("includes bank and bounded error class when present", () => {
    const line = formatMemoryOperationAudit(
      {
        principal: "agent",
        op: "memory_router_retain",
        outcome: "failure",
        bankId: "agent-bank",
        errorClass: "access_denied",
      },
      new Date("2026-09-19T00:00:00Z"),
    );
    expect(JSON.parse(line)).toEqual({
      at: "2026-09-19T00:00:00.000Z",
      principal: "agent",
      op: "memory_router_retain",
      outcome: "failure",
      bankId: "agent-bank",
      errorClass: "access_denied",
    });
  });
});
