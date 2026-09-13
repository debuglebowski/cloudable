// ---------------------------------------------------------------------------
// Names to ids.
//
// Every endpoint takes a UUID, but nobody remembers one. A command that takes
// `<machine>` accepts either, resolving a name through the list the caller can
// already see. An ambiguous name is refused rather than guessed at.
// ---------------------------------------------------------------------------
import type { ListMachinesResponse, MachineSummary } from "@cloudable/contracts";
import { CliError, EXIT } from "./errors";
import { authenticatedApiRequest, query } from "./http-client";
import { listPeople } from "./identity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(value: string): boolean {
  return UUID.test(value);
}

/** One page big enough that a person's org fits in it; `hasMore` is reported if not. */
const LOOKUP_LIMIT = 200;

export async function listMachines(limit?: number, cursor?: string): Promise<ListMachinesResponse> {
  return authenticatedApiRequest<ListMachinesResponse>(
    `/api/v1/machines${query({ limit, cursor })}`,
  );
}

export async function resolveMachine(nameOrId: string): Promise<MachineSummary | undefined> {
  if (looksLikeId(nameOrId)) return undefined;
  const page = await listMachines(LOOKUP_LIMIT);
  const exact = page.items.filter((m) => m.name === nameOrId);
  const matches =
    exact.length > 0
      ? exact
      : page.items.filter((m) => m.name.toLowerCase() === nameOrId.toLowerCase());

  if (matches.length > 1) {
    throw new CliError(
      `'${nameOrId}' matches ${matches.length} machines. Use the id:\n${matches.map((m) => `  ${m.id}  ${m.name}`).join("\n")}`,
      EXIT.conflict,
    );
  }
  const match = matches[0];
  if (!match) {
    throw new CliError(
      `no machine named '${nameOrId}'${page.pageInfo.hasMore ? ` in the first ${LOOKUP_LIMIT}` : ""}.\n\nRun \`cloudable machines list\` to see them.`,
      EXIT.notFound,
    );
  }
  return match;
}

/** The id to put in a request path, whether a name or an id was typed. */
export async function machineId(nameOrId: string): Promise<string> {
  const machine = await resolveMachine(nameOrId);
  return machine?.id ?? nameOrId;
}

export async function personId(emailOrId: string): Promise<string> {
  if (looksLikeId(emailOrId)) return emailOrId;
  const people = await listPeople();
  const match = people.find((p) => p.email.toLowerCase() === emailOrId.toLowerCase());
  if (!match) {
    throw new CliError(
      `no person with email '${emailOrId}'.\n\nRun \`cloudable people list\` to see them.`,
      EXIT.notFound,
    );
  }
  return match.id;
}
