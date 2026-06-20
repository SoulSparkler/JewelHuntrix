-- JewelHuntrix serverless migration
-- Adds the scan_state heartbeat table and seller_country on findings.
-- Apply with `npm run db:push` (drizzle) or run this SQL directly.

CREATE TABLE IF NOT EXISTS "scan_state" (
    "id" varchar PRIMARY KEY DEFAULT 'global' NOT NULL,
    "last_run_at" timestamp,
    "last_success_at" timestamp,
    "last_error" text,
    "last_listings_checked" integer DEFAULT 0 NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "seller_country" text;
