// Rate limiting utility for Telegram alerts
// Max 10 alerts per hour per listing source

interface AlertRecord {
  timestamp: number;
  listingUrl: string;
}

class TelegramRateLimiter {
  private alerts: AlertRecord[] = [];
  private readonly maxAlertsPerHour = 10;
  private readonly hourInMs = 60 * 60 * 1000;

  /**
   * Check if we can send an alert for this listing
   */
  canSendAlert(listingUrl: string): boolean {
    const now = Date.now();
    
    // Remove alerts older than 1 hour
    this.alerts = this.alerts.filter(alert => now - alert.timestamp < this.hourInMs);
    
    // Check if we've exceeded the hourly limit
    if (this.alerts.length >= this.maxAlertsPerHour) {
      console.log(`Rate limit reached: ${this.alerts.length}/${this.maxAlertsPerHour} alerts in the last hour`);
      return false;
    }
    
    // Check if we've already sent an alert for this specific listing recently (within 1 hour)
    const recentAlertForListing = this.alerts.find(
      alert => alert.listingUrl === listingUrl && now - alert.timestamp < this.hourInMs
    );
    
    if (recentAlertForListing) {
      console.log(`Duplicate alert prevented for listing: ${listingUrl}`);
      return false;
    }
    
    return true;
  }

  /**
   * Record that we sent an alert for this listing
   */
  recordAlert(listingUrl: string): void {
    const now = Date.now();
    this.alerts.push({ timestamp: now, listingUrl });
    console.log(`Alert recorded for ${listingUrl}. Total alerts in last hour: ${this.alerts.length}`);
  }

  /**
   * Get current alert count for monitoring
   */
  getCurrentAlertCount(): number {
    const now = Date.now();
    this.alerts = this.alerts.filter(alert => now - alert.timestamp < this.hourInMs);
    return this.alerts.length;
  }

  /**
   * Clear all alerts (useful for testing)
   */
  clear(): void {
    this.alerts = [];
  }
}

// Export singleton instance
export const telegramRateLimiter = new TelegramRateLimiter();