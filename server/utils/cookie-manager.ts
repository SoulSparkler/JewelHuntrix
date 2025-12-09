/**
 * Cookie Management Utilities for Vinted Session Persistence
 * 
 * Handles loading and validation of saved session cookies from file.
 * Provides fallback to legacy environment variable authentication.
 */

import fs from 'fs/promises';
import path from 'path';

const SESSION_FILE = process.env.VINTED_SESSION_FILE || './data/vinted-session.json';
const VINTED_REGION = process.env.VINTED_REGION || 'NL';
const LEGACY_SESSION_COOKIE = process.env.VINTED_SESSION_COOKIE;

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface SessionData {
  cookies: CookieData[];
  metadata: {
    savedAt: string;
    userAgent: string;
    region: string;
  };
}

export class CookieManager {
  private sessionData: SessionData | null = null;
  private cookiesLoaded = false;

  /**
   * Load cookies from file or environment variable
   */
  async loadCookies(): Promise<CookieData[]> {
    if (this.cookiesLoaded) {
      return this.sessionData?.cookies || [];
    }

    try {
      // Try to load from file first (persistent session)
      const cookies = await this.loadFromFile();
      if (cookies.length > 0) {
        this.sessionData = await this.loadSessionData();
        this.cookiesLoaded = true;
        console.log(`✅ Loaded ${cookies.length} cookies from persistent session file`);
        return cookies;
      }
    } catch (error) {
      console.warn('⚠️ Could not load cookies from file:', error.message);
    }

    // Fallback to legacy environment variable
    if (LEGACY_SESSION_COOKIE) {
      const legacyCookies = this.createLegacyCookie(LEGACY_SESSION_COOKIE);
      this.sessionData = {
        cookies: legacyCookies,
        metadata: {
          savedAt: new Date().toISOString(),
          userAgent: 'legacy-session',
          region: VINTED_REGION
        }
      };
      this.cookiesLoaded = true;
      console.log('✅ Using legacy session cookie from environment variable');
      return legacyCookies;
    }

    console.warn('⚠️ No valid session cookies found (file or environment)');
    return [];
  }

  /**
   * Load cookies from the session file
   */
  private async loadFromFile(): Promise<CookieData[]> {
    try {
      await fs.access(SESSION_FILE);
      const rawData = await fs.readFile(SESSION_FILE, 'utf-8');
      const sessionData: SessionData = JSON.parse(rawData);

      // Validate session data structure
      if (!sessionData.cookies || !Array.isArray(sessionData.cookies)) {
        throw new Error('Invalid session file format');
      }

      // Check if cookies are recent (less than 30 days old)
      const savedAt = new Date(sessionData.metadata.savedAt);
      const daysOld = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysOld > 30) {
        console.warn(`⚠️ Session cookies are ${Math.floor(daysOld)} days old, may need refresh`);
      } else {
        console.log(`✅ Session cookies are ${Math.floor(daysOld)} days old`);
      }

      return sessionData.cookies;
    } catch (error) {
      throw new Error(`Failed to load session file: ${error.message}`);
    }
  }

  /**
   * Load full session data including metadata
   */
  private async loadSessionData(): Promise<SessionData> {
    const rawData = await fs.readFile(SESSION_FILE, 'utf-8');
    return JSON.parse(rawData);
  }

  /**
   * Create legacy cookie from environment variable
   */
  private createLegacyCookie(sessionValue: string): CookieData[] {
    return [
      {
        name: '_vinted_fr_session',
        value: sessionValue,
        domain: '.vinted.nl',
        path: '/',
        httpOnly: true,
        secure: true
      }
    ];
  }

  /**
   * Get region-specific cookies to prevent location popups
   */
  getRegionCookies(): CookieData[] {
    return [
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
  }

  /**
   * Check if we have valid session cookies
   */
  async hasValidSession(): Promise<boolean> {
    const cookies = await this.loadCookies();
    return cookies.length > 0;
  }

  /**
   * Get session info for logging/debugging
   */
  async getSessionInfo(): Promise<{ hasSession: boolean; source: string; age?: number; cookies: number }> {
    const cookies = await this.loadCookies();
    
    if (!this.sessionData) {
      return { hasSession: false, source: 'none', cookies: 0 };
    }

    const source = SESSION_FILE && fs.access ? 'file' : 'legacy-env';
    const savedAt = new Date(this.sessionData.metadata.savedAt);
    const age = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24); // days

    return {
      hasSession: true,
      source,
      age: Math.floor(age),
      cookies: cookies.length
    };
  }

  /**
   * Delete session file (for testing or reset)
   */
  async deleteSession(): Promise<void> {
    try {
      await fs.unlink(SESSION_FILE);
      console.log('🗑️ Session file deleted');
    } catch (error) {
      console.warn('⚠️ Could not delete session file:', error.message);
    }
  }
}

// Export singleton instance
export const cookieManager = new CookieManager();