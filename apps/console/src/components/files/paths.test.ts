import { describe, expect, test } from "bun:test";

import type { FsEntry } from "@cloudable/contracts";

import { formatSize, joinPath, parentOf, sortEntries, syntaxNameFor } from "./paths";

const entry = (over: Partial<FsEntry> & { name: string }): FsEntry => ({
  type: "file",
  sizeBytes: 0,
  modifiedAt: "2026-01-01T00:00:00.000Z",
  mode: "rw-r--r--",
  symlinkTarget: null,
  ...over,
});

describe("joinPath / parentOf", () => {
  // The root is the case that breaks naive string concatenation: `"/" + "/" + name`
  // produces a double slash, and slicing a parent off "/etc" leaves an empty string.
  test("handles the filesystem root without doubling slashes", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home/cloudable", "notes.txt")).toBe("/home/cloudable/notes.txt");
  });

  test("the root has no parent, and a top-level directory's parent is the root", () => {
    expect(parentOf("/")).toBeNull();
    expect(parentOf("/etc")).toBe("/");
    expect(parentOf("/home/cloudable/notes.txt")).toBe("/home/cloudable");
  });
});

describe("syntaxNameFor", () => {
  test.each([
    ["/etc/app/config.json", "json"],
    ["/etc/app/config.yaml", "yaml"],
    ["/etc/app/config.yml", "yaml"],
    ["/home/cloudable/deploy.sh", "shell"],
    ["/home/cloudable/.bashrc", "shell"],
    ["/home/cloudable/.profile", "shell"],
    ["/etc/app/settings.ini", "properties"],
    ["/etc/app/.env", "properties"],
  ])("%s resolves to %s", (path, expected) => {
    expect(syntaxNameFor(path)).toBe(expected as never);
  });

  // `.conf` matches the generic properties branch too, so nginx has to be checked first or
  // the more specific language never wins.
  test("nginx.conf gets the nginx language, not the generic properties one", () => {
    expect(syntaxNameFor("/etc/nginx/nginx.conf")).toBe("nginx");
    expect(syntaxNameFor("/etc/redis/redis.conf")).toBe("properties");
  });

  test("an unknown or extensionless file gets no language rather than a wrong one", () => {
    expect(syntaxNameFor("/var/log/syslog")).toBeNull();
    expect(syntaxNameFor("/usr/bin/somebinary")).toBeNull();
    expect(syntaxNameFor("/home/cloudable/notes.txt")).toBeNull();
  });

  test("matching is case-insensitive", () => {
    expect(syntaxNameFor("/etc/Config.JSON")).toBe("json");
  });
});

describe("sortEntries", () => {
  const rows: FsEntry[] = [
    entry({ name: "zeta.txt", sizeBytes: 10, modifiedAt: "2026-03-01T00:00:00.000Z" }),
    entry({ name: "alpha.txt", sizeBytes: 900, modifiedAt: "2026-01-01T00:00:00.000Z" }),
    entry({ name: "src", type: "directory", sizeBytes: 4096 }),
  ];

  // The property that matters: whichever column is sorted, a directory never sorts into the
  // middle of the files. A directory's sizeBytes is its inode size, so sorting it among
  // files by size would place it somewhere meaningless.
  test.each(["name", "sizeBytes", "modifiedAt"] as const)(
    "directories stay first when sorting by %s, in both directions",
    (key) => {
      expect(sortEntries(rows, key, true)[0]?.type).toBe("directory");
      expect(sortEntries(rows, key, false)[0]?.type).toBe("directory");
    },
  );

  test("sorts files by name in both directions", () => {
    expect(sortEntries(rows, "name", true).map((r) => r.name)).toEqual([
      "src",
      "alpha.txt",
      "zeta.txt",
    ]);
    expect(sortEntries(rows, "name", false).map((r) => r.name)).toEqual([
      "src",
      "zeta.txt",
      "alpha.txt",
    ]);
  });

  test("sorts by size and by modified time", () => {
    expect(sortEntries(rows, "sizeBytes", true).map((r) => r.name)).toEqual([
      "src",
      "zeta.txt",
      "alpha.txt",
    ]);
    expect(sortEntries(rows, "modifiedAt", false).map((r) => r.name)).toEqual([
      "src",
      "zeta.txt",
      "alpha.txt",
    ]);
  });

  test("does not mutate the array it was given", () => {
    const original = [...rows];
    sortEntries(rows, "name", false);
    expect(rows).toEqual(original);
  });
});

describe("formatSize", () => {
  test("picks a unit a person can read", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
