import { storage } from "../storage";
import { searchListings, getSellerCountry } from "../lib/vinted";
import { scoreListingImages, generateAlertMessage } from "../lib/openrouter";
import { sendTelegramMessage } from "./telegram";
import type { SearchQuery } from "@shared/schema";

// Vision score (1-10) at/above which a listing becomes a Telegram-worthy finding.
const SCORE_THRESHOLD = parseInt(process.env.VISION_SCORE_THRESHOLD || "7", 10);

export interface ScanOutcome {
  listingsChecked: number;
  newFindings: number;
}

export async function scanSearchQuery(searchQuery: SearchQuery): Promise<ScanOutcome> {
  console.log(`\n=== Scan: ${searchQuery.searchLabel} ===`);

  // Note: searchListings throws on auth/block/network errors — the caller
  // (runScan) catches and records them so failures are never silent.
  const listings = await searchListings(searchQuery.vintedUrl);
  let newFindings = 0;

  for (const listing of listings) {
    // Skip listings we've already analyzed (dedupe across runs).
    if (await storage.getAnalyzedListing(listing.listingId)) continue;
    if (await storage.getFindingByListingUrl(listing.listingUrl)) continue;

    const score = await scoreListingImages(listing.imageUrls, listing.title, listing.description);

    const isValuable = score.score >= SCORE_THRESHOLD && score.confidence !== "low";
    const confidencePct = score.score * 10; // keep the dashboard's 0-100 scale

    await storage.createAnalyzedListing({
      listingId: listing.listingId,
      searchQueryId: searchQuery.id,
      confidenceScore: confidencePct,
      isValuable,
      lotType: "mixed",
    });

    if (!isValuable) {
      console.log(`  · ${listing.title.slice(0, 40)} — score ${score.score}/10 (${score.confidence}), skip`);
      continue;
    }

    // Only now (for the few that pass) do we spend a request to resolve country.
    const sellerCountry = listing.sellerId ? await getSellerCountry(listing.sellerId) : null;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 15);

    await storage.createFinding({
      listingId: listing.listingId,
      listingUrl: listing.listingUrl,
      listingTitle: listing.title,
      price: listing.price,
      confidenceScore: confidencePct,
      aiReasoning: score.reasoning,
      detectedMaterials: score.flags,
      reasons: [score.reasoning, ...score.flags],
      isValuable,
      lotType: "mixed",
      sellerCountry,
      searchQueryId: searchQuery.id,
      telegramSent: false,
      expiresAt,
    });

    const message = await generateAlertMessage({
      title: listing.title,
      price: listing.price,
      url: listing.listingUrl,
      sellerCountry,
      score,
    });
    await sendTelegramMessage(message, listing.listingUrl);

    console.log(`  ✅ FIND: ${listing.title.slice(0, 40)} — score ${score.score}/10, ${sellerCountry || "?"}`);
    newFindings++;

    // Gentle spacing between AI calls.
    await new Promise((r) => setTimeout(r, 1500));
  }

  await storage.updateLastScanned(searchQuery.id);
  console.log(`=== Done: ${listings.length} checked, ${newFindings} new findings ===\n`);
  return { listingsChecked: listings.length, newFindings };
}
