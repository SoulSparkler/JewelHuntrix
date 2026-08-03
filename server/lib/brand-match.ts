/**
 * Attribution (brand) signal detection.
 *
 * This exists to answer ONE routing question: does this listing carry a
 * maker/designer attribution signal? It reads docs/brand-ruleset.json as the
 * single source of truth and does not modify or reinterpret it — the score it
 * returns is the ruleset's own `base_score` plus the ruleset's own declared
 * `weight_bonus` multipliers, so the scrap path has something on the same 0-100
 * scale to be compared against.
 *
 * The deep brand knowledge still lives in the vision prompts; this module is
 * deliberately a shallow text matcher, not a replacement for it.
 */

import brandRulesJson from "../../docs/brand-ruleset.json";

const brandRules = brandRulesJson as unknown as {
  risk_budget: { max_total_cost_eur: number; includes_shipping: boolean };
  global_red_flags: Array<{ signal: string; keywords?: string[]; effect: string }>;
  value_multipliers: Array<{ signal: string; keywords: string[]; weight_bonus?: number; note?: string }>;
  brands: Array<{
    id: string;
    display_name: string;
    aliases: string[];
    base_score?: number;
  }>;
};

/**
 * Purchase-risk cap for the brand path (higher than the other two: attribution
 * can often be made with real confidence from photos alone). Shipping is
 * already included in this figure — do not add an allowance on top.
 */
export const BRAND_RISK_CAP_EUR = brandRules.risk_budget.max_total_cost_eur;

export interface BrandMatch {
  id: string;
  displayName: string;
  /** The alias text that matched. */
  matchedAlias: string;
  baseScore: number;
  /** True when "style"/"inspired by" sits next to the name — NOT attributed. */
  styleQualified: boolean;
}

export interface BrandDetection {
  matches: BrandMatch[];
  best: BrandMatch | null;
  /** Multiplier signals present, e.g. "complete_set", "original_packaging". */
  multipliers: Array<{ signal: string; bonus: number }>;
  /** 0-100 brand-path score, or null when there is no attribution signal. */
  score: number | null;
  /** Names found but disqualified by a style qualifier. */
  styleQualifiedOnly: BrandMatch[];
}

const STYLE_QUALIFIERS =
  brandRules.global_red_flags.find((f) => f.signal === "style_qualifier")?.keywords ??
  ["style", "inspired by", "in the manner of", "type", "look"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAlias(text: string, alias: string): number {
  const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`, "i");
  const m = re.exec(text);
  return m ? m.index : -1;
}

/**
 * "Trifari style" / "inspired by Dior" means the seller is describing a
 * lookalike. Check a window on both sides of the name rather than the whole
 * text, so an unrelated "style" elsewhere in a long description doesn't
 * disqualify a genuine attribution.
 */
function isStyleQualified(text: string, at: number, aliasLength: number): boolean {
  const before = text.slice(Math.max(0, at - 30), at);
  const after = text.slice(at + aliasLength, at + aliasLength + 30);
  return STYLE_QUALIFIERS.some(
    (q) => new RegExp(`(?<![a-z])${escapeRegExp(q)}(?![a-z])`, "i").test(before) ||
           new RegExp(`(?<![a-z])${escapeRegExp(q)}(?![a-z])`, "i").test(after),
  );
}

export function detectBrands(listingText: string, aiFlags: string[] = []): BrandDetection {
  const text = `${listingText || ""} ${aiFlags.join(" ; ")}`.toLowerCase();

  const attributed: BrandMatch[] = [];
  const styleQualifiedOnly: BrandMatch[] = [];

  for (const brand of brandRules.brands) {
    for (const alias of brand.aliases) {
      const at = findAlias(text, alias);
      if (at === -1) continue;

      const styleQualified = isStyleQualified(text, at, alias.length);
      const match: BrandMatch = {
        id: brand.id,
        displayName: brand.display_name,
        matchedAlias: alias,
        baseScore: brand.base_score ?? 50,
        styleQualified,
      };
      (styleQualified ? styleQualifiedOnly : attributed).push(match);
      break; // first alias hit is enough per brand
    }
  }

  const multipliers: Array<{ signal: string; bonus: number }> = [];
  for (const mult of brandRules.value_multipliers) {
    if (!mult.weight_bonus) continue;
    if (mult.keywords.some((k) => findAlias(text, k) !== -1)) {
      multipliers.push({ signal: mult.signal, bonus: mult.weight_bonus });
    }
  }

  attributed.sort((a, b) => b.baseScore - a.baseScore);
  const best = attributed[0] ?? null;

  const score = best
    ? Math.min(100, best.baseScore + multipliers.reduce((sum, m) => sum + m.bonus, 0))
    : null;

  return { matches: attributed, best, multipliers, score, styleQualifiedOnly };
}
