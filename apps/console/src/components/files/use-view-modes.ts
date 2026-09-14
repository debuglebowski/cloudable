/**
 * The chosen navigator and content modes, remembered per browser.
 *
 * A view preference is exactly the kind of state `localStorage` is for: it is per-person
 * and per-device, nothing else needs to read it, and losing it costs one click. It is
 * deliberately NOT a URL param or server-side setting — the session page is reached by a
 * freshly minted session id every time, so a shareable URL would not carry it anywhere
 * useful, and an org-level setting would be policy, which this is not.
 *
 * Every access is guarded: a private window or blocked site data throws on read rather
 * than returning null.
 */
import { useCallback, useEffect, useState } from "react";

import type { ContentMode } from "./content-pane";

export type NavigatorMode = "tree" | "table" | "compact";

const NAVIGATOR_KEY = "cloudable-files-navigator-mode";
const CONTENT_KEY = "cloudable-files-content-mode";

const NAVIGATOR_MODES: ReadonlyArray<NavigatorMode> = ["tree", "table", "compact"];
const CONTENT_MODES: ReadonlyArray<ContentMode> = ["code", "plain"];

function read<T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key) as T | null;
    return raw && allowed.includes(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function usePersistedMode<T extends string>(
  key: string,
  allowed: ReadonlyArray<T>,
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, allowed, fallback));
  useEffect(() => {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  }, [key, value]);
  return [value, useCallback((next: T) => setValue(next), [])];
}

export function useViewModes() {
  // Tree by default: it is the mode that makes the left pane worth docking, and it answers
  // "where am I" without a round trip per level the way breadcrumb navigation does.
  const [navigatorMode, setNavigatorMode] = usePersistedMode<NavigatorMode>(
    NAVIGATOR_KEY,
    NAVIGATOR_MODES,
    "tree",
  );
  const [contentMode, setContentMode] = usePersistedMode<ContentMode>(
    CONTENT_KEY,
    CONTENT_MODES,
    "code",
  );
  return { navigatorMode, setNavigatorMode, contentMode, setContentMode };
}
