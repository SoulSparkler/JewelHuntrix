import { storage } from "../storage";
import { searchListings, getSellerCountry, type VintedListing } from "../lib/vinted";
import { scoreListingImages, generateAlertMessage, type VisionScore } from "../lib/openrouter";
import { valuateListing, toValuationColumns, describeValuation } from "../lib/valuation";
import { bannedTermInTitle } from "../lib/prefilter";
import { mapWithConcurrency } from "../lib/concurrency";
import { sendTelegramMessage } from "./telegram";
import type { SearchQuery } from "../../shared/schema";

// Vision score (1-10) at/above which a listing becomes a Telegram-worthy finding.
const SCORE_THRESHOLD = parseInt(process.env.VISION_SCORE_THRESHOLD || "7", 10);

/**
 * How many listings are vision-scored at once. The biggest lever on how much a
 * run gets through — the calls are almost entirely network wait, so running
 * several in flight costs no extra per-listing OpenRouter spend.
 *
 * DON'T RAISE THIS WITHOUT RE-READING PER_LISTING_RESERVE_MS. The two are
 * coupled: the reserve assumes one listing finishes within 10s, and OpenRouter
 * throttles concurrent requests, so per-call latency stretches as concurrency
 * climbs. Measured over the same 12 listings:
 *
 *     concurrency  1 -> 3.8s/listing   (each call ~4s)
 *     concurrency  5 -> 2.3s/listing   (each call ~10s)
 *     concurrency 12 -> 1.7s/listing   (each call ~19s)
 *
 * Throughput keeps improving, but at 12 a single listing outlives the 10s
 * reserve and the batch overshoots SCAN_BUDGET_MS into Netlify's ~30s kill.
 * 5 is the point where per-call latency still fits the reserve.
 */
const SCAN_CONCURRENCY = parseInt(process.env.SCAN_CONCURRENCY || "5", 10);

/**
 * Concurrency for the cheap dedupe lookups. Higher than the AI limit (they are
 * fast) but still bounded: the Supabase connection pooler throws transient auth
 * failures when hit with a burst of dozens of simultaneous queries.
 */
const DEDUPE_CONCURRENCY = 8;

/** Time reserved for one listing's AI work before the deadline. */
const PER_LISTING_RESERVE_MS = 10_000;

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
 *   all_hallmarks    (current default) — any solid precious-metal mark
 *   underpriced_only — only a CONFIRMED-weight bargain vs melt value
 *   off              — scrap never overrides the vision threshold
 *
 * TEST-WEEK DEFAULT: this is `all_hallmarks` rather than the more conservative
 * `underpriced_only` on purpose. `underpriced_only` needs BOTH a seller-stated
 * weight AND a live spot price; with METAL_PRICE_PROVIDER unset there is no
 * spot price, so that mode can never fire and the scrap path would be dead
 * code — we'd spend a week "testing" nothing but the old vision filter.
 * `all_hallmarks` trades noise for throughput so hallmark-detection PRECISION
 * can actually be measured. Once precision looks good, set
 * SCRAP_ALERT_MODE=underpriced_only (env var wins over this default).
 */
