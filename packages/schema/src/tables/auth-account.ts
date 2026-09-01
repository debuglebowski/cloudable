import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { authUser } from "./auth-user";

/**
 * BetterAuth's own `account` table — one row per credential/provider a user
 * has linked (here, just the email+password credential, since only
 * `emailAndPassword` is enabled). Field set and the `(issuer, accountId)`
 * unique index both straight from `getSchema()`, not assumed from generic
 * BetterAuth docs (which usually show `providerId`+`accountId` — this
 * installed version's actual index is on `issuer`, not `providerId`).
 */
export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("account_issuer_account_id_uidx").on(table.issuer, table.accountId)],
);
