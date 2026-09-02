import type { AuditTimelineEntry } from "@/api/audit";
import type { DirectoryPerson } from "@/api/people-directory";
import { PersonAvatar } from "@/components/person-avatar";

/** Actor column: "person" resolves `actorId` (a raw personId, illegible on its own) to an
 * email via the same read-only directory lookup every other person-identifying column in
 * the app already uses (People/Access/Machines/Approvals) — "who did this" is the central
 * compliance question this column exists to answer, and a bare UUID doesn't answer it.
 * `agent`/`idp` keep their raw id/type as-is: neither is
 * a person, so resolving one through the people directory (or giving it a PersonAvatar)
 * would misattribute the action to someone who didn't do it. */
export function ActorCell({
  entry,
  people,
}: {
  entry: AuditTimelineEntry;
  people: DirectoryPerson[] | undefined;
}) {
  if (entry.actorType === "system") {
    return <span className="text-muted-foreground">system</span>;
  }
  if (entry.actorType === "person") {
    const email = people?.find((person) => person.id === entry.actorId)?.email ?? entry.actorId;
    return (
      <span className="flex items-center gap-1.5">
        <PersonAvatar name={email ?? "?"} className="size-5" />
        {email ?? "unknown"}
      </span>
    );
  }
  return <>{entry.actorId ?? entry.actorType}</>;
}
