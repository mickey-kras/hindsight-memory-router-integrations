import { AccessDeniedError } from "./bank-access.js";
import { CredentialResolutionError, UnknownPrincipalError } from "./principal-credential-resolver.js";
import { RecallAuthorizationError } from "./recall-coordinator.js";
import { RetainAuthorizationError } from "./retain-coordinator.js";
import { RouterRequestError } from "./router-transport.js";

export interface MemoryOperationAudit {
  principal: string;
  op: string;
  outcome: "success" | "failure";
  bankId?: string;
  errorClass?: string;
}

export type MemoryAuditLogger = (event: MemoryOperationAudit) => void;

// A throwing audit sink must never break or alter the outcome of a memory operation.
export function safeAuditLogger(sink: MemoryAuditLogger): MemoryAuditLogger {
  return (event) => {
    try {
      sink(event);
    } catch {
      // Intentionally swallowed.
    }
  };
}

export function memoryOperationErrorClass(error: unknown): string {
  if (
    error instanceof AccessDeniedError ||
    error instanceof RecallAuthorizationError ||
    error instanceof RetainAuthorizationError
  ) {
    return "access_denied";
  }
  if (error instanceof RouterRequestError) {
    return "router_request_failed";
  }
  if (error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError) {
    return "identity_resolution_failed";
  }
  return "operation_failed";
}

// Single-line JSON with metadata only; memory content, transcripts, and page titles are never logged.
export function formatMemoryOperationAudit(event: MemoryOperationAudit, at: Date = new Date()): string {
  return JSON.stringify({ at: at.toISOString(), ...event });
}
