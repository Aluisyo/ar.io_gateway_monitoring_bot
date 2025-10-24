/**
 * Version checker for AR.IO Gateway
 * Checks if a new version is available and notifies the user
 */
import axios from 'axios';
import { logger } from '../utils/logger.js';
import config from '../config.js';

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
  isOutdated: boolean;
  releaseUrl?: string;
  releaseDate?: string;
  releaseNotes?: string;
}

class VersionChecker {
  private lastCheck: number = 0;
  private checkInterval: number = 86400000; // 24 hours
  private cachedVersionInfo?: { version: string; url: string; date: string; notes: string };

  /**
   * Get current gateway version
   */
  async getCurrentVersion(): Promise<string | null> {
    try {
      const response = await axios.get(`${config.gateway.coreUrl}/ar-io/info`, {
        timeout: 5000,
      });
      
      return response.data.release || null;
    } catch (error: any) {
      logger.error('Failed to fetch current gateway version:', error.message);
      return null;
    }
  }

  /**
   * Get latest version from GitHub releases
   */
  async getLatestVersion(): Promise<{ version: string; url: string; date: string; notes: string } | null> {
    try {
      // Check cache first
      const now = Date.now();
      if (this.cachedVersionInfo && (now - this.lastCheck) < this.checkInterval) {
        return this.cachedVersionInfo;
      }

      const response = await axios.get(
        'https://api.github.com/repos/ar-io/ar-io-node/releases/latest',
        {
          timeout: 10000,
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'ARIO-Gateway-Monitor'
          }
        }
      );

      const versionInfo = {
        version: response.data.tag_name.replace(/^v/, ''), // Remove 'v' prefix if present
        url: response.data.html_url,
        date: response.data.published_at,
        notes: response.data.body || 'No release notes available'
      };

      this.cachedVersionInfo = versionInfo;
      this.lastCheck = now;

      return versionInfo;
    } catch (error: any) {
      logger.error('Failed to fetch latest gateway version:', error.message);
      return null;
    }
  }

  /**
   * Compare versions (handles both r-prefix like r54, r55 and semantic like 1.2.3)
   * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
   */
  private compareVersions(v1: string, v2: string): number {
    // Normalize versions - add 'r' prefix if just a number
    const normalize = (v: string) => /^\d+$/.test(v) ? `r${v}` : v;
    const norm1 = normalize(v1);
    const norm2 = normalize(v2);
    
    // Check if versions use r-prefix format (r54, r55)
    const rMatch1 = norm1.match(/^r(\d+)$/);
    const rMatch2 = norm2.match(/^r(\d+)$/);
    
    if (rMatch1 && rMatch2) {
      const num1 = parseInt(rMatch1[1]);
      const num2 = parseInt(rMatch2[1]);
      if (num1 < num2) return -1;
      if (num1 > num2) return 1;
      return 0;
    }

    // Otherwise treat as semantic version
    // Remove any prefixes like 'v' or 'release-'
    const clean1 = v1.replace(/^(v|release-)/, '');
    const clean2 = v2.replace(/^(v|release-)/, '');

    const parts1 = clean1.split('.').map(n => parseInt(n) || 0);
    const parts2 = clean2.split('.').map(n => parseInt(n) || 0);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;

      if (p1 < p2) return -1;
      if (p1 > p2) return 1;
    }

    return 0;
  }

  /**
   * Check if gateway version is outdated
   */
  async checkVersion(): Promise<VersionInfo | null> {
    try {
      const [currentVersion, latestRelease] = await Promise.all([
        this.getCurrentVersion(),
        this.getLatestVersion()
      ]);

      if (!currentVersion || !latestRelease) {
        return null;
      }

      const isOutdated = this.compareVersions(currentVersion, latestRelease.version) < 0;

      // Normalize version display (add 'r' prefix if just a number)
      const normalizedCurrent = /^\d+$/.test(currentVersion) ? `r${currentVersion}` : currentVersion;

      return {
        currentVersion: normalizedCurrent,
        latestVersion: latestRelease.version,
        isOutdated,
        releaseUrl: latestRelease.url,
        releaseDate: latestRelease.date,
        releaseNotes: latestRelease.notes
      };
    } catch (error: any) {
      logger.error('Failed to check version:', error.message);
      return null;
    }
  }

  /**
   * Format version info for display
   */
  formatVersionInfo(versionInfo: VersionInfo): string {
    let message = `📦 *Gateway Version Check*\n\n`;
    message += `Current Version: \`${versionInfo.currentVersion}\`\n`;
    message += `Latest Version: \`${versionInfo.latestVersion}\`\n\n`;

    if (versionInfo.isOutdated) {
      message += `⚠️ *Your gateway is outdated!*\n\n`;
      message += `A new version is available. Consider updating to get the latest features and fixes.\n\n`;
      
      if (versionInfo.releaseUrl) {
        message += `🔗 [View Release](${versionInfo.releaseUrl})\n`;
      }
      
      if (versionInfo.releaseDate) {
        const date = new Date(versionInfo.releaseDate);
        message += `📅 Released: ${date.toLocaleDateString()}\n`;
      }
    } else {
      message += `✅ *Your gateway is up to date!*`;
    }

    return message;
  }
}

export const versionChecker = new VersionChecker();
