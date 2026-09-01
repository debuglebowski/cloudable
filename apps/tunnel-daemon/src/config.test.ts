import { expect, test } from "bun:test";

test("config loads from env without throwing", async () => {
  process.env.CONTROL_PLANE_URL = "https://control-plane.example.test";
  const { config } = await import("./config");
  expect(config.controlPlaneUrl).toBe("https://control-plane.example.test");
  expect(config.machineToken).toBe("");
});
