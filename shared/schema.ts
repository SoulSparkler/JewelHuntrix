import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, decimal, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Lot type enum for categorizing jewelry listings
export const lotTypeEnum = z.enum(['single', 'vintage_lot', 'estate', 'mixed']);
export type LotType = z.infer<typeof lotTypeEnum>;

// Which valuation path produced a listing's score. `brand_path` = valuable
// because of who made it; `scrap_path` = valuable because of what it's made of;
// `both` = scored independently by each and the higher taken; `unscored` = no
// signal either way (never a fabricated value).
export const valuationPathEnum = z.enum([
  'brand_path',
  'scrap_path',
  'both',
  'unmarked_suspicion_path',
  'unscored',
]);
export type ValuationPathValue = z.infer<typeof valuationPathEnum>;

// Unmarked-metal path output. This path NEVER produces a value or a confirmed
// material claim — only how suspicious the piece looks and what to do next.
export const suspicionLevelEnum = z.enum(['low', 'medium', 'high']);
export type SuspicionLevelValue = z.infer<typeof suspicionLevelEnum>;

// What actually happened once a piece was in hand. Nothing captured this
// before, so unmarked_suspicion_path's weights had no way to be checked
// against reality — they were a starting heuristic per the handoff, never
// validated. Recording outcomes is what would eventually let them be retrained.
export const outcomeStatusEnum = z.enum([
  'confirmed_precious',   // hallmark found in hand, or tested precious
  'confirmed_costume',    // tested / magnet-failed / turned out base metal
  'not_purchased',        // never bought, so never confirmed either way
]);
export type OutcomeStatusValue = z.infer<typeof outcomeStatusEnum>;

export const searchQueries = pgTable("search_queries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vintedUrl: text("vinted_url").notNull(),
  searchLabel: text("search_label").notNull(),
  scanFrequencyHours: integer("scan_frequency_hours").notNull().default(3),
  confidenceThreshold: integer("confidence_threshold").notNull().default(70),
  isActive: boolean("is_active").notNull().default(true),
  lastScannedAt: timestamp("last_scanned_at"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const analyzedListings = pgTable("analyzed_listings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  listingId: text("listing_id").notNull().unique(),
  searchQueryId: varchar("search_query_id").references(() => searchQueries.id),
  analyzedAt: timestamp("analyzed_at").notNull().default(sql`now()`),
  confidenceScore: integer("confidence_score").notNull(),
  isValuable: boolean("is_valuable").notNull(),
  lotType: text("lot_type").notNull().default("single"),
});

/**
 * Columns shared by findings and manual scans that record HOW a listing earned
 * its score. Without these the UI cannot tell "valuable because of who made it"
 * apart from "valuable because of what it's made of".
 *
 * Scrap figures are nullable on purpose: a hallmarked listing with no stated
 * weight, or with no live spot price, is surfaced WITHOUT a euro value rather
 * than with a guessed one.
 */
const valuationColumns = {
  valuationPath: text("valuation_path").notNull().default("unscored"),
  valuationTag: text("valuation_tag"),
  valuationScore: integer("valuation_score"),
  scrapMetal: text("scrap_metal"),
  /** Fineness in parts per thousand, e.g. 925 for sterling. */
  scrapPurityMillesimal: integer("scrap_purity_millesimal"),
  scrapWeightGrams: decimal("scrap_weight_grams", { precision: 10, scale: 2 }),
  /** Only true when the seller stated the weight — never for an estimate. */
  scrapWeightConfirmed: boolean("scrap_weight_confirmed").notNull().default(false),
  meltValueEur: decimal("melt_value_eur", { precision: 10, scale: 2 }),
  /** Requires a confirmed weight and a fresh spot price to ever be true. */
  underpricedVsMelt: boolean("underpriced_vs_melt").notNull().default(false),

  // Unmarked-metal suspicion path. Deliberately has no value column: that path
  // may never output a euro figure or a confirmed material claim.
  suspicionLevel: text("suspicion_level"),
  suspicionSignals: jsonb("suspicion_signals").$type<string[]>().default([]),
  recommendedAction: text("recommended_action"),

  /** False when a path's risk budget (or confidence bar) rules out buying. */
  buyCandidate: boolean("buy_candidate").notNull().default(false),
  suppressedReason: text("suppressed_reason"),

  // Ground truth, filled in by hand after the piece is (or isn't) in hand.
  // Null means "not recorded yet" — the overwhelming majority of rows, always.
  outcomeStatus: text("outcome_status"),
  outcomeNote: text("outcome_note"),
  outcomeRecordedAt: timestamp("outcome_recorded_at"),
};

export const findings = pgTable("findings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  listingId: text("listing_id").notNull(),
  listingUrl: text("listing_url").notNull(),
  listingTitle: text("listing_title").notNull(),
  price: text("price").notNull(),
  confidenceScore: integer("confidence_score").notNull(),
  aiReasoning: text("ai_reasoning").notNull(),
  detectedMaterials: jsonb("detected_materials").notNull().$type<string[]>(),
  reasons: jsonb("reasons").notNull().$type<string[]>(),
  isValuable: boolean("is_valuable").notNull().default(false),
  lotType: text("lot_type").notNull().default("single"),
  sellerCountry: text("seller_country"),
  searchQueryId: varchar("search_query_id").references(() => searchQueries.id),
  foundAt: timestamp("found_at").notNull().default(sql`now()`),
  telegramSent: boolean("telegram_sent").notNull().default(false),
  expiresAt: timestamp("expires_at").notNull(),
  lastScannedAt: timestamp("last_scanned_at"),
  scanIntervalMinutes: integer("scan_interval_minutes").notNull().default(90),
  ...valuationColumns,
});

