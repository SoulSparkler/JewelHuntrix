/**
 * Lightweight Vinted client (serverless-friendly).
 *
 * Replaces the old Puppeteer scraper. Instead of driving a headless browser we
 * talk to Vinted's internal JSON API the same way the website does:
 *
 *   1. GET a catalog page on vinted.nl to obtain a fresh anonymous cookie jar
 *      (the important one is `access_token_web`).
 *   2. Call /api/v2/catalog/items with that jar.
 *
 * No login is required to read the PUBLIC catalog, and vinted.nl already shows
 * the full cross-border (NL/FR/DE/BE/IE/...) listings. Because we mint a fresh
 * anonymous session on every scan in a single round-trip, there is no long-lived
 * session to "drop" — which was the root cause of the previous instability.
 *
 * Region stays NL by design (see VINTED_BASE).
 */

const VINTED_BASE = process.env.VINTED_BASE_URL || "https://www.vinted.nl";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export interface VintedListing {
  listingId: string;
  title: string;
  price: string;
  imageUrls: string[];
  listingUrl: string;
  description: string;
  sellerId: string | null;
  sellerCountry: string | null;
}

/**
 * Obtain a fresh anonymous cookie jar from vinted.nl.
 *
 * Vinted sets `access_token_web` twice (a clearing empty value then the real
 * one); we keep only the last non-empty value of each cookie, otherwise the API
 * rejects us with HTTP 401 "invalid_authentication_token".
 */
