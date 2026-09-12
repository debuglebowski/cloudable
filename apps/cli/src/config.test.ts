import { expect, test } from "bun:test";

test("config loads from env without throwing", async () => {
  process.env.CLOUDABLE_API_URL = "https://api.cloudable.example.test";
  const { config } = await import("./config");
  expect(config.apiUrl).toBe("https://api.cloudable.example.test");
});

test("a missing API URL names the variable and says what to set it to", async () => {
  process.env.CLOUDABLE_API_URL = "";
  const { config } = await import("./config");
  expect(() => config.apiUrl).toThrow(/CLOUDABLE_API_URL/);
  expect(() => config.apiUrl).toThrow(/export CLOUDABLE_API_URL=/);
});
