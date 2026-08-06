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
  markFindingTelegramSent(id: string): Promise<void>;
  deleteFinding(id: string): Promise<boolean>;
  deleteExpiredFindings(): Promise<void>;

  // Manual Scans
  getManualScans(): Promise<ManualScan[]>;
  createManualScan(scan: InsertManualScan): Promise<ManualScan>;
  deleteManualScan(id: string): Promise<boolean>;

  // Outcomes — ground truth recorded once a piece is in hand, so the
  // unmarked-suspicion path's weights can eventually be checked against reality.
  recordFindingOutcome(id: string, status: string, note?: string): Promise<Finding | undefined>;
  recordManualScanOutcome(id: string, status: string, note?: string): Promise<ManualScan | undefined>;

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
      .where(sql`${findings.expiresAt} > ${now}`)
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
    // Spread first so every column on the findings table — including the
    // valuation-path fields added after this function was written — reaches
    // the insert. A hand-listed field set silently drops whatever it forgets;
    // that's exactly how the valuation columns were going missing before this.
    const results = await db.insert(findings).values({
      ...insertFinding,
      lotType: insertFinding.lotType ?? 'single',
      sellerCountry: (insertFinding as any).sellerCountry ?? null,
      searchQueryId: insertFinding.searchQueryId ?? null,
      telegramSent: insertFinding.telegramSent ?? false,
    } as any).returning();
    return results[0];
  }

  async markFindingTelegramSent(id: string): Promise<void> {
    await db.update(findings)
      .set({ telegramSent: true })
      .where(eq(findings.id, id));
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
      ...insertScan,
      lotType: insertScan.lotType ?? 'single',
      price: insertScan.price ?? null,
    } as any).returning();
    return results[0];
  }

  async deleteManualScan(id: string): Promise<boolean> {
    const results = await db.delete(manualScans).where(eq(manualScans.id, id)).returning();
    return results.length > 0;
  }

  async recordFindingOutcome(id: string, status: string, note?: string): Promise<Finding | undefined> {
    const results = await db.update(findings)
      .set({ outcomeStatus: status, outcomeNote: note ?? null, outcomeRecordedAt: new Date() })
      .where(eq(findings.id, id))
      .returning();
    return results[0];
  }

  async recordManualScanOutcome(id: string, status: string, note?: string): Promise<ManualScan | undefined> {
    const results = await db.update(manualScans)
      .set({ outcomeStatus: status, outcomeNote: note ?? null, outcomeRecordedAt: new Date() })
      .where(eq(manualScans.id, id))
      .returning();
    return results[0];
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
