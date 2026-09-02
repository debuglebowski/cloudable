import type { TunnelFrame } from "@cloudable/contracts";
import {
  HttpApiBuilder,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Socket,
} from "@effect/platform";
import { Deferred, Duration, Effect } from "effect";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { MachineService } from "../../domain/machine/MachineService";
import { SignerTag } from "../../services/Signer";
import { AgentSessionToken } from "../../services/attestation/AgentSessionToken";
import { fetchSessionForAttach } from "../../tunnel/queries";
import { TunnelRegistry, type TunnelSocket } from "../../tunnel/registry";
import { SESSION_TOKEN_KEY_ID } from "../../tunnel/session-token";
import { Api } from "../api";
import { CurrentUserAuthentication } from "../middleware/auth";
import { TunnelUnauthorized } from "../routes/tunnel";

/** How long the browser-attach route waits for the daemon to answer an `attach` with
 * `attached`/`attach_rejected` before giving up. Generous for a click-to-terminal flow (a
 * person waiting for a prompt to appear), short enough that a genuinely unresponsive daemon
 * doesn't leave the browser hanging indefinitely. */
const ATTACH_HANDSHAKE_TIMEOUT = Duration.seconds(10);

const BEARER_PREFIX = "Bearer ";

const bearerToken = (authorization: string | undefined): string | undefined =>
  authorization?.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length) : undefined;

const isTunnelFrame = (value: unknown): value is TunnelFrame =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === "string" &&
  typeof (value as { sessionId?: unknown }).sessionId === "string";

/** `GET /api/v1/tunnel/session-token-key` — see `AccessAttachRouteLive`/`TunnelConnectRouteLive`
 * below for the two raw websocket routes (an `HttpApiEndpoint` can't model a websocket
 * upgrade at all). */
export const TunnelLive = HttpApiBuilder.group(Api, "tunnel", (handlers) =>
  handlers.handle("sessionTokenPublicKey", ({ request }) =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessionToken;
      const signer = yield* SignerTag;

      const token = bearerToken(request.headers.authorization);
      if (!token) {
        return yield* Effect.fail(new TunnelUnauthorized({ reason: "missing_bearer_token" }));
      }
      // Any attested machine identity may fetch this — the public key isn't
      // secret and doesn't vary per machine, so no further scoping beyond
      // "the bearer session is real" is meaningful here.
      yield* sessions
        .verify(token)
        .pipe(Effect.mapError((error) => new TunnelUnauthorized({ reason: error.reason })));

      const publicKeyDer = yield* signer.publicKey(SESSION_TOKEN_KEY_ID);

      return {
        keyId: SESSION_TOKEN_KEY_ID,
        publicKeyDerBase64: Buffer.from(publicKeyDer).toString("base64"),
      };
    }).pipe(
      // A `SignerError` here is our own Key Vault/local-signer infra breaking, not a
      // meaningful outcome for the caller — same treatment `http/handlers/archive.ts`
      // gives `ProvisioningError`/`ArchiveDbError`.
      Effect.catchTag("SignerError", (e) => Effect.die(e)),
    ),
  ),
);

/**
 * The tunnel daemon's persistent outbound connection — a reverse tunnel over an
 * outbound connection: one websocket per machine, bearer-authenticated the same way as
 * every other agent-protocol call, registered in `TunnelRegistry` for the lifetime of the
 * connection. Raw-mounted via `HttpApiBuilder.Router.use(...)` — an `HttpApiEndpoint` can't
 * model a websocket upgrade at all (see `agent-wake.ts`'s doc comment, the only other place
 * in this codebase that already documents why). Verified against a real bound Bun.serve
 * instance with a real WebSocket client during development — see this unit's PR notes.
 */
