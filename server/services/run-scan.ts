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
 * on failure via Telegram, and runs the 30-day cleanup. Designed to finish well
 * within a serverless time budget for a handful of saved searches.
 */
export async function runScan(): Promise<{ ok: boolean; listingsChecked: number; newFindings: number; errors: string[] }> {
  const errors: string[] = [];
  let listingsChecked = 0;
  let newFindings = 0;

  await storage.markScanStarted();

  try {
    const searches = (await storage.getSearchQueries()).filter((s) => s.isActive);

    for (const search of searches) {
      try {
        const outcome = await scanSearchQuery(search);
        listingsChecked += outcome.listingsChecked;
        newFindings += outcome.newFindings;
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
      return { ok: false, listingsChecked, newFindings, errors };
    }

    await storage.markScanFinished({ success: true, listingsChecked });
    return { ok: true, listingsChecked, newFindings, errors };
  } catch (err: any) {
    // Total failure (e.g. DB down): record + alert.
    console.error("❌ Scan run failed entirely:", err.message);
    await storage.markScanFinished({ success: false, listingsChecked, error: err.message }).catch(() => {});
    await sendScanFailureAlert(err.message);
    return { ok: false, listingsChecked, newFindings, errors: [err.message] };
  }
}
