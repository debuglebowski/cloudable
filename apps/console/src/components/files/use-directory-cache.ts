/**
 * One directory cache shared by all three navigator modes.
 *
 * The tree needs many directories loaded at once (every expanded node); the table and the
 * compact list need exactly one. Both read the same `Map`, so switching modes never
 * re-fetches something already in hand, and expanding a tree node then switching to the
 * table shows that directory instantly.
 *
 * Every load is a real round trip over the tunnel to a process on the machine, so this
 * also de-duplicates: a path already loading is never requested twice.
 */
import type { FsEntry } from "@cloudable/contracts";
import { useCallback, useRef, useState } from "react";

import type { FileSession } from "./use-file-session";

export interface DirectoryState {
  entries: ReadonlyArray<FsEntry>;
  parent: string | null;
  truncated: boolean;
}

export interface DirectoryCache {
  /** Loaded directories, keyed by absolute path. */
  directories: ReadonlyMap<string, DirectoryState>;
  /** Paths with a load in flight — drives per-node spinners in the tree. */
  loading: ReadonlySet<string>;
  /** Paths whose last load failed, with a rendered reason. */
  errors: ReadonlyMap<string, string>;
  /** Loads a directory unless it is already cached. Returns the state, or null on failure. */
  load: (path: string) => Promise<DirectoryState | null>;
  /** Forces a reload, for after a write that changed a directory's contents. */
  reload: (path: string) => Promise<DirectoryState | null>;
  /** Drops a path so the next `load` refetches it. */
  invalidate: (path: string) => void;
}

export function useDirectoryCache(
  session: Pick<FileSession, "run">,
  describeFailure: (reason: string) => string,
): DirectoryCache {
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  // Refs, not state: `load` must see the CURRENT in-flight set and cache without being
  // re-created on every change, or each render would hand callers a different function and
  // the effects that call it would re-run.
  const inFlight = useRef(new Map<string, Promise<DirectoryState | null>>());
  const cacheRef = useRef(directories);
  cacheRef.current = directories;

  const fetchDirectory = useCallback(
    (path: string): Promise<DirectoryState | null> => {
      const existing = inFlight.current.get(path);
      if (existing) return existing;

      const promise = (async (): Promise<DirectoryState | null> => {
        setLoading((prev) => new Set(prev).add(path));
        try {
          const { result } = await session.run({ op: "list", path });
          if (!result.ok) {
            setErrors((prev) => new Map(prev).set(path, describeFailure(result.reason)));
            return null;
          }
          if (result.op !== "list") return null;
          const state: DirectoryState = {
            entries: result.entries,
            parent: result.parent,
            truncated: result.truncated,
          };
          // Keyed on the path the SERVER resolved, not the one asked for: it normalises
          // `..` and trailing slashes, and following a symlink lands somewhere else
          // entirely. Caching under the requested path would store the same directory
          // twice under two names.
          setDirectories((prev) => new Map(prev).set(result.path, state));
          setErrors((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
          return state;
        } finally {
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
          inFlight.current.delete(path);
        }
      })();

      inFlight.current.set(path, promise);
      return promise;
    },
    [session.run, describeFailure],
  );

  const load = useCallback(
    (path: string) => {
      const cached = cacheRef.current.get(path);
      if (cached) return Promise.resolve(cached);
      return fetchDirectory(path);
    },
    [fetchDirectory],
  );

  const invalidate = useCallback((path: string) => {
    setDirectories((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const reload = useCallback((path: string) => fetchDirectory(path), [fetchDirectory]);

  return { directories, loading, errors, load, reload, invalidate };
}
