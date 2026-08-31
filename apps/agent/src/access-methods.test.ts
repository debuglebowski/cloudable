import { describe, expect, test } from "bun:test";
import type { ProcessLister } from "./access-methods";
import { listRunningAccessMethods } from "./access-methods";

function fakeLister(cmdlines: string[]): ProcessLister {
  return { listCommandLines: async () => cmdlines };
}

const originalPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("listRunningAccessMethods", () => {
  test("reports web_terminal when a ttyd process is running", async () => {
    setPlatform("linux");
    try {
      const lister = fakeLister(["/usr/bin/bash", "/usr/local/bin/ttyd -p 7681 bash"]);
      expect(await listRunningAccessMethods(lister)).toEqual(["web_terminal"]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("returns [] when no known access-method process is running", async () => {
    setPlatform("linux");
    try {
      const lister = fakeLister(["/usr/bin/bash", "/usr/sbin/sshd -D"]);
      expect(await listRunningAccessMethods(lister)).toEqual([]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("returns [] when the process list is empty", async () => {
    setPlatform("linux");
    try {
      expect(await listRunningAccessMethods(fakeLister([]))).toEqual([]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("returns [] rather than throwing when the /proc scan itself fails", async () => {
    setPlatform("linux");
    try {
      const lister: ProcessLister = {
        listCommandLines: async () => {
          throw new Error("permission denied");
        },
      };
      expect(await listRunningAccessMethods(lister)).toEqual([]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("returns [] and never calls the lister on a non-Linux platform", async () => {
    setPlatform("darwin");
    try {
      let called = false;
      const lister: ProcessLister = {
        listCommandLines: async () => {
          called = true;
          return ["ttyd"];
        },
      };
      expect(await listRunningAccessMethods(lister)).toEqual([]);
      expect(called).toBe(false);
    } finally {
      setPlatform(originalPlatform);
    }
  });
});
