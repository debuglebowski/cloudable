import path from "node:path";
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { config } from "../../config";

/**
 * `HttpServerResponse.file` does no extension-based content-type inference
 * (confirmed by reading `@effect/platform`'s `internal/httpPlatform.ts` —
 * it only sets `etag`/`last-modified`), so every file this route serves
 * needs an explicit lookup or browsers get `application/octet-stream` and
 * refuse to execute `<script type="module">`. Covers what a Vite build
 * actually emits; anything unrecognized falls back to octet-stream.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Exported so `console.test.ts` can check the lookup directly, without going through a request. */
export const contentTypeFor = (filePath: string): string =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";

/**
 * Resolves `requestPath` against `baseDir`, or returns `null` if the result
 * would escape it (a `../`-style traversal attempt, encoded or not — the
 * caller decodes the raw request path before calling this). Exported so
 * `console.test.ts` can check the guard directly, since exercising it via a
 * real HTTP request would need `config.consoleDistDir` to point at a real,
 * populated directory, which isn't true in this test environment (see that
 * file's comment on why `config.ts`'s module-load-time-cached settings
 * can't be overridden per-test the way plain `process.env` reads can).
 */
export const resolveWithinDir = (baseDir: string, requestPath: string): string | null => {
  const resolved = path.resolve(baseDir, `.${requestPath}`);
  const isWithinDir = resolved === baseDir || resolved.startsWith(baseDir + path.sep);
  return isWithinDir ? resolved : null;
};

const indexHtmlPath = path.join(config.consoleDistDir, "index.html");

/**
 * The SPA-fallback response: served for any path that isn't a real file
 * under `consoleDistDir` (a client-side route like `/machines`, or a
 * rejected traversal attempt below) so `@tanstack/react-router` can take
 * over client-side. Falls through to a plain 404 if even `index.html` is
 * missing — e.g. this image was built/run without ever running
 * `vite build` for console.
 */
const serveIndexFallback = HttpServerResponse.file(indexHtmlPath, {
  contentType: contentTypeFor(indexHtmlPath),
}).pipe(Effect.catchAllCause(() => HttpServerResponse.text("not found", { status: 404 })));

/**
 * `GET *` — serves the console's static build (`config.consoleDistDir`,
 * `Dockerfile` copies `apps/console/dist` there) for every path this
 * server doesn't otherwise handle. Registered alongside the other raw
 * routes in `server.ts`; ordering relative to them doesn't matter — the
 * underlying router (`find-my-way`) always prefers a literal/static route
 * over a `*` wildcard, so `/api/*`/`/_internal/*` never fall through here.
 *
 * Unlike `binaries.ts`'s `:target` (a fixed allowlist, never touching the
 * filesystem with client input), this handler builds a real filesystem
 * path from the request path — the traversal guard below resolves it
 * against `consoleDistDir` and rejects (falls back to the SPA shell rather
 * than serving) anything that resolves outside it.
 */
export const ConsoleStaticRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    yield* router.get(
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = decodeURIComponent(request.url.split("?")[0] ?? "/");

        // A directory request (`/`, or any path ending in `/`) always means
        // "serve the app shell" — never attempt to stream a directory as a
        // file. Confirmed the hard way: Bun's `sendfile` throws
        // `EINVAL "does not support sending non-regular files"` for a
        // directory, which surfaces as an unhandled *defect*, not a typed
        // `PlatformError` — `Effect.catchAllCause` below is what actually
        // catches that class of failure; plain `Effect.catchAll` doesn't.
        if (pathname === "/" || pathname.endsWith("/")) {
          return yield* serveIndexFallback;
        }

        const resolved = resolveWithinDir(config.consoleDistDir, pathname);

        if (resolved === null) {
          return yield* serveIndexFallback;
        }

        return yield* HttpServerResponse.file(resolved, {
          contentType: contentTypeFor(resolved),
        }).pipe(Effect.catchAllCause(() => serveIndexFallback));
      }),
    );
  }),
);
