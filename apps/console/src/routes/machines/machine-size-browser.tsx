import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Cpu,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { CatalogItem } from "@/api/provider-catalog";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { computeCompatibility, deriveFamily, matchesSizeSearch } from "./machine-compatibility";

// Not virtualized — avoids adding a virtualization dependency for a control this
// scoped. Disclosed via the count next to the "Size" label (countSummary below)
// rather than silently truncating the list with no explanation.
const RENDER_CAP = 200;

// A fixed, sensible order rather than whatever order Object.keys happens to
// produce — "Other" always trails since it's the catch-all, not a real family.
const FAMILY_ORDER = [
  "Burstable",
  "General purpose",
  "Compute optimized",
  "Memory optimized",
  "Storage optimized",
  "GPU / accelerated",
  "Other",
];

type SortColumn = "vcpus" | "memoryGb" | "architecture";

export interface MachineSizeBrowserProps {
  sizes: CatalogItem[];
  isLoading: boolean;
  selectedSizeSku: string | null;
  onSelectSize: (sku: string) => void;
  /** Drives compatibility badges — `null` (no image picked yet) counts every size
   * as compatible, same as `computeCompatibility`. */
  selectedImage: CatalogItem | null;
  onSync: () => void;
  isSyncing: boolean;
}

/**
 * Step 2's size list — its own file because it's the one genuinely complex control
 * in the wizard, with real per-instance filter state (search/min-vCPU/min-RAM/
 * family/hide-incompatible) that has no business living in the wizard's own
 * top-level state. Only emits the selected SKU upward via `onSelectSize`.
 */
