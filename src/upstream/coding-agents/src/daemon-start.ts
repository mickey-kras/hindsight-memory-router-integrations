#!/usr/bin/env node
/** Legacy entrypoint: local upstream deployment is prohibited in router integrations. */
import { AccessDeniedError } from "@memory-router/shared/bank-access";
throw new AccessDeniedError();
