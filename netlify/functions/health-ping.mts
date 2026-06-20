// Netlify Scheduled Function — daily Telegram heartbeat.
//
// Sends "scanner draait, laatste succesvolle run: …, X listings gecheckt".
// Also doubles as a health endpoint: GET /.netlify/functions/health-ping
// returns the current scan_state as JSON.

import type { Config } from "@netlify/functions";
import { storage } from "../../server/storage";
import { sendHealthPing } from "../../server/services/telegram";

export default async () => {
  const state = await storage.getScanState();
  await sendHealthPing(state?.lastSuccessAt ?? null, state?.lastListingsChecked ?? 0);
  return new Response(
    JSON.stringify({
      lastRunAt: state?.lastRunAt ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastListingsChecked: state?.lastListingsChecked ?? 0,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      lastError: state?.lastError ?? null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  // 08:00 UTC daily
  schedule: process.env.HEALTH_CRON || "0 8 * * *",
};
