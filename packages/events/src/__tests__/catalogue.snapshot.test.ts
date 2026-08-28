import { expect, test } from "bun:test";
import { EVENT_TYPES } from "../catalogue";

test("event type catalogue is append-only", () => {
  expect([...EVENT_TYPES].sort()).toMatchSnapshot();
});
