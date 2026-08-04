# Valuation paths

JewelHuntrix scores a listing across **three independent paths**:

| Path | Question it answers | Ruleset | Risk cap |
|---|---|---|---|
| `brand_path` | Valuable because of **who made it**? | `docs/brand-ruleset.json` | €25 |
| `scrap_path` | Valuable because of **what it's made of**? (needs a **visible hallmark**) | `shared/rulesets/scrap-metal-rules.json` | €10 |
| `unmarked_suspicion_path` | **No hallmark visible** — could it still be real metal? | `shared/rulesets/unmarked-metal-suspicion.json` | €10 |

The third path is the one the project originally existed for: catching real gold
or silver that isn't properly marked, or where the mark just isn't in the photos.

Brand and scrap share no assumptions, so when both fire they are scored
**separately and the maximum is taken** — never the average, which would drag a
strong signal down toward a weak one and bury exactly the finds worth having.

## Routing

Runs before any scoring, in `server/lib/valuation.ts`:

| Attribution | Hallmark visible | Route | UI tag |
|---|---|---|---|
| yes | no | `brand_path` | `Brand match` |
| no | yes | `scrap_path` | `Scrap value (confirmed)` |
| yes | yes | `both` (max) | `Brand match + Scrap value (confirmed)` |
| no | no, but metal-look piece | `unmarked_suspicion_path` | `Suspected metal (unconfirmed - review)` |
| no | no, not metal-look | `unscored` | *(no tag)* |

`unscored` produces **no value at all**. Nothing is fabricated to fill the gap.

> **"Not visible" is not "absent."** Sellers rarely photograph the inside of a ring
> band or a clasp. Path 3 always reports the hallmark as *not visible*, never as
> *absent* (`routing_trigger.important`).

## Risk budgets

Each ruleset carries a `risk_budget`. These are **purchase-risk caps, not value
ceilings** — they limit how much to stake on a bet that can only be settled once
the piece is in hand. **Shipping is already included in each cap**, so the test is
`asking_price + shipping <= max_total_cost_eur`; do not add an allowance on top.

- **scrap (€10)** — hard suppress. Applies *while the weight is unconfirmed*. Once
  the seller states a weight the cap stops applying and the normal
  underpriced-vs-melt logic takes over.
- **unmarked (€10)** — hard suppress at **every** suspicion level, including `high`.
  A high score means the visuals are more consistent with precious metal, not that
  the material is confirmed.
- **brand (€25)** — **raise the confidence bar, don't suppress**. Above the cap a
  bare name match isn't enough; it needs a high-scoring maker or corroborating
  multipliers (box, paperwork, sterling, complete set).

A suppressed listing never surfaces as a find, however well it scored.

## Melt value (scrap path)

```
melt_value_eur = weight_grams * purity_decimal * spot_price_eur_per_gram
```

**Melt value is a floor, not a ceiling** (`scoring_notes.melt_value_is_a_floor`).
It's the minimum defensible scrap value — an intact, wearable piece routinely sells
*above* it for styling or brand reasons, so nothing caps a listing's value at melt.

`underpriced_signal` fires when asking price incl. shipping is below melt value,
**with the weight confirmed**.

### The three things this path refuses to do

Enforced in code, not left to the caller:

1. **Never assumes a weight.** Most listings don't state one. A missing weight means
   the melt value is unknown — the listing surfaces as `Gold 750 - weight unconfirmed`
   with no euro figure and a prompt to ask the seller for grams.
2. **Never flags an estimated weight as underpriced.** `underpricedVsMelt` requires a
   seller-stated weight. An "underpriced" alert is an instruction to spend money.
3. **Never invents a spot price.** With no feed configured, hallmarks are still
   detected and reported — only the euro figure is omitted. The
   `reference_values_at_time_of_writing` block is **never read by the code**.

A stale price (older than `MAX_PRICE_AGE_HOURS`, default 24h) still shows a melt
figure but can no longer raise an underpriced flag.

## Unmarked-metal suspicion (path 3)

Photo/text-only. No magnet, acid or loupe — the app only ever sees Vinted photos;
those tests are post-purchase buyer actions.

**Hard rule, enforced by the type system:** this path never outputs a euro value or
a "this is gold/silver" claim. `SuspicionResult` has no value field to populate. Its
maximum output is a suspicion level, the signals that fired, and a next action.

