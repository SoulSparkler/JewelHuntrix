import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSearchQuerySchema, insertManualScanSchema } from "@shared/schema";
import { scrapeVintedListing } from "./services/vinted-scraper";
import { analyzeJewelryImages } from "./services/openai-analyzer";
import { scanSearchQuery } from "./services/scanner";
import { sendTelegramAlert } from "./services/telegram";
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
      const { url } = req.body;
      
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

      const listing = await scrapeVintedListing(url);
      
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

      const analysis = await analyzeJewelryImages(
        listing.imageUrls,
        listing.title,
        listing.description,
        url
      );

      // Create manual scan record
      const scan = await storage.createManualScan({
        listingUrl: url,
        listingTitle: listing.title,
        confidenceScore: analysis.confidence,
        aiReasoning: analysis.reasons.join('; '),
        detectedMaterials: [analysis.mainMaterialGuess],
        reasons: analysis.reasons,
        isValuable: analysis.isValuableLikely,
        lotType: 'mixed', // Antique dealer approach
        price: listing.price,
      });
      
      console.log("✅ Created manual scan:", scan);

      // Send Telegram alert if high confidence (>= 75%) and valuable
      const CONFIDENCE_THRESHOLD = 75;
      if (analysis.confidence >= CONFIDENCE_THRESHOLD && analysis.isValuableLikely) {
        console.log(`📱 Manual scan: High-confidence finding detected (${analysis.confidence}%) - sending Telegram alert`);
        
        await sendTelegramAlert(
          listing.title,
          url,
          listing.price,
          analysis.confidence,
          analysis.mainMaterialGuess,
          analysis.reasons,
          analysis.isValuableLikely
        );
      } else {
        console.log(`📱 Manual scan: Below 75% confidence threshold (${analysis.confidence}%) - no Telegram alert`);
      }

      // Always return complete response (antique dealer format)
      res.json({
        listingUrl: analysis.listingUrl,
        isValuableLikely: analysis.isValuableLikely,
        confidence: analysis.confidence,
        mainMaterialGuess: analysis.mainMaterialGuess,
        reasons: analysis.reasons,
        listingTitle: listing.title,
        price: listing.price
      });
    } catch (error: any) {
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

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const httpServer = createServer(app);
  return httpServer;
}
