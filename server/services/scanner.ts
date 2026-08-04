import { storage } from "../storage";
import { searchListings, getSellerCountry } from "../lib/vinted";
import { scoreListingImages, generateAlertMessage } from "../lib/openrouter";
import { valuateListing, toValuationColumns, describeValuation } from "../lib/valuation";
import { sendTelegramMessage } from "./telegram";
import type { SearchQuery } from "../../shared/schema";

// Vision score (1-10) at/above which a listing becomes a Telegram-worthy finding.
const SCORE_THRESHOLD = parseInt(process.env.VISION_SCORE_THRESHOLD || "7", 10);

// Shipping added to the asking price before the risk-budget and
// underpriced-vs-melt comparisons. The caps in the rulesets ALREADY include
// shipping (Vinted jewellery shipping runs to about €3.50), so this is the
// shipping figure itself, not an extra allowance on top of the cap.
const ASSUMED_SHIPPING_EUR = parseFloat(process.env.ASSUMED_SHIPPING_EUR || "3.5");

/**
 * When the scrap path alone may surface a listing the vision pre-filter passed
 * over. A hallmarked listing with poor photos is exactly the case the vision
 * filter mishandles — but alerting on every "925" listing would be pure noise.
 *
 *   underpriced_only (default) — only a CONFIRMED-weight bargain vs melt value
 *   all_hallmarks              — any solid precious-metal mark
 *   off                        — scrap never overrides the vision threshold
 */
const SCRAP_ALERT_MODE = (process.env.SCRAP_ALERT_MODE || "underpriced_only").toLowerCase();

/**
 * Whether the unmarked-suspicion path may surface a listing on its own.
 *   medium_and_high (default) — suspicion medium or high
 *   high_only                 — only high
 *   off                       — never surfaces without the vision filter
 */
const UNMARKED_ALERT_MODE = (process.env.UNMARKED_ALERT_MODE || "medium_and_high").toLowerCase();

/** "€12.50" / "12,50 €" -> 12.5, or undefined when unparseable. */
function parsePriceEur(price: string): number | undefined {
  const cleaned = (price || "").replace(/[^\d.,]/g, "").replace(",", ".");
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

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
 * Analyzed listings are persisted, so the next invocation (cron every 30 min,
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

    // Routing step: decide which valuation path(s) apply BEFORE judging the
    // listing. Brand and scrap are scored independently; `both` takes the max.
    const priceEur = parsePriceEur(listing.price);
    const valuation = await valuateListing(
      listing.title,
      listing.description,
      score.flags,
      priceEur !== undefined ? priceEur + ASSUMED_SHIPPING_EUR : undefined,
      score.metalSignals,
    );

    const passesVision = score.score >= SCORE_THRESHOLD && score.confidence !== "low";
    // A hallmark can rescue a listing the photo pre-filter dismissed.
    const scrapOverride =
      SCRAP_ALERT_MODE === "all_hallmarks"
        ? valuation.scrap !== null
        : SCRAP_ALERT_MODE === "underpriced_only"
        ? valuation.scrap?.underpricedVsMelt === true
        : false;
    // So can an unmarked piece that looks like it could still be real metal —
    // the case this project originally existed to catch.
    const level = valuation.suspicion?.suspicionLevel;
    const unmarkedOverride =
      UNMARKED_ALERT_MODE === "high_only"
        ? level === "high"
        : UNMARKED_ALERT_MODE === "medium_and_high"
        ? level === "high" || level === "medium"
        : false;

    // Risk budgets have the final say — but ONLY a genuine budget block counts.
    // `unscored` and low-suspicion listings are still allowed through on photo
    // evidence alone; gating those would mute the vision pre-filter, which is
    // the original engine and the only thing that reads an unmarked piece well.
    const isValuable =
      (passesVision || scrapOverride || unmarkedOverride) && !valuation.riskSuppressed;
    const confidencePct = score.score * 10; // keep the dashboard's 0-100 scale

    await storage.createAnalyzedListing({
      listingId: listing.listingId,
      searchQueryId: searchQuery.id,
      confidenceScore: confidencePct,
      isValuable,
      lotType: "mixed",
    });

    if (!isValuable) {
      console.log(
        `  · ${listing.title.slice(0, 40)} — score ${score.score}/10 (${score.confidence}), ${describeValuation(valuation)}, skip`,
      );
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
      reasons: [score.reasoning, ...score.flags, valuation.summary],
      isValuable,
      lotType: "mixed",
      sellerCountry,
      searchQueryId: searchQuery.id,
      telegramSent: false,
      expiresAt,
      ...toValuationColumns(valuation),
    });

    const message = await generateAlertMessage({
      title: listing.title,
      price: listing.price,
      url: listing.listingUrl,
      sellerCountry,
      score,
      valuation: describeValuation(valuation),
    });
    await sendTelegramMessage(message, listing.listingUrl);

    console.log(
      `  ✅ FIND: ${listing.title.slice(0, 40)} — score ${score.score}/10, ${describeValuation(valuation)}, ${sellerCountry || "?"}`,
    );
    newFindings++;

    // Gentle spacing between AI calls.
    await new Promise((r) => setTimeout(r, 500));
  }

  await storage.updateLastScanned(searchQuery.id);
  console.log(`=== Done: ${analyzed} analyzed of ${listings.length} listed, ${newFindings} new findings${outOfTime ? " (partial — out of time)" : ""} ===\n`);
  return { listingsChecked: analyzed, newFindings, outOfTime };
}
