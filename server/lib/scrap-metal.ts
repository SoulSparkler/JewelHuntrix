/**
 * Scrap path — melt valuation for pieces with a VISIBLE hallmark.
 *
 * Values a piece by what it is made of (weight x purity x spot price),
 * independent of who made it. Requires a hallmark; pieces with no visible mark
 * go to the unmarked-suspicion path instead (see unmarked-suspicion.ts).
 *
 * Rules taken straight from shared/rulesets/scrap-metal-rules.json and enforced
 * here rather than left to callers:
 *
 *   - weight_handling: never assume a weight to force a score.
 *   - scoring_notes.do_not_flag_on_estimated_weight: only a CONFIRMED weight
 *     may raise an underpriced flag.
 *   - scoring_notes.melt_value_is_a_floor: melt is the scrap floor, NOT a
 *     resale ceiling — an intact wearable piece often sells above it.
 *   - risk_budget: while weight is unconfirmed, hard-suppress anything costing
 *     more than max_total_cost_eur (shipping included in that cap).
 *   - spot_price.update_policy: never hardcode a price; the
 *     reference_values_at_time_of_writing block is deliberately never read.
 */

import rulesJson from "../../shared/rulesets/scrap-metal-rules.json";
import supplementJson from "../../shared/rulesets/hallmark-regional-supplement.json";
import { getSpotPrices, type ScrapMetal } from "./spot-price";

// ---------------------------------------------------------------------------
// Ruleset shape (matches the authoritative handoff file)
// ---------------------------------------------------------------------------

interface MetalBlock {
  marks: string[];
  purity_map: Record<string, number>;
  karat_to_millesimal?: Record<string, string>;
}

const rules = rulesJson as unknown as {
  risk_budget: { max_total_cost_eur: number; includes_shipping: boolean };
  hallmark_lookup: {
    silver: MetalBlock;
    gold: MetalBlock;
    platinum: MetalBlock;
    non_solid_warnings: { marks: string[]; handling: Record<string, string> };
    french_system: {
      marks: Record<string, string>;
      purity_map_reference: Record<string, number>;
    };
  };
};

export const SCRAP_RISK_CAP_EUR = rules.risk_budget.max_total_cost_eur;

export interface HallmarkMatch {
  /** The literal text that matched, e.g. "925" or "eagle head". */
  mark: string;
  metal: ScrapMetal;
  purityDecimal: number | null;
  /** False for gold-filled / plated / rolled-gold marks. */
  solid: boolean;
  /** True when the mark doesn't pin down one fineness (French punches, "plat"). */
  purityUncertain: boolean;
  /** Seller-written text is stronger evidence than an AI photo read. */
  source: "listing_text" | "photo_ai";
  note?: string;
}

// ---------------------------------------------------------------------------
// Building the mark table from the ruleset
// ---------------------------------------------------------------------------

/** Word marks the ruleset lists without a numeric fineness of their own. */
const WORD_MARK_PURITY: Record<string, number | null> = {
  sterling: 0.925,
  ster: 0.925,
  "zilver 925": 0.925,
  "fine silver": 0.999,
  // Platinum word marks: 950 is the dominant jewellery standard, but the mark
  // alone doesn't prove it, so these are flagged purityUncertain below.
  plat: 0.95,
  pt: 0.95,
  "iridium platinum": 0.95,
  "ir plat": 0.95,
};

/** Word marks that name a metal but not a fineness — value conservatively. */
const UNCERTAIN_WORD_MARKS = new Set(["plat", "pt", "iridium platinum", "ir plat"]);

/**
 * Bare platinum abbreviations that are far too collision-prone to trust alone:
 * "plat" is French for a serving dish and "pt" appears in pint/point/Portugal
 * and countless product codes. They only count with a platinum word nearby.
 */
const AMBIGUOUS_ABBREVIATIONS = new Set(["plat", "pt"]);

interface MarkEntry {
  mark: string;
  metal: ScrapMetal;
  purity: number | null;
  uncertain: boolean;
  /**
   * True for marks that are also ordinary words ("crab", "owl", "britannia").
   * These only count when a metal word or hallmark word appears nearby —
   * otherwise every crab brooch reads as a French guarantee punch.
   */
  requiresContext?: boolean;
  note?: string;
}

