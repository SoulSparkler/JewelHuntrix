/**
 * Valuation router — the step that runs BEFORE any scoring.
 *
 * Three independent ways a listing can be worth attention:
 *
 *   brand_path              valuable because of WHO MADE IT
 *                           (docs/brand-ruleset.json)
 *   scrap_path              valuable because of WHAT IT'S MADE OF, with a
 *                           VISIBLE hallmark (scrap-metal-rules.json)
 *   unmarked_suspicion_path no hallmark visible, but the piece could still be
 *                           real metal (unmarked-metal-suspicion.json) —
 *                           produces a suspicion level only, never a value
 *
 * Brand and scrap share no assumptions, so when both fire they are scored
 * separately and the MAXIMUM is taken, never the average — averaging would drag
 * a strong signal down toward a weak one and bury exactly the finds worth having.
 *
 * Each path carries its own purchase-risk cap (its ruleset's `risk_budget`).
 * These are caps on how much to risk on an UNCONFIRMED bet, not value ceilings:
 *   - scrap & unmarked: HARD SUPPRESS above the cap
 *   - brand:            raise the confidence bar, do not suppress
 * All caps already include shipping, so the comparison is
 * `asking_price + shipping <= max_total_cost_eur`.
 */

import { detectBrands, BRAND_RISK_CAP_EUR, type BrandDetection } from "./brand-match";
import { valuateScrap, detectHallmarks, SCRAP_RISK_CAP_EUR, type ScrapValuation } from "./scrap-metal";
import {
  shouldRunUnmarkedPath,
  scoreUnmarkedSuspicion,
  UNMARKED_RISK_CAP_EUR,
  type SuspicionResult,
} from "./unmarked-suspicion";

export type ValuationPath =
  | "brand_path"
  | "scrap_path"
  | "both"
  | "unmarked_suspicion_path"
  | "unscored";

/** Visible per-listing tag, per the handoff's UI requirement. */
export type ValuationTag = string | null;

export interface Valuation {
  path: ValuationPath;
  tag: ValuationTag;
  /** Max of the brand/scrap scores (0-100). Null for unmarked and unscored. */
  score: number | null;
  scoredBy: "brand" | "scrap" | null;
  brand: BrandDetection | null;
  scrap: ScrapValuation | null;
  suspicion: SuspicionResult | null;

  /** False when a risk budget (or a confidence bar) rules this out as a buy. */
  buyCandidate: boolean;
  /**
   * True ONLY when a ruleset's risk_budget actively blocks this listing.
   *
   * Kept separate from `buyCandidate` on purpose: `unscored` and a low-suspicion
   * piece are "not a buy candidate on their own evidence", which is NOT the same
   * as "must never be alerted". The vision pre-filter is still allowed to surface
   * those — gating it on buyCandidate would mute the original engine, since a
   * great-looking piece whose title happens to name no maker routes to unscored.
   */
  riskSuppressed: boolean;
  /** Why buyCandidate is false. Null when it's true. */
  suppressedReason: string | null;
  /** The cap that applied, for display. */
  riskCapEur: number | null;

  /** One-line explanation of the routing decision, safe to show the user. */
  summary: string;
}

/**
 * Route and score one listing.
 *
 * @param title         Listing title.
 * @param description   Listing description.
 * @param aiFlags       Short visual observations from the vision model.
 * @param totalCostEur  Asking price PLUS shipping. The risk caps already
 *                      include shipping, so do not add an extra allowance.
 * @param metalSignals  Unmarked-metal signal IDs the vision model reported.
 */
