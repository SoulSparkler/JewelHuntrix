import { storage } from "../storage";
import { scrapeVintedSearch } from "./vinted-scraper";
import { analyzeJewelryImages } from "./openai-analyzer";
import { sendTelegramAlert } from "./telegram";
import type { SearchQuery } from "@shared/schema";

function getBuyAdvice(confidence: number, totalCost: number): "BUY" | "MAYBE" | "SKIP" {
  if (confidence >= 80 && totalCost <= 20) return "BUY";
  if (confidence >= 60 && totalCost <= 40) return "MAYBE";
  return "SKIP";
}

export async function scanSearchQuery(searchQuery: SearchQuery): Promise<number> {
  console.log(`\n=== Starting scan for: ${searchQuery.searchLabel} ===`);
  
  try {
    const listings = await scrapeVintedSearch(searchQuery.vintedUrl);
    let newFindings = 0;

    for (const listing of listings) {
      const existing = await storage.getAnalyzedListing(listing.listingId);
      if (existing) {
        console.log(`Skipping already analyzed listing: ${listing.listingId}`);
        continue;
      }

      console.log(`Analyzing new listing: ${listing.title}`);
      
      const analysis = await analyzeJewelryImages(listing.imageUrls, listing.title);

      await storage.createAnalyzedListing({
        listingId: listing.listingId,
        searchQueryId: searchQuery.id,
        confidenceScore: analysis.confidence,
        isValuable: analysis.confidence >= searchQuery.confidenceThreshold,
        lotType: analysis.lotType,
      });

      if (analysis.confidence >= searchQuery.confidenceThreshold && analysis.isValuable) {
        console.log(`✅ Valuable item found! Confidence: ${analysis.confidence}%`);
        
        const totalCost = parseFloat(listing.price?.replace(/[€,\s]/g, '') || '0') + 4.0;
        const advice = getBuyAdvice(analysis.confidence, totalCost);

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 15);

        const finding = await storage.createFinding({
          listingId: listing.listingId,
          listingUrl: listing.listingUrl,
          listingTitle: listing.title,
          price: listing.price,
          confidenceScore: analysis.confidence,
          aiReasoning: analysis.reasons.join('; '),
          detectedMaterials: analysis.detectedMaterials,
          reasons: analysis.reasons,
          isValuable: analysis.isValuable,
          lotType: analysis.lotType,
          searchQueryId: searchQuery.id,
          telegramSent: false,
          expiresAt,
        });

        const sent = await sendTelegramAlert(
          listing.title,
          listing.listingUrl,
          listing.price,
          analysis.confidence,
          analysis.detectedMaterials,
          analysis.reasons.join('; '),
          advice
        );

        if (sent && finding) {
          finding.telegramSent = true;
        }

        newFindings++;
      } else {
        console.log(`Item below threshold (${analysis.confidence}%) - not creating finding`);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    await storage.updateLastScanned(searchQuery.id);
    console.log(`=== Scan complete: ${newFindings} new findings ===\n`);
    
    return newFindings;
  } catch (error: any) {
    console.error(`Error scanning search query ${searchQuery.id}:`, error.message);
    return 0;
  }
}
