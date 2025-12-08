import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, decimal, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Lot type enum for categorizing jewelry listings
export const lotTypeEnum = z.enum(['single', 'vintage_lot', 'estate', 'mixed']);
export type LotType = z.infer<typeof lotTypeEnum>;

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
  searchQueryId: varchar("search_query_id").references(() => searchQueries.id),
  foundAt: timestamp("found_at").notNull().default(sql`now()`),
  telegramSent: boolean("telegram_sent").notNull().default(false),
  expiresAt: timestamp("expires_at").notNull(),
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
