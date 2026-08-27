// Runs against the local dev Postgres (docker-compose, port 5442 — see repo root
// `docker-compose.yml` / `DATABASE_URL`), the same instance `bun run dev` uses. Testcontainers
// (`apps/control-plane/test/testcontainers.ts`) timed out in this sandbox, so this suite uses
// `DbLive` directly instead, scoping every row it writes to a random `orgId` per test so runs
// never collide with each other or with manual dev-DB use.
import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { events, certificates, orgs } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db, DbLive } from "../../db/layer";
import { EventBus } from "../EventBus";
import { LocalSignerLive } from "../Signer.local";
import { SshCaService } from "./SshCaService";

// `provideMerge` (see the identical comment in `../../tunnel/server.test.ts` / `../../layers.ts`)
// keeps `Db`/`EventBus`/`Signer` visible in the final context, not just during construction.
const TestLayer = SshCaService.Default.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventBus.Default.pipe(Layer.provide(DbLive)), LocalSignerLive, DbLive),
  ),
);

const rawSubjectKey = (): Uint8Array =>
  new Uint8Array(
    crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }),
  ).slice(12);

async function withOrg<T>(run: (orgId: string) => Promise<T>): Promise<T> {
  const program = Effect.gen(function* () {
    const db = yield* Db;
    const [org] = yield* Effect.tryPromise(() =>
      db
        .insert(orgs)
        .values({ name: `test-${crypto.randomUUID()}` })
        .returning({ id: orgs.id }),
    );
    if (!org) throw new Error("failed to insert test org");
    return org.id;
  });
  const orgId = await Effect.runPromise(Effect.provide(program, DbLive));
  return run(orgId);
}

