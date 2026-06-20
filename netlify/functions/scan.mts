// Netlify Scheduled Function — runs the Vinted scan on a serverless cron.
//
// Replaces the old node-cron-in-a-long-running-process model. The schedule is
// set via the SCAN_CRON env var (falls back to every 2 hours). Netlify spreads
// the per-search timing/jitter logic inside runScan/scanSearchQuery is no longer
// needed because each invocation is independent; we add light jitter below to
// avoid hitting Vinted at exactly the same wall-clock minute every time.
//
// Manual trigger for testing:  GET /.netlify/functions/scan

import type { Config } from "@netlify/functions";
import { runScan } from "../../server/services/run-scan";

export default async (req: Request) => {
  // Small random delay (0-90s) so we don't request on the exact cron tick.
  // Skipped for manual (non-scheduled) invocations to keep the test snappy.
  const isScheduled = req.headers.get("x-nf-event") === "schedule";
  if (isScheduled) {
    await new Promise((r) => setTimeout(r, Math.random() * 90_000));
  }

  const result = await runScan();
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  schedule: process.env.SCAN_CRON || "0 */2 * * *",
};
