/**
 * Recursive directory tree. The first recursive component in the console — nothing else
 * here renders a self-referential structure, and `collapsible-section.tsx` could not be
 * reused because its open state is internal `useState` with no controlled prop, while a
 * tree has to drive expansion from outside (restoring a path, collapsing everything).
 *
 * Expansion is lazy: a node's children are fetched the first time it opens, then cached in
 * `use-directory-cache.ts`. Each expansion is a real round trip to a process on the
 * machine, so nothing is prefetched and nothing is auto-expanded beyond the initial path.
 */
import type { FsEntry } from "@cloudable/contracts";
import { ChevronRight, File as FileIcon, Folder as FolderIcon, Link2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { joinPath } from "./paths";
import type { DirectoryCache } from "./use-directory-cache";

export interface FileTreeProps {
  /** Where the tree is rooted. Everything above this is simply not shown. */
  root: string;
  cache: DirectoryCache;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (entry: FsEntry, fullPath: string) => void;
}

export function FileTree({
  root,
  cache,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
}: FileTreeProps) {
  return (
    <ul className="py-1 text-xs" role="tree" aria-label="Files">
      <TreeLevel
        path={root}
        depth={0}
        cache={cache}
        expanded={expanded}
        onToggle={onToggle}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    </ul>
  );
}

function TreeLevel({
  path,
  depth,
  cache,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
}: {
  path: string;
  depth: number;
} & Omit<FileTreeProps, "root">) {
  const dir = cache.directories.get(path);
  const error = cache.errors.get(path);

  if (error) {
    return (
      <li style={{ paddingLeft: `${depth * 0.75 + 1.5}rem` }} className="py-1 text-destructive">
        {error}
      </li>
    );
  }
  if (!dir) {
    return cache.loading.has(path) ? (
      <li
        style={{ paddingLeft: `${depth * 0.75 + 1.5}rem` }}
        className="flex items-center gap-1.5 py-1 text-muted-foreground"
      >
        <Loader2 className="size-3 animate-spin" /> Loading…
      </li>
    ) : null;
  }
  if (dir.entries.length === 0) {
    return (
      <li
        style={{ paddingLeft: `${depth * 0.75 + 1.5}rem` }}
        className="py-1 text-muted-foreground"
      >
        Empty
      </li>
    );
  }

  return (
    <>
      {dir.entries.map((entry) => {
        const full = joinPath(path, entry.name);
        // A symlink may point at either, and `lstat` describes the link rather than its
        // target, so it gets a disclosure arrow and resolves when opened — the same
        // try-list-then-read rule the rest of this component uses.
        const expandable = entry.type === "directory" || entry.type === "symlink";
        const isOpen = expanded.has(full);
        const Icon =
          entry.type === "directory" ? FolderIcon : entry.type === "symlink" ? Link2 : FileIcon;

        return (
          <li key={entry.name} role="treeitem" aria-expanded={expandable ? isOpen : undefined}>
            <div
              className={cn(
                "group flex items-center gap-1 rounded-md py-1 pr-2 hover:bg-accent",
                selectedPath === full && "bg-accent text-accent-foreground",
              )}
              style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
            >
              {expandable ? (
                <button
                  type="button"
                  aria-label={isOpen ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                  className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  onClick={() => onToggle(full)}
                >
                  {cache.loading.has(full) ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ChevronRight
                      className={cn("size-3 transition-transform", isOpen && "rotate-90")}
                    />
                  )}
                </button>
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono"
                onClick={() => onSelect(entry, full)}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            </div>
            {expandable && isOpen && (
              // `role="group"` on the nested list is the WAI-ARIA tree pattern — a `ul`'s
              // implicit `list` role would make every level read as a separate list rather
              // than as children of this node.
              // biome-ignore lint/a11y/useSemanticElements: see above.
              <ul role="group">
                <TreeLevel
                  path={full}
                  depth={depth + 1}
                  cache={cache}
                  expanded={expanded}
                  onToggle={onToggle}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}