export function MachineSizeBrowser({
  sizes,
  isLoading,
  selectedSizeSku,
  onSelectSize,
  selectedImage,
  onSync,
  isSyncing,
}: MachineSizeBrowserProps) {
  const [search, setSearch] = useState("");
  const [minVcpus, setMinVcpus] = useState("");
  const [maxVcpus, setMaxVcpus] = useState("");
  const [minMemoryGb, setMinMemoryGb] = useState("");
  const [maxMemoryGb, setMaxMemoryGb] = useState("");
  const [family, setFamily] = useState("All");
  const [hideIncompatible, setHideIncompatible] = useState(false);
  // Display order, not a filter — deliberately left out of clearFilters/
  // activeFilterCount below (clearing filters shouldn't also reset how you're
  // looking at what's left) and out of RENDER_CAP's "N sizes match" framing.
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const families = useMemo(() => {
    const present = new Set(sizes.map((entry) => deriveFamily(entry.code)));
    return FAMILY_ORDER.filter((candidate) => present.has(candidate));
  }, [sizes]);

  const minVcpusNum = minVcpus ? Number(minVcpus) : null;
  const maxVcpusNum = maxVcpus ? Number(maxVcpus) : null;
  const minMemoryGbNum = minMemoryGb ? Number(minMemoryGb) : null;
  const maxMemoryGbNum = maxMemoryGb ? Number(maxMemoryGb) : null;

  const filtered = useMemo(
    () =>
      sizes.filter((entry) => {
        if (!matchesSizeSearch(entry, search)) return false;
        if (minVcpusNum !== null && (entry.vcpus ?? 0) < minVcpusNum) return false;
        if (maxVcpusNum !== null && (entry.vcpus ?? Number.POSITIVE_INFINITY) > maxVcpusNum) {
          return false;
        }
        if (minMemoryGbNum !== null && (entry.memoryGb ?? 0) < minMemoryGbNum) return false;
        if (
          maxMemoryGbNum !== null &&
          (entry.memoryGb ?? Number.POSITIVE_INFINITY) > maxMemoryGbNum
        ) {
          return false;
        }
        if (family !== "All" && deriveFamily(entry.code) !== family) return false;
        if (hideIncompatible && !computeCompatibility(entry, selectedImage).compatible) {
          return false;
        }
        return true;
      }),
    [
      sizes,
      search,
      minVcpusNum,
      maxVcpusNum,
      minMemoryGbNum,
      maxMemoryGbNum,
      family,
      hideIncompatible,
      selectedImage,
    ],
  );

  // Sorted after filtering, before the RENDER_CAP slice below — sorting a 1000+-row
  // catalog by vCPU/RAM/architecture is exactly how you'd want to find "the biggest"
  // or "the smallest" option, and doing it before the cap means the cap follows the
  // sort (e.g. sorted by vCPU descending, "showing 200" means the 200 largest, not an
  // arbitrary 200 that then happen to get sorted). Missing data (null vcpus/memoryGb/
  // architecture) always sorts last regardless of direction — there's nothing to rank
  // it against, "unknown" isn't meaningfully smallest or largest.
  const sorted = useMemo(() => {
    if (!sortColumn) return filtered;
    const dir = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortColumn === "architecture") {
        if (a.architecture == null && b.architecture == null) return 0;
        if (a.architecture == null) return 1;
        if (b.architecture == null) return -1;
        return dir * a.architecture.localeCompare(b.architecture);
      }
      const av = a[sortColumn];
      const bv = b[sortColumn];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir * (av - bv);
    });
  }, [filtered, sortColumn, sortDirection]);

  function toggleSort(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  // A plain function returning JSX, not a `<SortHeader />` component — avoids React
  // treating each call as a fresh component type across renders (which would remount
  // rather than update), for what's otherwise just three near-identical header cells.
  function renderSortHeader(column: SortColumn, label: string) {
    const active = sortColumn === column;
    return (
      <button
        type="button"
        onClick={() => toggleSort(column)}
        className={cn(
          "flex items-center gap-0.5 text-left hover:text-foreground",
          active && "font-medium text-foreground",
        )}
      >
        {label}
        {active ? (
          sortDirection === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-30" />
        )}
      </button>
    );
  }

  function clearFilters() {
    setSearch("");
    setMinVcpus("");
    setMaxVcpus("");
    setMinMemoryGb("");
    setMaxMemoryGb("");
    setFamily("All");
    setHideIncompatible(false);
  }

  // Genuinely empty catalog (settled, zero rows) — never synced, as opposed to
  // `isLoading`'s "not answered yet." Replaces the whole toolbar+list: there's
  // nothing to filter or browse until a sync brings real rows in.
  if (!isLoading && sizes.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Label className="flex items-center gap-1.5">
          <TableHeaderIcon icon={Cpu} />
          Size
        </Label>
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={Cpu}
            title="No sizes synced yet"
            description="Sync live sizes from Azure to choose one."
          />
          <Button type="button" variant="outline" onClick={onSync} disabled={isSyncing}>
            {isSyncing && <Loader2 className="size-3.5 animate-spin" />}
            {isSyncing ? "Syncing…" : "Sync from Azure"}
          </Button>
        </div>
      </div>
    );
  }

  const visible = sorted.slice(0, RENDER_CAP);
  const activeFilterCount =
    (family !== "All" ? 1 : 0) +
    (minVcpusNum !== null ? 1 : 0) +
    (maxVcpusNum !== null ? 1 : 0) +
    (minMemoryGbNum !== null ? 1 : 0) +
    (maxMemoryGbNum !== null ? 1 : 0) +
    (hideIncompatible ? 1 : 0);
  // Same "Showing N of M" info the render cap already needs to disclose (see
  // RENDER_CAP's own comment) — surfaced once, next to the section label, instead
  // of as a separate line below the list.
  const countSummary =
    filtered.length > RENDER_CAP
      ? `Showing ${RENDER_CAP} of ${filtered.length.toLocaleString()}`
      : `${filtered.length.toLocaleString()} ${filtered.length === 1 ? "size" : "sizes"}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <TableHeaderIcon icon={Cpu} />
          Size
        </Label>
        <span className="text-xs text-muted-foreground">{countSummary}</span>
      </div>

      {/* One toolbar row, not two: the previous version put 8 equal-weight family
          buttons on their own line above 5 more controls (search, 2 number inputs, a
          checkbox, sync) — everything competed for attention before you even reached
          the list. Family, the two numeric filters, and "hide incompatible" all move
          into a single Filters popover (badge shows the active count) so the visible
          surface is just Search / Filters / Sync. Mid-sync, everything left of the
          divider stays rendered but unreactive (aria-disabled + pointer-events-none
          opacity-60) — the catalog underneath is being replaced, so filtering against
          it right now would be filtering against soon-to-be-stale data. The Sync
          button sits outside that wrapper and stays live throughout, switching to
          its own inline spinner rather than a separate progress bar. */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={cn(
            "flex flex-1 flex-wrap items-center gap-2",
            isSyncing && "pointer-events-none opacity-60",
          )}
          aria-disabled={isSyncing || undefined}
        >
          <div className="relative min-w-40 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or SKU…"
              className="pl-8"
            />
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="gap-1.5">
                <SlidersHorizontal className="size-3.5" />
                Filters
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 text-xs">
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="flex w-64 flex-col gap-4" align="start">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="size-family">Family</Label>
                <Select value={family} onValueChange={setFamily}>
                  <SelectTrigger id="size-family">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">All families</SelectItem>
                    {families.map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        {candidate}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="min-vcpus">Min vCPUs</Label>
                  <Input
                    id="min-vcpus"
                    type="number"
                    min={0}
                    value={minVcpus}
                    onChange={(event) => setMinVcpus(event.target.value)}
                    placeholder="Any"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="max-vcpus">Max vCPUs</Label>
                  <Input
                    id="max-vcpus"
                    type="number"
                    min={0}
                    value={maxVcpus}
                    onChange={(event) => setMaxVcpus(event.target.value)}
                    placeholder="Any"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="min-ram">Min RAM (GB)</Label>
                  <Input
                    id="min-ram"
                    type="number"
                    min={0}
                    value={minMemoryGb}
                    onChange={(event) => setMinMemoryGb(event.target.value)}
                    placeholder="Any"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="max-ram">Max RAM (GB)</Label>
                  <Input
                    id="max-ram"
                    type="number"
                    min={0}
                    value={maxMemoryGb}
                    onChange={(event) => setMaxMemoryGb(event.target.value)}
                    placeholder="Any"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="hide-incompatible-sizes"
                  checked={hideIncompatible}
                  onCheckedChange={(checked) => setHideIncompatible(checked === true)}
                />
                <Label
                  htmlFor="hide-incompatible-sizes"
                  className="font-normal text-muted-foreground"
                >
                  Hide incompatible sizes
                </Label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {/* border-l + pl-4, and shrink-0 so a narrow dialog squeezes the controls above
            (they can wrap onto their own line) rather than crowding this into them —
            keeps "browse/filter" and "refresh the catalog" reading as two distinct
            actions instead of one run-on toolbar. */}
        <div className="flex shrink-0 items-center border-l pl-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onSync}
            disabled={isSyncing}
          >
            {isSyncing && <Loader2 className="size-3.5 animate-spin" />}
            {isSyncing ? "Syncing…" : "Sync from Azure"}
          </Button>
        </div>
      </div>

      {/* Border wraps the header + list together as one visual table, not just the
          list — overflow-hidden clips the header's square top corners and the
          Command's own rounded-md against this container's rounded border cleanly
          instead of double-rounding. */}
      <div className="overflow-hidden rounded-md border">
        <div
          className={cn(
            "flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground",
            isSyncing && "pointer-events-none opacity-60",
          )}
          aria-disabled={isSyncing || undefined}
        >
          <span className="size-4 shrink-0" aria-hidden="true" />
          <div className="grid flex-1 grid-cols-[1fr_5rem_5rem_7rem] gap-2">
            <span>Size</span>
            {renderSortHeader("vcpus", "vCPU")}
            {renderSortHeader("memoryGb", "RAM")}
            {renderSortHeader("architecture", "Architecture")}
          </div>
        </div>

        {/* shouldFilter=false: filtering is fully manual above (search matches code as
            well as displayName, unlike the flat form this wizard replaces). Dimmed and
            inert mid-sync for the same reason as the toolbar above — the rows being
            shown are about to be replaced. */}
        <Command
          shouldFilter={false}
          className={cn("rounded-none", isSyncing && "pointer-events-none opacity-60")}
          aria-disabled={isSyncing || undefined}
        >
          {isLoading ? (
            <div className="flex flex-col gap-1 p-1">
              {Array.from({ length: 6 }).map((_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholders, not real data — indices never reorder.
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
              No sizes match your filters.
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <CommandList className="max-h-72 overflow-y-auto">
              {visible.map((entry) => {
                const compatibility = computeCompatibility(entry, selectedImage);
                const isSelected = entry.code === selectedSizeSku;
                return (
                  <CommandItem
                    key={entry.code}
                    value={entry.code}
                    disabled={!compatibility.compatible}
                    onSelect={() => compatibility.compatible && onSelectSize(entry.code)}
                  >
                    <Check
                      className={cn("size-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")}
                    />
                    <div className="grid flex-1 grid-cols-[1fr_5rem_5rem_7rem] items-center gap-2">
                      <span className="truncate">{entry.displayName}</span>
                      <span className="text-muted-foreground">{entry.vcpus ?? "—"}</span>
                      <span className="text-muted-foreground">{entry.memoryGb ?? "—"}</span>
                      {compatibility.compatible ? (
                        <Badge variant="outline" className="w-fit">
                          {entry.architecture ?? "—"}
                        </Badge>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="drift" className="pointer-events-auto w-fit">
                              {compatibility.reason}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {entry.displayName} requires {entry.architecture} — incompatible with{" "}
                            {selectedImage?.displayName}, which requires{" "}
                            {selectedImage?.architecture}.
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandList>
          )}
        </Command>
      </div>
    </div>
  );
}
