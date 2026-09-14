// ---------------------------------------------------------------------------
// `cloudable notifications *` — what a machine owner is told when someone else
// is granted access to their machine.
//
// One row per elevation grant. Marking read is all-or-nothing because that is
// what the endpoint does — there is no per-notification write.
// ---------------------------------------------------------------------------
import { parseArgs, readSpec } from "./args";
import { authenticatedApiRequest, postJson } from "./http-client";
import { printEmpty, printJson, printTable, shortTime } from "./output";

interface Notification {
  id: string;
  elevationId: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export async function runNotificationsListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ booleans: ["unread"] }));
  const res = await authenticatedApiRequest<{ items: Notification[] }>("/api/v1/notifications");

  const items = args.booleans.has("unread")
    ? res.items.filter((item) => item.readAt === null)
    : res.items;
  if (args.booleans.has("json")) {
    printJson({ items });
    return;
  }
  if (items.length === 0) {
    printEmpty(args.booleans.has("unread") ? "unread notifications" : "notifications");
    return;
  }
  printTable(
    ["created", "read", "elevation", "message"],
    items.map((item) => [
      shortTime(item.createdAt),
      item.readAt === null ? "no" : "yes",
      item.elevationId,
      item.message,
    ]),
  );
}

export async function runNotificationsReadCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const res = await authenticatedApiRequest<{ updated: number }>(
    "/api/v1/notifications/read",
    postJson({}),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  console.log(res.updated === 0 ? "Nothing unread." : `Marked ${res.updated} read.`);
}
