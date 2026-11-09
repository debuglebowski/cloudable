import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { idpRoleMode, machines, orgs, people, sessions } from "@cloudable/schema";
import { HttpApiBuilder } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { CONFIGURED_IDP_PROVIDER_ID, config } from "../config";
import { ApiLive } from "../http/api-live";
import { AccessAttachRouteLive, TunnelConnectRouteLive } from "../http/handlers/tunnel";
import { buildAppLive } from "../layers";
import { issueCliToken } from "../services/CliToken";
import { FakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "../services/SecretsProvider.fake";
import { LocalSignerLive } from "../services/Signer.local";
import { AgentSessionToken } from "../services/attestation/AgentSessionToken";
import { type IsolatedDb, createIsolatedDb } from "../test-support/isolated-db";
import { isDbReachable } from "../testing/db-reachable";
import { TunnelRegistry } from "../tunnel/registry";
import { MODE_ROW_ID, resetActivationForTest } from "./activation";
import { type IdpRolesConfig, readIdpRolesConfig } from "./config";

/**
 * The live-session deadline on the real attach route: a real HTTP server on a local port, the
 * real tunnel routes and registry, a fake tunnel daemon and a browser leg over real websockets,
 * and a real person whose role evidence runs out a few seconds after attach. Proves the session
 * closes at the deadline (not at the next sweep), and that nothing the machine sends after the
 * deadline reaches the browser.
 */
const BASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const reachable = await isDbReachable(BASE_URL);

const MANAGED = readIdpRolesConfig(
  {
    IDP_ROLES_ENABLED: "true",
    IDP_ROLE_CLAIM: "roles",
    IDP_ROLE_MAPPING: '{"Cloudable.Admin":["admin"]}',
  },
  {
    providerId: CONFIGURED_IDP_PROVIDER_ID,
    entityId: "https://idp.example/",
    ssoUrl: "https://idp.example/sso",
    emailDomains: "example.com",
    certs: ["cert"],
  },
) as IdpRolesConfig;

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });

