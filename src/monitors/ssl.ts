/**
 * SSL Certificate monitoring
 * Checks certificate expiration and validity
 */
import * as tls from 'tls';
import { logger } from '../utils/logger.js';
import config from '../config.js';

export interface SSLCertificateInfo {
  valid: boolean;
  domain: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  daysRemaining: number;
  subject: string;
  serialNumber?: string;
  error?: string;
}

export class SSLMonitor {
  /**
   * Check SSL certificate for a domain
   */
  async checkCertificate(domain?: string): Promise<SSLCertificateInfo> {
    const targetDomain = domain || config.ssl.domain;

    if (!targetDomain) {
      return {
        valid: false,
        domain: 'not configured',
        issuer: '',
        validFrom: new Date(),
        validTo: new Date(),
        daysRemaining: 0,
        subject: '',
        error: 'SSL_DOMAIN not configured',
      };
    }

    return new Promise((resolve) => {
      const options = {
        host: targetDomain,
        port: 443,
        servername: targetDomain,
        rejectUnauthorized: false, // We want to check even invalid certs
      };

      const socket = tls.connect(options, () => {
        const cert = socket.getPeerCertificate();
        
        if (!cert || Object.keys(cert).length === 0) {
          socket.destroy();
          resolve({
            valid: false,
            domain: targetDomain,
            issuer: '',
            validFrom: new Date(),
            validTo: new Date(),
            daysRemaining: 0,
            subject: '',
            error: 'No certificate found',
          });
          return;
        }

        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const isValid = now >= validFrom && now <= validTo;

        const info: SSLCertificateInfo = {
          valid: isValid,
          domain: targetDomain,
          issuer: cert.issuer?.CN || cert.issuer?.O || 'Unknown',
          validFrom,
          validTo,
          daysRemaining,
          subject: cert.subject?.CN || targetDomain,
          serialNumber: cert.serialNumber,
        };

        socket.destroy();
        resolve(info);
      });

      socket.on('error', (error: any) => {
        resolve({
          valid: false,
          domain: targetDomain,
          issuer: '',
          validFrom: new Date(),
          validTo: new Date(),
          daysRemaining: 0,
          subject: '',
          error: error.message,
        });
      });

      // Timeout after 10 seconds
      socket.setTimeout(10000, () => {
        socket.destroy();
        resolve({
          valid: false,
          domain: targetDomain,
          issuer: '',
          validFrom: new Date(),
          validTo: new Date(),
          daysRemaining: 0,
          subject: '',
          error: 'Connection timeout',
        });
      });
    });
  }

  /**
   * Get warning level based on days remaining
   */
  getWarningLevel(daysRemaining: number): 'critical' | 'warning' | 'info' | 'ok' {
    if (daysRemaining <= 1) return 'critical';
    if (daysRemaining <= 7) return 'warning';
    if (daysRemaining <= 30) return 'info';
    return 'ok';
  }

  /**
   * Format certificate info as human-readable string
   */
  formatCertificateInfo(cert: SSLCertificateInfo): string {
    if (cert.error) {
      return `❌ Error checking certificate: ${cert.error}`;
    }

    const emoji = cert.valid ? '✅' : '❌';
    const statusText = cert.valid ? 'VALID' : 'INVALID';
    
    let message = `${emoji} *SSL Certificate ${statusText}*\n\n`;
    message += `Domain: ${cert.domain}\n`;
    message += `Subject: ${cert.subject}\n`;
    message += `Issuer: ${cert.issuer}\n`;
    message += `Valid From: ${cert.validFrom.toLocaleDateString()}\n`;
    message += `Valid To: ${cert.validTo.toLocaleDateString()}\n`;
    message += `Days Remaining: ${cert.daysRemaining} days\n`;

    if (cert.serialNumber) {
      message += `Serial: ${cert.serialNumber}\n`;
    }

    // Add warning indicators
    const warningLevel = this.getWarningLevel(cert.daysRemaining);
    if (warningLevel === 'critical') {
      message += `\n🔴 *CRITICAL*: Certificate expires in ${cert.daysRemaining} day(s)!`;
    } else if (warningLevel === 'warning') {
      message += `\n⚠️ *WARNING*: Certificate expires soon!`;
    } else if (warningLevel === 'info') {
      message += `\n⚠️ Certificate expires in ${cert.daysRemaining} days`;
    }

    return message;
  }
}
