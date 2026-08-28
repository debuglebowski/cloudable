import { Effect, Layer } from "effect";
import { type AttestationMethod, AttestationRegistryTag } from "./AttestationMethod";
import { joinTokenAttestation } from "./JoinTokenAttestation";
import { managedIdentityAttestationEffect } from "./managed-identity";

/**
 * Wires every `AttestationMethod` implementation into the registry the
 * `/attest` endpoint dispatches against (see `AttestationMethod.ts` for why
 * this is a map behind one `Context.Tag` rather than one tag per method).
 *
 * Feature units adding a new method (e.g. a future bare-metal
 * implementation) append it to the `methods` array below.
 */
export const AttestationRegistryLive = Layer.effect(
  AttestationRegistryTag,
  Effect.gen(function* () {
    const managedIdentity = yield* managedIdentityAttestationEffect;
    const methods: ReadonlyArray<AttestationMethod> = [managedIdentity, joinTokenAttestation];
    return new Map(methods.map((method) => [method.method, method] as const));
  }),
);
