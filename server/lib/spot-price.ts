/**
 * Spot-price feed for the scrap-metal valuation path.
 *
 * The melt formula needs a EUR-per-gram price for gold / silver / platinum.
 * That price MUST come from a live feed: the `reference_values_at_time_of_writing`
 * block in scrap-metal-rules.json is orientation only and is deliberately never
 * read by this module.
 *
 * Picking and wiring an actual price vendor is out of scope for this pass, so
 * this file provides the seam and two working providers:
 *
 *   METAL_PRICE_PROVIDER=none    (default) — no prices. The scrap path still
 *                                 reports the hallmark, just without a euro
 *                                 figure. It never falls back to a guess.
 *   METAL_PRICE_PROVIDER=manual  — the owner sets prices by env var and
 *                                 refreshes them by hand. Honest and usable
 *                                 today; goes stale like any other source and
 *                                 is subject to the same staleness check.
 *   METAL_PRICE_PROVIDER=http    — reserved. `fetchFromHttpProvider` below is
 *                                 the single function a vendor gets plugged
 *                                 into; nothing else needs to change.
 *
 * Whatever the source, the result carries a `lastUpdatedTimestamp` and is
 * marked stale past MAX_PRICE_AGE_HOURS (default 24) so the caller can refuse
 * to make money decisions on old numbers.
 */

export type ScrapMetal = "gold" | "silver" | "platinum";

export interface SpotPrices {
  /** EUR per gram, per metal. A metal missing here has no usable price. */
  eurPerGram: Partial<Record<ScrapMetal, number>>;
  /** When these figures were published by the source (not when we cached them). */
  lastUpdatedTimestamp: string;
  source: string;
  /** True when the figures are older than MAX_PRICE_AGE_HOURS. */
  stale: boolean;
  ageHours: number;
}

export type SpotPriceResult =
  | { available: true; prices: SpotPrices }
  | { available: false; reason: string };

/** Troy ounce in grams — most feeds quote per troy ounce, not per gram. */
export const GRAMS_PER_TROY_OUNCE = 31.1034768;

export function troyOunceToGram(pricePerOunce: number): number {
  return pricePerOunce / GRAMS_PER_TROY_OUNCE;
}

const MAX_PRICE_AGE_HOURS = parseFloat(process.env.MAX_PRICE_AGE_HOURS || "24");
/** How long a fetched result is reused before we ask the source again. */
const CACHE_TTL_MS = parseFloat(process.env.SPOT_PRICE_CACHE_MINUTES || "60") * 60_000;

let cache: { at: number; result: SpotPriceResult } | null = null;

/**
 * Provider: manual. The owner refreshes these by hand in the environment.
 *
 *   SPOT_PRICE_GOLD_EUR_PER_G=...
 *   SPOT_PRICE_SILVER_EUR_PER_G=...
 *   SPOT_PRICE_PLATINUM_EUR_PER_G=...
 *   SPOT_PRICE_AS_OF=2026-08-03T00:00:00Z   (required — without it we cannot
 *                                            tell whether the numbers are old)
 */
function readManualPrices(): SpotPriceResult {
  const eurPerGram: Partial<Record<ScrapMetal, number>> = {};
  const envByMetal: Record<ScrapMetal, string | undefined> = {
    gold: process.env.SPOT_PRICE_GOLD_EUR_PER_G,
    silver: process.env.SPOT_PRICE_SILVER_EUR_PER_G,
    platinum: process.env.SPOT_PRICE_PLATINUM_EUR_PER_G,
  };

  for (const [metal, raw] of Object.entries(envByMetal) as Array<[ScrapMetal, string | undefined]>) {
    if (!raw) continue;
    const value = parseFloat(raw);
    // A zero/negative/garbage price would silently produce a €0 melt value,
    // which reads as "worthless" rather than "unknown". Drop it instead.
    if (!Number.isFinite(value) || value <= 0) {
      console.warn(`⚠️ Ignoring invalid manual spot price for ${metal}: "${raw}"`);
      continue;
    }
    eurPerGram[metal] = value;
  }

  if (Object.keys(eurPerGram).length === 0) {
    return { available: false, reason: "METAL_PRICE_PROVIDER=manual but no SPOT_PRICE_*_EUR_PER_G values are set" };
  }

  const asOf = process.env.SPOT_PRICE_AS_OF;
  if (!asOf) {
    return { available: false, reason: "SPOT_PRICE_AS_OF is not set — manual prices without a date cannot be age-checked" };
  }
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) {
    return { available: false, reason: `SPOT_PRICE_AS_OF is not a valid date: "${asOf}"` };
  }

  return { available: true, prices: describe(eurPerGram, new Date(asOfMs).toISOString(), "manual (env)") };
}

/**
 * Provider: http. Intentionally not implemented — choosing a vendor is a
 * separate decision. An implementation needs to return EUR-per-gram figures
 * plus the source's own publication timestamp; use troyOunceToGram() if the
 * feed quotes per troy ounce, and convert to EUR if it quotes in USD.
 */
async function fetchFromHttpProvider(): Promise<SpotPriceResult> {
  return {
    available: false,
    reason: "METAL_PRICE_PROVIDER=http is not implemented yet — no price vendor has been chosen",
  };
}

function describe(
  eurPerGram: Partial<Record<ScrapMetal, number>>,
  lastUpdatedTimestamp: string,
  source: string,
): SpotPrices {
  const ageHours = (Date.now() - Date.parse(lastUpdatedTimestamp)) / 3_600_000;
  return {
    eurPerGram,
    lastUpdatedTimestamp,
    source,
    ageHours,
    stale: ageHours > MAX_PRICE_AGE_HOURS,
  };
}

/**
 * Current spot prices, cached briefly. Never throws and never guesses: on any
 * failure it reports `available: false` with a reason, and callers must then
 * skip the euro figure rather than substitute a default.
 */
export async function getSpotPrices(): Promise<SpotPriceResult> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;

  const provider = (process.env.METAL_PRICE_PROVIDER || "none").toLowerCase();
  let result: SpotPriceResult;

  try {
    switch (provider) {
      case "manual":
        result = readManualPrices();
        break;
      case "http":
        result = await fetchFromHttpProvider();
        break;
      case "none":
        result = { available: false, reason: "No spot-price provider configured (set METAL_PRICE_PROVIDER)" };
        break;
      default:
        result = { available: false, reason: `Unknown METAL_PRICE_PROVIDER "${provider}"` };
    }
  } catch (err: any) {
    result = { available: false, reason: `Spot-price lookup failed: ${err.message}` };
  }

  // Recompute staleness on every call — a cached "fresh" result would
  // otherwise keep claiming freshness as it ages inside the cache window.
  if (result.available) {
    result = { available: true, prices: describe(result.prices.eurPerGram, result.prices.lastUpdatedTimestamp, result.prices.source) };
  }

  cache = { at: Date.now(), result };
  return result;
}

/** Test/ops hook — drops the cache so the next call re-reads the source. */
export function clearSpotPriceCache(): void {
  cache = null;
}
