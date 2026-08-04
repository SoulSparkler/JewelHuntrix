// Netlify Scheduled Function — runs the Vinted scan on a serverless cron.
//
// IMPORTANT TIME BUDGET: Netlify kills synchronous/scheduled functions after
// ~30 seconds. A full scan (dozens of listings, each needing image downloads +
// an AI vision call) cannot finish in one invocation. So runScan() is
// TIME-BOXED: it processes as many un-analyzed listings as fit in the budget
// and stops gracefully. Already-analyzed listings are recorded in the DB, so
// every following invocation (cron or manual) picks up where the last one
// stopped — the scan is incremental by design. The cron therefore runs every
// 30 minutes: frequent small bites instead of one impossible big one.
//
// NOTE: this schedule has silently stopped firing before (a ~16h gap on
// 2026-08-03 with no error recorded — scan_state showed lastError: null the
// whole time, i.e. never invoked rather than failing). .github/workflows/
// scan-backstop.yml hits POST /api/scan on the same 30-minute cadence as an
// independent safety net. Overlap is harmless: scans dedupe via the
// analyzed_listings table, so a doubled run just clears the backlog faster.
//
// (The previous version slept a random 0-90s "jitter" before starting, which
// exceeded the 30s limit — scheduled scans died in their own sleep. Removed.)
//
// Manual trigger for testing:  GET /.netlify/functions/scan

import type { Config } from "@netlify/functions";
import { runScan } from "../../server/services/run-scan";

export default async (_req: Request) => {
  const result = await runScan();
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  schedule: process.env.SCAN_CRON || "*/30 * * * *",
};
