import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Person } from "@/api/people";
import {
  isManuallyManaged,
  listPeople,
  peopleKeys,
  setPersonActive,
  updatePerson,
} from "@/api/people";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function formatAddedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * People — the system of record for who can own machines (spec §3/§20). Fully editable while no
 * IdP is connected; `source: "scim"` rows will render as read-only once one is. See
 * `src/api/people.ts` for the (currently mocked) data layer.
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

  const invalidatePeople = () =>
    void queryClient.invalidateQueries({ queryKey: peopleKeys.list() });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; patch: { email?: string; role?: string } }) =>
      updatePerson(vars.id, vars.patch),
    onSuccess: invalidatePeople,
  });

  const activeMutation = useMutation({
    mutationFn: (vars: { id: string; active: boolean }) => setPersonActive(vars.id, vars.active),
    onSuccess: invalidatePeople,
  });

  const mutationError = updateMutation.error ?? activeMutation.error;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">People</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            System of record for who can own machines. With no IdP connected this list is fully
            editable; once SCIM is connected, synced people become read-only here.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>Add person</Button>
      </div>

      {mutationError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {mutationError.message}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
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
                    <Badge variant={person.active ? "ok" : "secondary"}>
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
    </div>
  );
}
