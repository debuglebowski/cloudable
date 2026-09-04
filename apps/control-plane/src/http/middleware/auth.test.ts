import { describe, expect, test } from "bun:test";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpServer,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { AuthenticationRequired } from "./auth";

/**
 * Regression coverage for the bug where every `CurrentUserAuthentication`
 * failure (missing/expired session, no matching `people` row) surfaced to
 * clients as HTTP 500 instead of 401: `AuthenticationRequired` is a
 * middleware failure, not an endpoint's own `.addError(Err, { status })`, so
 * it has no per-endpoint call site to carry the status — it must be
 * annotated on the error schema itself, or `@effect/platform` falls back to
 * its 500 default for any unannotated error (`HttpApiSchema.getStatusError`).
 */
describe("AuthenticationRequired HTTP status", () => {
  test("is annotated 401, not the platform's unannotated-error default of 500", () => {
    expect(HttpApiSchema.getStatusError(AuthenticationRequired)).toBe(401);
  });

  test("a real request rejected by the auth middleware receives HTTP 401, not 500", async () => {
    // A minimal stand-in for `CurrentUserAuthentication` — same failure type,
    // unconditionally rejecting, so this exercises the real HTTP encoding
    // pipeline for `AuthenticationRequired` without needing a live BetterAuth
    // session or database (see `CurrentUserAuthenticationLive` for the real
    // thing).
    class TestAuthMiddleware extends HttpApiMiddleware.Tag<TestAuthMiddleware>()(
      "TestAuthMiddleware",
      { failure: AuthenticationRequired },
    ) {}

    const TestGroup = HttpApiGroup.make("test")
      .add(HttpApiEndpoint.get("ping", "/ping").addSuccess(Schema.Struct({ ok: Schema.Boolean })))
      .middleware(TestAuthMiddleware);

    class TestApi extends HttpApi.make("test-api").add(TestGroup) {}

    const TestAuthMiddlewareLive = Layer.succeed(
      TestAuthMiddleware,
      Effect.fail(new AuthenticationRequired({ reason: "no_session" })),
    );

    const TestGroupLive = HttpApiBuilder.group(TestApi, "test", (handlers) =>
      handlers.handle("ping", () => Effect.succeed({ ok: true })),
    );

    // `Layer.provideMerge` (not `provide`) for the server layer, same reasoning as
    // `agent-wake.test.ts`'s `TestServerLive`: it keeps `HttpServer.HttpServer` visible
    // in `program`'s own environment below, instead of `HttpApiBuilder.serve()`
    // consuming and hiding it.
    const TestServerLive = HttpApiBuilder.serve().pipe(
      Layer.provide(HttpApiBuilder.api(TestApi).pipe(Layer.provide(TestGroupLive))),
      Layer.provide(TestAuthMiddlewareLive),
      Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
    );

    const program = Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag !== "TcpAddress") {
        return yield* Effect.die(new Error("expected a TCP address from the test server"));
      }
      const { port } = server.address;
      const res = yield* Effect.promise(() => fetch(`http://localhost:${port}/ping`));
      const body = yield* Effect.promise(() => res.json());
      return { status: res.status, body };
    });

    const { status, body } = await Effect.runPromise(Effect.provide(program, TestServerLive));

    expect(status).toBe(401);
    expect(body).toMatchObject({ _tag: "AuthenticationRequired", reason: "no_session" });
  });
});