// Tracks scan health for the 24/7 reliability / heartbeat requirement.
// A single row (id = "global") is upserted after every scan run.
export const scanState = pgTable("scan_state", {
  id: varchar("id").primaryKey().default("global"),
  lastRunAt: timestamp("last_run_at"),
  lastSuccessAt: timestamp("last_success_at"),
  lastError: text("last_error"),
  lastListingsChecked: integer("last_listings_checked").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const manualScans = pgTable("manual_scans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  listingUrl: text("listing_url").notNull(),
  listingTitle: text("listing_title").notNull(),
  confidenceScore: integer("confidence_score").notNull(),
  aiReasoning: text("ai_reasoning").notNull(),
  detectedMaterials: jsonb("detected_materials").notNull().$type<string[]>(),
  reasons: jsonb("reasons").notNull().$type<string[]>(),
  isValuable: boolean("is_valuable").notNull().default(false),
  lotType: text("lot_type").notNull().default("single"),
  price: text("price"),
  scannedAt: timestamp("scanned_at").notNull().default(sql`now()`),
  ...valuationColumns,
});

export const insertSearchQuerySchema = createInsertSchema(searchQueries).omit({
  id: true,
  createdAt: true,
  lastScannedAt: true,
});

export const insertAnalyzedListingSchema = createInsertSchema(analyzedListings).omit({
  id: true,
  analyzedAt: true,
});

export const insertFindingSchema = createInsertSchema(findings).omit({
  id: true,
  foundAt: true,
});

export const insertManualScanSchema = createInsertSchema(manualScans).omit({
  id: true,
  scannedAt: true,
});

export type SearchQuery = typeof searchQueries.$inferSelect;
export type InsertSearchQuery = z.infer<typeof insertSearchQuerySchema>;

export type AnalyzedListing = typeof analyzedListings.$inferSelect;
export type InsertAnalyzedListing = z.infer<typeof insertAnalyzedListingSchema>;

export type Finding = typeof findings.$inferSelect;
export type InsertFinding = z.infer<typeof insertFindingSchema>;

export type ManualScan = typeof manualScans.$inferSelect;
export type InsertManualScan = z.infer<typeof insertManualScanSchema>;

export type ScanState = typeof scanState.$inferSelect;
