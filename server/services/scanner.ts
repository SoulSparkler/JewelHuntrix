import { storage } from "../storage";
import { scrapeVintedSearch } from "./vinted-scraper";
import { analyzeJewelryImages } from "./openai-analyzer";
import { sendTelegramAlert } from "./telegram";
import type { SearchQuery } from "@shared/schema";

export async function scanSearchQuery(searchQuery: SearchQuery): Promise<number> {
  console.log(`\n=== Starting scan for: ${searchQuery.searchLabel} ===`);
  
  try {
    const listings = await scrapeVintedSearch(searchQuery.vintedUrl);
    let newFindings = 0;

    for (const listing of listings) {
      // Check if listing was already analyzed
      const existingAnalysis = await storage.getAnalyzedListing(listing.listingId);
      if (existingAnalysis) {
        console.log(`Skipping already analyzed listing: ${listing.listingId}`);
        continue;
      }

      // Check if we already have a finding for this listing URL (deduplication)
      const existingFinding = await storage.getFindingByListingUrl(listing.listingUrl);
      if (existingFinding) {
        console.log(`Skipping listing with existing finding: ${listing.listingUrl}`);
        continue;
      }

      console.log(`Analyzing new listing: ${listing.title}`);
      
      const analysis = await analyzeJewelryImages(
        listing.imageUrls,
        listing.title,
        listing.description,
        listing.listingUrl
      );

      // Record the analysis
      await storage.createAnalyzedListing({
        listingId: listing.listingId,
        searchQueryId: searchQuery.id,
        confidenceScore: analysis.confidence,
        isValuable: analysis.isValuableLikely,
        lotType: 'mixed', // Antique dealer treats all as mixed lots for now
      });

      // Fixed 75% confidence threshold requirement
      const CONFIDENCE_THRESHOLD = 75;
      
      if (analysis.confidence >= CONFIDENCE_THRESHOLD && analysis.isValuableLikely) {
        console.log(`✅ High-confidence valuable item found! Confidence: ${analysis.confidence}%`);
        console.log(`💎 Main material: ${analysis.mainMaterialGuess}`);
        console.log(`🎯 Reasons: ${analysis.reasons.join('; ')}`);
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 15);

        // Create the finding
        const finding = await storage.createFinding({
          listingId: listing.listingId,
          listingUrl: listing.listingUrl,
          listingTitle: listing.title,
          price: listing.price,
          confidenceScore: analysis.confidence,
          aiReasoning: analysis.reasons.join('; '),
          detectedMaterials: [analysis.mainMaterialGuess],
          reasons: analysis.reasons,
          isValuable: analysis.isValuableLikely,
          lotType: 'mixed', // Antique dealer approach - all lots mixed
          searchQueryId: searchQuery.id,
          telegramSent: false,
          expiresAt,
        });

        // Send Telegram alert with new format
        const sent = await sendTelegramAlert(
          listing.title,
          listing.listingUrl,
          listing.price,
          analysis.confidence,
          analysis.mainMaterialGuess,
          analysis.reasons,
          analysis.isValuableLikely
        );

        // Update finding record if alert was sent
        if (sent && finding) {
          // Note: In a real implementation, you'd update the database here
          console.log(`📱 Telegram alert successfully sent`);
        }

        newFindings++;
      } else {
        console.log(`Item below 75% confidence threshold (${analysis.confidence}%) - not creating finding`);
        console.log(`❌ isValuableLikely: ${analysis.isValuableLikely}`);
        console.log(`💭 Main material guess: ${analysis.mainMaterialGuess}`);
        console.log(`📝 Reasons: ${analysis.reasons.join('; ')}`);
      }

      // Rate limiting: wait 3 seconds between requests
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    await storage.updateLastScanned(searchQuery.id);
    console.log(`=== Scan complete: ${newFindings} new high-confidence findings ===\n`);
    
    return newFindings;
  } catch (error: any) {
    console.error(`Error scanning search query ${searchQuery.id}:`, error.message);
    return 0;
  }
}