- **Visual signals** (colour/tone, wear/tarnish, solder/construction, weight/form)
  are reported by the vision model as stable IDs — see `VISUAL_SIGNAL_IDS` in
  `server/lib/unmarked-suspicion.ts`, which binds each ID to a ruleset entry so the
  JSON stays authoritative for weights and wording.
- **Text clues** (Dutch and English: `oma`, `erfstuk`, `lijkt goud`, `namaak`, …) are
  matched in code.
- Signals weighted `"raises priority, not confidence"` bump triage order only — they
  never move the suspicion level, exactly as the ruleset specifies.
- Any **high-negative** signal (wear-through to base metal, green skin residue,
  seller says `namaak`) forces the level to `low`.
- `high` requires 3+ positives across 3+ categories, zero negatives, **and** a
  plausible reason the mark isn't visible.

The weights are a **reasoned starting heuristic, not a calibrated model** — the
handoff flags this explicitly. See "Feedback loop" below.

## Spot prices

Wiring a price vendor was out of scope, so `server/lib/spot-price.ts` provides the
seam plus two working providers:

- `METAL_PRICE_PROVIDER=none` *(default)* — no prices; the path degrades as above.
- `METAL_PRICE_PROVIDER=manual` — set `SPOT_PRICE_*_EUR_PER_G` and `SPOT_PRICE_AS_OF`
  by hand. **`SPOT_PRICE_AS_OF` is required**: a price with no date can't be
  age-checked, so it's refused rather than trusted.
- `METAL_PRICE_PROVIDER=http` — reserved. Implement `fetchFromHttpProvider()` and
  nothing else changes. Use `troyOunceToGram()` if the feed quotes per ounce.

Check the feed at `GET /api/spot-prices`.

## Hallmark detection notes

- **Plating marks outrank fineness numbers.** `1/20 12K GF` contains "12K" but isn't
  solid gold, so it's rejected. Gold-plating marks can't veto a silver mark and
  vice versa.