describe.skipIf(!reachable)(
  "live tunnel deadline on the real attach route (isolated Postgres)",
  () => {
    let iso: IsolatedDb;
    let port: number;
    let serverFiber: Fiber.RuntimeFiber<unknown, unknown>;
    const originalUrl = config.databaseUrl;
    const originalMode = config.idpRoles;

    beforeAll(async () => {
      iso = await createIsolatedDb(BASE_URL);
      (config as { databaseUrl: string }).databaseUrl = iso.url;
      (config as { idpRoles: IdpRolesConfig | null }).idpRoles = MANAGED;
      resetActivationForTest();
      await iso.db.insert(idpRoleMode).values({
        id: MODE_ROW_ID,
        enabled: true,
        configFingerprint: MANAGED.fingerprint,
        activatedAt: new Date(Date.now() - 7200_000),
      });
      port = await freePort();
      // The same composition `server.ts` serves, minus background daemons.
      const tunnelRoutes = Layer.mergeAll(TunnelConnectRouteLive, AccessAttachRouteLive).pipe(
        Layer.provide(TunnelRegistry.Default),
      );
      const server = HttpApiBuilder.serve().pipe(
        Layer.provide(ApiLive),
        Layer.provide(tunnelRoutes),
        Layer.provide(
          buildAppLive({
            provisioning: FakeProvisioningServiceLive,
            signer: LocalSignerLive,
            secrets: FakeSecretsProviderLive,
          }),
        ),
        Layer.provide(BunHttpServer.layer({ port, hostname: "127.0.0.1" })),
      );
      serverFiber = Effect.runFork(Layer.launch(server));
      // Wait until it answers.
      for (let i = 0; i < 100; i++) {
        const ok = await fetch(`http://127.0.0.1:${port}/api/v1/health`).then(
          () => true,
          () => false,
        );
        if (ok) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    afterAll(async () => {
      if (serverFiber) await Effect.runPromise(Fiber.interrupt(serverFiber));
      (config as { databaseUrl: string }).databaseUrl = originalUrl;
      (config as { idpRoles: IdpRolesConfig | null }).idpRoles = originalMode;
      resetActivationForTest();
      await iso?.drop();
    });

    test("a live terminal closes at its person's role-evidence deadline, and carries nothing after it", async () => {
      const [org] = await iso.db.insert(orgs).values({ name: "live" }).returning();
      if (!org) throw new Error("org");
      // Evidence verified so that it lapses ~3s from now, on a whole second (the contract's rule).
      const deadlineMs = (Math.floor(Date.now() / 1000) + 3) * 1000;
      const verifiedAt = new Date(deadlineMs - MANAGED.intervalSec * 1000);
      const [person] = await iso.db
        .insert(people)
        .values({
          orgId: org.id,
          email: `${crypto.randomUUID()}@example.com`,
          role: "admin",
          idpRolesVerifiedAt: verifiedAt,
        })
        .returning();
      if (!person) throw new Error("person");
      const [machine] = await iso.db
        .insert(machines)
        .values({
          orgId: org.id,
          ownerPersonId: person.id,
          name: "live",
          provider: "fake",
          region: null,
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          state: "running",
        })
        .returning();
      if (!machine) throw new Error("machine");
      const token = issueCliToken({ personId: person.id });

      // The fake tunnel daemon: answers attach, then streams output every 100ms.
      const agent = await Effect.runPromise(
        Effect.map(AgentSessionToken, (s) => s).pipe(Effect.provide(AgentSessionToken.Default)),
      );
      const daemonToken = agent.mint({ orgId: org.id, machineId: machine.id }).token;
      const daemon = new WebSocket(`ws://127.0.0.1:${port}/api/v1/tunnel/connect`, {
        headers: { authorization: `Bearer ${daemonToken}` },
      } as unknown as string[]);
      await opened(daemon);
      const toDaemon: Array<{ kind: string; reason?: string; at: number }> = [];
      let streaming: ReturnType<typeof setInterval> | undefined;
      daemon.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        toDaemon.push({ ...frame, at: Date.now() });
        if (frame.kind === "attach") {
          daemon.send(JSON.stringify({ kind: "attached", sessionId: frame.sessionId }));
          streaming = setInterval(() => {
            daemon.send(
              JSON.stringify({
                kind: "data",
                sessionId: frame.sessionId,
                dataBase64: Buffer.from(String(Date.now())).toString("base64"),
              }),
            );
          }, 100);
        }
      });
      await new Promise((r) => setTimeout(r, 100));

      const minted = await fetch(`http://127.0.0.1:${port}/api/v1/access/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ targetMachineId: machine.id, method: "terminal" }),
      });
      expect(minted.status).toBe(200);
      const { sessionId } = (await minted.json()) as { sessionId: string };

      const browser = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/access/sessions/${sessionId}/attach?cols=80&rows=24`,
        { headers: { authorization: `Bearer ${token}` } } as unknown as string[],
      );
      const toBrowser: Array<{ kind: string; reason?: string; dataBase64?: string; at: number }> =
        [];
      const closed = new Promise<number>((resolve) => {
        browser.addEventListener("close", () => resolve(Date.now()), { once: true });
      });
      browser.addEventListener("message", (event) => {
        toBrowser.push({ ...JSON.parse(String(event.data)), at: Date.now() });
      });
      await opened(browser);

      const closedAt = await Promise.race([
        closed,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("never closed")), 15_000),
        ),
      ]);
      if (streaming) clearInterval(streaming);
      // The daemon's `close` frame is sent just after the browser's; give it a moment to land.
      await new Promise((r) => setTimeout(r, 300));
      daemon.close();

      // Attached and carried output before the deadline.
      expect(toBrowser.some((f) => f.kind === "attached")).toBe(true);
      expect(toBrowser.some((f) => f.kind === "data" && f.at < deadlineMs)).toBe(true);
      // Closed at the deadline: not before, and well inside the 60s sweep.
      expect(closedAt).toBeGreaterThanOrEqual(deadlineMs);
      expect(closedAt - deadlineMs).toBeLessThan(1_000);
      // Nothing from the machine reached the browser at or after the deadline.
      const lateData = toBrowser.filter((f) => f.kind === "data" && f.at >= deadlineMs);
      expect(lateData).toEqual([]);
      // Every data frame the browser got was generated before the deadline.
      for (const f of toBrowser.filter((x) => x.kind === "data")) {
        expect(Number(Buffer.from(f.dataBase64 ?? "", "base64").toString())).toBeLessThan(
          deadlineMs,
        );
      }
      // The browser was told why; the daemon was told to close the session.
      expect(toBrowser.find((f) => f.kind === "close")?.reason).toBe(
        "idp_reauthentication_required",
      );
      expect(
        toDaemon.some((f) => f.kind === "close" && f.reason === "idp_reauthentication_required"),
      ).toBe(true);
      // And the record says so.
      const [row] = await iso.db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row?.endedAt).not.toBeNull();
      expect(row?.endedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(deadlineMs);

      // A new attach after the deadline is refused before upgrading.
      const again = await fetch(
        `http://127.0.0.1:${port}/api/v1/access/sessions/${sessionId}/attach`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(again.status).toBe(401);
    }, 30_000);
  },
);
