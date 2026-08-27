import { expect, test } from "bun:test";

test("config loads from env without throwing", async () => {
  process.env.CLOUDABLE_API_URL = "https://api.cloudable.example.test";
  const { config } = await import("./config");
  expect(config.apiUrl).toBe("https://api.cloudable.example.test");
});
