import { afterEach, describe, expect, test } from "bun:test";
import { ImdsError, acquireManagedIdentityCredential } from "./managed-identity";

describe("acquireManagedIdentityCredential", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    process.env.IMDS_ENDPOINT = undefined;
  });

  test("returns the access token from a mock IMDS server", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        expect(req.headers.get("metadata")).toBe("true");
        expect(url.searchParams.get("api-version")).toBe("2018-02-01");
        expect(url.searchParams.get("resource")).toBe("https://management.azure.com/");
        return Response.json({ access_token: "fake-imds-token", expires_in: "3600" });
      },
    });
    process.env.IMDS_ENDPOINT = `http://localhost:${server.port}/metadata/identity/oauth2/token`;

    const token = await acquireManagedIdentityCredential();
    expect(token).toBe("fake-imds-token");
  });

  test("forwards a custom resource and user-assigned identity query params", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        expect(url.searchParams.get("resource")).toBe("https://custom.example/");
        expect(url.searchParams.get("client_id")).toBe("client-123");
        return Response.json({ access_token: "fake-token" });
      },
    });
    process.env.IMDS_ENDPOINT = `http://localhost:${server.port}/metadata/identity/oauth2/token`;

    const token = await acquireManagedIdentityCredential({
      resource: "https://custom.example/",
      identityQuery: { client_id: "client-123" },
    });
    expect(token).toBe("fake-token");
  });

  test("throws ImdsError on a non-2xx response", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    process.env.IMDS_ENDPOINT = `http://localhost:${server.port}/metadata/identity/oauth2/token`;

    await expect(acquireManagedIdentityCredential()).rejects.toBeInstanceOf(ImdsError);
  });

  test("throws ImdsError when the response has no access_token", async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ nope: true }) });
    process.env.IMDS_ENDPOINT = `http://localhost:${server.port}/metadata/identity/oauth2/token`;

    await expect(acquireManagedIdentityCredential()).rejects.toBeInstanceOf(ImdsError);
  });
});
