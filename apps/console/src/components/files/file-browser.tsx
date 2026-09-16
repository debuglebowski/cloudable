/**
 * The file interface for a `method: "files"` session.
 *
 * Two panes. On the left a navigator with three display modes; on the right the open file
 * in one of two content modes. The modes exist because the two jobs this serves want
 * different things:
 *
 *   tree     navigating to a known path, keeping the surroundings visible
 *   table    scanning a directory — size, mode, modified, sortable. This is the mode file
 *            RECOVERY wants, and the one an auditor's questions are answered in
 *   compact  hundreds of entries at a glance, the `ls` view
 *
 *   code     CodeMirror: line numbers, in-file search, syntax for JSON/YAML/shell/ini
 *   plain    a monospace textarea, zero dependencies, always works
 *
 * Both choices persist per browser (`use-view-modes.ts`).
 *
 * ## What this is not
 *
 * `CLAUDE.md` forbids code-server. An earlier version of this file claimed that having no
 * editor library was what kept it on the right side of that line; that was too broad a
 * reading. The line is whether you can DEVELOP here — extensions, a language server, a
 * debugger, a project concept, running code. Still deliberately absent: multi-file tabs,
 * search across files, autocomplete, linting, anything executable.
 *
 * Every operation runs on the machine as the session's own OS user
 * (`apps/tunnel-daemon/src/fs-helper.ts`). Nothing here is privileged, and a
 * `permission_denied` is a normal outcome to render rather than an error.
 */