export async function valuateListing(
  title: string,
  description = "",
  aiFlags: string[] = [],
  totalCostEur?: number,
  metalSignals: string[] = [],
): Promise<Valuation> {
  const listingText = `${title} ${description}`;

  const brand = detectBrands(listingText, aiFlags);
  const scrap = await valuateScrap(listingText, aiFlags, totalCostEur);

  const hasAttribution = brand.best !== null && brand.score !== null;
  const hasHallmark = scrap !== null;

  // --- both paths: score independently, take the max -----------------------
  if (hasAttribution && hasHallmark) {
    const brandScore = brand.score!;
    const scrapScore = scrap!.score;
    const scoredBy = scrapScore > brandScore ? "scrap" : "brand";
    const gate =
      scoredBy === "scrap"
        ? scrapGate(scrap!, totalCostEur)
        : brandGate(brand, totalCostEur);

    return {
      path: "both",
      tag: "Brand match + Scrap value (confirmed)",
      score: Math.max(brandScore, scrapScore),
      scoredBy,
      brand,
      scrap,
      suspicion: null,
      ...gate,
      summary:
        `${brand.best!.displayName} attribution (${brandScore}) and ${scrap!.label} (${scrapScore}) — ` +
        `taking the higher, from the ${scoredBy} path.`,
    };
  }

  // --- scrap only -----------------------------------------------------------
  if (hasHallmark) {
    return {
      path: "scrap_path",
      tag: "Scrap value (confirmed)",
      score: scrap!.score,
      scoredBy: "scrap",
      brand: null,
      scrap,
      suspicion: null,
      ...scrapGate(scrap!, totalCostEur),
      summary: `Hallmark signal: ${scrap!.label}. No maker attribution found.`,
    };
  }

  // --- brand only -----------------------------------------------------------
  if (hasAttribution) {
    return {
      path: "brand_path",
      tag: "Brand match",
      score: brand.score,
      scoredBy: "brand",
      brand,
      scrap: null,
      suspicion: null,
      ...brandGate(brand, totalCostEur),
      summary: `Attribution signal: ${brand.best!.displayName} (matched "${brand.best!.matchedAlias}"). No precious-metal hallmark visible.`,
    };
  }

  // A mark with no fixed fineness (the French owl/chouette) can't drive a melt
  // calculation, so it never routes to scrap — but it IS worth telling the user
  // about, since it means a real guarantee stamp is present.
  const unusable = detectHallmarks(listingText, aiFlags).unusable;
  const unusableNote = unusable.length
    ? ` A guarantee mark (${unusable.map((u) => u.mark).join(", ")}) is present but its fineness varies, so no melt value can come from it alone — verify alongside a numeric or maker mark.`
    : "";

  // --- no hallmark visible, no attribution: is it a metal-look piece? -------
  if (shouldRunUnmarkedPath(listingText, false)) {
    const suspicion = scoreUnmarkedSuspicion(listingText, metalSignals, totalCostEur);
    return {
      path: "unmarked_suspicion_path",
      tag: "Suspected metal (unconfirmed - review)",
      // No score: this path is explicitly not comparable to a valuation.
      score: null,
      scoredBy: null,
      brand: null,
      scrap: null,
      suspicion,
      buyCandidate: !suspicion.overRiskCap && suspicion.suspicionLevel !== "low",
      // Only the cap is a hard block. A low suspicion level just means this path
      // didn't find enough on its own — the vision filter may still surface it.
      riskSuppressed: suspicion.overRiskCap,
      suppressedReason: suspicion.overRiskCap
        ? `Over the €${UNMARKED_RISK_CAP_EUR.toFixed(2)} unmarked-suspicion risk cap (incl. shipping) — this path is unconfirmed by definition, so the cap applies at every suspicion level.`
        : suspicion.suspicionLevel === "low"
        ? "Suspicion level is low — likely costume or base metal."
        : null,
      riskCapEur: UNMARKED_RISK_CAP_EUR,
      summary:
        `No usable hallmark and no attribution, but the piece reads as metal. ` +
        `Suspicion: ${suspicion.suspicionLevel} (${suspicion.signalsTriggered.length} signal(s)). ${suspicion.signalsMissingNote}${unusableNote}`,
    };
  }

  // --- nothing plausible ----------------------------------------------------
  const qualified = brand.styleQualifiedOnly.length > 0
    ? ` A maker name appears but is qualified as "style"/"inspired by", which is not an attribution.`
    : "";
  return {
    path: "unscored",
    tag: null,
    score: null,
    scoredBy: null,
    brand: null,
    scrap: null,
    suspicion: null,
    buyCandidate: false,
    // No ruleset's risk budget applies here, so nothing blocks the vision
    // pre-filter from surfacing this listing on photo evidence alone.
    riskSuppressed: false,
    suppressedReason: "No maker attribution, no hallmark, and not a metal-look piece.",
    riskCapEur: null,
    summary: `No maker attribution and no usable precious-metal hallmark — not evaluable by any path.${qualified}${unusableNote}`,
  };
}

/**
 * scrap risk_budget.app_behavior — while the weight is unconfirmed the melt
 * estimate is a bet, so anything over the cap is suppressed no matter how good
 * it looks. Once the weight IS confirmed the cap stops applying and the normal
 * underpriced-vs-melt logic takes over.
 */
