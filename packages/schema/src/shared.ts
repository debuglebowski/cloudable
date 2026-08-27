import { pgEnum } from "drizzle-orm/pg-core";

/** Which scope level a setting value (or its resolved winner) came from. */
export const sourceEnum = pgEnum("setting_source", ["org", "template", "machine"]);

/** Who/what performed an action recorded on an event. */
export const actorTypeEnum = pgEnum("actor_type", ["person", "system", "agent", "idp"]);
