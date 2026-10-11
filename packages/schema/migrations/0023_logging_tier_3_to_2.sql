-- Logging tier 3 (full command capture) was never built and is removed. Fold any
-- stored value of 3 into 2 at every scope so no stored value fails to parse.
-- 'logging_tier' is LOGGING_TIER_SETTING_KEY in @cloudable/contracts.
UPDATE "setting_values" SET "value" = '2'::jsonb, "updated_at" = now() WHERE "key" = 'logging_tier' AND "value" = '3'::jsonb;
