import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSearchQuerySchema, insertManualScanSchema } from "@shared/schema";
import { scrapeVintedListing } from "./services/vinted-scraper";
import { analyzeJewelryImages } from "./services/openai-analyzer";
import { scanSearchQuery } from "./services/scanner";

export async function registerRoutes(app: Express): Promise<Server> {
  // Search Query Management
  app.get("/api/searches", async (req, res) => {
    try {
      const searches = await storage.getSearchQueries();
      res.json(searches);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/searches", async (req, res) => {
    try {
      const validated = insertSearchQuerySchema.parse(req.body);
      
      const query = await storage.createSearchQuery(validated);
      res.json(query);
    } catch (error: any) {
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
        listing.description
      );

      const scan = await storage.createManualScan({
        listingUrl: url,
        listingTitle: listing.title,
        confidenceScore: analysis.confidence,
        aiReasoning: analysis.reasons.join('; '),
        detectedMaterials: analysis.detectedMaterials,
        reasons: analysis.reasons,
        isValuable: analysis.isValuable,
        lotType: analysis.lotType,
        price: listing.price,
      });

      // Always return complete response
      res.json({
        listingUrl: url,
        listingTitle: listing.title,
        price: listing.price,
        isValuable: analysis.isValuable,
        confidence: analysis.confidence,
        detectedMaterials: analysis.detectedMaterials || [],
        reasons: analysis.reasons || [],
        lotType: analysis.lotType || 'single'
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
      const scans = await storage.getManualScans();
      res.json(scans);
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

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const httpServer = createServer(app);
  return httpServer;
}
