/**
 * Path 3 — unmarked precious-metal suspicion.
 *
 * For pieces with NO hallmark visible in the photos or text, which might still
 * be real gold or silver. This is the path the whole project originally existed
 * for: catching real metal that isn't properly marked, or where the mark simply
 * isn't in frame.
 *
 * HARD RULE (suspicion_score_model.hard_rule, enforced by the types below):
 * this path NEVER outputs a euro value or a "this is gold/silver" claim. The
 * maximum output is a suspicion level, the signals that drove it, and a
 * recommended next action. There is deliberately no value field to populate.
 *
 * Everything here is photo/text-only — no magnet, acid or loupe. Those are
 * post-purchase buyer actions and are out of scope for the app.
 *
 * Also note routing_trigger.important: "no hallmark visible in photos" is NOT
 * "no hallmark on the piece". Sellers rarely photograph the inside of a ring
 * band or a clasp. This path always says "not visible", never "absent".
 */

import rulesJson from "../../shared/rulesets/unmarked-metal-suspicion.json";

interface RawSignal {
  signal: string;
  suggests?: string;
  weight?: string;
  caution?: string;
  note?: string;
}

const rules = rulesJson as unknown as {
  risk_budget: { max_total_cost_eur: number };
  visual_signals: Record<string, RawSignal[]>;
  suspicion_score_model: {
    levels: string[];
    low: { meaning: string; recommended_action: string };
    medium: { meaning: string; recommended_action: string };
    high: { meaning: string; recommended_action: string };
  };
  output_format_suggestion: { fields: string[] };
};

export const UNMARKED_RISK_CAP_EUR = rules.risk_budget.max_total_cost_eur;

export const SUSPICION_DISCLAIMER =
  "Visual suspicion only - not a confirmed material identification. No melt value should be calculated from this path.";

export type SuspicionLevel = "low" | "medium" | "high";
export type SignalCategory =
  | "color_and_tone"
  | "wear_and_tarnish_pattern"
  | "solder_and_construction"
  | "weight_and_form_inference"
  | "listing_text_clues";

/**
 * Stable IDs for the ruleset's signals. The ruleset lists signals positionally
 * with no IDs of its own, so each entry here binds an ID to a category + index.
 * Descriptions and weights are then read FROM the ruleset, keeping that file
 * authoritative — if a weight changes there, it changes here.
 */
interface SignalDef {
  id: string;
  category: SignalCategory;
  index: number;
  /** Set for signals a model cannot see — matched from listing text instead. */
  textPatterns?: RegExp;
}

