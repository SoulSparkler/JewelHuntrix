import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSearchQuerySchema, insertManualScanSchema } from "@shared/schema";
import { getListing } from "./lib/vinted";
import { scoreListingImages, generateAlertMessage } from "./lib/openrouter";
import { scanSearchQuery } from "./services/scanner";
import { runScan } from "./services/run-scan";
import { sendTelegramMessage } from "./services/telegram";
import { db, testConnection, pool } from "./db";
import { searchQueries, manualScans, findings } from "@shared/schema";
import { sql } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {
  // Database Health Check Route
  app.get("/api/db-health", async (req, res) => {
    try {
      console.log("🔍 Running database health check...");
      
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

      scanSearchQuery(searchQuery).catch(err => {
        console.error("Background scan error:", err);
      });
      
      res.json({ success: true, message: "Scan started" });
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

      const score = await scoreListingImages(listing.imageUrls, listing.title, listing.description);
      const SCORE_THRESHOLD = parseInt(process.env.VISION_SCORE_THRESHOLD || "7", 10);
      const isValuable = score.score >= SCORE_THRESHOLD && score.confidence !== "low";
      const confidencePct = score.score * 10;

      // Create manual scan record
      const scan = await storage.createManualScan({
        listingUrl: url,
        listingTitle: listing.title,
        confidenceScore: confidencePct,
        aiReasoning: score.reasoning,
        detectedMaterials: score.flags,
        reasons: [score.reasoning, ...score.flags],
        isValuable,
        lotType: 'mixed', // Antique dealer approach
        price: listing.price,
      });

      console.log("✅ Created manual scan:", scan.id);

      // Send Telegram alert if it passes the vision-score threshold.
      if (isValuable) {
        console.log(`📱 Manual scan: candidate (score ${score.score}/10) - sending Telegram alert`);
        const message = await generateAlertMessage({
          title: listing.title,
          price: listing.price,
          url,
          sellerCountry: listing.sellerCountry,
          score,
        });
        await sendTelegramMessage(message, url);
      } else {
        console.log(`📱 Manual scan: score ${score.score}/10 below threshold - no Telegram alert`);
      }

      // Return response (keeps the dashboard's existing field names working).
      res.json({
        listingUrl: url,
        isValuableLikely: isValuable,
        confidence: confidencePct,
        score: score.score,
        scoreConfidence: score.confidence,
        flags: score.flags,
        reasons: [score.reasoning, ...score.flags],
        listingTitle: listing.title,
        price: listing.price
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
