import { execSync } from 'child_process';
import { logger } from './logger.js';
import config from '../config.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export class LogParser {
  /**
   * Read recent error and warning logs from the gateway
   */
  static async getRecentErrors(lines: number = 50, referenceTimestamp?: number): Promise<LogEntry[]> {
    const logPaths = [
      '/var/log/nginx/error.log',
      '/var/log/ar-io-node/ar-io-node.log',
      `${process.env.HOME}/.pm2/logs/ar-io-node-error.log`,
      `${process.env.HOME}/.pm2/logs/ar-io-node-out.log`,
      './logs/error.log',
      './data/logs/error.log',
    ];

    const errors: LogEntry[] = [];
    const cutoff = Date.now() - ONE_HOUR_MS;
    const sameDayOnly = typeof referenceTimestamp === 'number' ? new Date(referenceTimestamp) : null;

    for (const logPath of logPaths) {
      try {
        // Try to read last N lines from log file, filter for actual errors
        const cmd = `tail -n ${lines} ${logPath} 2>/dev/null | grep -iE "\\[error\\]|\\[critical\\]|level=error|level=critical|ERROR:|CRITICAL:|upstream.*closed|upstream.*timed out" || true`;
        const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        
        if (output.trim()) {
          const logLines = output.trim().split('\n');
          
          for (const line of logLines) {
            const parsed = this.parseLogLine(line);
            if (parsed && this.isRecent(parsed.timestamp, cutoff) && this.isSameDay(parsed.timestamp, sameDayOnly)) {
              errors.push(parsed);
            }
          }
        }
      } catch (error) {
        // Log file doesn't exist or can't be read, skip
        continue;
      }
    }

    // Return most recent errors (unique by message)
    const uniqueErrors = this.deduplicateErrors(errors);
    return uniqueErrors.slice(0, 10); // Limit to 10 most recent
  }

  /**
   * Parse a log line to extract timestamp, level, and message
   */
  private static parseLogLine(line: string): LogEntry | null {
    if (!line || line.trim().length === 0) {
      return null;
    }

    // Try different log formats
    
    // Format 1: JSON logs (common in Node apps)
    if (line.startsWith('{')) {
      try {
        const json = JSON.parse(line);
        return {
          timestamp: json.timestamp || json.time || new Date().toISOString(),
          level: json.level || json.severity || 'ERROR',
          message: json.message || json.msg || line.substring(0, 200),
        };
      } catch {
        // Not valid JSON
      }
    }

    // Format 2: Standard log format with timestamp
    const bracketMatch = line.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2}[T\s][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)\s+\[(\w+)\]\s+(.*)$/);
    if (bracketMatch) {
      return {
        timestamp: bracketMatch[1],
        level: bracketMatch[2].toUpperCase(),
        message: bracketMatch[3].substring(0, 200),
      };
    }

    const standardMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s]*)\s+(\w+)\s*[:\-]\s*(.+)$/);
    if (standardMatch) {
      return {
        timestamp: standardMatch[1],
        level: standardMatch[2].toUpperCase(),
        message: standardMatch[3].substring(0, 200),
      };
    }

    // Format 3: Nginx error log format
    const nginxMatch = line.match(/^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.+)$/);
    if (nginxMatch) {
      return {
        timestamp: nginxMatch[1],
        level: nginxMatch[2].toUpperCase(),
        message: nginxMatch[3].substring(0, 200),
      };
    }

    // Format 4: Generic - just extract error/warning keywords
    const genericMatch = line.match(/(error|warning|critical|fail)/i);
    if (genericMatch) {
      return {
        timestamp: new Date().toISOString(),
        level: genericMatch[1].toUpperCase(),
        message: line.substring(0, 200),
      };
    }

    return null;
  }

  /**
   * Deduplicate errors by message
   */
  private static deduplicateErrors(errors: LogEntry[]): LogEntry[] {
    const seen = new Set<string>();
    const unique: LogEntry[] = [];

    for (const error of errors) {
      // Create a simple hash of the message (first 100 chars)
      const key = error.message.substring(0, 100).toLowerCase();
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(error);
      }
    }

    return unique;
  }

  /**
   * Get logs from all AR.IO containers (core, observer, envoy)
   */
  static async getDockerLogs(containerName?: string, lines: number = 50, referenceTimestamp?: number): Promise<LogEntry[]> {
    try {
      let containers: string[] = [];
      
      if (containerName) {
        containers = [containerName];
      } else {
        // Get ALL AR.IO containers
        try {
          const detectCmd = `docker ps --format "{{.Names}}" 2>/dev/null | grep -E "ar-io.*core|ar-io.*observer|ar-io.*envoy"`;
          const output = execSync(detectCmd, { encoding: 'utf-8' }).trim();
          containers = output ? output.split('\n').filter(c => c.trim()) : [];
        } catch {
          return [];
        }
      }
      
      if (containers.length === 0) return [];
      
      const allErrors: LogEntry[] = [];
      const cutoff = Date.now() - ONE_HOUR_MS;
      const sameDayOnly = typeof referenceTimestamp === 'number' ? new Date(referenceTimestamp) : null;
      
      // Get logs from each container
      for (const container of containers) {
        try {
          const cmd = `docker logs --tail ${lines} ${container} 2>&1 | grep -iE "\\[error\\]|\\[critical\\]|level=error|level=critical|ERROR:|CRITICAL:|upstream.*closed|upstream.*timed out" || true`;
          const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
          
          if (output.trim()) {
            for (const line of output.trim().split('\n')) {
              const parsed = this.parseLogLine(line);
              if (parsed && this.isRecent(parsed.timestamp, cutoff) && this.isSameDay(parsed.timestamp, sameDayOnly)) {
                allErrors.push(parsed);
              }
            }
          }
        } catch (err) {
          logger.debug(`Could not read logs from ${container}`);
        }
      }
      
      return this.deduplicateErrors(allErrors).slice(0, 10);
    } catch (error) {
      logger.debug('Docker logs not available:', error);
    }

    return [];
  }

  private static isRecent(timestamp: string, cutoff: number): boolean {
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      return true; // Keep entries we can't parse rather than drop context entirely
    }
    return parsed >= cutoff;
  }

  private static isSameDay(timestamp: string, referenceDate: Date | null): boolean {
    if (!referenceDate) {
      return true;
    }

    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      return true;
    }

    const entryDate = new Date(parsed);
    return entryDate.getUTCFullYear() === referenceDate.getUTCFullYear() &&
           entryDate.getUTCMonth() === referenceDate.getUTCMonth() &&
           entryDate.getUTCDate() === referenceDate.getUTCDate();
  }

  /**
   * Format errors for Telegram message
   */
  static formatErrorsForTelegram(errors: LogEntry[]): string {
    if (errors.length === 0) {
      return '';
    }

    let message = '\n\n*🔍 Recent Errors*\n';
    
    for (const error of errors.slice(0, 5)) { // Show top 5
      const levelEmoji = this.getLevelEmoji(error.level);
      const sanitized = this.escapeMarkdown(error.message);
      message += `${levelEmoji} \`${sanitized}\`\n`;
    }

    if (errors.length > 5) {
      message += `\n_...and ${errors.length - 5} more errors_`;
    }

    return message;
  }

  /**
   * Get emoji for log level
   */
  private static getLevelEmoji(level: string): string {
    const l = level.toUpperCase();
    if (l.includes('CRITICAL') || l.includes('FATAL')) return '🔴';
    if (l.includes('ERROR')) return '❌';
    if (l.includes('WARN')) return '⚠️';
    return '📝';
  }

  private static escapeMarkdown(text: string): string {
    return text
      .replace(/`/g, "'")
      .replace(/([_*\\\[\]\(\)])/g, '\\$1');
  }
}
