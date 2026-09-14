/**
 * The file interface for a `method: "files"` session.
 *
 * Deliberately plain. `CLAUDE.md` forbids building code-server, and the way this stays on
 * the right side of that line is by not drifting toward one: no syntax highlighting, no
 * project concept, no multi-file tabs, no cross-file search, nothing executable. One
 * listing, one file open at a time, a monospace textarea. It exists to recover and fix
 * files, which is what `elevations.level = "file_recovery"` has always meant.
 *
 * Every operation runs on the machine as the session's own OS user — see
 * `apps/tunnel-daemon/src/fs-helper.ts`. Nothing here is a privileged path, and a failure
 * arriving as `permission_denied` is a normal, expected outcome to render, not an error.
 */
import {
  FS_MAX_INLINE_BYTES,
  FS_MAX_TRANSFER_BYTES,
  type FsEntry,
  MACHINE_OS_USER,
} from "@cloudable/contracts";
import {
  ArrowUpFromLine,
  Download,
  File as FileIcon,
  Folder as FolderIcon,
  FolderPlus,
  Link2,
  Pencil,
  RotateCw,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { TableHeaderIcon } from "@/components/table-header-icon";
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
import { Textarea } from "@/components/ui/textarea";

import { type FsOutcome, useFileSession } from "./use-file-session";

/**
 * Where to start. The session user's home, derived from `MACHINE_OS_USER` rather than
 * spelled out, so it cannot drift from the user the control plane actually puts in the
 * token's `targetOsUser` claim. `/` would be a wall of system directories nobody opened
 * this to look at.
 */
const DEFAULT_PATH = `/home/${MACHINE_OS_USER}`;

export interface FileBrowserProps {
  sessionId: string;
  initialPath?: string;
}

/** One open file in the editor. `modifiedAt` is what the save's lost-update check pins to. */
interface OpenFile {
  path: string;
  original: string;
  draft: string;
  modifiedAt: string;
}

const GENERIC_FAILURE = "The machine couldn't complete that operation.";

const FAILURE_TEXT: Record<string, string> = {
  not_found: "That path no longer exists.",
  permission_denied: "You don't have permission for that on this machine.",
  not_a_directory: "That isn't a directory.",
  is_a_directory: "That's a directory, not a file.",
  too_large: "That file is too large to open here.",
  is_binary: "That looks like a binary file. Download it instead.",
  exists: "Something already exists at that path.",
  changed_on_disk: "The file changed on the machine since you opened it.",
  invalid_path: "That path isn't valid.",
  io_error: GENERIC_FAILURE,
};

const describeFailure = (reason: string): string => FAILURE_TEXT[reason] ?? GENERIC_FAILURE;

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const joinPath = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

const decodeText = (base64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

const encodeText = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export function FileBrowser({ sessionId, initialPath = DEFAULT_PATH }: FileBrowserProps) {
  const session = useFileSession(sessionId);
  const { state, closeReason, run, upload } = session;

  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<ReadonlyArray<FsEntry> | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const dirty = open !== null && open.draft !== open.original;

  const list = useCallback(
    async (target: string) => {
      const { result } = await run({ op: "list", path: target });
      if (!result.ok) {
        setListError(describeFailure(result.reason));
        setEntries([]);
        return;
      }
      if (result.op !== "list") return;
      setListError(null);
      setEntries(result.entries);
      setParent(result.parent);
      setTruncated(result.truncated);
      setPath(result.path);
    },
    [run],
  );

  useEffect(() => {
    if (state !== "attached") return;
    void list(initialPath);
  }, [state, initialPath, list]);

  const navigate = useCallback(
    (target: string) => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      setOpen(null);
      setEntries(null);
      void list(target);
    },
    [dirty, list],
  );

  const openFile = useCallback(
    async (full: string) => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      setBusy(true);
      const { result } = await run({ op: "read", path: full });
      setBusy(false);
      if (!result.ok) {
        toast.error("Couldn't open the file", { description: describeFailure(result.reason) });
        return;
      }
      if (result.op !== "read") return;
      const text = decodeText(result.contentBase64);
      setOpen({ path: result.path, original: text, draft: text, modifiedAt: result.modifiedAt });
    },
    [dirty, run],
  );

  /**
   * A symlink can point at either a file or a directory, and nothing in the listing says
   * which — `lstat` describes the link, not its target. So try to open it as a directory
   * and fall back to reading it as a file.
   *
   * The fallback matters more than it looks: this tool is aimed squarely at `/etc` and
   * `/var/log`, both full of symlinks. Treating every symlink as a directory made a
   * symlinked file unopenable AND blanked the listing behind a `not_a_directory` error,
   * with the breadcrumb still showing the old path.
   */
  const activate = useCallback(
    async (entry: FsEntry) => {
      const full = joinPath(path, entry.name);
      if (entry.type === "directory") {
        navigate(full);
        return;
      }
      if (entry.type !== "symlink") {
        void openFile(full);
        return;
      }
      if (dirty && !confirm("Discard unsaved changes?")) return;
      setBusy(true);
      const { result } = await run({ op: "list", path: full });
      setBusy(false);
      if (result.ok && result.op === "list") {
        setOpen(null);
        setListError(null);
        setEntries(result.entries);
        setParent(result.parent);
        setTruncated(result.truncated);
        setPath(result.path);
        return;
      }
      if (!result.ok && result.reason === "not_a_directory") {
        void openFile(full);
        return;
      }
      toast.error("Couldn't open that link", {
        description: result.ok ? GENERIC_FAILURE : describeFailure(result.reason),
      });
    },
    [dirty, navigate, openFile, path, run],
  );

  const save = useCallback(async () => {
    if (!open) return;
    setBusy(true);
    const { result } = await run({
      op: "write",
      path: open.path,
      contentBase64: encodeText(open.draft),
      // Pins the save to what was read. The helper refuses with `changed_on_disk` if
      // anyone else touched the file meanwhile, rather than silently discarding their work.
      expectedModifiedAt: open.modifiedAt,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error("Couldn't save", { description: describeFailure(result.reason) });
      return;
    }
    if (result.op !== "write") return;
    setOpen({ ...open, original: open.draft, modifiedAt: result.modifiedAt });
    toast.success("Saved");
    void list(path);
  }, [open, run, list, path]);

  const download = useCallback(
    async (entry: FsEntry) => {
      const full = joinPath(path, entry.name);
      if (entry.sizeBytes > FS_MAX_TRANSFER_BYTES) {
        toast.error("Too large to download", {
          description: `The limit is ${formatSize(FS_MAX_TRANSFER_BYTES)}.`,
        });
        return;
      }
      setBusy(true);
      const outcome: FsOutcome = await run({ op: "download", path: full });
      setBusy(false);
      if (!outcome.result.ok || !outcome.bytes) {
        toast.error("Couldn't download", {
          description: outcome.result.ok ? GENERIC_FAILURE : describeFailure(outcome.result.reason),
        });
        return;
      }
      // Attached to the document before clicking, and revoked on a later tick. A detached
      // anchor does not start a download in Firefox, and revoking synchronously after
      // `click()` can cancel the download before it begins.
      const url = URL.createObjectURL(new Blob([outcome.bytes as BlobPart]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.name;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    [path, run],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      if (file.size > FS_MAX_TRANSFER_BYTES) {
        toast.error("Too large to upload", {
          description: `The limit is ${formatSize(FS_MAX_TRANSFER_BYTES)}.`,
        });
        return;
      }
      const target = joinPath(path, file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      setBusy(true);
      let { result } = await upload(target, bytes, false);
      // There is no delete operation here, so an overwrite is the one thing in this
      // interface that can't be undone. It never happens without being asked for.
      if (!result.ok && result.reason === "exists") {
        if (!confirm(`${file.name} already exists on the machine. Replace it?`)) {
          setBusy(false);
          return;
        }
        ({ result } = await upload(target, bytes, true));
      }
      setBusy(false);
      if (!result.ok) {
        toast.error("Couldn't upload", { description: describeFailure(result.reason) });
        return;
      }
      toast.success(`Uploaded ${file.name}`);
      void list(path);
    },
    [path, upload, list],
  );

  const makeDirectory = useCallback(async () => {
    const name = prompt("New folder name");
    if (!name) return;
    setBusy(true);
    const { result } = await run({ op: "mkdir", path: joinPath(path, name) });
    setBusy(false);
    if (!result.ok) {
      toast.error("Couldn't create the folder", { description: describeFailure(result.reason) });
      return;
    }
    void list(path);
  }, [path, run, list]);

  const rename = useCallback(
    async (entry: FsEntry) => {
      const name = prompt(`Rename ${entry.name} to`, entry.name);
      if (!name || name === entry.name) return;
      setBusy(true);
      const { result } = await run({
        op: "rename",
        from: joinPath(path, entry.name),
        to: joinPath(path, name),
      });
      setBusy(false);
      if (!result.ok) {
        toast.error("Couldn't rename", { description: describeFailure(result.reason) });
        return;
      }
      void list(path);
    },
    [path, run, list],
  );

  if (state === "connecting") {
    return <p className="text-sm text-muted-foreground">Connecting to the machine…</p>;
  }
  if (state === "rejected") {
    return (
      <p className="text-sm text-destructive">
        The machine refused this session{closeReason ? `: ${closeReason}` : "."}
      </p>
    );
  }
  if (state === "closed") {
    return (
      <p className="text-sm text-muted-foreground">
        This session has ended{closeReason ? ` (${closeReason})` : ""}. Start a new one from the
        machine.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Breadcrumbs path={path} onNavigate={navigate} />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void list(path)} disabled={busy}>
            <RotateCw className="size-3.5" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => void makeDirectory()} disabled={busy}>
            <FolderPlus className="size-3.5" /> New folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => uploadInputRef.current?.click()}
            disabled={busy}
          >
            <ArrowUpFromLine className="size-3.5" /> Upload
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleUpload(file);
            }}
          />
        </div>
      </div>

      {/* min-h-0, no flex-1: shrinks to what's left under the header when content
          overflows, but never grows past its own content — a short listing collapses
          instead of stretching into empty space. Same treatment as every other table in
          the console (see `machines-page.tsx`). */}
      <div className="min-h-0 overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
        {entries === null ? (
          <div className="space-y-2 p-4">
            {["a", "b", "c", "d", "e"].map((key) => (
              <Skeleton key={key} className="h-6 w-full" />
            ))}
          </div>
        ) : listError ? (
          <p className="p-6 text-center text-sm text-destructive">{listError}</p>
        ) : entries.length === 0 && parent === null ? (
          // Only at `/`, where there is no ".." row to render and so nothing at all to show.
          // A deeper empty directory still renders the table for its "go up" row.
          <EmptyState icon={FolderIcon} title="Empty" description="Nothing in this directory." />
        ) : (
          <Table containerClassName="h-full max-h-none">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={FileIcon} />
                    Name
                  </span>
                </TableHead>
                <TableHead className="w-28">Size</TableHead>
                <TableHead className="w-28">Mode</TableHead>
                <TableHead className="w-44">Modified</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parent !== null && (
                <TableRow className="cursor-pointer" onClick={() => navigate(parent)}>
                  <TableCell className="font-mono text-xs">..</TableCell>
                  <TableCell colSpan={4} />
                </TableRow>
              )}
              {entries.map((entry) => (
                <EntryRow
                  key={entry.name}
                  entry={entry}
                  busy={busy}
                  onActivate={() => void activate(entry)}
                  onDownload={() => void download(entry)}
                  onRename={() => void rename(entry)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {truncated && (
        <p className="shrink-0 text-xs text-muted-foreground">
          This directory has more entries than can be listed here. Narrow it down from the terminal.
        </p>
      )}

      {open && (
        <FileEditor
          file={open}
          dirty={dirty}
          busy={busy}
          onChange={(draft) => setOpen({ ...open, draft })}
          onSave={() => void save()}
          onClose={() => {
            if (dirty && !confirm("Discard unsaved changes?")) return;
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

function Breadcrumbs({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (target: string) => void;
}) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground">
      <button
        type="button"
        className="hover:text-foreground hover:underline"
        onClick={() => onNavigate("/")}
      >
        /
      </button>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join("/")}`;
        const last = index === segments.length - 1;
        return (
          <span key={target} className="flex items-center gap-1">
            <button
              type="button"
              className={last ? "text-foreground" : "hover:text-foreground hover:underline"}
              onClick={() => onNavigate(target)}
            >
              {segment}
            </button>
            {!last && <span aria-hidden="true">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

function EntryRow({
  entry,
  busy,
  onActivate,
  onDownload,
  onRename,
}: {
  entry: FsEntry;
  busy: boolean;
  onActivate: () => void;
  onDownload: () => void;
  onRename: () => void;
}) {
  // A symlink is shown as itself so what is on disk stays legible, but it gets the same
  // actions a file does — `activate` resolves what it actually points at, and its
  // `sizeBytes` is the link's own, not the target's, so it can't be size-gated here.
  const editable =
    entry.type === "symlink" || (entry.type === "file" && entry.sizeBytes <= FS_MAX_INLINE_BYTES);
  const downloadable = entry.type === "file" || entry.type === "symlink";

  const Icon =
    entry.type === "directory" ? FolderIcon : entry.type === "symlink" ? Link2 : FileIcon;

  return (
    <TableRow>
      <TableCell>
        <button
          type="button"
          className="flex items-center gap-2 text-left font-mono text-xs hover:underline"
          onClick={onActivate}
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
      <TableCell className="font-mono text-xs text-muted-foreground">{entry.mode}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(entry.modifiedAt).toLocaleString()}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {editable && (
            <Button variant="ghost" size="sm" onClick={onActivate} disabled={busy} title="Edit">
              <Pencil className="size-3.5" />
            </Button>
          )}
          {downloadable && (
            <Button variant="ghost" size="sm" onClick={onDownload} disabled={busy} title="Download">
              <Download className="size-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRename} disabled={busy} title="Rename">
            <span className="text-xs">Rename</span>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function FileEditor({
  file,
  dirty,
  busy,
  onChange,
  onSave,
  onClose,
}: {
  file: OpenFile;
  dirty: boolean;
  busy: boolean;
  onChange: (draft: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 shrink-0 flex-col gap-2 rounded-2xl border border-muted-foreground/20 bg-card p-4 shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-xs">{file.path}</span>
        {dirty && <span className="text-xs text-muted-foreground">unsaved</span>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={onSave} disabled={!dirty || busy}>
            <Save className="size-3.5" /> Save
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <Textarea
        value={file.draft}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="min-h-64 font-mono text-xs"
      />
    </div>
  );
}