export const TunnelConnectRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const sessions = yield* AgentSessionToken;
    const registry = yield* TunnelRegistry;
    const machineService = yield* MachineService;

    yield* router.get(
      "/api/v1/tunnel/connect",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        // Verify BEFORE upgrading — a bad token gets a normal 401, not an upgrade
        // followed by an immediate, harder-to-diagnose close (the plan's own explicit
        // requirement).
        const token = bearerToken(request.headers.authorization);
        if (!token) {
          return HttpServerResponse.unsafeJson({ reason: "missing_bearer_token" }, { status: 401 });
        }
        const verified = yield* sessions.verify(token).pipe(Effect.either);
        if (verified._tag === "Left") {
          return HttpServerResponse.unsafeJson({ reason: verified.left.reason }, { status: 401 });
        }
        const { machineId, orgId } = verified.right;

        // Same archived-state check `attest`/`poll`/`report` all apply (`agent-protocol.ts`)
        // — a bearer session survives past a machine being archived, for up to its own TTL,
        // and without this the daemon's persistent tunnel connection would too, keeping
        // every live session on an offboarded machine reachable until that session expires.
        const machineDetail = yield* machineService.getById(machineId, orgId).pipe(
          Effect.catchTag("MachineNotFoundError", () => Effect.succeed(null)),
          Effect.catchTag("MachineServiceError", (e) => Effect.die(e)),
        );
        if (machineDetail === null || machineDetail.state.startsWith("archived")) {
          return HttpServerResponse.unsafeJson(
            { reason: machineDetail === null ? "machine_not_found" : "machine_archived" },
            { status: 401 },
          );
        }

        const socket = yield* request.upgrade;
        const write = yield* socket.writer;

        const tunnelSocket: TunnelSocket = {
          // A write failing means the socket is already dead — nothing left to relay to,
          // and the socket's own close/error path (below) is what actually cleans up the
          // registry entry, so this deliberately swallows rather than propagates.
          send: (frame) => write(JSON.stringify(frame)).pipe(Effect.catchAll(() => Effect.void)),
          close: () =>
            write(new Socket.CloseEvent(1000, "closed")).pipe(Effect.catchAll(() => Effect.void)),
        };

        yield* registry.registerDaemon(machineId, tunnelSocket);
        yield* Effect.logInfo(`tunnel daemon connected: machine ${machineId}`);

        yield* socket
          .run((bytes) =>
            Effect.gen(function* () {
              let parsed: unknown;
              try {
                parsed = JSON.parse(new TextDecoder().decode(bytes));
              } catch {
                // Malformed frame from this daemon — ignore rather than crash the whole
                // connection over one bad message.
                return;
              }
              if (!isTunnelFrame(parsed)) return;

              if (parsed.kind === "attached") {
                yield* Effect.logInfo(`tunnel: session ${parsed.sessionId} attached`);
                yield* registry.resolveHandshake(parsed.sessionId, { ok: true });
              } else if (parsed.kind === "attach_rejected") {
                yield* Effect.logInfo(
                  `tunnel: session ${parsed.sessionId} attach_rejected: ${parsed.reason}`,
                );
                yield* registry.resolveHandshake(parsed.sessionId, {
                  ok: false,
                  reason: parsed.reason,
                });
              } else if (parsed.kind === "data" || parsed.kind === "close") {
                // The actual relay traffic — forward to whichever browser socket is
                // carrying this session, if one is still attached. A missing browser
                // socket (attach never completed, or the browser already left) means
                // there's nothing to forward to; not an error.
                const browser = yield* registry.getBrowser(parsed.sessionId);
                if (browser) yield* browser.send(parsed);
              }
            }),
          )
          .pipe(
            // Whatever ends the connection — the daemon closing it, a network drop, a
            // write/read error — deregistering must still run: a dropped daemon connection
            // means every session it was carrying is already dead (registry.ts's own
            // `deregisterDaemon` doc comment).
            Effect.ensuring(
              Effect.logInfo(`tunnel daemon disconnected: machine ${machineId}`).pipe(
                Effect.zipRight(registry.deregisterDaemon(machineId)),
              ),
            ),
            Effect.catchAll(() => Effect.void),
          );

        return HttpServerResponse.empty();
      }),
    );
  }),
);