describe("SshCaService (against local dev Postgres)", () => {
  test("issueCertificate persists a row, emits an event, and returns a well-formed certificate", async () => {
    await withOrg(async (orgId) => {
      const personId = crypto.randomUUID();
      const program = Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        return yield* sshCa.issueCertificate({
          orgId,
          personId,
          osUser: "ubuntu",
          machineScope: "all",
          subjectPublicKeyRaw: rawSubjectKey(),
        });
      });

      const issued = await Effect.runPromise(Effect.provide(program, TestLayer));

      expect(issued.certificate.startsWith("ssh-ed25519-cert-v01@openssh.com ")).toBe(true);
      expect(issued.fingerprint.startsWith("SHA256:")).toBe(true);
      const ttlMs = issued.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(7 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThan(9 * 60 * 60 * 1000);

      const readBack = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const db = yield* Db;
            const rows = yield* Effect.tryPromise(() =>
              db.select().from(certificates).where(eq(certificates.id, issued.certificateId)),
            );
            const eventRows = yield* Effect.tryPromise(() =>
              db.select().from(events).where(eq(events.correlationId, issued.certificateId)),
            );
            return { rows, eventRows };
          }),
          DbLive,
        ),
      );

      expect(readBack.rows).toHaveLength(1);
      expect(readBack.rows[0]?.personId).toBe(personId);
      expect(readBack.rows[0]?.orgId).toBe(orgId);
      expect(readBack.rows[0]?.fingerprint).toBe(issued.fingerprint);
      expect(readBack.rows[0]?.revokedAt).toBeNull();

      expect(readBack.eventRows).toHaveLength(1);
      expect(readBack.eventRows[0]?.type).toBe("access.certificate_issued");
      expect(readBack.eventRows[0]?.orgId).toBe(orgId);
      const payload = readBack.eventRows[0]?.payload as { principal: string; machineScope: string };
      expect(payload.principal).toBe("ubuntu");
      expect(payload.machineScope).toBe("all");
    });
  });

  test("rejects a public key that is not exactly 32 bytes", async () => {
    await withOrg(async (orgId) => {
      const program = Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        return yield* sshCa.issueCertificate({
          orgId,
          personId: crypto.randomUUID(),
          osUser: "ubuntu",
          machineScope: "all",
          subjectPublicKeyRaw: new Uint8Array(10),
        });
      });
      const error = await Effect.runPromise(Effect.provide(Effect.flip(program), TestLayer));
      expect(error.reason).toBe("invalid_public_key");
    });
  });

  test("revokeCertificate marks the row revoked, emits an event, and refuses a second revoke", async () => {
    await withOrg(async (orgId) => {
      const personId = crypto.randomUUID();
      const issueProgram = Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        return yield* sshCa.issueCertificate({
          orgId,
          personId,
          osUser: "ubuntu",
          machineScope: ["machine-1"],
          subjectPublicKeyRaw: rawSubjectKey(),
        });
      });
      const issued = await Effect.runPromise(Effect.provide(issueProgram, TestLayer));

      const revokeProgram = Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        yield* sshCa.revokeCertificate({
          orgId,
          certificateId: issued.certificateId,
          reason: "offboarded",
        });
      });
      await Effect.runPromise(Effect.provide(revokeProgram, TestLayer));

      const row = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const db = yield* Db;
            const rows = yield* Effect.tryPromise(() =>
              db.select().from(certificates).where(eq(certificates.id, issued.certificateId)),
            );
            return rows[0];
          }),
          DbLive,
        ),
      );
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.revokedReason).toBe("offboarded");

      const secondRevoke = await Effect.runPromise(
        Effect.provide(Effect.flip(revokeProgram), TestLayer),
      );
      expect(secondRevoke.reason).toBe("not_found");
    });
  });

  test("REQUIRED FAILURE PATH: revokeCertificate refuses to revoke another org's certificate", async () => {
    await withOrg(async (ownerOrgId) => {
      await withOrg(async (attackerOrgId) => {
        const issueProgram = Effect.gen(function* () {
          const sshCa = yield* SshCaService;
          return yield* sshCa.issueCertificate({
            orgId: ownerOrgId,
            personId: crypto.randomUUID(),
            osUser: "ubuntu",
            machineScope: "all",
            subjectPublicKeyRaw: rawSubjectKey(),
          });
        });
        const issued = await Effect.runPromise(Effect.provide(issueProgram, TestLayer));

        const crossOrgRevoke = Effect.gen(function* () {
          const sshCa = yield* SshCaService;
          yield* sshCa.revokeCertificate({
            orgId: attackerOrgId,
            certificateId: issued.certificateId,
            reason: "attempted cross-org revoke",
          });
        });
        const error = await Effect.runPromise(
          Effect.provide(Effect.flip(crossOrgRevoke), TestLayer),
        );
        expect(error.reason).toBe("not_found");

        const row = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const db = yield* Db;
              const rows = yield* Effect.tryPromise(() =>
                db.select().from(certificates).where(eq(certificates.id, issued.certificateId)),
              );
              return rows[0];
            }),
            DbLive,
          ),
        );
        expect(row?.revokedAt).toBeNull();
      });
    });
  });

  test("listCertificates only returns certificates for the given org", async () => {
    await withOrg(async (orgA) => {
      await withOrg(async (orgB) => {
        const issue = (orgId: string) =>
          Effect.gen(function* () {
            const sshCa = yield* SshCaService;
            return yield* sshCa.issueCertificate({
              orgId,
              personId: crypto.randomUUID(),
              osUser: "ubuntu",
              machineScope: "all",
              subjectPublicKeyRaw: rawSubjectKey(),
            });
          });

        await Effect.runPromise(Effect.provide(issue(orgA), TestLayer));
        await Effect.runPromise(Effect.provide(issue(orgB), TestLayer));

        const listA = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const sshCa = yield* SshCaService;
              return yield* sshCa.listCertificates(orgA);
            }),
            TestLayer,
          ),
        );
        expect(listA).toHaveLength(1);
      });
    });
  });
});
