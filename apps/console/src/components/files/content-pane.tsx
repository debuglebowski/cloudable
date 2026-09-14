/**
 * The right-hand pane: one open file, shown in the chosen content mode.
 *
 * Two modes, both editable and both writing to the same buffer, so switching between them
 * never loses work:
 *
 *   code   CodeMirror — line numbers, in-file search, syntax for JSON/YAML/shell/ini.
 *   plain  A monospace textarea. Zero dependencies and the honest fallback: if the editor
 *          chunk fails to load, or a file is better read raw, this always works.
 *
 * The editor is behind `React.lazy`, which is the app's first dynamic import. The console
 * ships as one unsplit bundle today, so without this every page would carry CodeMirror to
 * render a machines table. The load is invisible in practice — it starts while the file is
 * still being read over the tunnel.
 */
import { Suspense, lazy } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export type ContentMode = "code" | "plain";

const CodeEditor = lazy(() => import("./code-editor").then((m) => ({ default: m.CodeEditor })));

export interface ContentPaneProps {
  mode: ContentMode;
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}

export function ContentPane({
  mode,
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
}: ContentPaneProps) {
  if (mode === "plain") {
    return (
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            onSave();
          }
        }}
        readOnly={readOnly}
        spellCheck={false}
        // `resize-none` and `h-full`: the pane owns the height, so the textarea fills it
        // rather than growing the page the way the old single-column layout did.
        className="h-full min-h-0 resize-none border-0 font-mono text-xs focus-visible:ring-0"
      />
    );
  }

  return (
    <Suspense
      fallback={
        <div className="space-y-2 p-3">
          {["a", "b", "c", "d", "e", "f"].map((key) => (
            <Skeleton key={key} className="h-3 w-full" />
          ))}
        </div>
      }
    >
      <CodeEditor
        path={path}
        value={value}
        onChange={onChange}
        onSave={onSave}
        readOnly={readOnly}
      />
    </Suspense>
  );
}