/**
 * The browser's leg — the other half of the relay `TunnelConnectRouteLive`
 * above carries. Raw-mounted the same way (an `HttpApiEndpoint`/`.middleware()` can't model
 * a websocket upgrade), so `CurrentUserAuthentication` is run manually: `yield*` the
 * middleware tag itself to get the per-request authentication Effect, then `yield*` that.
 *
 * Authorization is deliberately narrow — `sessions.orgId === currentUser.orgId &&
 * sessions.personId === currentUser.personId && endedAt IS NULL` — not "any admin can attach
 * to anyone's session". Admin access to someone else's machine is the elevation-approval
 * machinery's job (`domain/elevation/`), not a bypass added here.
 */
export const AccessAttachRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const authenticate = yield* CurrentUserAuthentication;
    const registry = yield* TunnelRegistry;
    // Captured here, at layer-construction time — the router's own per-request ambient
    // context (`HttpRouter.Provided`) doesn't include `Db`, same reasoning
    // `CurrentUserAuthenticationLive` documents for capturing it the same way.
    const db = yield* Db;

    yield* router.get(
      "/api/v1/access/sessions/:sessionId/attach",
      Effect.gen(function* () {
        const authResult = yield* authenticate.pipe(Effect.either);
        if (authResult._tag === "Left") {
          return HttpServerResponse.empty({ status: 401 });
        }
        const currentUser = authResult.right;

        const request = yield* HttpServerRequest.HttpServerRequest;
        // Raw-mounted routes aren't necessarily covered by `HttpMiddleware.cors`'s origin
        // allowlist the way `HttpApi`-declared endpoints are, and a websocket upgrade isn't
        // CORS-preflighted the way a normal `fetch` is anyway — this is the real enforcement
        // point for this route, not a backstop.
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== config.consoleOrigin) {
          return HttpServerResponse.empty({ status: 403 });
        }

        const params = yield* HttpRouter.params;
        const sessionId = params.sessionId;
        if (!sessionId) {
          return HttpServerResponse.unsafeJson({ reason: "missing_session_id" }, { status: 400 });
        }

        const sessionRow = yield* fetchSessionForAttach(sessionId).pipe(
          Effect.provideService(Db, db),
          Effect.catchTag("SessionQueryError", (e) => Effect.die(e)),
        );
        const authorized =
          sessionRow !== undefined &&
          sessionRow.orgId === currentUser.orgId &&
          sessionRow.personId === currentUser.personId &&
          sessionRow.endedAt === null;
        if (!authorized) {
          // Same response whether the session doesn't exist, belongs to someone else, or
          // already ended — nothing here should let a caller distinguish those cases.
          return HttpServerResponse.unsafeJson({ reason: "not_found" }, { status: 404 });
        }
        if (!sessionRow.sessionToken) {
          // Shouldn't happen — `mintSession` always persists one now (see TunnelServer) —
          // but a null here means there's genuinely nothing to replay to the daemon.
          return HttpServerResponse.unsafeJson({ reason: "no_session_token" }, { status: 500 });
        }

        const daemon = yield* registry.getDaemon(sessionRow.machineId);
        if (!daemon) {
          // 503 BEFORE upgrading — cleaner than upgrade-then-immediately-disconnect, same
          // reasoning as verifying the daemon's own bearer token before its upgrade.
          return HttpServerResponse.unsafeJson({ reason: "daemon_not_connected" }, { status: 503 });
        }

        const searchParams = yield* HttpServerRequest.ParsedSearchParams;
        const parseSize = (value: string | ReadonlyArray<string> | undefined, fallback: number) => {
          const raw = Array.isArray(value) ? value[0] : value;
          const parsed = raw ? Number(raw) : Number.NaN;
          return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
        };
        const cols = parseSize(searchParams.cols, 80);
        const rows = parseSize(searchParams.rows, 24);

        const socket = yield* request.upgrade;
        const write = yield* socket.writer;

        const browserSocket: TunnelSocket = {
          send: (frame) => write(JSON.stringify(frame)).pipe(Effect.catchAll(() => Effect.void)),
          close: () =>
            write(new Socket.CloseEvent(1000, "closed")).pipe(Effect.catchAll(() => Effect.void)),
        };

        yield* registry.registerRelay(sessionId, sessionRow.machineId, browserSocket);
        yield* Effect.logInfo(`tunnel: browser attaching session ${sessionId}`);

        const handshake = yield* registry.beginHandshake(sessionId);
        yield* daemon.send({
          kind: "attach",
          sessionId,
          sessionToken: sessionRow.sessionToken,
          cols,
          rows,
        });

        const outcome = yield* Deferred.await(handshake).pipe(
          Effect.timeout(ATTACH_HANDSHAKE_TIMEOUT),
          Effect.catchAll(() => Effect.succeed({ ok: false, reason: "attach_timeout" } as const)),
        );

        if (!outcome.ok) {
          yield* Effect.logInfo(`tunnel: session ${sessionId} attach failed: ${outcome.reason}`);
          yield* browserSocket.send({ kind: "close", sessionId, reason: outcome.reason });
          yield* browserSocket.close();
          yield* registry.deregisterRelay(sessionId);
          return HttpServerResponse.empty();
        }

        yield* Effect.logInfo(`tunnel: session ${sessionId} attached (relay live)`);
        // Tell the BROWSER it's attached too — found live during development: without this,
        // the browser leg has no signal the PTY is actually ready (e.g. to stop showing a
        // "connecting…" state) and just silently starts receiving `data` frames with no
        // prior confirmation.
        yield* browserSocket.send({ kind: "attached", sessionId });

        // Relay the browser's own inbound frames to the daemon — `data` (keystrokes) and
        // `resize` (terminal size changes) are the two things a real xterm.js frontend
        // actually sends during normal operation. `sessionId` is forced to this route's own
        // path param regardless of what the frame claims, since one browser socket is
        // dedicated to exactly one session by construction.
        yield* socket
          .run((bytes) =>
            Effect.gen(function* () {
              let parsed: unknown;
              try {
                parsed = JSON.parse(new TextDecoder().decode(bytes));
              } catch {
                return;
              }
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                typeof (parsed as { kind?: unknown }).kind !== "string"
              ) {
                return;
              }
              const kind = (parsed as { kind: string }).kind;
              if (kind === "data") {
                const dataBase64 = (parsed as { dataBase64?: unknown }).dataBase64;
                if (typeof dataBase64 === "string") {
                  yield* daemon.send({ kind: "data", sessionId, dataBase64 });
                }
              } else if (kind === "resize") {
                const frameCols = (parsed as { cols?: unknown }).cols;
                const frameRows = (parsed as { rows?: unknown }).rows;
                if (typeof frameCols === "number" && typeof frameRows === "number") {
                  yield* daemon.send({
                    kind: "resize",
                    sessionId,
                    cols: frameCols,
                    rows: frameRows,
                  });
                }
              }
            }),
          )
          .pipe(
            // The browser leg disconnecting (tab closed, network drop) ends the session for
            // real — nothing is left to read the daemon's output, so the daemon-side PTY
            // shouldn't keep running either. `closeRelay` tells both legs and cleans up the
            // registry; sending to an already-closed browser socket is a harmless no-op (its
            // `send`/`close` swallow write errors, same as the daemon-connect route's).
            Effect.ensuring(
              Effect.logInfo(`tunnel: browser left session ${sessionId}`).pipe(
                Effect.zipRight(registry.closeRelay(sessionId, "connection_lost")),
              ),
            ),
            Effect.catchAll(() => Effect.void),
          );

        return HttpServerResponse.empty();
      }),
    );
  }),
);
