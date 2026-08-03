import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSearchQuerySchema, insertManualScanSchema, outcomeStatusEnum } from "../shared/schema";
import { getListing } from "./lib/vinted";
import { scoreListingImages, analyzeListingDetailed, generateAlertMessage } from "./lib/openrouter";
import { valuateListing, toValuationColumns, describeValuation } from "./lib/valuation";
import { getSpotPrices } from "./lib/spot-price";
import { scanSearchQuery } from "./services/scanner";
import { runScan } from "./services/run-scan";
import { sendTelegramMessage } from "./services/telegram";
import { db, testConnection, pool } from "./db";
import { searchQueries, manualScans, findings } from "../shared/schema";
import { sql } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {
  // Database Health Check Route
  app.get("/api/db-health", async (req, res) => {
    try {
      console.log("🔍 Running database health check...");

      // Non-secret diagnostics about the configured DATABASE_URL so we can spot
      // a malformed env var (quotes / whitespace / wrong protocol) remotely
      // without ever exposing the credentials.
      const rawUrl = process.env.DATABASE_URL;
      let urlDiag: Record<string, any> = { set: !!rawUrl };
      if (rawUrl) {
        const trimmed = rawUrl.trim();
        const unquoted = (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) ? trimmed.slice(1, -1).trim() : trimmed;
        let parseOk = false;
        let host: string | null = null;
        let protocol: string | null = null;
        try { const u = new URL(unquoted); parseOk = true; host = u.hostname; protocol = u.protocol; } catch {}
        urlDiag = {
          set: true,
          length: rawUrl.length,
          hadSurroundingQuotes: unquoted !== trimmed,
          hadOuterWhitespace: trimmed !== rawUrl,
          protocol,
          host,
          parseOk,
        };
      }

      // Test basic connection
      const connectionTest = await testConnection();
      
      // Check table existence and counts
      let tableInfo = {};
      try {
        const searchCount = await db.select({ count: sql`COUNT(*)` }).from(searchQueries);
        const manualScanCount = await db.select({ count: sql`COUNT(*)` }).from(manualScans);
        const findingsCount = await db.select({ count: sql`COUNT(*)` }).from(findings);
        
        tableInfo = {
          searchQueries: searchCount[0].count,
          manualScans: manualScanCount[0].count,
          findings: findingsCount[0].count
        };
      } catch (tableError: any) {
        console.error("❌ Table query error:", tableError.message);
        tableInfo = { error: tableError.message };
      }
      
      // Test INSERT and SELECT operations
      let operationTest = {};
      try {
        // Test insert
        const testInsert = await db.insert(searchQueries).values({
          vintedUrl: "test://health-check",
          searchLabel: "DB Health Check Test",
          scanFrequencyHours: 1,
          confidenceThreshold: 75,
          isActive: false
        }).returning();
        
        // Test delete
        await db.delete(searchQueries).where(sql`vinted_url = 'test://health-check'`);
        
        operationTest = { insertSelectDelete: "success" };
      } catch (opError: any) {
        console.error("❌ Operation test error:", opError.message);
        operationTest = { error: opError.message };
      }
      
      res.json({
        status: "ok",
        databaseUrl: urlDiag,
        connection: connectionTest,
        tables: tableInfo,
        operations: operationTest,
        timestamp: new Date().toISOString()
      });
      
    } catch (error: any) {
      console.error("❌ Database health check failed:", error);
      res.status(500).json({
        status: "error",
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Search Query Management
  app.get("/api/searches", async (req, res) => {
    try {
      console.log("📋 Getting all search queries...");
      const searches = await storage.getSearchQueries();
      console.log(`✅ Found ${searches.length} search queries`);
      res.json(searches);
    } catch (error: any) {
      console.error("❌ Error getting searches:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/searches", async (req, res) => {
    try {
      console.log("📝 Creating new search query:", req.body);
      const validated = insertSearchQuerySchema.parse(req.body);
      console.log("✅ Validated search query data:", validated);
      
      const query = await storage.createSearchQuery(validated);
      console.log("✅ Created search query:", query);
      res.json(query);
    } catch (error: any) {
      console.error("❌ Error creating search query:", error.message);
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/searches/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updated = await storage.updateSearchQuery(id, req.body);
      
      if (!updated) {
        return res.status(404).json({ error: "Search query not found" });
      }
      
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/searches/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteSearchQuery(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Search query not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/searches/:id/trigger", async (req, res) => {
    try {
      const { id } = req.params;
      const searchQuery = await storage.getSearchQuery(id);
      
      if (!searchQuery) {
        return res.status(404).json({ error: "Search query not found" });
      }

      // Await with a time budget: fire-and-forget dies silently on serverless
      // (the runtime freezes as soon as the response is sent). The scan is
      // incremental — repeat the trigger to continue where it stopped.
      const budgetMs = parseInt(process.env.SCAN_BUDGET_MS || "20000", 10);
      const outcome = await scanSearchQuery(searchQuery, Date.now() + budgetMs);
      res.json({
        success: true,
        listingsChecked: outcome.listingsChecked,
        newFindings: outcome.newFindings,
        partial: outcome.outOfTime,
        message: outcome.outOfTime
          ? `Analyzed ${outcome.listingsChecked} listings (time budget reached — trigger again to continue)`
          : `Scan complete: ${outcome.listingsChecked} listings analyzed, ${outcome.newFindings} findings`,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Findings
  app.get("/api/findings", async (req, res) => {
    try {
      const findings = await storage.getFindings();
      res.json(findings);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Record what actually happened once a piece is in hand — the ground truth
  // the unmarked-suspicion path's weights need before they can be calibrated
  // against anything. status is one of outcomeStatusEnum; note is free text
  // (e.g. "found 800 stamp inside band" / "magnet test failed").
  app.post("/api/findings/:id/outcome", async (req, res) => {
    try {
      const { id } = req.params;
      const parsed = outcomeStatusEnum.safeParse(req.body?.status);
      if (!parsed.success) {
        return res.status(400).json({ error: `status must be one of: ${outcomeStatusEnum.options.join(", ")}` });
      }
      const updated = await storage.recordFindingOutcome(id, parsed.data, req.body?.note);
      if (!updated) return res.status(404).json({ error: "Finding not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/findings/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteFinding(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Finding not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Manual Analysis
  app.post("/api/analyze-listing", async (req, res) => {
    // Add cache-busting headers
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    try {
      const { url } = req.body ?? {};

      // Validate URL
      if (!url || !url.includes('vinted')) {
        return res.status(400).json({
          error: 'Invalid Vinted URL',
          isValuable: false,
          confidence: 0,
          detectedMaterials: [],
          reasons: ['Invalid URL provided'],
          lotType: 'single'
        });
      }

      try {
        new URL(url);
      } catch {
        return res.status(400).json({
          error: 'Malformed URL',
          isValuable: false,
          confidence: 0,
          detectedMaterials: [],
          reasons: [`URL is not valid: ${url}`],
          lotType: 'single'
        });
      }

      const listing = await getListing(url);

      if (!listing) {
        return res.status(404).json({
          error: "Could not fetch listing",
          isValuable: false,
          confidence: 0,
          detectedMaterials: [],
          reasons: ['Failed to fetch listing from Vinted'],
          lotType: 'single'
        });
      }

      // Manual scans get the strong, apprentice-teaching deep analysis (not the
      // cheap bulk pre-filter). The long-form write-up is stored in aiReasoning.
      const detail = await analyzeListingDetailed(listing.imageUrls, listing.title, listing.description);
      const SCORE_THRESHOLD = parseInt(process.env.VISION_SCORE_THRESHOLD || "7", 10);

      // Routing step: brand path, scrap path, both (max), or unscored.
      const shippingEur = parseFloat(process.env.ASSUMED_SHIPPING_EUR || "3.5");
      const priceCleaned = (listing.price || "").replace(/[^\d.,]/g, "").replace(",", ".");
      const priceEur = parseFloat(priceCleaned);
      const valuation = await valuateListing(
        listing.title,
        listing.description,
        detail.flags,
        Number.isFinite(priceEur) ? priceEur + shippingEur : undefined,
        detail.metalSignals,
      );

      const isValuable = detail.score >= SCORE_THRESHOLD && detail.confidence !== "low";
      // Confidence shown in the UI = certainty it contains REAL precious materials.
      const confidencePct = detail.certaintyPreciousPct;

      // Create manual scan record
      const scan = await storage.createManualScan({
        listingUrl: url,
        listingTitle: listing.title,
        confidenceScore: confidencePct,
        aiReasoning: detail.analysis,
        detectedMaterials: detail.flags,
        reasons: detail.flags,
        isValuable,
        lotType: 'mixed', // Antique dealer approach
        price: listing.price,
        ...toValuationColumns(valuation),
      });

      console.log("✅ Created manual scan:", scan.id);

      // Send Telegram alert if it passes the threshold.
      if (isValuable) {
        console.log(`📱 Manual scan: candidate (score ${detail.score}/10) - sending Telegram alert`);
        const message = await generateAlertMessage({
          title: listing.title,
          price: listing.price,
          url,
          sellerCountry: listing.sellerCountry,
          score: {
            score: detail.score,
            reasoning: detail.analysis,
            flags: detail.flags,
            confidence: detail.confidence,
            metalSignals: detail.metalSignals,
          },
          valuation: describeValuation(valuation),
        });
        await sendTelegramMessage(message, url);
      } else {
        console.log(`📱 Manual scan: score ${detail.score}/10 below threshold - no Telegram alert`);
      }

      // Return response (keeps the dashboard's existing field names working).
      res.json({
        listingUrl: url,
        isValuableLikely: isValuable,
        confidence: confidencePct,
        certaintyPreciousPct: detail.certaintyPreciousPct,
        score: detail.score,
        scoreConfidence: detail.confidence,
        flags: detail.flags,
        analysis: detail.analysis,
        reasons: detail.flags,
        listingTitle: listing.title,
        price: listing.price,
        // Which path(s) produced the score, so the caller can tell "valuable
        // because of who made it" from "valuable because of what it's made of".
        valuation: {
          path: valuation.path,
          tag: valuation.tag,
          score: valuation.score,
          scoredBy: valuation.scoredBy,
          summary: valuation.summary,
          buyCandidate: valuation.buyCandidate,
          suppressedReason: valuation.suppressedReason,
          riskCapEur: valuation.riskCapEur,
          brand: valuation.brand?.best
            ? { name: valuation.brand.best.displayName, score: valuation.brand.score }
            : null,
          // Path 3. Carries no value field by design — see its hard_rule.
          suspicion: valuation.suspicion
            ? {
                level: valuation.suspicion.suspicionLevel,
                signalsTriggered: valuation.suspicion.signalsTriggered,
                signalsMissingNote: valuation.suspicion.signalsMissingNote,
                recommendedAction: valuation.suspicion.recommendedAction,
                explicitDisclaimer: valuation.suspicion.explicitDisclaimer,
                priorityBoost: valuation.suspicion.priorityBoost,
              }
            : null,
          scrap: valuation.scrap
            ? {
                label: valuation.scrap.label,
                metal: valuation.scrap.metal,
                purityDecimal: valuation.scrap.purityDecimal,
                weightGrams: valuation.scrap.weightGrams,
                weightConfirmed: valuation.scrap.weightConfirmed,
                weightReason: valuation.scrap.weightReason,
                meltValueEur: valuation.scrap.meltValueEur,
                spotPriceEurPerGram: valuation.scrap.spotPriceEurPerGram,
                spotPriceAsOf: valuation.scrap.spotPriceAsOf,
                spotPriceStale: valuation.scrap.spotPriceStale,
                valueUnavailableReason: valuation.scrap.valueUnavailableReason,
                underpricedVsMelt: valuation.scrap.underpricedVsMelt,
                notes: valuation.scrap.notes,
              }
            : null,
        },
      });
    } catch (error: any) {
      console.error("❌ analyze-listing error:", error.message, "| body:", JSON.stringify(req.body), "| stack:", error.stack);
      res.status(500).json({
        error: error.message,
        isValuable: false,
        confidence: 0,
        detectedMaterials: [],
        reasons: ['Analysis failed: ' + error.message],
        lotType: 'single'
      });
    }
  });

  // Manual Scans History
  app.get("/api/manual-scans", async (req, res) => {
    try {
      console.log("📋 Getting all manual scans...");
      const scans = await storage.getManualScans();
      console.log(`✅ Found ${scans.length} manual scans`);
      res.json(scans);
    } catch (error: any) {
      console.error("❌ Error getting manual scans:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/manual-scans/:id/outcome", async (req, res) => {
    try {
      const { id } = req.params;
      const parsed = outcomeStatusEnum.safeParse(req.body?.status);
      if (!parsed.success) {
        return res.status(400).json({ error: `status must be one of: ${outcomeStatusEnum.options.join(", ")}` });
      }
      const updated = await storage.recordManualScanOutcome(id, parsed.data, req.body?.note);
      if (!updated) return res.status(404).json({ error: "Manual scan not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/manual-scans/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteManualScan(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Manual scan not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Health check (now reports real scan state for monitoring)
  app.get("/api/health", async (req, res) => {
    try {
      const state = await storage.getScanState();
      res.json({
        status: "ok",
        lastRunAt: state?.lastRunAt ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastListingsChecked: state?.lastListingsChecked ?? 0,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastError: state?.lastError ?? null,
      });
    } catch (error: any) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  // Spot-price feed status. The scrap path silently degrades to "no euro
  // figure" when this is unavailable or stale, so it needs to be inspectable.
  app.get("/api/spot-prices", async (req, res) => {
    try {
      const result = await getSpotPrices();
      if (!result.available) {
        return res.json({
          available: false,
          reason: result.reason,
          provider: process.env.METAL_PRICE_PROVIDER || "none",
          note: "Scrap-path listings are surfaced with their hallmark but without a melt value.",
        });
      }
      res.json({
        available: true,
        provider: process.env.METAL_PRICE_PROVIDER || "none",
        source: result.prices.source,
        eurPerGram: result.prices.eurPerGram,
        lastUpdatedTimestamp: result.prices.lastUpdatedTimestamp,
        ageHours: Math.round(result.prices.ageHours * 10) / 10,
        stale: result.prices.stale,
      });
    } catch (error: any) {
      res.status(500).json({ available: false, error: error.message });
    }
  });

  // Manual full-scan trigger (same entry point the Netlify cron uses).
  app.post("/api/scan", async (req, res) => {
    try {
      const result = await runScan();
      res.status(result.ok ? 200 : 500).json(result);
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
