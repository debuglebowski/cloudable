/**
 * Pure helpers shared by the file interface's panes.
 *
 * Split out of the components so they can be tested directly. `syntaxNameFor` in particular
 * returns a NAME rather than a CodeMirror extension: the mapping from a filename to a
 * language is ordinary logic worth testing, while building the extension needs the editor
 * packages, and importing those into a test would drag a DOM-dependent module in with them.
 */
import type { FsEntry } from "@cloudable/contracts";

export const joinPath = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

/** `null` at the filesystem root, which has no parent to navigate to. */
export const parentOf = (path: string): string | null =>
  path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The languages the editor knows. `null` means plain text with line numbers, which is a
 * perfectly good editor rather than a degraded one. */
export type SyntaxName = "json" | "yaml" | "shell" | "nginx" | "properties" | null;

/**
 * Syntax by extension, then by well-known basename. A deliberately small set: these are the
 * files people actually edit on a machine, and every entry here is a language package in
 * the editor's lazy chunk, so the list is a size decision as much as a feature one.
 */
export function syntaxNameFor(path: string): SyntaxName {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (ext === "json") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "sh" || ext === "bash" || name === ".bashrc" || name === ".profile") return "shell";
  // Checked before the generic `.conf` branch below, which would otherwise swallow it.
  if (name.includes("nginx") && (ext === "conf" || ext === "")) return "nginx";
  if (ext === "ini" || ext === "conf" || ext === "cfg" || ext === "properties" || ext === "env") {
    return "properties";
  }
  return null;
}

export type SortKey = "name" | "sizeBytes" | "modifiedAt";

/**
 * Sorts a directory listing for the table mode.
 *
 * Directories stay grouped above files whatever column is active. Interleaving them by size
 * or date makes a listing much harder to scan, and a directory's `sizeBytes` is its inode
 * size rather than anything a person would recognise, so sorting them among files by size
 * would be actively misleading.
 */
export function sortEntries(
  entries: ReadonlyArray<FsEntry>,
  key: SortKey,
  ascending: boolean,
): FsEntry[] {
  const rows = [...entries];
  const direction = ascending ? 1 : -1;
  rows.sort((a, b) => {
    const aDir = a.type === "directory";
    const bDir = b.type === "directory";
    if (aDir !== bDir) return aDir ? -1 : 1;
    if (key === "name") return a.name.localeCompare(b.name) * direction;
    if (key === "sizeBytes") return (a.sizeBytes - b.sizeBytes) * direction;
    return (Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt)) * direction;
  });
  return rows;
}
