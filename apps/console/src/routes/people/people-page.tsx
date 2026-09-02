import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Mail, Plus, Shield, Tag, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { Person } from "@/api/people";
import {
  isManuallyManaged,
  listPeople,
  peopleKeys,
  setPersonActive,
  updatePerson,
} from "@/api/people";
import { PersonAvatar } from "@/components/person-avatar";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { AddPersonDialog } from "./add-person-dialog";
import { DeactivatePersonDialog } from "./deactivate-person-dialog";
import { EditableCell } from "./editable-cell";
import { OffboardPersonDialog } from "./offboard-person-dialog";

function formatAddedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * People — the system of record for who can own machines. Fully editable while no
 * IdP is connected; `source: "scim"` rows render as read-only. Real backend — see
 * `src/api/people.ts`. "Offboard" (any active person) is distinct from "Deactivate"
 * (manual people only) — see `offboard-person-dialog.tsx`'s own doc comment.
 */
export function PeoplePage() {
  const queryClient = useQueryClient();
  const {
    data: people,
    isLoading,
    isError,
  } = useQuery({
    queryKey: peopleKeys.list(),
    queryFn: listPeople,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<Person | null>(null);
  const [offboardTarget, setOffboardTarget] = useState<Person | null>(null);

  const invalidatePeople = () =>
    void queryClient.invalidateQueries({ queryKey: peopleKeys.list() });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; patch: { email?: string; role?: string } }) =>
      updatePerson(vars.id, vars.patch),
    onSuccess: invalidatePeople,
  });

  const activeMutation = useMutation({
    mutationFn: (vars: { id: string; active: boolean }) => setPersonActive(vars.id, vars.active),
    onSuccess: (_result, vars) => {
      invalidatePeople();
      toast.success(vars.active ? "Person reactivated" : "Person deactivated");
    },
    // No onError toast — `mutationError` below already renders it inline, same as
    // `updateMutation`.
  });

  const mutationError = updateMutation.error ?? activeMutation.error;

  return (
    // h-full min-h-0 + flex-1 on the table wrapper below: fills whatever
    // height `main` actually has left under the header instead of capping at
    // a flat vh fraction — see machines-page.tsx's identical comment.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">People</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            System of record for who can own machines. With no IdP connected this list is fully
            editable; once SCIM is connected, synced people become read-only here.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus />
          Add person
        </Button>
      </div>

      {mutationError && (
        <p className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {mutationError.message}
        </p>
      )}

      {/* Shadow, not a bare bg-card box — see Card's own comment for the exact
          value and why there's no border alongside it. flex-1 min-h-0 + the
          Table override fill remaining height instead of a flat vh cap. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
        <Table containerClassName="h-full max-h-none">
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="flex items-center gap-1.5">
                  <TableHeaderIcon icon={Mail} />
                  Email
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1.5">
                  <TableHeaderIcon icon={Shield} />
                  Role
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1.5">
                  <TableHeaderIcon icon={Tag} />
                  Status
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1.5">
                  <TableHeaderIcon icon={Workflow} />
                  Source
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1.5">
                  <TableHeaderIcon icon={Clock} />
                  Added
                </span>
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 5 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-6 rounded-full" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-16 rounded-md" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-24 rounded-md" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Skeleton className="ml-auto h-7 w-20" />
                  </TableCell>
                </TableRow>
              ))}
            {isError && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-destructive">
                  Couldn&apos;t load people. Try refreshing the page.
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !isError && people?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No people yet.
                </TableCell>
              </TableRow>
            )}
            {people?.map((person) => {
              const isManual = isManuallyManaged(person);
              return (
                <TableRow key={person.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <PersonAvatar name={person.email} />
                      {isManual ? (
                        <EditableCell
                          value={person.email}
                          onSave={(next) =>
                            updateMutation.mutate({ id: person.id, patch: { email: next } })
                          }
                        />
                      ) : (
                        <span>{person.email}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {isManual ? (
                      <EditableCell
                        value={person.role}
                        onSave={(next) =>
                          updateMutation.mutate({ id: person.id, patch: { role: next } })
                        }
                      />
                    ) : (
                      <span className="capitalize">{person.role}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={person.active ? "ok" : "secondary"} dot={!person.active}>
                      {person.active ? "Active" : "Deactivated"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {isManual ? (
                      <Badge variant="outline">Manual</Badge>
                    ) : (
                      <Badge variant="secondary" title="Synced from SCIM — read-only here">
                        Synced from SCIM
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatAddedAt(person.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {person.active && (
                        // outline, not destructive — this only opens the confirmation dialog,
                        // which already carries its own `variant="destructive"` confirm button
                        // (offboard-person-dialog.tsx) once the person has actually committed.
                        // Matches Access's identical "row button opens a destructive dialog"
                        // pattern (Revoke/Terminate are both `outline` triggers too) — a
                        // permanent solid-red button on every active row was pre-alarming
                        // before the real decision point, and the one place in the app that
                        // styled this differently from everywhere else.
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setOffboardTarget(person)}
                        >
                          Offboard
                        </Button>
                      )}
                      {isManual ? (
                        person.active ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDeactivateTarget(person)}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => activeMutation.mutate({ id: person.id, active: true })}
                          >
                            Reactivate
                          </Button>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">Managed by IdP</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <AddPersonDialog open={addOpen} onOpenChange={setAddOpen} />

      <DeactivatePersonDialog
        person={deactivateTarget}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
        onConfirm={(person) => {
          activeMutation.mutate({ id: person.id, active: false });
          setDeactivateTarget(null);
        }}
      />

      <OffboardPersonDialog
        person={offboardTarget}
        onOpenChange={(open) => {
          if (!open) setOffboardTarget(null);
        }}
      />
    </div>
  );
}