function scrapGate(scrap: ScrapValuation, totalCostEur?: number) {
  if (scrap.overRiskCap) {
    return {
      buyCandidate: false,
      riskSuppressed: true,
      suppressedReason:
        `Over the €${SCRAP_RISK_CAP_EUR.toFixed(2)} scrap risk cap (incl. shipping) while the weight is unconfirmed — ` +
        `the melt estimate is unverified, so this is not a buy candidate until the seller states a weight.`,
      riskCapEur: SCRAP_RISK_CAP_EUR,
    };
  }
  return { buyCandidate: true, riskSuppressed: false, suppressedReason: null, riskCapEur: SCRAP_RISK_CAP_EUR };
}

/**
 * brand risk_budget.app_behavior — above the cap, do NOT suppress; require a
 * higher confidence bar instead, since strong attribution can genuinely justify
 * a higher price. We read "higher bar" as: a high-scoring maker, or corroborating
 * value multipliers (box/paperwork/sterling/complete set) rather than a bare
 * name match.
 */
const BRAND_HIGH_CONFIDENCE_SCORE = 75;

function brandGate(brand: BrandDetection, totalCostEur?: number) {
  const overCap =
    totalCostEur !== undefined && Number.isFinite(totalCostEur) && totalCostEur > BRAND_RISK_CAP_EUR;

  if (!overCap) {
    return { buyCandidate: true, riskSuppressed: false, suppressedReason: null, riskCapEur: BRAND_RISK_CAP_EUR };
  }

  const strongEnough =
    (brand.score ?? 0) >= BRAND_HIGH_CONFIDENCE_SCORE || brand.multipliers.length > 0;

  return {
    buyCandidate: strongEnough,
    // The brand budget explicitly raises the bar rather than suppressing, so a
    // weak attribution above the cap still reaches the vision filter.
    riskSuppressed: false,
    suppressedReason: strongEnough
      ? null
      : `Over the €${BRAND_RISK_CAP_EUR.toFixed(2)} brand risk cap (incl. shipping), and the attribution rests on a bare name match — ` +
        `needs a legible mark or corroborating signals before it's a buy candidate.`,
    riskCapEur: BRAND_RISK_CAP_EUR,
  };
}

/**
 * Flatten a Valuation into the shared valuation columns on findings /
 * manual_scans. Numeric decimals are stringified because drizzle's `decimal`
 * maps to string, and stay null whenever the underlying figure is unknown.
 */
export function toValuationColumns(v: Valuation) {
  return {
    valuationPath: v.path,
    valuationTag: v.tag,
    valuationScore: v.score,
    scrapMetal: v.scrap?.metal ?? null,
    scrapPurityMillesimal:
      v.scrap?.purityDecimal != null ? Math.round(v.scrap.purityDecimal * 1000) : null,
    scrapWeightGrams: v.scrap?.weightGrams != null ? v.scrap.weightGrams.toFixed(2) : null,
    scrapWeightConfirmed: v.scrap?.weightConfirmed ?? false,
    meltValueEur: v.scrap?.meltValueEur != null ? v.scrap.meltValueEur.toFixed(2) : null,
    underpricedVsMelt: v.scrap?.underpricedVsMelt ?? false,
    suspicionLevel: v.suspicion?.suspicionLevel ?? null,
    suspicionSignals: v.suspicion?.signalsTriggered.map((s) => s.id) ?? [],
    recommendedAction: v.suspicion?.recommendedAction ?? null,
    buyCandidate: v.buyCandidate,
    suppressedReason: v.suppressedReason,
  };
}

/** Short human line for Telegram / logs, e.g. "[Both] Trifari · Silver 925". */
export function describeValuation(v: Valuation): string {
  if (v.path === "unscored") return "[Unscored] no brand, hallmark or metal-look signal";

  const parts: string[] = [];
  if (v.brand?.best) parts.push(v.brand.best.displayName);
  if (v.scrap) {
    parts.push(v.scrap.label);
    if (v.scrap.meltValueEur != null) parts.push(`melt ≈ €${v.scrap.meltValueEur.toFixed(2)} (floor)`);
    if (v.scrap.underpricedVsMelt) parts.push("UNDER MELT");
  }
  if (v.suspicion) {
    parts.push(`suspicion ${v.suspicion.suspicionLevel}`);
    parts.push(`${v.suspicion.signalsTriggered.length} signal(s)`);
  }
  if (!v.buyCandidate && v.suppressedReason) parts.push("SUPPRESSED");

  return `[${v.tag}] ${parts.join(" · ")}`;
}
