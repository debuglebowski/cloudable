/**
 * The table mode: name, size, mode, modified.
 *
 * This is the mode that serves file RECOVERY rather than navigation. "What changed at
 * 03:14" and "this is world-readable" are the questions an auditor and an admin recovering
 * a file actually ask, and a tree cannot answer either at a glance. Columns sort, because
 * scanning a directory for the most recently touched file is the common case.
 *
 * Follows the console's table discipline exactly: `Table` inside a `min-h-0` wrapper with
 * `containerClassName="h-full max-h-none"`, so it collapses to its content and never
 * stretches to fill (see `machines-page.tsx`'s comment for the full reasoning).
 */
import type { FsEntry } from "@cloudable/contracts";
import { ArrowDown, ArrowUp, File as FileIcon, Folder as FolderIcon, Link2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { SortKey } from "./paths";

export interface FileTableProps {
  entries: ReadonlyArray<FsEntry>;
  parent: string | null;
  selectedName: string | null;
  onActivate: (entry: FsEntry) => void;
  onNavigateParent: () => void;
  formatSize: (bytes: number) => string;
  /** Per-row actions, rendered in the trailing column. */
  renderActions: (entry: FsEntry) => React.ReactNode;
}

export function FileTable({
  entries,
  parent,
  selectedName,
  onActivate,
  onNavigateParent,
  formatSize,
  renderActions,
}: FileTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });

  const sorted = useMemo(() => {
    const rows = [...entries];
    rows.sort((a, b) => {
      // Directories stay grouped above files regardless of the column being sorted —
      // interleaving them by size or date makes a directory listing much harder to scan.
      if ((a.type === "directory") !== (b.type === "directory")) {
        return a.type === "directory" ? -1 : 1;
      }
      const dir = sort.asc ? 1 : -1;
      if (sort.key === "name") return a.name.localeCompare(b.name) * dir;
      if (sort.key === "sizeBytes") return (a.sizeBytes - b.sizeBytes) * dir;
      return (Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt)) * dir;
    });
    return rows;
  }, [entries, sort]);

  const toggle = (key: SortKey) =>
    setSort((prev) => ({ key, asc: prev.key === key ? !prev.asc : true }));

  const Th = ({ label, k, className }: { label: string; k: SortKey; className?: string }) => (
    <TableHead className={className}>
      <button
        type="button"
        className="flex items-center gap-1 hover:text-foreground"
        onClick={() => toggle(k)}
      >
        {label}
        {sort.key === k &&
          (sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );

  return (
    <Table containerClassName="h-full max-h-none">
      <TableHeader>
        <TableRow>
          <Th label="Name" k="name" />
          <Th label="Size" k="sizeBytes" className="w-28" />
          <TableHead className="w-28">Mode</TableHead>
          <Th label="Modified" k="modifiedAt" className="w-44" />
          <TableHead className="w-36 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {parent !== null && (
          <TableRow className="cursor-pointer" onClick={onNavigateParent}>
            <TableCell className="font-mono text-xs">..</TableCell>
            <TableCell colSpan={4} />
          </TableRow>
        )}
        {sorted.map((entry) => {
          const Icon =
            entry.type === "directory" ? FolderIcon : entry.type === "symlink" ? Link2 : FileIcon;
          return (
            <TableRow key={entry.name} className={cn(selectedName === entry.name && "bg-accent")}>
              <TableCell>
                <button
                  type="button"
                  className="flex items-center gap-2 text-left font-mono text-xs hover:underline"
                  onClick={() => onActivate(entry)}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span>{entry.name}</span>
                  {entry.symlinkTarget && (
                    <span className="text-muted-foreground">→ {entry.symlinkTarget}</span>
                  )}
                </button>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {entry.type === "directory" ? "—" : formatSize(entry.sizeBytes)}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {entry.mode}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(entry.modifiedAt).toLocaleString()}
              </TableCell>
              <TableCell className="text-right">{renderActions(entry)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
