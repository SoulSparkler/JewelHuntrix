-- Outcome tracking: what actually happened once a piece was in hand.
-- Nothing captured this before, so unmarked_suspicion_path's weights had no
-- way to be checked against reality. This is the field the handoff pointed at
-- when it said the weights "have not been independently validated" and asked
-- to flag it if a feedback loop got built.
-- Apply with `npm run db:push` (drizzle) or run this SQL directly.

ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "outcome_status" text;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "outcome_note" text;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "outcome_recorded_at" timestamp;

ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "outcome_status" text;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "outcome_note" text;
ALTER TABLE "manual_scans" ADD COLUMN IF NOT EXISTS "outcome_recorded_at" timestamp;
