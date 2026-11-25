import type { ProfileSummary } from "@cloudable/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Layers, Plus, Server, SlidersHorizontal, Tag } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { profileKeys, useCreateProfile, useProfiles } from "@/api/profiles";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { ProfileFormDialog } from "./profile-form-dialog";

/** "provider fake, size small", or a dash when the profile fixes none of them. */
export function creationFieldsSummary(p: ProfileSummary): string {
  const parts = [
    p.provider && p.provider,
    p.region && p.region,
    p.sizeSku && p.sizeSku,
    p.image && p.image,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Profiles: named sets of settings machines link to. The chain is org → profile → machine;
 * the lowest level that sets something wins. See docs/inheritance.md.
 */
export function ProfilesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profilesQuery = useProfiles();
  const create = useCreateProfile();
  const [creating, setCreating] = useState(false);

  const profiles = profilesQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Profiles</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            A profile is a set of settings and packages that machines link to. A machine takes what
            its profile sets, and the org's for the rest. Edit a profile and its machines follow,
            unless they override the setting.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          New profile
        </Button>
      </div>

      <div className="min-h-0 overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
        {profilesQuery.isSuccess && profiles.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No profiles yet"
            description="Every machine takes its settings from the org. Make a profile to give a group of machines their own."
          />
        ) : (
          <Table containerClassName="h-full max-h-[60vh]">
            <TableHeader>
              <TableRow>
                <Th icon={Layers}>Name</Th>
                <Th icon={Server}>Machines</Th>
                <Th icon={SlidersHorizontal}>Fixed for its machines</Th>
                <Th icon={Tag}>Status</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profilesQuery.isPending &&
                [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    {["w-32", "w-8", "w-40", "w-16"].map((width) => (
                      <TableCell key={width}>
                        <Skeleton className={`h-4 ${width}`} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {profilesQuery.isError && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-destructive">
                    Failed to load profiles.
                  </TableCell>
                </TableRow>
              )}
              {profiles.map((p) => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  onClick={() =>
                    void navigate({ to: "/profiles/$profileId", params: { profileId: p.id } })
                  }
                >
                  <TableCell className="font-medium">
                    {p.name}
                    {p.description && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {p.description}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{p.machineCount}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {creationFieldsSummary(p)}
                  </TableCell>
                  <TableCell>
                    {p.archivedAt ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : (
                      <Badge variant="ok">Active</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ProfileFormDialog
        open={creating}
        onOpenChange={setCreating}
        save={(values) => create.mutateAsync(values)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: profileKeys.all });
          toast.success("Profile created");
        }}
      />
    </div>
  );
}

function Th({ icon, children }: { icon: typeof Layers; children: string }) {
  return (
    <TableHead>
      <span className="flex items-center gap-1.5">
        <TableHeaderIcon icon={icon} />
        {children}
      </span>
    </TableHead>
  );
}
