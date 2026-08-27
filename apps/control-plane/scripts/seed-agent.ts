#!/usr/bin/env bun
import * as schema from "@cloudable/schema";
import { drizzle } from "drizzle-orm/postgres-js";
/**
 * Dev-only helper: seeds one org + one machine row and mints a join token
 * for it, so a real agent has something to attest against locally (see
 * docs/agents.md's E2E walkthrough). No unit in this build creates
 * `machines` rows yet — provisioning is out of this unit's scope — so this
 * script stands in for that step for local testing only. Not wired into
 * any production path.
 *
 * Usage: bun run apps/control-plane/scripts/seed-agent.ts
 */
import { Effect } from "effect";
import postgres from "postgres";
import { config } from "../src/config";
import { AttestationMethodTag } from "../src/services/attestation/AttestationMethod";
import { JoinTokenAttestationLive } from "../src/services/attestation/JoinTokenAttestation";

const sql = postgres(config.databaseUrl);
const db = drizzle(sql, { schema });

const [org] = await db.insert(schema.orgs).values({ name: "dev-seed-org" }).returning();
if (!org) throw new Error("failed to insert seed org");

const [machine] = await db
  .insert(schema.machines)
  .values({
    orgId: org.id,
    name: "dev-seed-machine",
    region: "local",
    sizeSku: "dev",
    image: "dev",
  })
  .returning();
if (!machine) throw new Error("failed to insert seed machine");

const token = await Effect.runPromise(
  Effect.gen(function* () {
    const attestation = yield* AttestationMethodTag;
    return yield* attestation.issueCredential({ orgId: org.id, machineId: machine.id });
  }).pipe(Effect.provide(JoinTokenAttestationLive)),
);

console.log(`orgId=${org.id}`);
console.log(`machineId=${machine.id}`);
console.log(`MACHINE_TOKEN=${token}`);

await sql.end();
