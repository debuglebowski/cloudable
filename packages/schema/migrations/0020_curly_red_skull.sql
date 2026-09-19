ALTER TABLE "snapshots" ALTER COLUMN "contains_config" SET DEFAULT false;--> statement-breakpoint
-- Correct every existing row, not just the default.
--
-- `contains_config` was hardcoded `true` by `createSnapshot` while nothing ever captured
-- configuration, so every snapshot in every deployment claims to hold a machine's desired
-- state that was never recorded anywhere. The console and CLI render that claim directly
-- ("data+config"), and `mode: "config"` restores refuse — so the product currently says a
-- snapshot holds configuration AND that you cannot restore configuration from it.
--
-- This is a correction of a false value, not a rewrite of history: no snapshot has ever
-- held configuration, so `false` is what these rows always should have said. Unconditional
-- because there is no row anywhere for which `true` was ever accurate.
UPDATE "snapshots" SET "contains_config" = false;
