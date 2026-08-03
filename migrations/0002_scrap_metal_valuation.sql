-- JewelHuntrix scrap-metal valuation migration
-- Adds the columns that record WHICH valuation path scored a listing:
--   brand_path = valuable because of who made it
--   scrap_path = valuable because of what it's made of (weight x purity x spot)
--   both       = scored independently by each path, higher taken
--   unscored   = no signal either way (never a fabricated value)
--
-- Scrap figures are nullable on purpose: a hallmarked listing with no stated
-- weight, or with no live spot price, is stored WITHOUT a euro value.
-- Apply with `npm run db:push` (drizzle) or run this SQL directly.

ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "valuation_path" text DEFAULT 'unscored' NOT NULL;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "valuation_tag" text;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "valuation_score" integer;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "scrap_metal" text;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "scrap_purity_millesimal" integer;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "scrap_weight_grams" numeric(10, 2);
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "scrap_weight_confirmed" boolean DEFAULT false NOT NULL;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "melt_value_eur" numeric(10, 2);
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "underpriced_vs_melt" boolean DEFAULT false NOT NULL;

ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "valuation_path" text DEFAULT 'unscored' NOT NULL;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "valuation_tag" text;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "valuation_score" integer;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "scrap_metal" text;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "scrap_purity_millesimal" integer;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "scrap_weight_grams" numeric(10, 2);
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "scrap_weight_confirmed" boolean DEFAULT false NOT NULL;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "melt_value_eur" numeric(10, 2);
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "underpriced_vs_melt" boolean DEFAULT false NOT NULL;

-- Unmarked-metal suspicion path (path 3). No value column by design: that path
-- may never output a euro figure or a confirmed material claim, only a
-- suspicion level, the signals behind it, and a recommended next action.
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "suspicion_level" text;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "suspicion_signals" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "recommended_action" text;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "buy_candidate" boolean DEFAULT false NOT NULL;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "suppressed_reason" text;

ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "suspicion_level" text;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "suspicion_signals" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "recommended_action" text;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "buy_candidate" boolean DEFAULT false NOT NULL;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "suppressed_reason" text;

-- Findings are browsed by path in the dashboard.
CREATE INDEX IF NOT EXISTS "findings_valuation_path_idx" ON "findings" ("valuation_path");
