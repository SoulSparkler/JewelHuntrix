import puppeteer, { Browser, Page, HTTPResponse } from 'puppeteer';
import { cookieManager } from '../utils/cookie-manager';
import fs from 'fs/promises';
import path from 'path';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

let lastSessionRefresh = 0;
const SESSION_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkSessionRefresh(): Promise<boolean> {
  const now = Date.now();
  if (now - lastSessionRefresh > SESSION_REFRESH_INTERVAL) {
    console.log("🔄 Session refresh needed, checking session health...");
    try {
      // Simple session check by accessing a Vinted page
      const testResponse = await fetch('https://www.vinted.com/catalog', {
        method: 'HEAD',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Cookie': (await cookieManager.loadCookies()).map(c => `${c.name}=${c.value}`).join('; ')
        }
      });
      
      if (testResponse.status === 403 || testResponse.status === 429) {
        console.log("⚠️ Session may be expired or rate-limited");
        lastSessionRefresh = now;
        return false;
      }
      
      console.log("✅ Session health check passed");
      lastSessionRefresh = now;
      return true;
    } catch (error) {
      console.warn("⚠️ Session health check failed:", error.message);
      lastSessionRefresh = now;
      return false;
    }
  }
  return true;
}

async function validateRegionCookies(page: Page): Promise<boolean> {
  try {
    // Check if we're getting location popups or regional restrictions
    const hasLocationPopup = await page.evaluate(() => {
      const popup = document.querySelector('[data-testid*="location"], .location-popup, .country-selector');
      return popup !== null && popup.offsetParent !== null;
    });
    
    if (hasLocationPopup) {
      console.log("🌍 Location popup detected, setting region cookies...");
      const regionCookies = cookieManager.getRegionCookies();
      for (const cookie of regionCookies) {
        await page.setCookie(cookie);
      }
      return true;
    }
    return false;
  } catch (error) {
    console.warn("⚠️ Region validation failed:", error.message);
    return false;
  }
}

async function handle403Recovery(page: Page, url: string): Promise<boolean> {
  console.log("🚫 403 Forbidden detected, attempting recovery...");
  
  try {
    // Clear all cookies and reload
    const cookies = await page.cookies();
    for (const cookie of cookies) {
      await page.deleteCookie(cookie);
    }
    
    // Wait a bit before retry
    await delay(5000 + Math.random() * 5000);
    
    // Reload with fresh session
    await page.goto('https://www.vinted.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
    
    // Reload the original URL
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // Check if we can access the page now
    const title = await page.title();
    if (!title.includes('403') && !title.includes('Access Denied')) {
      console.log("✅ 403 recovery successful");
      return true;
    }
    
  } catch (error) {
    console.error("❌ 403 recovery failed:", error.message);
  }
  
  return false;
}

// Enhanced retry logic with anti-blocking strategies
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Check session health before each attempt
      const sessionHealthy = await checkSessionRefresh();
      if (!sessionHealthy && i > 0) {
        console.log("⚠️ Session may be compromised, extending delay");
        await delay(30000 + Math.random() * 30000);
      }
      
      return await fn();
    } catch (error: any) {
      const isLastAttempt = i === maxRetries - 1;
      
      // Handle specific error types
      if (error.message.includes('403') || error.message.includes('Forbidden')) {
        console.log(`🚫 403 error on attempt ${i + 1}/${maxRetries}, will attempt recovery`);
        if (isLastAttempt) throw new Error('403 Forbidden - session may be blocked');
      } else if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
        console.log(`⏳ Rate limit detected on attempt ${i + 1}/${maxRetries}, extending delay`);
        const delay = (i + 1) * 60000 + Math.random() * 30000; // 1-4 minutes
        await new Promise(r => setTimeout(r, delay));
      } else if (error.message.includes('timeout')) {
        console.log(`⏰ Timeout on attempt ${i + 1}/${maxRetries}, retrying with delay`);
        const delay = (i + 1) * 2000 + Math.random() * 3000;
        await new Promise(r => setTimeout(r, delay));
      }
      
      if (isLastAttempt) {
        throw error;
      }
      
      const backoffDelay = Math.pow(2, i) * 2000 + Math.random() * 2000;
      console.log(`🔄 Retry ${i + 1}/${maxRetries} after ${Math.floor(backoffDelay/1000)}s delay`);
      await new Promise(r => setTimeout(r, backoffDelay));
    }
  }
  throw new Error('Max retries exceeded');
}

export interface VintedListing {
  listingId: string;
  title: string;
  price: string;
  imageUrls: string[];
  listingUrl: string;
  description?: string;
}

