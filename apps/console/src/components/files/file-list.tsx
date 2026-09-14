/**
 * The compact mode: names only, flowed into as many columns as fit.
 *
 * For a directory with hundreds of entries — `/usr/bin`, a node_modules, a log directory —
 * the table's four columns mean a lot of scrolling to answer "is the file I want in here".
 * This is the `ls` view: dense, alphabetical, one glance.
 */
import type { FsEntry } from "@cloudable/contracts";
import { File as FileIcon, Folder as FolderIcon, Link2 } from "lucide-react";

import { cn } from "@/lib/utils";

export interface FileListProps {
  entries: ReadonlyArray<FsEntry>;
  parent: string | null;
  selectedName: string | null;
  onActivate: (entry: FsEntry) => void;
  onNavigateParent: () => void;
}

export function FileList({
  entries,
  parent,
  selectedName,
  onActivate,
  onNavigateParent,
}: FileListProps) {
  return (
    <div className="h-full overflow-auto p-3">
      {/* Fixed-width columns rather than `columns-*`: CSS multi-column flows top-to-bottom
          then wraps, which puts alphabetically adjacent names in different columns and is
          genuinely hard to scan. A grid keeps reading order left-to-right. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 gap-y-0.5">
        {parent !== null && (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-1 py-1 text-left font-mono text-xs hover:bg-accent"
            onClick={onNavigateParent}
          >
            <span className="size-3.5 shrink-0" />
            ..
          </button>
        )}
        {entries.map((entry) => {
          const Icon =
            entry.type === "directory" ? FolderIcon : entry.type === "symlink" ? Link2 : FileIcon;
          return (
            <button
              key={entry.name}
              type="button"
              className={cn(
                "flex items-center gap-1.5 rounded px-1 py-1 text-left font-mono text-xs hover:bg-accent",
                selectedName === entry.name && "bg-accent text-accent-foreground",
              )}
              onClick={() => onActivate(entry)}
              title={entry.symlinkTarget ? `→ ${entry.symlinkTarget}` : entry.name}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{entry.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
