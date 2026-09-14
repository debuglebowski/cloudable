/**
 * CodeMirror 6, wired directly in a `useEffect` — the same shape
 * `components/terminal/terminal-session.tsx` uses for xterm, and for the same reason: this
 * app has no React wrapper libraries around imperative widgets, and a wrapper would add a
 * dependency whose only job is to re-do what twenty lines of effect already does.
 *
 * ## Why an editor library at all
 *
 * `CLAUDE.md` says never build code-server, and an earlier version of this component
 * claimed that having no syntax highlighting was what kept the file interface on the right
 * side of that line. That reading was too broad. The line is whether you can DEVELOP here:
 * extensions, a language server, a debugger, a project or workspace concept, running code,
 * forwarding ports. Line numbers and colour are not that — `nano` and `vim` both highlight,
 * and nobody calls them an IDE. What stays out, deliberately: multi-file tabs, search across
 * files, autocomplete, linting, anything that executes.
 *
 * ## Loading
 *
 * The module is imported lazily by `content-pane.tsx`, so the machines, compliance and audit
 * pages do not pay for it. That is worth doing here specifically because the console is one
 * unsplit bundle today, and this is the first dynamic import in the app.
 *
 * ## Theme
 *
 * Colours come from the console's own CSS variables (`index.css`, `--code-*`), never from a
 * CodeMirror theme package. That keeps the editor looking like part of the card it sits in,
 * and it means the `.dark` class switches the editor with no JavaScript and no tearing down
 * the `EditorView` — which a JS-side light/dark theme swap would otherwise require.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import { syntaxNameFor } from "./paths";

export interface CodeEditorProps {
  /** The file's path — decides syntax only. Changing it rebuilds the editor. */
  path: string;
  /** Initial document. Later changes to this prop are ignored; see the effect. */
  value: string;
  onChange: (next: string) => void;
  /** Ctrl/Cmd-S inside the editor. */
  onSave: () => void;
  readOnly?: boolean;
}

/** Turns the name `syntaxNameFor` resolved into the extension that implements it. The
 * filename-to-language decision lives in `paths.ts` so it can be tested without importing
 * any of these packages. */
function languageFor(path: string): Extension[] {
  switch (syntaxNameFor(path)) {
    case "json":
      return [json()];
    case "yaml":
      return [yaml()];
    case "shell":
      return [StreamLanguage.define(shell)];
    case "nginx":
      return [StreamLanguage.define(nginx)];
    case "properties":
      return [StreamLanguage.define(properties)];
    default:
      return [];
  }
}

/** Maps lezer highlight tags onto the `--code-*` tokens. */
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "hsl(var(--code-keyword))" },
  { tag: [t.string, t.special(t.string)], color: "hsl(var(--code-string))" },
  { tag: [t.number, t.bool, t.null], color: "hsl(var(--code-number))" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "hsl(var(--code-comment))",
    fontStyle: "italic",
  },
  {
    tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)],
    color: "hsl(var(--code-property))",
  },
  { tag: [t.invalid], color: "hsl(var(--code-invalid))" },
]);

/** Structural theme. Every colour is a token, so `.dark` switches it with no JS. */
const consoleTheme = EditorView.theme({
  "&": {
    fontSize: "12px",
    backgroundColor: "transparent",
    color: "hsl(var(--foreground))",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, 'IBM Plex Mono', ui-monospace, monospace)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "0.5rem 0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "hsl(var(--muted-foreground))",
    border: "none",
    paddingRight: "0.5rem",
  },
  ".cm-activeLine": { backgroundColor: "hsl(var(--code-active-line))" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "hsl(var(--foreground))" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "hsl(var(--code-selection))" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "hsl(var(--code-selection))" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--foreground))" },
  ".cm-selectionMatch": { backgroundColor: "hsl(var(--code-selection))" },
  // The search panel is CodeMirror's own DOM, so it needs dressing to not look pasted on.
  ".cm-panels": {
    backgroundColor: "hsl(var(--muted))",
    color: "hsl(var(--foreground))",
    borderTop: "1px solid hsl(var(--border))",
  },
  ".cm-panel input, .cm-panel button": {
    fontFamily: "inherit",
    fontSize: "12px",
    backgroundColor: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "0.375rem",
    padding: "0.125rem 0.375rem",
  },
});

export function CodeEditor({ path, value, onChange, onSave, readOnly = false }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Held in refs so the extension list below never needs rebuilding when a handler
  // identity changes — recreating the EditorView would drop cursor, scroll and undo.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // `value` is deliberately absent from the deps. It is the INITIAL document; after that
  // the editor owns the buffer and pushes changes out through `onChange`. Feeding the prop
  // back in on every keystroke would fight the editor for cursor position. Switching files
  // changes `path`, which is what legitimately rebuilds the document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          indentOnInput(),
          search({ top: true }),
          highlightSelectionMatches(),
          syntaxHighlighting(highlightStyle),
          consoleTheme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          placeholderExt(readOnly ? "" : "Empty file"),
          ...languageFor(path),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path, readOnly]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}

export default CodeEditor;
