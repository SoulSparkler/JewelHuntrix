import { eq, desc, lt, and, sql } from "drizzle-orm";
import { db } from "./db";
import {
  searchQueries,
  analyzedListings,
  findings,
  manualScans,
  scanState,
  type SearchQuery,
  type InsertSearchQuery,
  type AnalyzedListing,
  type InsertAnalyzedListing,
  type Finding,
  type InsertFinding,
  type ManualScan,
  type InsertManualScan,
  type ScanState,
} from "../shared/schema";

export interface IStorage {
  // Search Queries
  getSearchQueries(): Promise<SearchQuery[]>;
  getSearchQuery(id: string): Promise<SearchQuery | undefined>;
  createSearchQuery(query: InsertSearchQuery): Promise<SearchQuery>;
  updateSearchQuery(id: string, query: Partial<InsertSearchQuery>): Promise<SearchQuery | undefined>;
  deleteSearchQuery(id: string): Promise<boolean>;
  updateLastScanned(id: string): Promise<void>;

  // Analyzed Listings
  getAnalyzedListing(listingId: string): Promise<AnalyzedListing | undefined>;
  createAnalyzedListing(listing: InsertAnalyzedListing): Promise<AnalyzedListing>;

  // Findings
  getFindings(): Promise<Finding[]>;
  getFinding(id: string): Promise<Finding | undefined>;
  getFindingByListingUrl(listingUrl: string): Promise<Finding | undefined>;
  createFinding(finding: InsertFinding): Promise<Finding>;
  deleteFinding(id: string): Promise<boolean>;
  deleteExpiredFindings(): Promise<void>;

  // Manual Scans
  getManualScans(): Promise<ManualScan[]>;
  createManualScan(scan: InsertManualScan): Promise<ManualScan>;
  deleteManualScan(id: string): Promise<boolean>;

  // Scan health / retention
  cleanupOldAnalyzedListings(days: number): Promise<void>;
  getScanState(): Promise<ScanState | undefined>;
  markScanStarted(): Promise<void>;
  markScanFinished(opts: { success: boolean; listingsChecked: number; error?: string }): Promise<void>;
}

export class PostgresStorage implements IStorage {
  // Search Queries
  async getSearchQueries(): Promise<SearchQuery[]> {
    return await db.select().from(searchQueries).orderBy(desc(searchQueries.createdAt));
  }

  async getSearchQuery(id: string): Promise<SearchQuery | undefined> {
    const results = await db.select().from(searchQueries).where(eq(searchQueries.id, id));
    return results[0];
  }

  async createSearchQuery(insertQuery: InsertSearchQuery): Promise<SearchQuery> {
    const results = await db.insert(searchQueries).values({
      vintedUrl: insertQuery.vintedUrl,
      searchLabel: insertQuery.searchLabel,
      scanFrequencyHours: insertQuery.scanFrequencyHours ?? 3,
      confidenceThreshold: insertQuery.confidenceThreshold ?? 70,
      isActive: insertQuery.isActive ?? true,
    }).returning();
    return results[0];
  }

  async updateSearchQuery(id: string, updates: Partial<InsertSearchQuery>): Promise<SearchQuery | undefined> {
    const results = await db.update(searchQueries)
      .set(updates)
      .where(eq(searchQueries.id, id))
      .returning();
    return results[0];
  }

  async deleteSearchQuery(id: string): Promise<boolean> {
    const results = await db.delete(searchQueries).where(eq(searchQueries.id, id)).returning();
    return results.length > 0;
  }

  async updateLastScanned(id: string): Promise<void> {
    await db.update(searchQueries)
      .set({ lastScannedAt: new Date() })
      .where(eq(searchQueries.id, id));
  }

  // Analyzed Listings
  async getAnalyzedListing(listingId: string): Promise<AnalyzedListing | undefined> {
    const results = await db.select().from(analyzedListings).where(eq(analyzedListings.listingId, listingId));
    return results[0];
  }

  async createAnalyzedListing(insertListing: InsertAnalyzedListing): Promise<AnalyzedListing> {
    const results = await db.insert(analyzedListings).values({
      listingId: insertListing.listingId,
      searchQueryId: insertListing.searchQueryId ?? null,
      confidenceScore: insertListing.confidenceScore,
      isValuable: insertListing.isValuable,
      lotType: insertListing.lotType ?? 'single',
    }).returning();
    return results[0];
  }

