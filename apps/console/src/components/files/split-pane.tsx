/**
 * A two-pane split with a draggable divider, and the width persisted per browser.
 *
 * Hand-rolled rather than pulling in `react-resizable-panels`. The console has no split
 * layout anywhere today, so a dependency would be carried for one screen, and the whole
 * behaviour is a pointer-move listener and a clamp.
 *
 * Resizable rather than a fixed width because the left pane's three modes want genuinely
 * different widths: a tree is comfortable at ~18rem, the table's four columns are cramped
 * under ~30rem. Rather than guess per mode, let it be dragged and remember.
 *
 * Uses pointer capture, so a fast drag that leaves the divider still tracks — a plain
 * mousemove on the element drops the drag the moment the cursor outruns it.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const MIN_PX = 200;
const MAX_PX = 720;

function readStored(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? Math.min(MAX_PX, Math.max(MIN_PX, parsed)) : fallback;
  } catch {
    // Private windows and blocked site data both throw on access rather than returning
    // null, so every read of storage here is guarded.
    return fallback;
  }
}

export interface SplitPaneProps {
  storageKey: string;
  defaultWidth?: number;
  left: ReactNode;
  right: ReactNode;
  /** Collapses the left pane entirely, for giving the editor the full width. */
  leftCollapsed?: boolean;
}

export function SplitPane({
  storageKey,
  defaultWidth = 288,
  left,
  right,
  leftCollapsed = false,
}: SplitPaneProps) {
  const [width, setWidth] = useState(() => readStored(storageKey, defaultWidth));
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {}
  }, [storageKey, width]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const container = containerRef.current;
    if (!container) return;
    const next = event.clientX - container.getBoundingClientRect().left;
    setWidth(Math.min(MAX_PX, Math.max(MIN_PX, next)));
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 gap-0">
      {!leftCollapsed && (
        <>
          <div className="flex min-h-0 shrink-0 flex-col" style={{ width: `${width}px` }}>
            {left}
          </div>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize the file pane"
            aria-valuenow={width}
            aria-valuemin={MIN_PX}
            aria-valuemax={MAX_PX}
            className={cn(
              "group relative w-2 shrink-0 cursor-col-resize",
              // The hit area is 8px but the visible line is 1px, so it is easy to grab
              // without looking like a chunky gutter.
              "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border",
              "hover:before:bg-ring focus-visible:outline-none focus-visible:before:bg-ring",
              dragging && "before:bg-ring",
            )}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              setDragging(false);
            }}
            onDoubleClick={() => setWidth(defaultWidth)}
            // A drag handle that only responds to a pointer is unusable without one.
            // Arrows nudge, Home/End jump to the bounds, Enter restores the default —
            // the same set a native `separator` widget is expected to answer.
            onKeyDown={(event) => {
              const step = event.shiftKey ? 48 : 12;
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setWidth((w) => Math.max(MIN_PX, w - step));
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setWidth((w) => Math.min(MAX_PX, w + step));
              } else if (event.key === "Home") {
                event.preventDefault();
                setWidth(MIN_PX);
              } else if (event.key === "End") {
                event.preventDefault();
                setWidth(MAX_PX);
              } else if (event.key === "Enter") {
                event.preventDefault();
                setWidth(defaultWidth);
              }
            }}
          />
        </>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{right}</div>
    </div>
  );
}