function buildMetalEntries(metal: ScrapMetal, block: MetalBlock): MarkEntry[] {
  const entries: MarkEntry[] = [];
  // purity_map keys are finenesses in their own right (e.g. silver 958 is in
  // the map but not in `marks`), so treat both sources as marks.
  const marks = new Set<string>([...block.marks, ...Object.keys(block.purity_map)]);

  for (const raw of marks) {
    const mark = raw.toLowerCase();
    let purity: number | null = null;

    if (block.purity_map[mark] !== undefined) {
      purity = block.purity_map[mark];
    } else if (block.karat_to_millesimal?.[mark]) {
      purity = block.purity_map[block.karat_to_millesimal[mark]] ?? null;
    } else if (mark in WORD_MARK_PURITY) {
      purity = WORD_MARK_PURITY[mark];
    } else {
      // Karat spellings the ruleset lists as marks but doesn't map ("14ct",
      // "9ct", "22ct"): normalise "Nct" to "Nk" and retry.
      const asK = mark.replace(/ct$/, "k");
      const mapped = block.karat_to_millesimal?.[asK];
      if (mapped) purity = block.purity_map[mapped] ?? null;
    }

    entries.push({
      mark,
      metal,
      purity,
      uncertain: UNCERTAIN_WORD_MARKS.has(mark),
      requiresContext: AMBIGUOUS_ABBREVIATIONS.has(mark),
    });
  }
  return entries;
}

