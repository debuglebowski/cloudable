import type { AptRepository } from "@cloudable/contracts";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  aptRepositoryErrorMessage,
  useAddAptRepository,
  useAptRepositories,
  useRemoveAptRepository,
} from "@/api/apt-repositories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const waitingToast = (status: string) =>
  status === "approved"
    ? toast.success("Done", { description: "Machines pick it up on their next check-in." })
    : toast.success("Approval requested", {
        description: "Nothing changes until an approver signs it off on the Approvals page.",
      });

/**
 * Apt repositories outside Ubuntu's own that machines may install from. Adding or removing
 * one needs an approval. A repository installs nothing by itself: its packages are added to
 * the package list below like any other. Any other apt source on a machine counts as drift.
 */
export function AptRepositoriesCard() {
  const query = useAptRepositories();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AptRepository | null>(null);
  const active = (query.data ?? []).filter((r) => r.removedAt === null);
  const removed = (query.data ?? []).filter((r) => r.removedAt !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Apt repositories</CardTitle>
        <CardDescription>
          Package sources beyond Ubuntu's own, for example NodeSource for a newer Node. Adding or
          removing one needs an approval. A repository installs nothing by itself. Any other apt
          source found on a machine counts as drift.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add repository
          </Button>
        </div>
        <div className="min-h-0 overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
          <Table containerClassName="h-full max-h-[60vh]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Signing key</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isPending && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-4 w-48" />
                  </TableCell>
                </TableRow>
              )}
              {query.isSuccess && active.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                    None. Machines install from Ubuntu's own archives only.
                  </TableCell>
                </TableRow>
              )}
              {[...active, ...removed].map((repo) => (
                <TableRow key={repo.id} className={repo.removedAt ? "opacity-60" : undefined}>
                  <TableCell className="font-medium">
                    {repo.name}
                    {repo.removedAt && (
                      <Badge variant="outline" className="ml-2">
                        removed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {repo.url} {repo.suite} {repo.components.join(" ")}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {repo.fingerprint}
                  </TableCell>
                  <TableCell className="text-right">
                    {!repo.removedAt && (
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(repo)}>
                        Remove…
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <AddRepositoryDialog open={adding} onOpenChange={setAdding} />
      <RemoveRepositoryDialog repo={removing} onClose={() => setRemoving(null)} />
    </Card>
  );
}

function AddRepositoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useAddAptRepository();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [suite, setSuite] = useState("");
  const [components, setComponents] = useState("main");
  const [signingKey, setSigningKey] = useState("");
  const [reason, setReason] = useState("");
  const ready =
    [name, url, suite, components, signingKey, reason].every((v) => v.trim() !== "") &&
    !add.isPending;

  function close() {
    add.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Add an apt repository</DialogTitle>
          <DialogDescription>
            Use the values the vendor publishes. Cloudable shows the signing key's fingerprint so
            the approver can check it against the vendor's.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            add.mutate(
              {
                name: name.trim(),
                url: url.trim(),
                suite: suite.trim(),
                components: components.split(/\s+/).filter(Boolean),
                signingKey,
                reason: reason.trim(),
              },
              {
                onSuccess: (result) => {
                  waitingToast(result.status);
                  close();
                },
              },
            );
          }}
        >
          <Field
            id="apt-name"
            label="Name"
            value={name}
            onChange={setName}
            placeholder="NodeSource"
          />
          <Field
            id="apt-url"
            label="URL"
            value={url}
            onChange={setUrl}
            placeholder="https://deb.nodesource.com/node_24.x"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              id="apt-suite"
              label="Suite"
              value={suite}
              onChange={setSuite}
              placeholder="nodistro"
            />
            <Field
              id="apt-components"
              label="Components"
              value={components}
              onChange={setComponents}
              placeholder="main"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="apt-key">Signing key (ASCII-armored public key)</Label>
            <Textarea
              id="apt-key"
              className="h-32 font-mono text-xs"
              value={signingKey}
              onChange={(event) => setSigningKey(event.target.value)}
              placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
            />
          </div>
          <Field
            id="apt-reason"
            label="Why, for the approver"
            value={reason}
            onChange={setReason}
            placeholder="Node 24 for Claude Code"
          />
          {add.isError && (
            <p className="text-sm text-destructive">{aptRepositoryErrorMessage(add.error)}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {add.isPending ? "Asking…" : "Ask for approval"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveRepositoryDialog({
  repo,
  onClose,
}: {
  repo: AptRepository | null;
  onClose: () => void;
}) {
  const remove = useRemoveAptRepository();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={repo !== null}
      onOpenChange={(open) => {
        if (!open) {
          remove.reset();
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove "{repo?.name}"?</DialogTitle>
          <DialogDescription>
            Machines stop installing from it once an approver signs off. Packages already installed
            from it stay installed.
          </DialogDescription>
        </DialogHeader>
        <Field id="apt-remove-reason" label="Why" value={reason} onChange={setReason} />
        {remove.isError && (
          <p className="text-sm text-destructive">{aptRepositoryErrorMessage(remove.error)}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!repo || reason.trim() === "" || remove.isPending}
            onClick={() =>
              repo &&
              remove.mutate(
                { id: repo.id, reason: reason.trim() },
                {
                  onSuccess: (result) => {
                    waitingToast(result.status);
                    setReason("");
                    onClose();
                  },
                },
              )
            }
          >
            Ask for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
      />
    </div>
  );
}