async function createBrowser(): Promise<Browser> {
  return await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });
}

async function setupPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  
  // Enhanced user agent and headers
  await page.setUserAgent(getRandomUserAgent());
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8,fr;q=0.7,de;q=0.6',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0'
  });

  // Set viewport to mimic real device
  await page.setViewport({ width: 1366, height: 768 });

  // Load persistent session cookies if available
  const sessionCookies = await cookieManager.loadCookies();
  if (sessionCookies.length > 0) {
    await page.setCookie(...sessionCookies);
    console.log(`🔐 Loaded ${sessionCookies.length} session cookies`);
  } else {
    console.warn('⚠️ No session cookies loaded - scraping may be limited');
  }

  // Set region cookies to prevent location popups
  const regionCookies = cookieManager.getRegionCookies();
  for (const cookie of regionCookies) {
    try {
      await page.setCookie(cookie);
    } catch (error) {
      console.warn(`Could not set region cookie ${cookie.name}:`, error.message);
    }
  }

  // Enhanced request interception for performance
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    
    // Block unnecessary resources
    if (['image', 'font', 'media'].includes(type)) {
      req.abort();
    } else if (url.includes('analytics') || url.includes('tracking') || url.includes('ads')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Monitor for 403 responses
  page.on('response', async (response: HTTPResponse) => {
    if (response.status() === 403) {
      console.log('🚫 403 Forbidden detected on:', response.url());
    } else if (response.status() === 429) {
      console.log('⏳ Rate limit detected on:', response.url());
    }
  });

  // Random human-like delays between actions
  page.on('framenavigated', async () => {
    const delay = 1000 + Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
  });

  return page;
}

export async function scrapeVintedSearch(searchUrl: string): Promise<VintedListing[]> {
  console.log(`🔍 Scraping Vinted search: ${searchUrl}`);

  return await withRetry(async () => {
    let browser: Browser | null = null;
    try {
      // Human-like initial delay
      await delay(3000 + Math.random() * 4000);

      browser = await createBrowser();
      const page = await setupPage(browser);

      // Validate region cookies first
      await validateRegionCookies(page);

      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });

      // Check for 403 error page
      const title = await page.title();
      if (title.includes('403') || title.includes('Access Denied')) {
        const recovered = await handle403Recovery(page, searchUrl);
        if (!recovered) {
          throw new Error('403 Forbidden - unable to recover session');
        }
      }

      // Extract listings data with enhanced parsing
      const listings = await page.evaluate(() => {
        const results: any[] = [];

        // Enhanced catalog parsing with multiple fallbacks
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.textContent || '';
          
          // Try different patterns for catalog items
          const patterns = [
            /"catalog_items"\s*:\s*(\[[\s\S]*?\])/,
            /"items"\s*:\s*(\[[\s\S]*?\])/,
            /__INITIAL_DATA__.*?"items"\s*:\s*(\[[\s\S]*?\])/
          ];
          
          for (const pattern of patterns) {
            try {
              const match = content.match(pattern);
              if (match) {
                const items = JSON.parse(match[1]);
                for (const item of items) {
                  if (item.id && item.title) {
                    results.push({
                      listingId: item.id.toString(),
                      title: item.title.trim(),
                      price: item.price ? (item.price.amount ? `€${item.price.amount}` : `€${item.price}`) : 'Price not available',
                      imageUrls: item.photos?.map((p: any) => p.url || p.full_size_url || p.url_template).filter(Boolean) || [],
                      listingUrl: item.url || `https://www.vinted.com/items/${item.id}`,
                      description: item.description || ''
                    });
                  }
                }
                break; // Stop after first successful parse
              }
            } catch (e) {
              console.warn('Pattern match failed:', e);
            }
          }
        }

        // Fallback: Parse from DOM if script parsing fails
        if (results.length === 0) {
          const itemElements = document.querySelectorAll('[data-testid*="item"], .catalog-grid .item, .items-grid .item');
          itemElements.forEach((element) => {
            const title = element.querySelector('h3, h4, .item-title')?.textContent?.trim();
            const priceElement = element.querySelector('.price, .item-price');
            const price = priceElement?.textContent?.trim();
            const link = element.querySelector('a[href*="/items/"]')?.getAttribute('href');
            const images = element.querySelectorAll('img');
            const imageUrls = Array.from(images).map(img => (img as HTMLImageElement).src).filter(Boolean);
            
            if (title && link) {
              const listingId = link.match(/\/items\/(\d+)/)?.[1];
              if (listingId) {
                results.push({
                  listingId,
                  title,
                  price: price || 'Price not available',
                  imageUrls,
                  listingUrl: link.startsWith('http') ? link : `https://www.vinted.com${link}`,
                  description: ''
                });
              }
            }
          });
        }

        return results;
      });

      console.log(`✅ Found ${listings.length} listings from Vinted search`);
      return listings;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  });
}