const SIGNAL_DEFS: SignalDef[] = [
  { id: "warm_buttery_yellow", category: "color_and_tone", index: 0 },
  { id: "bright_greenish_uniform", category: "color_and_tone", index: 1 },
  { id: "grayish_white_warm_sheen", category: "color_and_tone", index: 2 },
  { id: "cold_bluish_mirror_shine", category: "color_and_tone", index: 3 },

  { id: "blotchy_tarnish_in_recesses", category: "wear_and_tarnish_pattern", index: 0 },
  { id: "wear_through_to_other_metal", category: "wear_and_tarnish_pattern", index: 1 },
  { id: "even_colour_at_friction_points", category: "wear_and_tarnish_pattern", index: 2 },
  { id: "green_residue_skin_contact", category: "wear_and_tarnish_pattern", index: 3 },

  { id: "colour_matched_solder", category: "solder_and_construction", index: 0 },
  { id: "mismatched_solder", category: "solder_and_construction", index: 1 },
  { id: "seamless_cast", category: "solder_and_construction", index: 2 },
  { id: "pitting_or_grainy_surface", category: "solder_and_construction", index: 3 },

  { id: "thick_substantial_form", category: "weight_and_form_inference", index: 0 },
  { id: "drapes_heavily", category: "weight_and_form_inference", index: 1 },

  // Text clues are matched in code rather than by the vision model.
  {
    id: "heirloom_or_unknown_origin",
    category: "listing_text_clues",
    index: 0,
    textPatterns:
      /\b(oma'?s?|opa'?s?|erfstuk|erfstukken|nalatenschap|geërfd|geerfd|gevonden|zolder|grandma'?s?|heirloom|estate|inherited|weet niet meer waar vandaan)\b/i,
  },
  {
    id: "seller_unsure_of_material",
    category: "listing_text_clues",
    index: 1,
    textPatterns:
      /(lijkt goud|lijkt zilver|zou (goud|zilver) kunnen zijn|weet niet of het echt is|mogelijk (goud|zilver)|geen idee of|niet zeker of|might be (gold|silver)|looks like (gold|silver)|not sure if (it'?s )?real)/i,
  },
  {
    id: "seller_states_costume",
    category: "listing_text_clues",
    index: 2,
    textPatterns: /\b(namaak|nep|nepsieraad|modesieraad|fantasie|fantasiesieraad|imitatie|costume jewell?ery|fake)\b/i,
  },
];

const BY_ID = new Map(SIGNAL_DEFS.map((d) => [d.id, d]));

/** All IDs a vision model may report — used to build the prompt vocabulary. */
export const VISUAL_SIGNAL_IDS = SIGNAL_DEFS.filter((d) => !d.textPatterns).map((d) => d.id);

/** Extra observation the model can report: the mark area simply isn't in frame. */
export const HALLMARK_AREA_NOT_PHOTOGRAPHED = "hallmark_area_not_photographed";

function rawFor(def: SignalDef): RawSignal | undefined {
  return rules.visual_signals[def.category]?.[def.index];
}

/**
 * Turn the ruleset's prose weights into numbers.
 * "raises priority, not confidence" contributes nothing to the level — it only
 * bumps triage order, exactly as the ruleset specifies.
 */
function weightOf(raw: RawSignal | undefined): { points: number; priorityOnly: boolean; strongNegative: boolean } {
  const w = (raw?.weight || "").toLowerCase();
  if (w.includes("priority")) return { points: 0, priorityOnly: true, strongNegative: false };
  if (w.includes("neutral")) return { points: 0, priorityOnly: false, strongNegative: false };

  const negative = w.includes("negative");
  const magnitude = w.includes("high") ? 4 : w.includes("medium") ? 2 : w.includes("low") ? 1 : 0;
  return {
    points: negative ? -magnitude : magnitude,
    priorityOnly: false,
    strongNegative: negative && w.includes("high"),
  };
}

export interface TriggeredSignal {
  id: string;
  category: SignalCategory;
  description: string;
  suggests?: string;
  caution?: string;
  points: number;
  priorityOnly: boolean;
}

/** Shape from output_format_suggestion. Deliberately has no value field. */
export interface SuspicionResult {
  suspicionLevel: SuspicionLevel;
  signalsTriggered: TriggeredSignal[];
  signalsMissingNote: string;
  recommendedAction: string;
  explicitDisclaimer: string;
  /** Raw weighted sum — triage only, not a probability. */
  rawScore: number;
  /** True when heirloom/uncertain-seller clues bump review order. */
  priorityBoost: boolean;
  /** True when risk_budget suppresses this as a buy candidate. */
  overRiskCap: boolean;
  riskCapEur: number;
}

/** Item types the routing trigger considers "a metal-look piece". */
const METAL_LOOK_ITEM =
  /\b(ring|ringen|ketting|kettingen|collier|chain|necklace|armband|armbanden|bracelet|bangle|hanger|pendant|medaillon|locket|broche|brooch|oorbel\w*|earring\w*|manchetknop\w*|cufflink\w*)\b/i;

/**
 * routing_trigger: a metal-look piece with no hallmark visible in photos or
 * mentioned in text. Callers pass `hallmarkVisible` from the scrap path's
 * detection so the two paths stay consistent.
 */
export function shouldRunUnmarkedPath(listingText: string, hallmarkVisible: boolean): boolean {
  if (hallmarkVisible) return false;
  return METAL_LOOK_ITEM.test(listingText || "");
}

/**
 * Score the unmarked-suspicion path.
 *
 * @param listingText    Title + description.
 * @param observedSignals Signal IDs the vision model reported seeing, plus
 *                        optionally HALLMARK_AREA_NOT_PHOTOGRAPHED.
 * @param totalCostEur   asking price + shipping, for the risk cap.
 */
export function scoreUnmarkedSuspicion(
  listingText: string,
  observedSignals: string[] = [],
  totalCostEur?: number,
): SuspicionResult {
  const text = listingText || "";
  const triggered: TriggeredSignal[] = [];
  const seen = new Set<string>();

  const add = (def: SignalDef) => {
    if (seen.has(def.id)) return;
    const raw = rawFor(def);
    if (!raw) return;
    const { points, priorityOnly } = weightOf(raw);
    seen.add(def.id);
    triggered.push({
      id: def.id,
      category: def.category,
      description: raw.signal,
      suggests: raw.suggests,
      caution: raw.caution || raw.note,
      points,
      priorityOnly,
    });
  };

  // Visual signals reported by the model.
  for (const id of observedSignals) {
    const def = BY_ID.get(id);
    if (def && !def.textPatterns) add(def);
  }
  // Text clues matched here.
  for (const def of SIGNAL_DEFS) {
    if (def.textPatterns && def.textPatterns.test(text)) add(def);
  }

  const positives = triggered.filter((s) => s.points > 0);
  const negatives = triggered.filter((s) => s.points < 0);
  const strongNegative = triggered.some((s) => {
    const raw = rawFor(BY_ID.get(s.id)!);
    return weightOf(raw).strongNegative;
  });
  const rawScore = triggered.reduce((sum, s) => sum + s.points, 0);
  const priorityBoost = triggered.some((s) => s.priorityOnly && s.category === "listing_text_clues");

  const hallmarkPlausiblyHidden = observedSignals.includes(HALLMARK_AREA_NOT_PHOTOGRAPHED);
  const distinctPositiveCategories = new Set(positives.map((s) => s.category)).size;
  const mediumPlusPositives = positives.filter((s) => s.points >= 2).length;

  // Thresholds straight from suspicion_score_model.
  let level: SuspicionLevel;
  if (strongNegative) {
    level = "low";
  } else if (
    positives.length >= 3 &&
    distinctPositiveCategories >= 3 &&
    negatives.length === 0 &&
    hallmarkPlausiblyHidden
  ) {
    level = "high";
  } else if (mediumPlusPositives >= 2 && !strongNegative) {
    level = "medium";
  } else {
    level = "low";
  }

  const overRiskCap =
    totalCostEur !== undefined && Number.isFinite(totalCostEur) && totalCostEur > UNMARKED_RISK_CAP_EUR;

  const missingNote = hallmarkPlausiblyHidden
    ? "Hallmark area (clasp / inside of band) not photographed - a mark may be present but unseen."
    : "Hallmark not visible in the available photos. This is 'not visible', not 'absent'.";

  let recommendedAction = rules.suspicion_score_model[level].recommended_action;
  if (overRiskCap) {
    recommendedAction =
      `Over the €${UNMARKED_RISK_CAP_EUR.toFixed(2)} risk cap (incl. shipping) - do not buy on suspicion alone at this price, ` +
      `regardless of suspicion level. ${recommendedAction}`;
  }

  return {
    suspicionLevel: level,
    signalsTriggered: triggered,
    signalsMissingNote: missingNote,
    recommendedAction,
    explicitDisclaimer: SUSPICION_DISCLAIMER,
    rawScore,
    priorityBoost,
    overRiskCap,
    riskCapEur: UNMARKED_RISK_CAP_EUR,
  };
}

/** Human-readable signal vocabulary for the vision prompt. */
export function describeSignalVocabulary(): string {
  return SIGNAL_DEFS.filter((d) => !d.textPatterns)
    .map((d) => {
      const raw = rawFor(d);
      return `- ${d.id}: ${raw?.signal ?? ""}`;
    })
    .join("\n");
}
