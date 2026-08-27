import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { Api } from "../api";

export const HealthLive = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("check", () => Effect.succeed({ status: "ok" as const })),
);