async function getCookieJar(userAgent: string): Promise<string> {
  const res = await fetch(`${VINTED_BASE}/catalog`, {
    headers: { "User-Agent": userAgent, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`Vinted session bootstrap failed: HTTP ${res.status}`);
  }
  // node >=18 exposes getSetCookie(); fall back to the single header otherwise.
  const raw: string[] =
    (res.headers as any).getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);

  const jar = new Map<string, string>();
  for (const cookie of raw) {
    const pair = cookie.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(name, value); // last non-empty wins
  }
  if (!jar.has("access_token_web")) {
    throw new Error("Vinted did not return an access_token_web cookie");
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Convert a user-facing URL (what the owner pastes into the dashboard) into the
 * internal API endpoint, preserving all filters.
 *
 * Supports two shapes:
 *   - a catalog search   → /api/v2/catalog/items?...   (keyword/brand/price filters)
 *   - a member/seller URL → /api/v2/wardrobe/{id}/items (scan one seller's whole
 *     wardrobe). e.g. https://www.vinted.nl/member/57257941
 *
 * NOTE: the wardrobe endpoint ignores price_to/price_from — those are enforced
 * client-side in searchListings() instead (see priceBounds()).
 */
function toApiUrl(catalogUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(catalogUrl);
  } catch {
    // Treat a bare string as a free-text search.
    parsed = new URL(`${VINTED_BASE}/catalog`);
    parsed.searchParams.set("search_text", catalogUrl);
  }
  const params = parsed.searchParams;
  if (!params.has("per_page")) params.set("per_page", "48");
  if (!params.has("order")) params.set("order", "newest_first");

  // Member/seller URL → that seller's wardrobe.
  const memberMatch = parsed.pathname.match(/\/member\/(\d+)/);
  if (memberMatch) {
    return `${VINTED_BASE}/api/v2/wardrobe/${memberMatch[1]}/items?${params.toString()}`;
  }

  return `${VINTED_BASE}/api/v2/catalog/items?${params.toString()}`;
}

/**
 * Extract price_to / price_from from the pasted URL. Used to enforce a price cap
 * client-side for member (wardrobe) scans, whose endpoint ignores those params.
 * Harmless for catalog scans — Vinted already applied them server-side.
 */
function priceBounds(catalogUrl: string): { min: number; max: number } {
  try {
    const p = new URL(catalogUrl).searchParams;
    const max = parseFloat(p.get("price_to") || "");
    const min = parseFloat(p.get("price_from") || "");
    return {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : Infinity,
    };
  } catch {
    return { min: 0, max: Infinity };
  }
}

function fetchWithTimeout(url: string, init: RequestInit, ms = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Search a Vinted catalog URL and return normalized listings.
 * Throws on auth/block failures so the caller can alert + record the error.
 */
export async function searchListings(catalogUrl: string): Promise<VintedListing[]> {
  const ua = randomUA();
  const jar = await getCookieJar(ua);
  const apiUrl = toApiUrl(catalogUrl);

  const res = await fetchWithTimeout(apiUrl, {
    headers: {
      "User-Agent": ua,
      Cookie: jar,
      Accept: "application/json",
      Referer: `${VINTED_BASE}/catalog`,
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Vinted auth rejected (HTTP ${res.status}) — anonymous token invalid/blocked`);
  }
  if (res.status === 429) {
    throw new Error("Vinted rate-limited the scan (HTTP 429)");
  }
  if (!res.ok) {
    throw new Error(`Vinted API error: HTTP ${res.status}`);
  }

  const data: any = await res.json();
  let items: any[] = Array.isArray(data.items) ? data.items : [];

  // Enforce price bounds client-side (the wardrobe endpoint ignores price_to).
  const { min, max } = priceBounds(catalogUrl);
  if (min > 0 || max < Infinity) {
    items = items.filter((item) => {
      const amt = parseFloat(item.price?.amount);
      if (!Number.isFinite(amt)) return true; // keep unknown-price items
      return amt >= min && amt <= max;
    });
  }

  return items.map((item) => {
    const photos: string[] = (item.photos || [])
      .map((p: any) => p?.full_size_url || p?.url)
      .filter(Boolean);
    return {
      listingId: String(item.id),
      title: (item.title || "").trim(),
      price: item.price?.amount ? `€${item.price.amount}` : "Prijs onbekend",
      imageUrls: photos,
      listingUrl: item.url || `${VINTED_BASE}/items/${item.id}`,
      description: item.description || "",
      sellerId: item.user?.id ? String(item.user.id) : null,
      sellerCountry: null, // resolved lazily via getSellerCountry() only when needed
    };
  });
}

/**
 * Fetch a single listing for the manual-scan dashboard feature.
 *
 * The authenticated item-detail API is gated for anonymous clients, so we read
 * the PUBLIC item HTML page and pull metadata from its OpenGraph / JSON-LD tags.
 * Good enough for one-off manual checks. Returns null if the page can't be read.
 */
export async function getListing(listingUrl: string): Promise<VintedListing | null> {
  try {
    const ua = randomUA();
    const res = await fetchWithTimeout(listingUrl, {
      headers: { "User-Agent": ua, Accept: "text/html" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const meta = (prop: string): string | null => {
      const m = html.match(
        new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
      );
      return m ? m[1] : null;
    };

    const idMatch = listingUrl.match(/\/items\/(\d+)/);
    const title = meta("og:title") || "Onbekende titel";
    let priceAmount = meta("product:price:amount");

    if (!priceAmount) {
      const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLdMatch) {
        try {
          const ld = JSON.parse(jsonLdMatch[1]);
          const offer = ld?.offers ?? ld;
          if (offer?.price) priceAmount = String(offer.price);
        } catch {}
      }
    }
    if (!priceAmount) {
      const pricePat = html.match(/"price"\s*:\s*{\s*"amount"\s*:\s*"?([\d.]+)"?/);
      if (pricePat) priceAmount = pricePat[1];
    }

    const ogImage = meta("og:image");

    // Collect gallery images from the embedded JSON if present.
    const imgSet = new Set<string>();
    if (ogImage) imgSet.add(ogImage);
    for (const m of html.matchAll(/"(https:\/\/images\d*\.vinted\.net\/[^"]+f800[^"]*)"/g)) {
      imgSet.add(m[1].replace(/\\u002F/g, "/"));
    }

    return {
      listingId: idMatch ? idMatch[1] : listingUrl,
      title,
      price: priceAmount ? `€${priceAmount}` : "Prijs onbekend",
      imageUrls: [...imgSet].slice(0, 6),
      listingUrl,
      description: meta("og:description") || "",
      sellerId: null,
      sellerCountry: null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a seller's country (e.g. "Nederland" / "Frankrijk") from the member
 * endpoint. Catalog items don't carry country, so we only call this for the few
 * listings that actually pass the AI threshold (keeps request volume tiny).
 * Returns null on any failure — country is informational, never fatal.
 */
export async function getSellerCountry(sellerId: string): Promise<string | null> {
  try {
    const ua = randomUA();
    const jar = await getCookieJar(ua);
    const res = await fetchWithTimeout(`${VINTED_BASE}/api/v2/users/${sellerId}`, {
      headers: {
        "User-Agent": ua,
        Cookie: jar,
        Accept: "application/json",
        Referer: `${VINTED_BASE}/`,
      },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.user?.country_title || data.user?.country_iso_code || null;
  } catch {
    return null;
  }
}
