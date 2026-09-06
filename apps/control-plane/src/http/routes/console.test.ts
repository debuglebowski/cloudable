import { describe, expect, test } from "bun:test";
import { HttpApiBuilder, HttpServer, HttpServerResponse } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { ConsoleStaticRouteLive, contentTypeFor, resolveWithinDir } from "./console";

describe("contentTypeFor", () => {
  test("looks up known Vite build output extensions", () => {
    expect(contentTypeFor("/dist/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/dist/assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/dist/assets/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/dist/favicon.svg")).toBe("image/svg+xml");
  });

  test("falls back to octet-stream for an unrecognized extension", () => {
    expect(contentTypeFor("/dist/whatever.bin")).toBe("application/octet-stream");
  });
});

describe("resolveWithinDir", () => {
  const dist = "/app/console-dist";

  test("resolves an ordinary asset path under the dist dir", () => {
    expect(resolveWithinDir(dist, "/assets/app.js")).toBe("/app/console-dist/assets/app.js");
  });

  test("resolves the root path to the dist dir itself", () => {
    expect(resolveWithinDir(dist, "/")).toBe(dist);
  });

  test("rejects a traversal attempt that would escape the dist dir", () => {
    expect(resolveWithinDir(dist, "/../../etc/passwd")).toBeNull();
  });

  test("rejects a traversal attempt disguised inside a deeper path", () => {
    expect(resolveWithinDir(dist, "/assets/../../../etc/passwd")).toBeNull();
  });
});

describe("GET * (console static route)", () => {
  // A literal route registered alongside the catch-all, standing in for the
  // real `/api/v1/*` endpoints — proves the underlying router (find-my-way)
  // always prefers a literal route over `*`, so real API routes are never
  // swallowed by this one regardless of registration order.
  const FakeApiRouteLive = HttpApiBuilder.Router.use((router) =>
    Effect.gen(function* () {
      yield* router.get("/api/v1/health", HttpServerResponse.json({ status: "ok" }));
    }),
  );

  const TestServerLive = HttpApiBuilder.Router.serve().pipe(
    Layer.provide(FakeApiRouteLive),
    Layer.provide(ConsoleStaticRouteLive),
    Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
  );

  const fetchFromTestServer = (pathname: string) =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag !== "TcpAddress") {
        return yield* Effect.die(new Error("expected a TCP address from the test server"));
      }
      const { port } = server.address;
      return yield* Effect.promise(() => fetch(`http://localhost:${port}${pathname}`));
    });

  test("a literal API route is never swallowed by the catch-all", async () => {
    const res = await Effect.runPromise(
      Effect.provide(fetchFromTestServer("/api/v1/health"), TestServerLive),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("an unmatched path falls through to the catch-all without erroring", async () => {
    // No real console build exists in this test environment (`config.consoleDistDir`
    // defaults to `/app/console-dist`, a container-only path — see config.ts), so this
    // exercises the "index.html also missing" branch: a clean 404, not a hang or a 500.
    const res = await Effect.runPromise(
      Effect.provide(fetchFromTestServer("/machines"), TestServerLive),
    );
    expect(res.status).toBe(404);
  });
});