  // Findings
  async getFindings(): Promise<Finding[]> {
    const now = new Date();
    return await db.select()
      .from(findings)
      .where(lt(findings.expiresAt, now))
      .orderBy(desc(findings.foundAt));
  }

  async getFinding(id: string): Promise<Finding | undefined> {
    const results = await db.select().from(findings).where(eq(findings.id, id));
    return results[0];
  }

  async getFindingByListingUrl(listingUrl: string): Promise<Finding | undefined> {
    const results = await db.select().from(findings).where(eq(findings.listingUrl, listingUrl));
    return results[0];
  }

  async createFinding(insertFinding: InsertFinding): Promise<Finding> {
    const results = await db.insert(findings).values({
      listingId: insertFinding.listingId,
      listingUrl: insertFinding.listingUrl,
      listingTitle: insertFinding.listingTitle,
      price: insertFinding.price,
      confidenceScore: insertFinding.confidenceScore,
      aiReasoning: insertFinding.aiReasoning,
      detectedMaterials: insertFinding.detectedMaterials,
      reasons: insertFinding.reasons,
      isValuable: insertFinding.isValuable,
      lotType: insertFinding.lotType ?? 'single',
      sellerCountry: (insertFinding as any).sellerCountry ?? null,
      searchQueryId: insertFinding.searchQueryId ?? null,
      telegramSent: insertFinding.telegramSent ?? false,
      expiresAt: insertFinding.expiresAt,
    } as any).returning();
    return results[0];
  }

  async deleteFinding(id: string): Promise<boolean> {
    const results = await db.delete(findings).where(eq(findings.id, id)).returning();
    return results.length > 0;
  }

  async deleteExpiredFindings(): Promise<void> {
    const now = new Date();
    await db.delete(findings).where(lt(findings.expiresAt, now));
  }

  // Manual Scans
  async getManualScans(): Promise<ManualScan[]> {
    return await db.select()
      .from(manualScans)
      .orderBy(desc(manualScans.scannedAt));
  }

  async createManualScan(insertScan: InsertManualScan): Promise<ManualScan> {
    const results = await db.insert(manualScans).values({
      listingUrl: insertScan.listingUrl,
      listingTitle: insertScan.listingTitle,
      confidenceScore: insertScan.confidenceScore,
      aiReasoning: insertScan.aiReasoning,
      detectedMaterials: insertScan.detectedMaterials,
      reasons: insertScan.reasons,
      isValuable: insertScan.isValuable,
      lotType: insertScan.lotType ?? 'single',
      price: insertScan.price ?? null,
    } as any).returning();
    return results[0];
  }

  async deleteManualScan(id: string): Promise<boolean> {
    const results = await db.delete(manualScans).where(eq(manualScans.id, id)).returning();
    return results.length > 0;
  }

  // Scan health / retention
  async cleanupOldAnalyzedListings(days: number): Promise<void> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await db.delete(analyzedListings).where(lt(analyzedListings.analyzedAt, cutoff));
  }

  async getScanState(): Promise<ScanState | undefined> {
    const rows = await db.select().from(scanState).where(eq(scanState.id, "global"));
    return rows[0];
  }

  async markScanStarted(): Promise<void> {
    const now = new Date();
    await db
      .insert(scanState)
      .values({ id: "global", lastRunAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: scanState.id, set: { lastRunAt: now, updatedAt: now } });
  }

  async markScanFinished(opts: { success: boolean; listingsChecked: number; error?: string }): Promise<void> {
    const now = new Date();
    const base = {
      lastListingsChecked: opts.listingsChecked,
      lastError: opts.success ? null : opts.error ?? "unknown error",
      updatedAt: now,
    };
    await db
      .insert(scanState)
      .values({
        id: "global",
        ...base,
        lastSuccessAt: opts.success ? now : null,
        consecutiveFailures: opts.success ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: scanState.id,
        set: opts.success
          ? { ...base, lastSuccessAt: now, consecutiveFailures: 0 }
          : { ...base, consecutiveFailures: sql`${scanState.consecutiveFailures} + 1` },
      });
  }
}

// Export singleton instance
export const storage = new PostgresStorage();