function buildFrenchEntries(): MarkEntry[] {
  const fr = rules.hallmark_lookup.french_system;
  const ref = fr.purity_map_reference;
  const out: MarkEntry[] = [];

  const push = (marks: string[], metal: ScrapMetal, purity: number | null, note: string) => {
    for (const m of marks) out.push({ mark: m, metal, purity, uncertain: true, note });
  };

  if (ref.eagle_head !== undefined) {
    push(["eagle head", "eagle's head", "tete d'aigle", "tête d'aigle"], "gold", ref.eagle_head,
      "French 18k gold guarantee (tête d'aigle).");
  }
  if (ref.boar_head_or_crab !== undefined) {
    push(["boar head", "boar's head", "hure de sanglier"], "silver", ref.boar_head_or_crab,
      "French silver guarantee (hure de sanglier); the punch alone doesn't distinguish the 0.800 and 0.950 standards, so the conservative value is used.");
    push(["crab", "crabe"], "silver", ref.boar_head_or_crab,
      "French silver guarantee (crab); conservative fineness used.");
  }
  if (fr.marks.owl) {
    // The ruleset says owl = various purities, verify alongside another mark.
    // No fineness => detected and reported, but never valued.
    push(["owl", "chouette"], "gold", null,
      "French import/small-work mark (chouette) — purity varies, so no melt value can be derived from it alone. Verify alongside a numeric or maker mark.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regional supplement (France / Belgium / Italy / Spain / UK)
//
// A LOCAL addition layered on top of the handoff ruleset, which stays
// unmodified. It fills the gaps that matter for European sourcing: the Spanish
// 915 standard, Dutch/Belgian 833 and 835 silver, the French Minerve, swan and
// dog's-head punches, and the English pictorial standard marks.
// ---------------------------------------------------------------------------

interface SupplementEntry {
  marks: string[];
  purity_decimal: number;
  purity_uncertain?: boolean;
  requires_context?: boolean;
  note?: string;
}

const supplement = supplementJson as unknown as {
  matching_rules: {
    high_signal_numeric_additions: string[];
    base_ruleset_marks_needing_context: { marks: string[] };
  };
  regions: Record<string, Partial<Record<"gold" | "silver" | "platinum", SupplementEntry[]>> & { note?: string }>;
  metal_context_word_additions: Record<string, string[]>;
  non_solid_additions: { marks: string[] };
};

function buildSupplementEntries(): MarkEntry[] {
  const out: MarkEntry[] = [];
  for (const region of Object.values(supplement.regions)) {
    for (const metal of ["gold", "silver", "platinum"] as const) {
      for (const entry of region[metal] ?? []) {
        for (const mark of entry.marks) {
          out.push({
            mark: mark.toLowerCase(),
            metal,
            purity: entry.purity_decimal,
            uncertain: entry.purity_uncertain === true,
            requiresContext: entry.requires_context === true,
            note: entry.note,
          });
        }
      }
    }
  }
  return out;
}

/** Base-ruleset marks that are ordinary words and need the same guard. */
const BASE_MARKS_NEEDING_CONTEXT = new Set(
  supplement.matching_rules.base_ruleset_marks_needing_context.marks.map((m) => m.toLowerCase()),
);

const SOLID_ENTRIES: MarkEntry[] = dedupeEntries([
  ...buildMetalEntries("silver", rules.hallmark_lookup.silver),
  ...buildMetalEntries("gold", rules.hallmark_lookup.gold),
  ...buildMetalEntries("platinum", rules.hallmark_lookup.platinum),
  ...buildFrenchEntries(),
  ...buildSupplementEntries(),
]).map((e) =>
  BASE_MARKS_NEEDING_CONTEXT.has(e.mark) ? { ...e, requiresContext: true } : e,
);

/**
 * The base ruleset and the supplement can name the same mark (e.g. 916). Keep
 * the first occurrence per mark+metal so the authoritative file wins.
 */
function dedupeEntries(entries: MarkEntry[]): MarkEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.metal}:${e.mark}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const NON_SOLID_MARKS: string[] = rules.hallmark_lookup.non_solid_warnings.marks.map((m) => m.toLowerCase());

/**
 * Silver-side plating marks. The handoff ruleset's non_solid_warnings covers
 * GOLD plating only, so a "verzilverd"/EPNS listing mentioning 800 or 925 would
 * otherwise score as solid silver. Now sourced from the supplement file.
 */
const LOCAL_SILVER_PLATE_GUARDS: string[] = supplement.non_solid_additions.marks.map((m) => m.toLowerCase());

/** Vermeil = gold over a STERLING base, so the silver is real (ruleset handling). */
const VERMEIL_MARKS = ["vermeil", "silver gilt", "gilt sterling"];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Bare numbers that read unambiguously as jewellery fineness. Everything else
 * numeric needs an explicit metal word nearby — otherwise a €800 price or a
 * "999 pieces" count gets scored as a hallmark. Note 999/900 map to more than
 * one metal in the ruleset, so they are deliberately NOT high-signal.
 */
const HIGH_SIGNAL_NUMERIC = new Set([
  "375", "585", "750", "916", "925", "958",
  // Distinctive regional finenesses that don't read as prices or quantities:
  // 915 (Spain), 833/835/830 (Low Countries & Scandinavia), 417/583.
  ...supplement.matching_rules.high_signal_numeric_additions,
]);

const METAL_CONTEXT_WORDS: Record<ScrapMetal, string[]> = {
  gold: ["gold", "golden", ...(supplement.metal_context_word_additions.gold ?? [])],
  silver: ["silver", "sterling", ...(supplement.metal_context_word_additions.silver ?? [])],
  // "plat" and "pt" are deliberately NOT context words even though they are
  // platinum marks: they would corroborate themselves, and "plat" is also
  // French for a serving dish.
  platinum: ["platinum", ...(supplement.metal_context_word_additions.platinum ?? [])],
};

const MARK_CONTEXT_WORDS = [
  "hallmark", "hallmarked", "stamp", "stamped", "mark", "marked", "keurmerk",
  "gestempeld", "gemerkt", "stempel", "poincon", "poinçon",
  // Italian / Spanish / French equivalents, so a seller writing in their own
  // language still corroborates an ambiguous mark.
  "punzone", "punzonato", "punzon", "punzón", "contraste", "marchio", "bollo",
  "titolo", "sello", "assay", "assayed",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNumericMark(mark: string): boolean {
  return /^\d+$/.test(mark);
}

/** Does `mark` appear in `text` as a standalone token (not inside a number/word)? */
function containsMark(text: string, mark: string): boolean {
  if (isNumericMark(mark)) {
    // "1925"/"9250" are not 925 and "1.750" is not 750, but ordinary
    // punctuation ("750, 5 gram") must still match.
    const re = new RegExp(`(?<!\\d)(?<!\\d[.,])${mark}(?!\\d)(?![.,]\\d)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      const after = text.slice(m.index + mark.length, m.index + mark.length + 12);
      if (/[€$£]\s*$/.test(before)) continue;              // "€750"
      if (/^\s*(euro|eur|dollar|usd|,-)/i.test(after)) continue; // "750 euro"
      return true;
    }
    return false;
  }
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(mark)}(?![a-z0-9])`, "i").test(text);
}

function hasMetalContext(text: string, metal: ScrapMetal): boolean {
  return METAL_CONTEXT_WORDS[metal].some((w) => containsMark(text, w));
}

function hasMarkContext(text: string): boolean {
  return MARK_CONTEXT_WORDS.some((w) => containsMark(text, w));
}

function matchSolid(text: string, source: HallmarkMatch["source"]): HallmarkMatch[] {
  const out: HallmarkMatch[] = [];
  for (const entry of SOLID_ENTRIES) {
    if (!containsMark(text, entry.mark)) continue;

    // Ambiguous bare numbers, and marks that are also ordinary words ("crab",
    // "owl", "britannia", "swan"), need corroboration before we believe them.
    const needsContext =
      entry.requiresContext ||
      (isNumericMark(entry.mark) && !HIGH_SIGNAL_NUMERIC.has(entry.mark));

    if (needsContext && !hasMetalContext(text, entry.metal) && !hasMarkContext(text)) {
      continue;
    }
    out.push({
      mark: entry.mark,
      metal: entry.metal,
      purityDecimal: entry.purity,
      solid: true,
      purityUncertain: entry.uncertain,
      source,
      note: entry.note,
    });
  }
  return out;
}

function matchList(text: string, marks: string[]): string[] {
  return marks.filter((m) => containsMark(text, m));
}

export interface HallmarkDetection {
  /** Solid precious-metal marks that survived plating suppression. */
  solid: HallmarkMatch[];
  /** Plating / filled marks found (gold-filled, GP, RGP, plus local guards). */
  notSolidMarks: string[];
  /**
   * Marks detected but with no resolvable fineness (the French owl/chouette,
   * whose purity varies). These cannot drive a melt calculation, so they never
   * become `best` — but they are real observations worth surfacing.
   */
  unusable: HallmarkMatch[];
  /** The mark the scrap path should be valued on, if any. */
  best: HallmarkMatch | null;
  /** True when a plating mark suppressed an otherwise-solid reading. */
  suppressed: boolean;
  /** Gold-filled specifically: has SOME scrap value, unlike plating. */
  goldFilled: boolean;
}

/**
 * Find precious-metal marks in a listing.
 *
 * @param listingText Seller-written title + description.
 * @param aiFlags     Short observations the vision model made from the photos.
 */
export function detectHallmarks(listingText: string, aiFlags: string[] = []): HallmarkDetection {
  const text = (listingText || "").toLowerCase();
  const aiText = (aiFlags.join(" ; ") || "").toLowerCase();
  const both = `${text} ${aiText}`;

  const nonSolidHits = [
    ...matchList(both, NON_SOLID_MARKS.filter((m) => !VERMEIL_MARKS.includes(m))),
    ...matchList(both, LOCAL_SILVER_PLATE_GUARDS),
  ];
  const isVermeil = matchList(both, VERMEIL_MARKS).length > 0;
  const goldFilled = /\b(gf|gold[- ]filled|rgp|rolled gold)\b/i.test(both);

  let candidates = [...matchSolid(text, "listing_text"), ...matchSolid(aiText, "photo_ai")];

  // A plating mark kills the metal it refers to. Gold-plating marks must not
  // veto a silver mark, and the silver-plate guards must not veto a gold mark.
  const goldPlating = nonSolidHits.some((m) => /gf|gold|rgp|rolled|gp/i.test(m));
  const silverPlating = nonSolidHits.some((m) => LOCAL_SILVER_PLATE_GUARDS.includes(m));

  const before = candidates.length;
  candidates = candidates.filter((c) => {
    if (c.metal === "gold" && goldPlating) return false;
    if (c.metal === "silver" && silverPlating) return false;
    return true;
  });
  const suppressed = candidates.length < before;

  // Vermeil: the gold layer is worthless but the sterling base is real.
  if (isVermeil && !candidates.some((c) => c.metal === "silver")) {
    candidates.push({
      mark: "vermeil",
      metal: "silver",
      purityDecimal: 0.925,
      solid: true,
      purityUncertain: false,
      source: "listing_text",
      note: "Vermeil is gold over a sterling base — the silver is valued, the gold plating ignored. Verify the base really is sterling.",
    });
  }

  // Prefer seller-stated marks over AI photo reads, then higher purity.
  candidates.sort((a, b) => {
    if (a.source !== b.source) return a.source === "listing_text" ? -1 : 1;
    return (b.purityDecimal ?? 0) - (a.purityDecimal ?? 0);
  });

  // A mark with no fineness cannot drive the melt formula, so it must not
  // claim the scrap path — that would surface "Scrap value (confirmed)" for a
  // listing that can never produce a value.
  const usable = candidates.filter((c) => c.purityDecimal !== null);
  const unusable = candidates.filter((c) => c.purityDecimal === null);

  return {
    solid: usable,
    notSolidMarks: nonSolidHits,
    unusable,
    best: usable[0] ?? null,
    suppressed: suppressed && candidates.length === 0,
    goldFilled,
  };
}

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

export interface WeightDetection {
  grams: number | null;
  confirmed: boolean;
  /** Why no confirmed weight is available — surfaced to the user verbatim. */
  reason: string;
}

const MIN_PLAUSIBLE_GRAMS = 0.1;
const MAX_PLAUSIBLE_GRAMS = 2000;

/**
 * Pull a stated weight out of listing text. Only a weight the SELLER stated
 * counts as confirmed. Several different weights in one listing means we do not
 * pick one — that assumption is exactly what weight_handling forbids.
 */
export function detectWeight(listingText: string): WeightDetection {
  const text = (listingText || "").toLowerCase();
  const found = new Set<number>();

  const gramRe = /(?<![\d.,])(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:g|gr|gram|grams|gramme|grammes|gramm|grammen)(?![a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = gramRe.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(",", "."));
    if (value >= MIN_PLAUSIBLE_GRAMS && value <= MAX_PLAUSIBLE_GRAMS) found.add(value);
  }

  const kgRe = /(?<![\d.,])(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:kg|kilo|kilogram)(?![a-z])/gi;
  while ((m = kgRe.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(",", ".")) * 1000;
    if (value >= MIN_PLAUSIBLE_GRAMS && value <= MAX_PLAUSIBLE_GRAMS) found.add(value);
  }

  if (found.size === 0) return { grams: null, confirmed: false, reason: "No weight stated in the listing" };
  if (found.size > 1) {
    return {
      grams: null,
      confirmed: false,
      reason: `Listing states multiple weights (${[...found].sort((a, b) => a - b).join("g, ")}g) — which one is the metal is unclear`,
    };
  }
  return { grams: [...found][0], confirmed: true, reason: "Weight stated by the seller" };
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

export interface ScrapValuation {
  /** e.g. "Silver 925" or "Gold 750 - weight unconfirmed". */
  label: string;
  metal: ScrapMetal;
  purityDecimal: number | null;
  purityUncertain: boolean;
  hallmark: HallmarkMatch;

  weightGrams: number | null;
  weightConfirmed: boolean;
  weightReason: string;

  /** Melt value in EUR. Null whenever weight or spot price is missing. */
  meltValueEur: number | null;
  spotPriceEurPerGram: number | null;
  spotPriceAsOf: string | null;
  spotPriceStale: boolean;
  valueUnavailableReason: string | null;

  /** 0-100, comparable with the brand path. */
  score: number;
  /** Only ever true with a CONFIRMED weight and a fresh spot price. */
  underpricedVsMelt: boolean;
  /** True when risk_budget suppresses this as a buy candidate. */
  overRiskCap: boolean;
  riskCapEur: number;
  notes: string[];
}

/**
 * Score a listing on the scrap path. Returns null when no solid precious-metal
 * mark is present — that is a routing decision for the caller, not a zero.
 *
 * @param totalCostEur asking price + shipping, for the underpriced comparison
 *                     and the risk-budget cap. Omit to skip both.
 */
export async function valuateScrap(
  listingText: string,
  aiFlags: string[] = [],
  totalCostEur?: number,
): Promise<ScrapValuation | null> {
  const detection = detectHallmarks(listingText, aiFlags);
  const hallmark = detection.best;
  if (!hallmark) return null;

  const metal = hallmark.metal;
  const weight = detectWeight(listingText);
  const notes: string[] = [];

  if (hallmark.source === "photo_ai") {
    notes.push("Hallmark read from photos by AI, not stated by the seller — verify before buying.");
  }
  if (hallmark.note) notes.push(hallmark.note);
  if (hallmark.purityUncertain && hallmark.purityDecimal !== null) {
    notes.push(`"${hallmark.mark}" doesn't pin down a single fineness; valued at the conservative ${hallmark.purityDecimal}.`);
  }
  if (detection.goldFilled) {
    notes.push("Gold-filled marks present: a bonded layer (~1/20 of weight) with some scrap value, but far below solid gold. Not valued as solid here.");
  }
  if (detection.notSolidMarks.length > 0) {
    notes.push(`Plating marks also present (${detection.notSolidMarks.join(", ")}) — check which piece they refer to.`);
  }

  const spot = await getSpotPrices();
  const spotPrice = spot.available ? spot.prices.eurPerGram[metal] ?? null : null;

  let meltValueEur: number | null = null;
  let valueUnavailableReason: string | null = null;

  if (!weight.confirmed || weight.grams === null) {
    valueUnavailableReason = weight.reason;
    notes.push("Ask the seller for the weight in grams to turn this into a melt figure.");
  } else if (spotPrice === null) {
    valueUnavailableReason = spot.available
      ? `No EUR/gram spot price available for ${metal}`
      : `Spot price unavailable: ${spot.reason}`;
  } else {
    // melt_value_formula. purityDecimal is non-null here: detectHallmarks only
    // returns marks with a resolvable fineness as `best`.
    meltValueEur = weight.grams * hallmark.purityDecimal! * spotPrice;
    // melt_value_is_a_floor — do NOT present this as a resale ceiling.
    notes.push("Melt value is the scrap floor, not a resale ceiling — an intact wearable piece often sells above it.");
  }

  if (spot.available && spot.prices.stale) {
    notes.push(`Spot price is ${Math.round(spot.prices.ageHours)}h old (source: ${spot.prices.source}) — refresh before acting.`);
  }

  // scoring_notes.underpriced_signal: asking price incl. shipping below melt,
  // with weight CONFIRMED (do_not_flag_on_estimated_weight).
  const underpricedVsMelt =
    weight.confirmed &&
    meltValueEur !== null &&
    totalCostEur !== undefined &&
    Number.isFinite(totalCostEur) &&
    spot.available &&
    !spot.prices.stale &&
    totalCostEur < meltValueEur;

  // risk_budget: while the weight is unconfirmed the whole estimate is a bet,
  // so anything over the cap is suppressed no matter how good it looks. Once
  // the weight is genuinely confirmed the cap no longer applies.
  const overRiskCap =
    !weight.confirmed &&
    totalCostEur !== undefined &&
    Number.isFinite(totalCostEur) &&
    totalCostEur > SCRAP_RISK_CAP_EUR;

  if (overRiskCap) {
    notes.push(
      `Over the €${SCRAP_RISK_CAP_EUR.toFixed(2)} scrap risk cap (incl. shipping) while the weight is unconfirmed — not a buy candidate until the seller states a weight.`,
    );
  }

  const purityLabel = hallmark.purityDecimal !== null ? String(Math.round(hallmark.purityDecimal * 1000)) : hallmark.mark;
  const metalLabel = metal.charAt(0).toUpperCase() + metal.slice(1);
  const label = weight.confirmed ? `${metalLabel} ${purityLabel}` : `${metalLabel} ${purityLabel} - weight unconfirmed`;

  return {
    label,
    metal,
    purityDecimal: hallmark.purityDecimal,
    purityUncertain: hallmark.purityUncertain,
    hallmark,
    weightGrams: weight.grams,
    weightConfirmed: weight.confirmed,
    weightReason: weight.reason,
    meltValueEur,
    spotPriceEurPerGram: spotPrice,
    spotPriceAsOf: spot.available ? spot.prices.lastUpdatedTimestamp : null,
    spotPriceStale: spot.available ? spot.prices.stale : false,
    valueUnavailableReason,
    score: scrapScore(hallmark, weight, underpricedVsMelt),
    underpricedVsMelt,
    overRiskCap,
    riskCapEur: SCRAP_RISK_CAP_EUR,
    notes,
  };
}

/**
 * 0-100 scrap score on the same scale as the brand path so `max` can compare
 * them. Driven by fineness, then adjusted for how solid the evidence is.
 */
function scrapScore(hallmark: HallmarkMatch, weight: WeightDetection, underpriced: boolean): number {
  const purity = hallmark.purityDecimal ?? 0;
  // Gold and platinum carry far more value per gram than silver, so equal
  // fineness does not mean equal interest.
  const metalWeighting: Record<ScrapMetal, number> = { gold: 1, platinum: 1, silver: 0.72 };
  let score = 40 + purity * 50 * metalWeighting[hallmark.metal];

  if (weight.confirmed) score += 8;
  if (hallmark.source === "photo_ai") score -= 10;
  if (hallmark.purityUncertain) score -= 5;
  if (underpriced) score = Math.max(score, 92);

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Post-purchase guidance from the ruleset — shown as a "verify in hand" hint. */
export const quickPhysicalTests = (rulesJson as any).quick_physical_tests as Array<{
  test: string;
  method: string;
  read: string;
}>;
