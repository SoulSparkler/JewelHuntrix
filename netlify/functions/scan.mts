// Netlify Scheduled Function — runs the Vinted scan on a serverless cron.
//
// IMPORTANT TIME BUDGET: Netlify kills synchronous/scheduled functions after
// ~30 seconds. A full scan (dozens of listings, each needing image downloads +
// an AI vision call) cannot finish in one invocation. So runScan() is
// TIME-BOXED: it processes as many un-analyzed listings as fit in the budget
// and stops gracefully. Already-analyzed listings are recorded in the DB, so
// every following invocation (cron or manual) picks up where the last one
// stopped — the scan is incremental by design. The cron therefore runs every
// 15 minutes: frequent small bites instead of one impossible big one.
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
  schedule: process.env.SCAN_CRON || "*/15 * * * *",
};
