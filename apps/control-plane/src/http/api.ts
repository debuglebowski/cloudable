import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { MachinesGroup } from "./routes/machines";
import { AgentProtocolGroup } from "./routes/agent-protocol";

const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("check", "/api/v1/health").addSuccess(
    Schema.Struct({ status: Schema.Literal("ok") }),
  ),
);

export class Api extends HttpApi.make("cloudable")
  .add(HealthGroup)
  .add(MachinesGroup)
  .add(AgentProtocolGroup) {}
// Feature units: import your HttpApiGroup and append `.add(YourGroup)` to the chain above.
// Never reorder existing `.add()` calls.
