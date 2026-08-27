import { HttpApiBuilder } from "@effect/platform";
import { attest } from "../../services/attestation/attest";
import { Api } from "../api";

/**
 * Deliberately thin: all the real logic (dispatch, verification, event
 * emission) lives in `services/attestation/attest.ts`, which is unit-tested
 * directly. This handler only adapts the validated HTTP payload to it.
 */
export const AgentLive = HttpApiBuilder.group(Api, "agent", (handlers) =>
  handlers.handle("attest", ({ payload }) => attest(payload)),
);
