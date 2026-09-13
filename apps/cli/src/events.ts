// ---------------------------------------------------------------------------
// `cloudable events` — the append-only log, newest first.
//
// This is the same projection the console's Audit page reads. Events are never
// updated or deleted (invariant 2), so anything printed here is the record as
// it will stay: retention expires it, nothing edits it.
// ---------------------------------------------------------------------------
import { parseArgs, positiveInt, readSpec } from "./args";
import { authenticatedApiRequest, query } from "./http-client";
import { dash, printEmpty, printJson, printTable, shortTime } from "./output";

interface EvidenceRecord {
  id: string;
  type: string;
  occurredAt: string;
  recordedAt: string;
  orgId: string;
  actor: { type: "person" | "system" | "agent" | "idp"; id: string };
  machineId: string | null;
  correlationId: string;
  summary: string;
  commandRecording: { correlationId: string; count: number } | null;
}

export async function runEventsCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ values: ["limit", "cursor"] }));
  const limit = args.flags.limit ? positiveInt(args.flags.limit, "limit") : 50;

  const page = await authenticatedApiRequest<{
    data: EvidenceRecord[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }>(`/api/v1/evidence${query({ limit, cursor: args.flags.cursor })}`);

  if (args.booleans.has("json")) {
    printJson(page);
    return;
  }
  if (page.data.length === 0) {
    printEmpty("events");
    return;
  }
  printTable(
    ["occurred", "type", "actor", "machine", "summary"],
    page.data.map((event) => [
      shortTime(event.occurredAt),
      event.type,
      `${event.actor.type}:${event.actor.id}`,
      dash(event.machineId),
      event.summary,
    ]),
  );
  if (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
    console.log(`\nMore. Continue with --cursor ${page.pageInfo.nextCursor}`);
  }
}
