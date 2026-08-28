/**
 * `wake`: the fourth agent-protocol operation (spec §23) — an optional,
 * control-plane-to-agent fast path so a machine doesn't sit out its full
 * poll interval when there's fresh desired state. Exactly one message, no
 * payload, and it cannot carry instructions (spec §8.1): the agent still
 * has to poll to find out *what* changed.
 *
 * STUB, by design and noted in this unit's PR: `HttpApiEndpoint`/
 * `HttpApiGroup` model HTTP verbs, not a websocket upgrade, and wiring a
 * full upgrade path through this skeleton's router (`@effect/platform`'s
 * `Socket`/`platform-bun`'s `BunSocket`) was more than this slice's time
 * budget justified for an operation the spec itself calls optional. What's
 * real: the wire contract both sides already agree on
 * (`@cloudable/contracts`' `WakeMessage`), and the agent's `wake.ts`, which
 * is written against it and simply has nothing to connect to yet.
 *
 * To make this real: accept the upgrade on `GET /api/v1/agent/wake`
 * (bearer-authenticated the same way as `/poll`/`/report`), hold one
 * socket per attested machine, and on a signal that machine's desired
 * state changed, send exactly `{"type":"pull_now"}` and nothing else.
 */
export type { WakeMessage } from "@cloudable/contracts";