export async function scrapeVintedListing(listingUrl: string): Promise<VintedListing | null> {
  console.log(`🔍 Scraping single Vinted listing: ${listingUrl}`);
  
  return await withRetry(async () => {
    let browser: Browser | null = null;
    try {
      // Human-like delay before individual listing
      await delay(2000 + Math.random() * 3000);
      
      browser = await createBrowser();
      const page = await setupPage(browser);

      await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      
      // Check for 403 on individual listing
      const title = await page.title();
      if (title.includes('403') || title.includes('Access Denied')) {
        const recovered = await handle403Recovery(page, listingUrl);
        if (!recovered) {
          throw new Error('403 Forbidden - unable to access listing');
        }
      }
      
      // Enhanced data extraction with multiple fallbacks
      const data = await page.evaluate(() => {
        const url = window.location.href;
        const listingIdMatch = url.match(/\/items\/(\d+)/);
        const listingId = listingIdMatch ? listingIdMatch[1] : 'unknown';

        let title = '';
        let price = '';
        let imageUrls: string[] = [];
        let description = '';

        // Multiple extraction strategies
        const extractionStrategies = [
          // Strategy 1: __INITIAL_DATA__
          () => {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
              const content = script.textContent || '';
              if (content.includes('__INITIAL_DATA__')) {
                try {
                  const match = content.match(/window\.__INITIAL_DATA__\s*=\s*(\{.*?\});/s);
                  if (match) {
                    const jsonData = JSON.parse(match[1]);
                    if (jsonData.item && jsonData.item.item) {
                      const item = jsonData.item.item;
                      return {
                        title: item.title || '',
                        price: item.price ? `${item.price.amount} ${item.price.currency}` : '',
                        imageUrls: item.photos?.map((p: any) => p.url || p.full_size_url).filter(Boolean) || [],
                        description: item.description || ''
                      };
                    }
                  }
                } catch (e) {
                  console.warn('__INITIAL_DATA__ parsing failed:', e);
                }
              }
            }
            return null;
          },
          
          // Strategy 2: JSON-LD structured data
          () => {
            const jsonLd = document.querySelector('script[type="application/ld+json"]');
            if (jsonLd) {
              try {
                const data = JSON.parse(jsonLd.textContent || '');
                if (data.offers) {
                  return {
                    title: data.name || '',
                    price: data.offers.price ? `${data.offers.price} ${data.offers.priceCurrency}` : '',
                    imageUrls: data.image ? (Array.isArray(data.image) ? data.image : [data.image]) : [],
                    description: data.description || ''
                  };
                }
              } catch (e) {
                console.warn('JSON-LD parsing failed:', e);
              }
            }
            return null;
          },
          
          // Strategy 3: Meta tags
          () => {
            const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
            const ogPrice = document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content');
            const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
            const description = document.querySelector('meta[name="description"]')?.getAttribute('content');
            
            if (ogTitle || ogPrice) {
              return {
                title: ogTitle || '',
                price: ogPrice ? `€${ogPrice}` : '',
                imageUrls: ogImage ? [ogImage] : [],
                description: description || ''
              };
            }
            return null;
          }
        ];

        // Try each strategy
        for (const strategy of extractionStrategies) {
          try {
            const result = strategy();
            if (result && result.title) {
              return { listingId, ...result, listingUrl: url };
            }
          } catch (e) {
            console.warn('Extraction strategy failed:', e);
          }
        }

        // Fallback: DOM scraping
        title = document.querySelector('h1')?.textContent?.trim() || 'Untitled';
        price = document.querySelector('.price, .price-box__price, [data-testid="price"], .item-price')?.textContent?.trim() || 'Price not available';
        imageUrls = Array.from(document.querySelectorAll('img[src*="vinted"], img[data-src*="vinted"], .gallery img'))
          .map(img => ((img as HTMLImageElement).src || (img as HTMLImageElement).dataset.src) as string)
          .filter(Boolean);
        description = document.querySelector('.item-description, .description, [data-testid="description"], .item-details')?.textContent?.trim() || '';

        return {
          listingId,
          title,
          price,
          imageUrls,
          description,
          listingUrl: url
        };
      });

      console.log(`✅ Successfully extracted listing data: ${data.title.substring(0, 50)}...`);
      return data;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  });
}