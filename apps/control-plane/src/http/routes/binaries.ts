import path from "node:path";
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { config } from "../../config";

/**
 * `GET /_internal/binaries/:target` — serves the compiled agent +
 * tunnel-daemon binaries (`Dockerfile` copies them to `config.agentBinariesDir`)
 * so `ProvisioningService.azure.ts`'s cloud-init can `curl` them onto a
 * fresh VM at boot. A brand-new Ubuntu VM has no Bun/Node to run TS source
 * with — only a standalone binary works.
 *
 * Deliberately unauthenticated: these binaries aren't secret (same posture
 * as the public GHCR control-plane image) and the machine curling them
 * hasn't attested yet — it can't have, it doesn't have an agent running to
 * attest WITH until this succeeds.
 *
 * Not an `HttpApiEndpoint` — same reasoning as `agent-wake.ts`'s raw route:
 * this serves a binary file response, not a typed JSON schema.
 *
 * `TARGETS` is a fixed allowlist, not a path built from the URL param
 * directly — `:target` only ever selects an entry, never contributes to
 * the filesystem path, so there's no path-traversal surface regardless of
 * what a caller sends.
 */
const TARGETS: Record<string, string> = {
  "cloudable-agent-linux-x64": "cloudable-agent-linux-x64",
  "cloudable-agent-linux-arm64": "cloudable-agent-linux-arm64",
  "cloudable-tunnel-daemon-linux-x64": "cloudable-tunnel-daemon-linux-x64",
  "cloudable-tunnel-daemon-linux-arm64": "cloudable-tunnel-daemon-linux-arm64",
};

export const BinariesRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    yield* router.get(
      "/_internal/binaries/:target",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const target = params.target;
        const filename = target ? TARGETS[target] : undefined;
        if (!filename) {
          return yield* HttpServerResponse.text("unknown binary target", { status: 404 });
        }
        return yield* HttpServerResponse.file(path.join(config.agentBinariesDir, filename), {
          contentType: "application/octet-stream",
        });
      }),
    );
  }),
);