import {
  FS_MAX_INLINE_BYTES,
  FS_MAX_TRANSFER_BYTES,
  type FsEntry,
  MACHINE_OS_USER,
} from "@cloudable/contracts";
import { useBlocker } from "@tanstack/react-router";
import {
  ArrowUpFromLine,
  Columns2,
  Download,
  FileCode,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  List,
  Pencil,
  RotateCw,
  Rows3,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { type ContentMode, ContentPane } from "./content-pane";
import { ConfirmDialog, TextPromptDialog } from "./file-dialogs";
import { FileList } from "./file-list";
import { FileTable } from "./file-table";
import { FileTree } from "./file-tree";
import { formatSize, joinPath, parentOf } from "./paths";
import { SplitPane } from "./split-pane";
import { useDirectoryCache } from "./use-directory-cache";
import type { FileSession, FsOutcome } from "./use-file-session";
import { type NavigatorMode, useViewModes } from "./use-view-modes";

/** Where the tree is rooted and the table opens. Derived from the contract constant so it
 * cannot drift from the OS user the control plane puts in the token's `targetOsUser`. */
const DEFAULT_PATH = `/home/${MACHINE_OS_USER}`;

export interface FileBrowserProps {
  /**
   * The transport. Injected rather than opened here, because there are two:
   * `useFileSession` talks to a live machine over the tunnel websocket, and
   * `useSnapshotInspection` reads an archived machine's snapshot over HTTP. Both satisfy
   * this shape, and everything below is written against it rather than against either.
   */
  session: FileSession;
  initialPath?: string;
  /**
   * Hides every operation that would change something: save, rename, new folder, upload.
   *
   * Not merely cosmetic for a snapshot — there is no write path on that side at all
   * (`apps/control-plane/src/snapshot-fs/ext4/filesystem.ts`), so a Save button would be
   * offering something the server cannot do. The editor and content pane already accept
   * `readOnly` and this is the first caller to pass it.
   */
  readOnly?: boolean;
  /** Shown above the navigator — e.g. that a snapshot is the persistent disk only. */
  notice?: string;
}

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

const decodeText = (base64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

const encodeText = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export function FileBrowser({
  session,
  initialPath = DEFAULT_PATH,
  readOnly = false,
  notice,
}: FileBrowserProps) {
  const { state, closeReason, run, upload } = session;
  const { navigatorMode, setNavigatorMode, contentMode, setContentMode } = useViewModes();
  const cache = useDirectoryCache(session, describeFailure);

  const [cwd, setCwd] = useState(initialPath);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([initialPath]));
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renaming, setRenaming] = useState<FsEntry | null>(null);
  const [pendingReplace, setPendingReplace] = useState<{ file: File; target: string } | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);

  const dirty = open !== null && open.draft !== open.original;

  // Unsaved work is real once there is an editor holding it, so leaving the route asks
  // first. `confirm()` inside a navigate handler could not do this — the router would have
  // already committed by the time a custom dialog resolved.
  useBlocker({
    shouldBlockFn: () => {
      if (!dirty) return false;
      return !window.confirm("You have unsaved changes. Leave anyway?");
    },
    enableBeforeUnload: () => dirty,
  });

  useEffect(() => {
    if (state !== "attached") return;
    void cache.load(initialPath);
  }, [state, initialPath, cache.load]);

  /** Runs `action`, asking first when the open file has unsaved changes. */
  const guardDirty = useCallback(
    (action: () => void) => {
      if (!dirty) {
        action();
        return;
      }
      setPendingDiscard(() => action);
    },
    [dirty],
  );

  const openDirectory = useCallback(
    (path: string) => {
      setCwd(path);
      void cache.load(path);
    },
    [cache.load],
  );

  const openFile = useCallback(
    async (full: string) => {
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
    [run],
  );

  /**
   * Open whatever this entry turns out to be. A symlink's `lstat` describes the link and
   * not its target, so the only way to know is to try: list it, and fall back to reading it
   * as a file when the machine says it is not a directory.
   */
  const activate = useCallback(
    async (entry: FsEntry, fullPath: string) => {
      if (entry.type === "directory") {
        guardDirty(() => openDirectory(fullPath));
        return;
      }
      if (entry.type !== "symlink") {
        guardDirty(() => void openFile(fullPath));
        return;
      }
      setBusy(true);
      const { result } = await run({ op: "list", path: fullPath });
      setBusy(false);
      if (result.ok && result.op === "list") {
        guardDirty(() => openDirectory(result.path));
        return;
      }
      if (!result.ok && result.reason === "not_a_directory") {
        guardDirty(() => void openFile(fullPath));
        return;
      }
      toast.error("Couldn't open that link", {
        description: result.ok ? GENERIC_FAILURE : describeFailure(result.reason),
      });
    },
    [guardDirty, openDirectory, openFile, run],
  );

  const toggleExpanded = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else {
          next.add(path);
          void cache.load(path);
        }
        return next;
      });
    },
    [cache.load],
  );

  const save = useCallback(async () => {
    if (!open) return;
    setBusy(true);
    const { result } = await run({
      op: "write",
      path: open.path,
      contentBase64: encodeText(open.draft),
      // Pins the save to what was read, so a file changed underneath comes back as
      // `changed_on_disk` rather than silently discarding the other person's work.
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
    const dir = parentOf(open.path);
    if (dir) void cache.reload(dir);
  }, [open, run, cache.reload]);

  const download = useCallback(
    async (entry: FsEntry, fullPath: string) => {
      if (entry.sizeBytes > FS_MAX_TRANSFER_BYTES) {
        toast.error("Too large to download", {
          description: `The limit is ${formatSize(FS_MAX_TRANSFER_BYTES)}.`,
        });
        return;
      }
      setBusy(true);
      const outcome: FsOutcome = await run({ op: "download", path: fullPath });
      setBusy(false);
      if (!outcome.result.ok || !outcome.bytes) {
        toast.error("Couldn't download", {
          description: outcome.result.ok ? GENERIC_FAILURE : describeFailure(outcome.result.reason),
        });
        return;
      }
      // Attached before clicking and revoked on a later tick: a detached anchor does not
      // start a download in Firefox, and revoking synchronously can cancel it.
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
    [run],
  );

  const doUpload = useCallback(
    async (file: File, replace: boolean) => {
      const target = joinPath(cwd, file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      setBusy(true);
      const { result } = await upload(target, bytes, replace);
      setBusy(false);
      if (!result.ok && result.reason === "exists") {
        setPendingReplace({ file, target });
        return;
      }
      if (!result.ok) {
        toast.error("Couldn't upload", { description: describeFailure(result.reason) });
        return;
      }
      toast.success(`Uploaded ${file.name}`);
      void cache.reload(cwd);
    },
    [cwd, upload, cache.reload],
  );

  const handleUpload = useCallback(
    (file: File) => {
      if (file.size > FS_MAX_TRANSFER_BYTES) {
        toast.error("Too large to upload", {
          description: `The limit is ${formatSize(FS_MAX_TRANSFER_BYTES)}.`,
        });
        return;
      }
      void doUpload(file, false);
    },
    [doUpload],
  );

  const createFolder = useCallback(
    async (name: string) => {
      setBusy(true);
      const { result } = await run({ op: "mkdir", path: joinPath(cwd, name) });
      setBusy(false);
      if (!result.ok) {
        toast.error("Couldn't create the folder", { description: describeFailure(result.reason) });
        return;
      }
      void cache.reload(cwd);
    },
    [cwd, run, cache.reload],
  );

  const doRename = useCallback(
    async (entry: FsEntry, name: string) => {
      if (name === entry.name) return;
      setBusy(true);
      const { result } = await run({
        op: "rename",
        from: joinPath(cwd, entry.name),
        to: joinPath(cwd, name),
      });
      setBusy(false);
      if (!result.ok) {
        toast.error("Couldn't rename", { description: describeFailure(result.reason) });
        return;
      }
      void cache.reload(cwd);
    },
    [cwd, run, cache.reload],
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

  const dir = cache.directories.get(cwd);
  const dirError = cache.errors.get(cwd);
  const selectedName =
    open && parentOf(open.path) === cwd ? open.path.slice(cwd === "/" ? 1 : cwd.length + 1) : null;

  const rowActions = (entry: FsEntry) => {
    const full = joinPath(cwd, entry.name);
    const editable =
      entry.type === "symlink" || (entry.type === "file" && entry.sizeBytes <= FS_MAX_INLINE_BYTES);
    const downloadable = entry.type === "file" || entry.type === "symlink";
    return (
      <div className="flex justify-end gap-1">
        {editable && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            title={readOnly ? "View" : "Edit"}
            onClick={() => void activate(entry, full)}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
        {downloadable && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            title="Download"
            onClick={() => void download(entry, full)}
          >
            <Download className="size-3.5" />
          </Button>
        )}
        {!readOnly && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenaming(entry)}>
            <span className="text-xs">Rename</span>
          </Button>
        )}
      </div>
    );
  };

  const navigator = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Tabs value={navigatorMode} onValueChange={(v) => setNavigatorMode(v as NavigatorMode)}>
          <TabsList className="h-7">
            <ModeTab value="tree" label="Tree" icon={<List className="size-3.5" />} />
            <ModeTab value="table" label="Table" icon={<Rows3 className="size-3.5" />} />
            <ModeTab value="compact" label="Compact" icon={<Columns2 className="size-3.5" />} />
          </TabsList>
        </Tabs>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {navigatorMode === "tree" ? initialPath : cwd}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {navigatorMode === "tree" ? (
          <FileTree
            root={initialPath}
            cache={cache}
            expanded={expanded}
            onToggle={toggleExpanded}
            selectedPath={open?.path ?? null}
            onSelect={(entry, full) => void activate(entry, full)}
          />
        ) : dirError ? (
          <p className="p-6 text-center text-sm text-destructive">{dirError}</p>
        ) : !dir ? (
          <div className="space-y-2 p-4">
            {["a", "b", "c", "d", "e"].map((key) => (
              <Skeleton key={key} className="h-5 w-full" />
            ))}
          </div>
        ) : dir.entries.length === 0 && dir.parent === null ? (
          <EmptyState icon={FolderIcon} title="Empty" description="Nothing in this directory." />
        ) : navigatorMode === "table" ? (
          <FileTable
            entries={dir.entries}
            parent={dir.parent}
            selectedName={selectedName}
            formatSize={formatSize}
            onActivate={(entry) => void activate(entry, joinPath(cwd, entry.name))}
            onNavigateParent={() =>
              dir.parent && guardDirty(() => openDirectory(dir.parent as string))
            }
            renderActions={rowActions}
          />
        ) : (
          <FileList
            entries={dir.entries}
            parent={dir.parent}
            selectedName={selectedName}
            onActivate={(entry) => void activate(entry, joinPath(cwd, entry.name))}
            onNavigateParent={() =>
              dir.parent && guardDirty(() => openDirectory(dir.parent as string))
            }
          />
        )}
      </div>

      {dir?.truncated && (
        <p className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          More entries than can be listed. Narrow it down from the terminal.
        </p>
      )}
    </div>
  );

  const content = (
    <div className="ml-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
      {open ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
            <span className="truncate font-mono text-[11px]" title={open.path}>
              {open.path}
            </span>
            {dirty && <span className="shrink-0 text-[11px] text-muted-foreground">unsaved</span>}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Tabs value={contentMode} onValueChange={(v) => setContentMode(v as ContentMode)}>
                <TabsList className="h-7">
                  <ModeTab value="code" label="Code" icon={<FileCode className="size-3.5" />} />
                  <ModeTab value="plain" label="Plain" icon={<FileText className="size-3.5" />} />
                </TabsList>
              </Tabs>
              {!readOnly && (
                <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
                  <Save className="size-3.5" /> Save
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => guardDirty(() => setOpen(null))}
                title="Close file"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ContentPane
              mode={contentMode}
              path={open.path}
              value={open.draft}
              onChange={(draft) => setOpen((prev) => (prev ? { ...prev, draft } : prev))}
              onSave={() => void save()}
              readOnly={readOnly}
            />
          </div>
        </>
      ) : (
        <EmptyState
          icon={FileCode}
          title="No file open"
          description="Pick a file on the left to view or edit it."
        />
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Show the file pane" : "Hide the file pane"}
        >
          <Columns2 className="size-3.5" />
          {collapsed ? "Show files" : "Hide files"}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void cache.reload(navigatorMode === "tree" ? initialPath : cwd)}
          >
            <RotateCw className="size-3.5" /> Refresh
          </Button>
          {!readOnly && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || navigatorMode === "tree"}
                onClick={() => setNewFolderOpen(true)}
              >
                <FolderPlus className="size-3.5" /> New folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || navigatorMode === "tree"}
                onClick={() => uploadInputRef.current?.click()}
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
                  if (file) handleUpload(file);
                }}
              />
            </>
          )}
        </div>
      </div>

      {notice && (
        <p className="shrink-0 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}

      <SplitPane
        storageKey="cloudable-files-pane-width"
        left={navigator}
        right={content}
        leftCollapsed={collapsed}
      />

      <TextPromptDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        title="New folder"
        description={`Created in ${cwd} on the machine.`}
        label="Folder name"
        confirmLabel="Create"
        onConfirm={(name) => void createFolder(name)}
      />
      <TextPromptDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title={renaming ? `Rename ${renaming.name}` : "Rename"}
        label="New name"
        initialValue={renaming?.name ?? ""}
        confirmLabel="Rename"
        onConfirm={(name) => {
          if (renaming) void doRename(renaming, name);
          setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={pendingReplace !== null}
        onOpenChange={(next) => !next && setPendingReplace(null)}
        title="Replace the existing file?"
        description={
          pendingReplace
            ? `${pendingReplace.file.name} already exists on the machine. There is no undo — this interface has no delete, and the current contents will be gone.`
            : ""
        }
        confirmLabel="Replace"
        destructive
        onConfirm={() => {
          if (pendingReplace) void doUpload(pendingReplace.file, true);
          setPendingReplace(null);
        }}
      />
      <ConfirmDialog
        open={pendingDiscard !== null}
        onOpenChange={(next) => !next && setPendingDiscard(null)}
        title="Discard unsaved changes?"
        description={`Your edits to ${open?.path ?? "this file"} have not been written to the machine.`}
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          pendingDiscard?.();
          setPendingDiscard(null);
        }}
      />
    </div>
  );
}

function ModeTab({
  value,
  label,
  icon,
}: {
  value: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TabsTrigger value={value} className="px-2 py-1">
          {icon}
          <span className="sr-only">{label}</span>
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