- **Vermeil is the exception** — gold over a *sterling* base, so it keeps real silver
  value at 0.925 (the ruleset's `handling.vermeil`).
- **Marks with no fixed fineness never claim the scrap path.** The French owl
  (*chouette*) is an import mark of varying purity, so it can't drive a melt
  calculation. It's still reported to the user, just not as a valuation.
- **Ambiguous bare numbers need corroboration.** `999` and `900` map to more than one
  metal, and `800` reads like a price, so they only match with an explicit metal
  word or hallmark word nearby. `€800` is not an 800 silver mark; `1925` is not 925.
- **Seller-stated marks beat AI photo reads** — a photo-read mark carries a "verify
  before buying" note and a score penalty.

## Regional coverage (FR / BE / IT / ES / UK)

`shared/rulesets/hallmark-regional-supplement.json` is a **local addition** layered on
top of the handoff ruleset, which stays unmodified so a future revision can drop in
cleanly. It fills the gaps that matter for European sourcing:

| Region | Added |
|---|---|
| **Spain** | `915` (the distinctive Spanish silver standard), `plata de ley` → 925, `583` |
| **Belgium / Low Countries** | `833`, `835` (very common Dutch/Belgian silver), `830`, `333` (8k), `417` (10k) |
| **France** | Minerve, `950` first-standard silver, coquille (14k), trèfle (9k), horse head, swan, dog's head (platinum 950) |
| **Italy** | `argento` / `oro` as language cues, `500` (12k) |
| **UK** | Lion passant → 925, Britannia → 958, lion rampant, leopard's head, crowned harp |

Belgium has **no compulsory assay marking**, so an unmarked Belgian piece is entirely
normal — that's a case for path 3, never a negative signal.

### False-positive guards

Pictorial and word marks are also ordinary nouns, so several require a metal word or
hallmark word nearby before they count (`requires_context` in the supplement):

- `crab`, `owl`, `swan`, `britannia`, `leopard's head` — "cute crab brooch" and
  "vintage owl pendant" are common listings and must not read as French punches.
- Town marks (**anchor, rose, castle**) are deliberately **excluded entirely** — "rose
  gold" alone would false-positive on every listing that mentions it.
- `plat` and `pt` need a platinum word nearby: `plat` is French for a serving dish and
  `pt` appears in countless product codes. They are also excluded from the platinum
  context vocabulary, since otherwise they would corroborate themselves.

Silver-side plating marks (`EPNS`, `verzilverd`, `argenté`, `metal blanco`,
`alpacca`, …) now live in the supplement's `non_solid_additions`. They suppress silver
claims only and can never veto a gold or platinum mark in a mixed lot.

## Configuration

See the valuation block in `.env.example`. The two to know:

```
SCRAP_ALERT_MODE=all_hallmarks        # | underpriced_only | off
UNMARKED_ALERT_MODE=medium_and_high   # | high_only | off
```

These control when a path may surface a listing the *vision* pre-filter skipped.
`SCRAP_ALERT_MODE` defaults to `all_hallmarks` for the calibration period —
`underpriced_only` needs both a seller-stated weight and a live spot price, so
with no price provider configured it can never fire.

## Scan scheduling

The scan is time-boxed (~20s per run against Netlify's ~30s function limit) and
**incremental** — each run analyzes what fits and the next resumes from the
`analyzed_listings` table. It therefore needs triggering repeatedly.

| Trigger | Status |
|---|---|
| External cron → `POST /api/scan` | **Authoritative.** Every 30 min. |
| Netlify scheduled function | Backup. Silently stopped for ~16h on 2026-08-03. |
| GitHub Actions (`scan-backstop.yml`) | Manual dispatch only. |

**Why not GitHub Actions:** its `*/30` schedule arrived ~23 minutes late and
skipped whole slots outright. GitHub documents scheduled workflows as
best-effort and may drop them under load. The workflow is kept for manual
dispatch (Actions tab → "Scan backstop" → "Run workflow") as a quick way to
prove the pipeline still works without needing a terminal.

**External cron setup** (cron-job.org, UptimeRobot, or similar):

```
Method:   POST
URL:      https://treasurehuntrix.netlify.app/api/scan
Interval: every 30 minutes
Timeout:  40s   (scan is budgeted to ~20s; Netlify kills at ~30s)
```

Note `/api/scan` answers **HTTP 200 even when individual searches failed** —
the verdict is in the body (`"ok": true/false`). If the cron service supports
keyword monitoring, alert on the body *not* containing `"ok":true`. Same lesson
`keep-alive.yml` encodes for `/api/db-health`.

Overlap between triggers is harmless: scanning dedupes via `analyzed_listings`,
so a doubled run clears backlog faster rather than re-alerting.

**Coverage caveat:** each run typically gets through only ~1 saved search before
the budget expires, so with 4 active searches a full sweep takes ~4 runs (~2h at
a 30-min cadence). If a search looks stale, that is usually why — check
`lastScannedAt` per search via `GET /api/searches`.

## Known gaps

- **No price vendor chosen** (explicit non-goal).
- **No weight estimation from photos** (explicit non-goal). The
  `weight_handling.fallback_options` estimate-range branch is specified but has no
  implementation, so every un-stated weight takes the "surface as unconfirmed"
  branch. Inventing gram figures would defeat rule 1 above.
- **Suspicion weights are uncalibrated.** The handoff asks that this be flagged if a
  feedback loop is built. There is currently **no outcome capture** — nothing records
  whether a bought piece turned out to have a hallmark or test as precious. Adding
  an outcome field to `findings` would let these weights be retrained against real
  results; until then treat `suspicion_level` as triage order, not probability.
- **The regional supplement is local, not handoff-provided.** Its purities follow
  standard European assay practice, but they have not been checked against an
  authoritative hallmark reference. Verify before relying on any single mark for a
  high-value purchase. Delete the file to fall back to the handoff ruleset alone —
  the code degrades cleanly, it just detects less.
- Marks whose punch legally covers more than one standard (Minerve, boar's head,
  crab, swan, horse head) are valued at the **conservative** end of their range,
  because the distinguishing numeral is almost never legible in a listing photo.
- **German and Scandinavian marks are only partly covered** — 830/833/835 are in via
  the Low Countries entry, but there is no dedicated block for the German crown-and-
  moon system or Scandinavian city marks.
- The brand-path score reuses the ruleset's own `base_score` + `weight_bonus` values
  so the paths are comparable on one 0-100 scale. Deep brand knowledge still lives in
  the vision prompts; `server/lib/brand-match.ts` is a shallow text matcher for
  *routing*, not a replacement for it.