const SCRAP_ALERT_MODE = (process.env.SCRAP_ALERT_MODE || "all_hallmarks").toLowerCase();

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

  // ---- Phase 1: free filters. Nothing here costs an AI call. ----
  // Keep the result index-aligned rather than pushing as workers finish: the
  // incoming order interleaves the locale domains (see searchListings), and a
  // run only scores the first handful, so scrambling it would undo that.
  let skippedByWordlist = 0;

  const keep = await mapWithConcurrency(listings, DEDUPE_CONCURRENCY, async (listing) => {
    try {
      if (await storage.getAnalyzedListing(listing.listingId)) return false;
      if (await storage.getFindingByListingUrl(listing.listingUrl)) return false;

      const banned = bannedTermInTitle(listing.title);
      if (banned) {
        // Record it so later runs don't re-check the same junk.
        await storage.createAnalyzedListing({
          listingId: listing.listingId,
          searchQueryId: searchQuery.id,
          confidenceScore: 0,
          isValuable: false,
          lotType: "mixed",
        });
        skippedByWordlist++;
        return false;
      }

      return true;
    } catch (err: any) {
      console.error(`  ⚠️  Pre-filter failed for ${listing.listingId}: ${err.message}`);
      return false;
    }
  });

  const candidates: VintedListing[] = listings.filter((_, i) => keep[i]);

  if (skippedByWordlist > 0) {
    console.log(`  ⊘ ${skippedByWordlist} listing(s) rejected on title keywords before any AI call.`);
  }

  // ---- Phase 2: AI scoring, several listings in flight at once. ----
  // Passing listings are NOT marked analyzed here — that happens only after the
  // alert is sent in phase 3. If the budget expires in between, the listing is
  // simply re-scored next run instead of being silently swallowed.
  const alertQueue: Array<{ listing: VintedListing; score: VisionScore; valuation: Awaited<ReturnType<typeof valuateListing>>; confidencePct: number }> = [];

  await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (listing) => {
    if (Date.now() + PER_LISTING_RESERVE_MS > deadline) {
      outOfTime = true;
      return;
    }

    try {
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

      if (!isValuable) {
        await storage.createAnalyzedListing({
          listingId: listing.listingId,
          searchQueryId: searchQuery.id,
          confidenceScore: confidencePct,
          isValuable: false,
          lotType: "mixed",
        });
        console.log(
          `  · ${listing.title.slice(0, 40)} — score ${score.score}/10 (${score.confidence}), ${describeValuation(valuation)}, skip`,
        );
        return;
      }

      alertQueue.push({ listing, score, valuation, confidencePct });
    } catch (err: any) {
      // One bad listing must not abort the batch — it used to throw straight out
      // of the scan and cost every remaining listing in the run.
      console.error(`  ⚠️  Scoring failed for ${listing.listingId}: ${err.message}`);
    }
  });

  // ---- Phase 3: alerts, strictly serialized. ----
  // Telegram and the alert rate limiter both dislike bursts, and the reader
  // wants these in a stable order.
  for (const { listing, score, valuation, confidencePct } of alertQueue) {
    if (Date.now() + 5_000 > deadline) {
      outOfTime = true;
      break;
    }

    try {
      // Only now (for the few that pass) do we spend a request to resolve country.
      const sellerCountry = listing.sellerId ? await getSellerCountry(listing.sellerId) : null;

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 15);

      const finding = await storage.createFinding({
        listingId: listing.listingId,
        listingUrl: listing.listingUrl,
        listingTitle: listing.title,
        price: listing.price,
        confidenceScore: confidencePct,
        aiReasoning: score.reasoning,
        detectedMaterials: score.flags,
        reasons: [score.reasoning, ...score.flags, valuation.summary],
        isValuable: true,
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
      // Flip the flag only after the send succeeded — the column is the
      // record of delivery, not of intent. It used to stay false forever.
      await storage.markFindingTelegramSent(finding.id);

      await storage.createAnalyzedListing({
        listingId: listing.listingId,
        searchQueryId: searchQuery.id,
        confidenceScore: confidencePct,
        isValuable: true,
        lotType: "mixed",
      });

      console.log(
        `  ✅ FIND: ${listing.title.slice(0, 40)} — score ${score.score}/10, ${describeValuation(valuation)}, ${sellerCountry || "?"}`,
      );
      newFindings++;
    } catch (err: any) {
      console.error(`  ⚠️  Alert failed for ${listing.listingId}: ${err.message}`);
    }

    // Gentle spacing between alerts.
    await new Promise((r) => setTimeout(r, 500));
  }

  await storage.updateLastScanned(searchQuery.id);
  if (outOfTime) {
    console.log(`  ⏳ Time budget reached after ${analyzed} listings — continuing next run.`);
  }
  console.log(`=== Done: ${analyzed} analyzed of ${listings.length} listed, ${newFindings} new findings${outOfTime ? " (partial — out of time)" : ""} ===\n`);
  return { listingsChecked: analyzed, newFindings, outOfTime };
}
