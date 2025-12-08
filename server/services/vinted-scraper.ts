import puppeteer, { Browser, Page } from 'puppeteer';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

// Environment variables for authentication
const VINTED_SESSION_COOKIE = process.env.VINTED_SESSION_COOKIE;
const VINTED_AUTH_TOKEN = process.env.VINTED_AUTH_TOKEN;

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry logic with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms delay`);
      await new Promise(r => setTimeout(r, delay));
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
  
  // Set user agent and headers
  await page.setUserAgent(getRandomUserAgent());
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  });

  // Set auth cookies if available
  if (VINTED_SESSION_COOKIE) {
    await page.setCookie({
      name: '_vinted_fr_session',
      value: VINTED_SESSION_COOKIE,
      domain: '.vinted.nl',
      path: '/',
      httpOnly: true,
      secure: true
    });
  }

  // Block unnecessary resources
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

export async function scrapeVintedSearch(searchUrl: string): Promise<VintedListing[]> {
  console.log(`Scraping Vinted search: ${searchUrl}`);

  return await withRetry(async () => {
    let browser: Browser | null = null;
    try {
      await delay(2000 + Math.random() * 3000);

      browser = await createBrowser();
      const page = await setupPage(browser);

      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });

      // Extract listings data
      const listings = await page.evaluate(() => {
        const results: any[] = [];

        // Try to find catalog items in script tags
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.textContent || '';
          if (content.includes('catalog_items')) {
            try {
              const match = content.match(/"catalog_items"\s*:\s*(\[[\s\S]*?\])/);
              if (match) {
                const items = JSON.parse(match[1]);
                for (const item of items) {
                  if (item.id && item.title) {
                    results.push({
                      listingId: item.id.toString(),
                      title: item.title,
                      price: item.price ? `€${item.price}` : 'Price not available',
                      imageUrls: item.photos?.map((p: any) => p.url || p.full_size_url).filter(Boolean) || [],
                      listingUrl: item.url || `https://www.vinted.com/items/${item.id}`,
                    });
                  }
                }
              }
            } catch (e) {
              console.error('Error parsing catalog items:', e);
            }
          }
        }

        return results;
      });

      console.log(`Found ${listings.length} listings from Vinted`);
      return listings;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  });
}

export async function scrapeVintedListing(listingUrl: string): Promise<VintedListing | null> {
  console.log(`Scraping single Vinted listing: ${listingUrl}`);
  
  return await withRetry(async () => {
    let browser: Browser | null = null;
    try {
      await delay(1000 + Math.random() * 2000);
      
      browser = await createBrowser();
      const page = await setupPage(browser);

      await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      
      // Extract all data using Puppeteer
      const data = await page.evaluate(() => {
        // Extract listing ID from URL
        const url = window.location.href;
        const listingIdMatch = url.match(/\/items\/(\d+)/);
        const listingId = listingIdMatch ? listingIdMatch[1] : 'unknown';

        // Try to extract from window data first
        let title = '';
        let price = '';
        let imageUrls: string[] = [];
        let description = '';

        // Look for initial data in script tags
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
                  title = item.title || '';
                  price = item.price ? `${item.price.amount} ${item.price.currency}` : '';
                  imageUrls = item.photos?.map((p: any) => p.url).filter(Boolean) || [];
                  break;
                }
              }
            } catch (e) {
              console.warn('JSON parsing failed:', e);
            }
          }
        }

        // Fallback selectors if JSON parsing fails
        if (!title) {
          title = document.querySelector('h1')?.textContent?.trim() || 'Untitled';
        }
        if (!price) {
          price = document.querySelector('.price, .price-box__price, [data-testid="price"]')?.textContent?.trim() || 'Price not available';
        }
        if (imageUrls.length === 0) {
          imageUrls = Array.from(document.querySelectorAll('img[src*="vinted"], img[data-src*="vinted"]'))
            .map(img => ((img as HTMLImageElement).src || (img as HTMLImageElement).dataset.src) as string)
            .filter(Boolean) as string[];
        }
        
        // Extract description
        description = document.querySelector('.item-description, .description, [data-testid="description"]')?.textContent?.trim() || '';

        return {
          listingId,
          title,
          price,
          imageUrls,
          description,
          listingUrl: url
        };
      });

      return data;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  });
}