/**
 * Zero-cost pre-filter that runs BEFORE the AI vision call.
 *
 * Every AI call spends part of a ~20s scan budget, so a listing the title alone
 * rules out is worth rejecting for free. This is deliberately a blunt instrument
 * with a short, conservative list — a false positive here means a real find is
 * never even looked at, which is far worse than one wasted AI call.
 *
 * Three rules keep it safe:
 *   1. TITLE ONLY. Descriptions of mixed lots mention every material in the box
 *      ("geen namaak tussen"), so matching them would reject the best listings.
 *   2. Only terms that state the piece is NOT precious metal. Plating marks are
 *      absent on purpose: vermeil is gold over STERLING and keeps real silver
 *      value, so "verguld zilver" must survive.
 *   3. Word-boundary matched, so "nep" cannot fire inside "neppel" and "rvs"
 *      cannot fire inside a model code.
 */

/**
 * Default terms, all Dutch/English/French/German declarations of a non-precious
 * piece. Override wholesale with PREFILTER_BANNED_WORDS, or set it empty to
 * disable the filter.
 */
const DEFAULT_BANNED = [
  // explicit fakes
  "replica", "namaak", "nep", "fake", "imitatie", "imitation", "faux",
  // explicitly non-metal bodies
  "plastic", "kunststof", "acryl", "acrylic", "hars", "resin", "siliconen", "silicone",
  // explicitly declared base metal
  "rvs", "roestvrij staal", "roestvrijstaal", "stainless steel", "stainless",
  "edelstaal", "chirurgisch staal", "surgical steel", "acier inoxydable", "edelstahl",
];

function parseBannedWords(): string[] {
  const raw = process.env.PREFILTER_BANNED_WORDS;
  if (raw === undefined) return DEFAULT_BANNED;
  return raw
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

const BANNED = parseBannedWords();

const BANNED_PATTERNS = BANNED.map(
  (word) => new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu"),
);

/**
 * The banned term found in this title, or null when the listing should proceed
 * to the AI pre-filter. Returns the matched term so the skip is explainable in
 * logs rather than silent.
 */
export function bannedTermInTitle(title: string): string | null {
  const haystack = (title || "").toLowerCase();
  if (!haystack) return null;
  for (const [i, pattern] of BANNED_PATTERNS.entries()) {
    if (pattern.test(haystack)) return BANNED[i];
  }
  return null;
}
