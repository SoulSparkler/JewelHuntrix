#!/usr/bin/env node

/**
 * Manual Vinted Login Script
 * 
 * This script launches a non-headless Puppeteer browser for manual login to Vinted.
 * After successful login, it saves all cookies to a JSON file for persistent session reuse.
 * 
 * Usage:
 * 1. Run: node scripts/manual-vinted-login.js
 * 2. Manually log into your Vinted account in the opened browser
 * 3. Wait for the "Login successful! Cookies saved." message
 * 4. Close the browser
 * 
 * The saved cookies will be used by the scraper for all future authenticated requests.
 */

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const SESSION_FILE = process.env.VINTED_SESSION_FILE || './data/vinted-session.json';
const VINTED_REGION = process.env.VINTED_REGION || 'NL';

async function ensureDataDirectory() {
  const dataDir = path.dirname(SESSION_FILE);
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}

async function setRegionCookies(page) {
  // Set region cookies to prevent "Where do you live?" popup
  const regionCookies = [
    {
      name: 'country',
      value: VINTED_REGION.toLowerCase(),
      domain: '.vinted.nl',
      path: '/',
      httpOnly: false,
      secure: true
    },
    {
      name: 'selected_country',
      value: VINTED_REGION.toLowerCase(),
      domain: '.vinted.nl',
      path: '/',
      httpOnly: false,
      secure: true
    }
  ];

  for (const cookie of regionCookies) {
    try {
      await page.setCookie(cookie);
      console.log(`✅ Set region cookie: ${cookie.name}=${cookie.value}`);
    } catch (error) {
      console.warn(`⚠️ Could not set cookie ${cookie.name}:`, error.message);
    }
  }
}

async function waitForLogin(page) {
  console.log('🔍 Waiting for successful login...');
  
  try {
    // Wait for user to be logged in (look for logout button or user menu)
    await page.waitForSelector('[data-testid="header-user-menu"], .user-menu, [href*="/account"]', {
      timeout: 300000 // 5 minutes timeout
    });
    
    console.log('✅ Login detected! Saving cookies...');
    return true;
  } catch (error) {
    console.error('❌ Login timeout or detection failed:', error.message);
    return false;
  }
}

async function saveCookies(page) {
  const cookies = await page.cookies();
  
  // Add metadata to cookies
  const sessionData = {
    cookies,
    metadata: {
      savedAt: new Date().toISOString(),
      userAgent: await page.evaluate(() => navigator.userAgent),
      region: VINTED_REGION
    }
  };

  await fs.writeFile(SESSION_FILE, JSON.stringify(sessionData, null, 2));
  console.log(`💾 Cookies saved to: ${SESSION_FILE}`);
  console.log(`📊 Saved ${cookies.length} cookies`);
  
  return sessionData;
}

async function main() {
  console.log('🚀 Starting Vinted Manual Login Process');
  console.log(`📁 Session file: ${SESSION_FILE}`);
  console.log(`🌍 Region: ${VINTED_REGION}`);
  console.log('');
  
  await ensureDataDirectory();

  let browser;
  try {
    console.log('🌐 Launching non-headless browser...');
    browser = await puppeteer.launch({
      headless: false, // Non-headless for manual login
      defaultViewport: { width: 1200, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('🔗 Navigating to Vinted...');
    await page.goto('https://www.vinted.nl', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Set region cookies immediately
    await setRegionCookies(page);
    
    console.log('');
    console.log('🔐 MANUAL LOGIN REQUIRED');
    console.log('Please log into your Vinted account manually in the opened browser.');
    console.log('Once logged in, this script will automatically detect the login and save cookies.');
    console.log('');
    console.log('⏳ Waiting for login... (You have 5 minutes)');
    
    const loginSuccess = await waitForLogin(page);
    
    if (loginSuccess) {
      const sessionData = await saveCookies(page);
      console.log('');
      console.log('🎉 LOGIN SUCCESSFUL!');
      console.log('✅ Cookies saved and ready for scraper use');
      console.log('');
      console.log('You can now close this browser and run the scraper.');
      console.log('The saved session will be automatically loaded for all future requests.');
      
      // Keep browser open for a moment so user can see success message
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      console.log('');
      console.log('❌ Login failed or timed out.');
      console.log('Please try running the script again.');
    }
    
  } catch (error) {
    console.error('💥 Error during login process:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n🛑 Login process interrupted by user');
  process.exit(0);
});

main().catch(console.error);