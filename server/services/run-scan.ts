import { storage } from "../storage";
import { scanSearchQuery } from "./scanner";
import { sendScanFailureAlert } from "./telegram";

/**
 * Single entry point for "run all active scans now".
 *
 * Called by:
 *   - the Netlify scheduled function (serverless cron), and
 *   - the /api/scan dashboard route (manual trigger).
 *
 * It is self-contained and stateless: it records health into scan_state, alerts
 * on failure via Telegram, and runs the 30-day cleanup.
 *
 * TIME-BOXED: Netlify kills functions after ~30s, so each run analyzes as many
 * new listings as fit in SCAN_BUDGET_MS and stops gracefully; analyzed-listing
 * records in the DB make the next run resume where this one stopped. `partial`
 * in the result tells the caller there is more work waiting.
 */
const SCAN_BUDGET_MS = parseInt(process.env.SCAN_BUDGET_MS || "20000", 10);

export async function runScan(): Promise<{ ok: boolean; partial: boolean; listingsChecked: number; newFindings: number; errors: string[] }> {
  const errors: string[] = [];
  let listingsChecked = 0;
  let newFindings = 0;
  let partial = false;
  const deadline = Date.now() + SCAN_BUDGET_MS;

  await storage.markScanStarted();

  try {
    const searches = (await storage.getSearchQueries()).filter((s) => s.isActive);

    for (const [i, search] of searches.entries()) {
      if (Date.now() + 10_000 > deadline) {
        partial = true;
        break;
      }
      // Gentle spacing between separate Vinted catalog sessions (each one mints
      // a fresh anonymous token) so requests don't cluster at the same instant.
      if (i > 0) await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
      try {
        const outcome = await scanSearchQuery(search, deadline);
        listingsChecked += outcome.listingsChecked;
        newFindings += outcome.newFindings;
        if (outcome.outOfTime) partial = true;
      } catch (err: any) {
        const msg = `${search.searchLabel}: ${err.message}`;
        console.error(`❌ ${msg}`);
        errors.push(msg);
      }
    }

    // Retention: drop expired findings + analyzed-listing records older than 30 days.
    await storage.deleteExpiredFindings();
    await storage.cleanupOldAnalyzedListings(30);

    if (errors.length > 0) {
      await storage.markScanFinished({ success: false, listingsChecked, error: errors.join(" | ") });
      await sendScanFailureAlert(errors.join("\n"));
      return { ok: false, partial, listingsChecked, newFindings, errors };
    }

    await storage.markScanFinished({ success: true, listingsChecked });
    return { ok: true, partial, listingsChecked, newFindings, errors };
  } catch (err: any) {
    // Total failure (e.g. DB down): record + alert.
    console.error("❌ Scan run failed entirely:", err.message);
    await storage.markScanFinished({ success: false, listingsChecked, error: err.message }).catch(() => {});
    await sendScanFailureAlert(err.message);
    return { ok: false, partial, listingsChecked, newFindings, errors: [err.message] };
  }
}
