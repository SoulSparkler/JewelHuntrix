import { storage } from "../storage";
import { searchListings, getSellerCountry } from "../lib/vinted";
import { scoreListingImages, generateAlertMessage } from "../lib/openrouter";
import { sendTelegramMessage } from "./telegram";
import type { SearchQuery } from "../../shared/schema";

// Vision score (1-10) at/above which a listing becomes a Telegram-worthy finding.
const SCORE_THRESHOLD = parseInt(process.env.VISION_SCORE_THRESHOLD || "7", 10);

export interface ScanOutcome {
  listingsChecked: number;
  newFindings: number;
  /** True when the time budget ran out before all listings were analyzed. */
  outOfTime: boolean;
}

/**
 * Scan one saved search, analyzing new listings until `deadline` (epoch ms).
 *
 * Serverless invocations (Netlify) are killed after ~30s, so we time-box the
 * expensive per-listing AI work and stop GRACEFULLY when the budget runs out.
 * Analyzed listings are persisted, so the next invocation (cron every 15 min,
 * or a manual trigger) continues exactly where this one stopped.
 */
export async function scanSearchQuery(searchQuery: SearchQuery, deadline: number = Number.MAX_SAFE_INTEGER): Promise<ScanOutcome> {
  console.log(`\n=== Scan: ${searchQuery.searchLabel} ===`);

  // Note: searchListings throws on auth/block/network errors — the caller
  // (runScan) catches and records them so failures are never silent.
  const listings = await searchListings(searchQuery.vintedUrl);
  let newFindings = 0;
  let analyzed = 0;
  let outOfTime = false;

  for (const listing of listings) {
    // Skip listings we've already analyzed (dedupe across runs).
    if (await storage.getAnalyzedListing(listing.listingId)) continue;
    if (await storage.getFindingByListingUrl(listing.listingUrl)) continue;

    // Each un-analyzed listing costs image downloads + an AI call (~5-10s).
    // Stop before starting one we can't finish inside the budget.
    if (Date.now() + 10_000 > deadline) {
      outOfTime = true;
      console.log(`  ⏳ Time budget reached after ${analyzed} listings — continuing next run.`);
      break;
    }

    const score = await scoreListingImages(listing.imageUrls, listing.title, listing.description);
    analyzed++;

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
    await new Promise((r) => setTimeout(r, 500));
  }

  await storage.updateLastScanned(searchQuery.id);
  console.log(`=== Done: ${analyzed} analyzed of ${listings.length} listed, ${newFindings} new findings${outOfTime ? " (partial — out of time)" : ""} ===\n`);
  return { listingsChecked: analyzed, newFindings, outOfTime };
}
