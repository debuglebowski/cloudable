import type { SettingRow } from "@cloudable/schema";
import { Context, type Effect } from "effect";
import type { Elevation, ElevationLevel, ElevationStatus } from "./types";

export interface MachineRecord {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
}

export interface PersonRecord {
  id: string;
  orgId: string;
  /** A deactivated (offboarded) person must never be granted elevated access. */
  active: boolean;
}

export interface InsertElevationValues {
  orgId: string;
  personId: string;
  machineId: string;
  level: ElevationLevel;
  reason: string;
  approvalId: string;
  grantedAt: Date | null;
  expiresAt: Date | null;
  status: ElevationStatus;
}

export interface InsertAutoApprovedApprovalArgs {
  orgId: string;
  personId: string;
  machineId: string;
  reason: string;
  now: Date;
}

/**
 * Persistence port for the elevation domain — everything `ElevationService`
 * needs from Postgres, behind a narrow interface so this domain's own unit
 * tests run against an in-memory fake instead of a real database.
 *
 * (A `PostgreSqlContainer`-backed integration test hangs indefinitely under
 * Bun in this sandbox — an upstream bug, see `oven-sh/bun#21342` /
 * `testcontainers-node#974` — so `ElevationService.test.ts` mocks this port
 * directly instead. `ElevationRepo.live.ts`'s real, Drizzle-backed
 * implementation is exercised by this unit's E2E verification against the
 * docker-compose Postgres instead.)
 */
export interface ElevationRepo {
  findMachine(machineId: string): Effect.Effect<MachineRecord | null, Error>;
  findPerson(personId: string): Effect.Effect<PersonRecord | null, Error>;
  findElevation(elevationId: string): Effect.Effect<Elevation | null, Error>;
  /** `scopeIds` narrows to just this org/template/machine chain — not every org's rows for these keys. */
  findSettingRows(
    keys: ReadonlyArray<string>,
    scopeIds: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<SettingRow<unknown>>, Error>;
  insertAutoApprovedApproval(
    args: InsertAutoApprovedApprovalArgs,
  ): Effect.Effect<{ id: string }, Error>;
  insertElevation(values: InsertElevationValues): Effect.Effect<Elevation, Error>;
  updateElevationGranted(
    elevationId: string,
    grantedAt: Date,
    expiresAt: Date,
  ): Effect.Effect<Elevation, Error>;
  updateElevationStatus(
    elevationId: string,
    status: "denied" | "expired",
  ): Effect.Effect<Elevation, Error>;
}

export class ElevationRepoTag extends Context.Tag("ElevationRepo")<
  ElevationRepoTag,
  ElevationRepo
>() {}
