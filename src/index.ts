/**
 * AR.IO Gateway Monitoring Bot
 * Self-hosted monitoring solution for AR.IO gateway operators
 */
import axios from 'axios';
import { logger } from './utils/logger.js';
import config from './config.js';
import { runtimeConfig } from './utils/runtime-config.js';
import { HealthMonitor } from './monitors/health.js';
import { ObserverMonitor, type EpochStats } from './monitors/observer.js';
import { NetworkMonitor } from './monitors/network.js';
import { SSLMonitor } from './monitors/ssl.js';
import { TelegramBot } from './alerts/telegram.js';
import { metricsTracker } from './utils/metrics-tracker.js';
import { containerMonitor } from './monitors/container.js';
import { metricsDb } from './utils/metrics-db.js';

class MonitoringBot {
  private healthMonitor: HealthMonitor;
  private observerMonitor: ObserverMonitor;
  private networkMonitor: NetworkMonitor;
  private sslMonitor: SSLMonitor;
  private telegram: TelegramBot;
  private healthCheckTimer?: NodeJS.Timeout;
  private observerCheckTimer?: NodeJS.Timeout;
  private networkCheckTimer?: NodeJS.Timeout;
  private sslCheckTimer?: NodeJS.Timeout;
  private resourceCheckTimer?: NodeJS.Timeout;
  private containerCheckTimer?: NodeJS.Timeout;
  private dailySummaryTimer?: NodeJS.Timeout;
  private weeklySummaryTimer?: NodeJS.Timeout;
  private metricsRecordingTimer?: NodeJS.Timeout;
  private versionCheckTimer?: NodeJS.Timeout;
  private arnsResolutionTimer?: NodeJS.Timeout;
  private previousHealth?: { core: boolean; observer: boolean };
  private lastSSLWarning?: string;
  private cpuHistory: Array<{ value: number; timestamp: number }> = [];
  private previousMetrics?: {
    timestamp: number;
    blockHeight?: number;
    arnsResolutions?: number;
    arnsCacheHits?: number;
    arnsCacheMisses?: number;
    errors?: number;
    totalRequests?: number;
  };
  private errorRateHistory: Array<{ errors: number; requests: number; timestamp: number }> = [];
  private observerSelectionHistory: Array<{
    epochIndex: number;
    selected: boolean;
    timestamp: number;
  }> = [];
  private lastObserverCheck?: {
    epochIndex: number;
    wasSelected: boolean;
    hadReport: boolean;
  };

  constructor() {
    this.healthMonitor = new HealthMonitor();
    this.observerMonitor = new ObserverMonitor();
    this.networkMonitor = new NetworkMonitor();
    this.sslMonitor = new SSLMonitor();
    this.telegram = new TelegramBot();
  }

  async start() {
    try {
      logger.info('🚀 Starting AR.IO Gateway Monitoring Bot...');
      logger.info(`Monitoring: ${config.gateway.name}`);
      logger.info(`Core URL: ${config.gateway.coreUrl}`);
      logger.info(`Observer URL: ${config.gateway.observerUrl}`);

      this.setupTelegramHandlers();
      
      this.telegram.start().catch(error => {
        logger.error('❌ Fatal Telegram error:', error);
        process.exit(1);
      });
      
      await new Promise(resolve => setTimeout(resolve, 3000));

      await this.telegram.sendAlert('info', 
        `🚀 Bot Started\n\n` +
        `Monitoring: ${config.gateway.name}\n` +
        `Health checks every ${config.monitoring.healthCheckInterval / 1000}s\n` +
        `Observer checks every ${config.monitoring.observerCheckInterval / 1000}s`
      );

      this.startHealthMonitoring();
      this.startObserverMonitoring();
      this.startNetworkMonitoring();
      this.startSSLMonitoring();
      this.startResourceMonitoring();
      this.startContainerMonitoring();
      this.startArnsResolutionMonitoring();
      this.startMetricsRecording();
      this.startScheduledReports();
      this.startVersionChecking();

      logger.info('✅ All monitoring systems active');
    } catch (error: any) {
      logger.error('Failed to start monitoring bot:', error.message);
      throw error;
    }
  }

  private setupTelegramHandlers() {
    this.telegram.setStatusHandler(async () => {
      return await this.healthMonitor.checkHealth();
    });

    this.telegram.setInfoHandler(async () => {
      return await this.observerMonitor.getGatewayInfo();
    });

    this.telegram.setObserverHandler(async () => {
      return await this.observerMonitor.checkObserverStatus();
    });

    this.telegram.setEpochHandler(async () => {
      return await this.observerMonitor.getEpochStats();
    });

    this.telegram.setSSLHandler(
      async () => await this.sslMonitor.checkCertificate(),
      (cert) => this.sslMonitor.formatCertificateInfo(cert)
    );

    this.telegram.setRewardsHandler(async () => {
      return await this.observerMonitor.getRewards();
    });

    this.telegram.setMetricsHandler(async () => {
      return await this.healthMonitor.getMetrics();
    });
  }

  private startHealthMonitoring() {
    logger.info('Starting health monitoring...');

    const checkHealth = async () => {
      try {
        const health = await this.healthMonitor.checkHealth();
        
        if (this.previousHealth) {
          if (this.previousHealth.core !== health.core.isHealthy) {
            if (!health.core.isHealthy) {
              logger.error('Core service went DOWN');
              await this.telegram.sendAlert('critical',
                `Core service is DOWN\n` +
                `Error: ${health.core.error || 'No response'}\n` +
                `Response time: ${health.core.responseTime}ms`,
                'service_health'
              );
            } else {
              logger.info('Core service recovered');
              await this.telegram.sendAlert('info',
                `Core service is back UP\n` +
                `Response time: ${health.core.responseTime}ms`,
                'service_health'
              );
            }
          }

          if (this.previousHealth.observer !== health.observer.isHealthy) {
            if (!health.observer.isHealthy) {
              logger.error('Observer service went DOWN');
              await this.telegram.sendAlert('critical',
                `Observer service is DOWN\n` +
                `Error: ${health.observer.error || 'No response'}\n` +
                `Response time: ${health.observer.responseTime}ms`,
                'service_health'
              );
            } else {
              logger.info('Observer service recovered');
              await this.telegram.sendAlert('info',
                `Observer service is back UP\n` +
                `Response time: ${health.observer.responseTime}ms`,
                'service_health'
              );
            }
          }
        }

        // Check latency for both services
        const latencyThreshold = runtimeConfig.get('latencyThreshold');
        if (health.core.isHealthy && health.core.responseTime > latencyThreshold) {
          logger.warn(`High core latency: ${health.core.responseTime}ms`);
          await this.telegram.sendResourceAlert('latency', health.core.responseTime, latencyThreshold, 'core');
        }
        
        if (health.observer.isHealthy && health.observer.responseTime > latencyThreshold) {
          logger.warn(`High observer latency: ${health.observer.responseTime}ms`);
          await this.telegram.sendResourceAlert('latency', health.observer.responseTime, latencyThreshold, 'observer');
        }

        this.previousHealth = {
          core: health.core.isHealthy,
          observer: health.observer.isHealthy,
        };

      } catch (error: any) {
        logger.error('Health check failed:', error.message);
      }
    };

    checkHealth();
    this.healthCheckTimer = setInterval(checkHealth, config.monitoring.healthCheckInterval);
  }

  private startObserverMonitoring() {
    if (!config.gateway.address) {
      logger.warn('Gateway address not configured - observer monitoring disabled');
      return;
    }

    logger.info('Starting observer monitoring...');

    const checkObserver = async () => {
      try {
        const status = await this.observerMonitor.checkObserverStatus();
        const now = Date.now();
        const previousEpoch = this.lastObserverCheck?.epochIndex;
        const epochChanged = previousEpoch !== undefined && status.epochIndex !== previousEpoch;

        if (epochChanged) {
          // Alert for previous epoch ending / new epoch starting
          if (previousEpoch !== undefined) {
            try {
              const previousStats = await this.observerMonitor.getEpochStats(previousEpoch);
              const message = this.formatEpochChangeMessage('ended', previousStats);
              await this.telegram.sendAlert('info', message, 'epoch');
            } catch (error: any) {
              logger.warn('Failed to fetch previous epoch stats:', error?.message || error);
            }
          }

          try {
            const currentStats = await this.observerMonitor.getEpochStats(status.epochIndex);
            const message = this.formatEpochChangeMessage('started', currentStats);
            await this.telegram.sendAlert('info', message, 'epoch');
          } catch (error: any) {
            logger.warn('Failed to fetch new epoch stats:', error?.message || error);
          }
        }

        if (status.isSelectedAsObserver && !status.hasSubmittedReport) {
          const timeRemaining = status.epochEndTimestamp 
            ? status.epochEndTimestamp - now
            : 0;
          
          const hoursRemaining = Math.floor(timeRemaining / 3600000);
          
          if (hoursRemaining < 12 && hoursRemaining > 0) {
            logger.warn(`Observer report not submitted, ${hoursRemaining}h remaining`);
            await this.telegram.sendAlert('warning',
              `⚠️ No observation report submitted!\n\n` +
              `Epoch: ${status.epochIndex}\n` +
              `Time remaining: ${hoursRemaining} hours\n` +
              `Action: Submit observations now!`,
              'observer_report'
            );
          }
          
          if (hoursRemaining <= 0 && this.lastObserverCheck?.epochIndex !== status.epochIndex) {
            logger.error(`Failed to submit report for epoch ${status.epochIndex}`);
            await this.telegram.sendObserverAlert('report_failed', {
              epochIndex: status.epochIndex,
              additional: 'Epoch deadline has passed',
            });
          }
        }

        if (!this.lastObserverCheck || this.lastObserverCheck.epochIndex !== status.epochIndex) {
          this.observerSelectionHistory.push({
            epochIndex: status.epochIndex,
            selected: status.isSelectedAsObserver,
            timestamp: now,
          });

          if (this.observerSelectionHistory.length > 20) {
            this.observerSelectionHistory.shift();
          }

          const recentHistory = this.observerSelectionHistory.slice(-config.alerts.notSelectedEpochsThreshold);
          if (recentHistory.length >= config.alerts.notSelectedEpochsThreshold) {
            const allNotSelected = recentHistory.every(h => !h.selected);
            
            if (allNotSelected) {
              const firstEpoch = recentHistory[0].epochIndex;
              const lastEpoch = recentHistory[recentHistory.length - 1].epochIndex;
              logger.warn(`Not selected for ${config.alerts.notSelectedEpochsThreshold} consecutive epochs`);
              await this.telegram.sendObserverAlert('not_selected', {
                value: config.alerts.notSelectedEpochsThreshold,
                threshold: config.alerts.notSelectedEpochsThreshold,
                additional: `Epochs ${firstEpoch} - ${lastEpoch}`,
              });
            }
          }
        }

        if (status.observerWeight !== undefined && 
            status.observerWeight < config.alerts.lowObserverWeightThreshold) {
          await this.telegram.sendObserverAlert('low_weight', {
            value: status.observerWeight,
            threshold: config.alerts.lowObserverWeightThreshold,
            additional: `Lower weights reduce selection probability`,
          });
        }

        this.lastObserverCheck = {
          epochIndex: status.epochIndex,
          wasSelected: status.isSelectedAsObserver,
          hadReport: status.hasSubmittedReport || false,
        };

      } catch (error: any) {
        logger.error('Observer monitoring error:', error);
      }
    };

    setTimeout(checkObserver, 10000);
    this.observerCheckTimer = setInterval(checkObserver, config.monitoring.observerCheckInterval);
  }

  private formatEpochChangeMessage(event: 'started' | 'ended', stats: EpochStats): string {
    const lines: string[] = [];
    const headerEmoji = event === 'started' ? '🚀' : '✅';
    const headerVerb = event === 'started' ? 'Started' : 'Ended';

    lines.push(`${headerEmoji} *Epoch ${stats.epochIndex} ${headerVerb}*`);

    if (event === 'started') {
      lines.push(`Start: ${this.formatDateTime(stats.startTimestamp)}`);
      lines.push(`Planned End: ${this.formatDateTime(stats.endTimestamp)}`);
    } else {
      lines.push(`Ended: ${this.formatDateTime(stats.endTimestamp)}`);
      lines.push(`Duration: ${this.formatDuration(stats.startTimestamp, stats.endTimestamp)}`);
    }

    lines.push('');
    lines.push('*Observers*');
    if (
      stats.totalObservers !== undefined &&
      stats.observationCount !== undefined &&
      stats.observationPercentage !== undefined
    ) {
      lines.push(
        `Reports Submitted: ${stats.observationCount}/${stats.totalObservers} (${stats.observationPercentage.toFixed(1)}%)`
      );
    } else {
      lines.push('Reports Submitted: Data unavailable');
    }

    lines.push('');
    lines.push('*Rewards*');
    lines.push(`Eligible Rewards: ${stats.totalEligibleRewards?.toFixed(2) ?? 'N/A'} ARIO`);

    if (stats.isDistributed) {
      lines.push(
        `Distributed: ${stats.totalDistributedRewards?.toFixed(2) ?? 0} ARIO (${stats.distributionPercentage?.toFixed(1) ?? '0'}%)`
      );

      if (
        stats.gatewaysPassed !== undefined &&
        stats.gatewaysFailed !== undefined &&
        stats.passPercentage !== undefined &&
        stats.failPercentage !== undefined
      ) {
        lines.push(
          `Pass: ${stats.gatewaysPassed} (${stats.passPercentage.toFixed(1)}%) | Fail: ${stats.gatewaysFailed} (${stats.failPercentage.toFixed(1)}%)`
        );
      }
    } else {
      lines.push('Distribution: Pending');
    }

    return lines.join('\n');
  }

  private formatDateTime(timestamp?: number): string {
    if (!timestamp) {
      return 'N/A';
    }
    return new Date(timestamp).toLocaleString();
  }

  private formatDuration(startTimestamp?: number, endTimestamp?: number): string {
    if (!startTimestamp || !endTimestamp || endTimestamp <= startTimestamp) {
      return 'N/A';
    }

    const durationMs = endTimestamp - startTimestamp;
    const durationMinutes = Math.floor(durationMs / 60000);
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
  }

  private startNetworkMonitoring() {
    if (!config.features.monitorGatewayRegistry && !config.features.monitorArnsActivity) {
      logger.info('Network monitoring disabled (opt-in required)');
      return;
    }

    logger.info('Starting network monitoring...');
    if (config.features.monitorGatewayRegistry) {
      logger.info('  - Gateway registry changes enabled');
    }
    if (config.features.monitorArnsActivity) {
      logger.info('  - ArNS activity monitoring enabled');
    }

    const checkNetwork = async () => {
      logger.info('⏰ Network monitoring check starting...');
      try {
        if (config.features.monitorGatewayRegistry) {
          const gatewayChanges = await this.networkMonitor.checkGatewayChanges();
          for (const change of gatewayChanges) {
            await this.telegram.sendGatewayChangeAlert(change);
          }
        }

        if (config.features.monitorArnsActivity) {
          const arnsChanges = await this.networkMonitor.checkArnsChanges();
          for (const change of arnsChanges) {
            await this.telegram.sendArnsChangeAlert(change);
          }
        }

      } catch (error: any) {
        logger.error('Network monitoring error:', error);
      }
    };

    setTimeout(checkNetwork, 30000);
    this.networkCheckTimer = setInterval(checkNetwork, config.monitoring.networkCheckInterval);
  }

  private startArnsResolutionMonitoring() {
    const gatewayHost = config.gateway.host;
    if (!gatewayHost) {
      logger.warn('Cannot start ArNS resolution monitoring: GATEWAY_HOST not configured');
      return;
    }

    const requiredHeaders = ['x-arns-process-id', 'x-arns-resolved-id', 'x-arns-ttl-seconds'];
    const sampleSize = 10;
    const initialEnabled = runtimeConfig.get('monitorArnsResolution');
    logger.info(`ArNS resolution monitoring ${initialEnabled ? 'enabled' : 'disabled'} (runtime config)`);

    const scheduleNextRun = (minDelayMs: number, maxDelayMs: number) => {
      const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
      this.arnsResolutionTimer = setTimeout(runCheck, delay);
    };

    const runCheck = async () => {
      if (!runtimeConfig.get('monitorArnsResolution')) {
        logger.debug('Skipping ArNS resolution check: feature disabled in runtime config');
        scheduleNextRun(50 * 60 * 1000, 70 * 60 * 1000);
        return;
      }

      try {
        const snapshots = metricsDb.getAllNetworkSnapshots('arns');

        if (snapshots.size === 0) {
          logger.info('Skipping ArNS resolution check: no ArNS snapshots available');
          scheduleNextRun(50 * 60 * 1000, 70 * 60 * 1000);
          return;
        }

        const allNames = Array.from(snapshots.keys());
        shuffleInPlace(allNames);
        const selection = allNames.slice(0, Math.min(sampleSize, allNames.length));
        const failures: string[] = [];

        for (const name of selection) {
          const url = `https://${name}.${gatewayHost}`;
          try {
            const response = await axios.head(url, {
              timeout: 5000,
              validateStatus: () => true,
            });

            if (response.status !== 200) {
              failures.push(`${url} (HTTP ${response.status})`);
              continue;
            }

            const missingHeaders = requiredHeaders.filter((header) => !response.headers[header]);
            if (missingHeaders.length > 0) {
              failures.push(`${url} (missing headers: ${missingHeaders.join(', ')})`);
            }
          } catch (error: any) {
            failures.push(`${url} (${error?.message || 'request failed'})`);
          }
        }

        if (failures.length > 0) {
          const message =
            `⚠️ ArNS resolution issues detected:\n` +
            failures.map((item) => `• ${item}`).join('\n');

          logger.warn('ArNS resolution check detected failures', { failures });
          await this.telegram.sendAlert('warning', message, 'arns_resolution');
        } else {
          logger.info('ArNS resolution check passed', { namesTested: selection });
        }
      } catch (error: any) {
        logger.error('ArNS resolution check failed', error);
      } finally {
        scheduleNextRun(50 * 60 * 1000, 70 * 60 * 1000);
      }
    };

    const initialDelayMs = 5 * 60 * 1000 + Math.random() * (10 * 60 * 1000);
    this.arnsResolutionTimer = setTimeout(runCheck, initialDelayMs);
    logger.info('ArNS resolution monitoring scheduled', { initialDelayMs });
  }

  private startSSLMonitoring() {
    if (!config.features.monitorSslCertificate || !config.ssl.domain) {
      logger.info('SSL monitoring disabled');
      return;
    }

    logger.info(`Starting SSL monitoring for ${config.ssl.domain}...`);

    const checkSSL = async () => {
      try {
        const cert = await this.sslMonitor.checkCertificate();
        
        if (cert.error) {
          const errorKey = `ssl_error:${cert.error}`;
          if (this.lastSSLWarning !== errorKey) {
            await this.telegram.sendAlert('warning',
              `SSL Certificate Check Failed\n\n` +
              `Domain: ${cert.domain}\n` +
              `Error: ${cert.error}`,
              'ssl_certificate'
            );
            this.lastSSLWarning = errorKey;
          }
          return;
        }

        const warningLevel = this.sslMonitor.getWarningLevel(cert.daysRemaining);
        
        if (warningLevel === 'critical' && this.lastSSLWarning !== 'critical') {
          await this.telegram.sendAlert('critical',
            `SSL Certificate Expiring SOON!\n\n` +
            `Domain: ${cert.domain}\n` +
            `Days Remaining: ${cert.daysRemaining}\n` +
            `Expires: ${new Date(cert.validTo).toLocaleDateString()}`,
            'ssl_certificate'
          );
          this.lastSSLWarning = 'critical';
        } else if (warningLevel === 'warning' && this.lastSSLWarning !== 'warning') {
          await this.telegram.sendAlert('warning',
            `SSL Certificate Expiring Soon\n\n` +
            `Domain: ${cert.domain}\n` +
            `Days Remaining: ${cert.daysRemaining}\n` +
            `Expires: ${new Date(cert.validTo).toLocaleDateString()}`,
            'ssl_certificate'
          );
          this.lastSSLWarning = 'warning';
        } else if (warningLevel === 'info' && this.lastSSLWarning !== 'info') {
          await this.telegram.sendAlert('info',
            `SSL Certificate Renewal Reminder\n\n` +
            `Domain: ${cert.domain}\n` +
            `Days Remaining: ${cert.daysRemaining}\n` +
            `Renew by: ${new Date(cert.validTo).toLocaleDateString()}`,
            'ssl_certificate'
          );
          this.lastSSLWarning = 'info';
        } else if (warningLevel === 'ok') {
          this.lastSSLWarning = undefined;
        }

      } catch (error: any) {
        logger.error('SSL monitoring error:', error);
      }
    };

    setTimeout(checkSSL, 20000);
    this.sslCheckTimer = setInterval(checkSSL, config.monitoring.sslCheckInterval);
  }

  async stop() {
    logger.info('Stopping monitoring bot...');
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    if (this.observerCheckTimer) {
      clearInterval(this.observerCheckTimer);
    }

    if (this.networkCheckTimer) {
      clearInterval(this.networkCheckTimer);
    }

    if (this.sslCheckTimer) {
      clearInterval(this.sslCheckTimer);
    }

    if (this.resourceCheckTimer) {
      clearInterval(this.resourceCheckTimer);
    }

    if (this.containerCheckTimer) {
      clearInterval(this.containerCheckTimer);
    }

    if (this.metricsRecordingTimer) {
      clearInterval(this.metricsRecordingTimer);
    }

    if (this.dailySummaryTimer) {
      clearTimeout(this.dailySummaryTimer);
    }

    if (this.weeklySummaryTimer) {
      clearTimeout(this.weeklySummaryTimer);
    }

    if (this.versionCheckTimer) {
      clearInterval(this.versionCheckTimer);
    }

    if (this.arnsResolutionTimer) {
      clearTimeout(this.arnsResolutionTimer);
    }

    logger.info('Monitoring bot stopped');
  }

  private startResourceMonitoring() {
    logger.info('Starting resource alert monitoring...');

    const checkResources = async () => {
      try {
        const metrics = await this.healthMonitor.getMetrics();
        const now = Date.now();

        if (metrics.cpuUsagePercent !== undefined) {
          this.cpuHistory.push({ value: metrics.cpuUsagePercent, timestamp: now });
          
          const tenMinutesAgo = now - (10 * 60 * 1000);
          this.cpuHistory = this.cpuHistory.filter(h => h.timestamp > tenMinutesAgo);

          const durationMs = config.alerts.cpuDurationMinutes * 60 * 1000;
          const cutoffTime = now - durationMs;
          const recentHighCpu = this.cpuHistory.filter(
            h => h.timestamp >= cutoffTime && h.value >= config.alerts.cpuThreshold
          );

          const samplesInWindow = this.cpuHistory.filter(h => h.timestamp >= cutoffTime);
          if (samplesInWindow.length >= config.alerts.cpuDurationMinutes && 
              recentHighCpu.length === samplesInWindow.length &&
              metrics.cpuUsagePercent >= config.alerts.cpuThreshold) {
            logger.warn(`CPU sustained high: ${metrics.cpuUsagePercent.toFixed(1)}% for ${config.alerts.cpuDurationMinutes}min`);
            await this.telegram.sendResourceAlert(
              'cpu',
              metrics.cpuUsagePercent,
              config.alerts.cpuThreshold,
              config.alerts.cpuDurationMinutes
            );
          }
        }

        if (metrics.memoryUsagePercent !== undefined && 
            metrics.memoryUsagePercent >= config.alerts.memoryThreshold) {
          logger.warn(`Memory high: ${metrics.memoryUsagePercent.toFixed(1)}%`);
          await this.telegram.sendResourceAlert(
            'memory',
            metrics.memoryUsagePercent,
            config.alerts.memoryThreshold
          );
        }

        if (metrics.diskUsagePercent !== undefined && 
            metrics.diskUsagePercent >= config.alerts.diskThreshold) {
          logger.warn(`Disk space high: ${metrics.diskUsagePercent.toFixed(1)}%`);
          await this.telegram.sendResourceAlert(
            'disk',
            metrics.diskUsagePercent,
            config.alerts.diskThreshold
          );
        }

        if (metrics.averageResponseTimeMs !== undefined && 
            metrics.averageResponseTimeMs >= config.alerts.responseTimeThreshold) {
          await this.telegram.sendResourceAlert(
            'response_time',
            metrics.averageResponseTimeMs,
            config.alerts.responseTimeThreshold
          );
        }

        if (metrics.heightDifference !== undefined && 
            metrics.heightDifference > config.alerts.blockSyncLagThreshold) {
          logger.warn(`Block sync lagging: ${metrics.heightDifference} blocks behind`);
          const estimatedTime = this.estimateSyncTime(metrics.heightDifference);
          
          let additionalInfo = '';
          if (metrics.lastHeightImported !== undefined && metrics.currentNetworkHeight !== undefined) {
            additionalInfo = `Current: ${metrics.lastHeightImported.toLocaleString()}\n` +
                           `Expected: ${metrics.currentNetworkHeight.toLocaleString()}\n` +
                           `Behind: ${metrics.heightDifference.toLocaleString()} blocks`;
            if (estimatedTime) {
              additionalInfo += `\nEstimated catch-up: ${estimatedTime}`;
            }
          } else if (estimatedTime) {
            additionalInfo = `Estimated catch-up time: ${estimatedTime}`;
          }
          
          await this.telegram.sendPerformanceAlert('block_sync', {
            current: metrics.heightDifference,
            threshold: config.alerts.blockSyncLagThreshold,
            additional: additionalInfo || undefined,
          });
        }

        if (metrics.arnsCacheHitRate !== undefined && 
            metrics.arnsCacheHitRate < config.alerts.arnsCacheHitRateThreshold) {
          logger.warn(`ArNS cache hit rate low: ${metrics.arnsCacheHitRate.toFixed(1)}%`);
          await this.telegram.sendPerformanceAlert('arns_cache', {
            current: metrics.arnsCacheHitRate,
            threshold: config.alerts.arnsCacheHitRateThreshold,
          });
        }

        if (this.previousMetrics && metrics.arnsErrors !== undefined && metrics.httpRequestsTotal !== undefined) {
          const rawErrorsDelta = metrics.arnsErrors - (this.previousMetrics.errors || 0);
          const rawRequestsDelta = metrics.httpRequestsTotal - (this.previousMetrics.totalRequests || 0);

          if (rawErrorsDelta < 0 || rawRequestsDelta < 0) {
            // Counter reset detected – clear history to avoid skewed calculations
            this.errorRateHistory = [];
          }

          const errorsDelta = Math.max(rawErrorsDelta, 0);
          const requestsDelta = Math.max(rawRequestsDelta, 0);

          if (requestsDelta > 0) {
            this.errorRateHistory.push({ errors: errorsDelta, requests: requestsDelta, timestamp: now });

            const smoothingWindowMs = 10 * 60 * 1000;
            const windowStart = now - smoothingWindowMs;
            this.errorRateHistory = this.errorRateHistory.filter(sample => sample.timestamp >= windowStart);

            const aggregated = this.errorRateHistory.reduce(
              (acc, sample) => {
                acc.errors += sample.errors;
                acc.requests += sample.requests;
                return acc;
              },
              { errors: 0, requests: 0 }
            );

            if (aggregated.requests >= config.alerts.errorRateMinRequests && aggregated.requests > 0) {
              const smoothedErrorRate = (aggregated.errors / aggregated.requests) * 100;

              if (smoothedErrorRate > config.alerts.errorRateThreshold) {
                logger.warn(
                  `Error rate high (smoothed): ${smoothedErrorRate.toFixed(2)}% (${aggregated.errors} errors / ${aggregated.requests} requests)`
                );
                const additionalDetails = [
                  `${aggregated.errors} errors in ${aggregated.requests.toLocaleString()} requests (last ${smoothingWindowMs / 60000} min)`,
                  `${errorsDelta} errors in ${requestsDelta.toLocaleString()} requests (latest interval)`
                ].join('\n');

                await this.telegram.sendPerformanceAlert('error_rate', {
                  current: smoothedErrorRate,
                  threshold: config.alerts.errorRateThreshold,
                  additional: additionalDetails,
                });
              }
            }
          }
        }

        this.previousMetrics = {
          timestamp: now,
          blockHeight: metrics.lastHeightImported,
          arnsResolutions: metrics.arnsResolutions,
          errors: metrics.arnsErrors,
          totalRequests: metrics.httpRequestsTotal,
        };

      } catch (error: any) {
        logger.error('Resource monitoring error:', error);
      }
    };

    checkResources();
    this.resourceCheckTimer = setInterval(checkResources, 60 * 1000);
  }

  private estimateSyncTime(blocksRemaining: number): string | undefined {
    const avgBlocksPerMinute = 20;
    const minutesRemaining = Math.ceil(blocksRemaining / avgBlocksPerMinute);
    
    if (minutesRemaining < 60) {
      return `~${minutesRemaining} minutes`;
    } else if (minutesRemaining < 1440) {
      const hours = Math.ceil(minutesRemaining / 60);
      return `~${hours} hour${hours > 1 ? 's' : ''}`;
    } else {
      const days = Math.ceil(minutesRemaining / 1440);
      return `~${days} day${days > 1 ? 's' : ''}`;
    }
  }

  private startContainerMonitoring() {
    logger.info('Starting container state monitoring...');

    const checkContainers = async () => {
      try {
        const states = await containerMonitor.getContainerStates();
        const changes = containerMonitor.detectChanges(states);

        for (const change of changes) {
          const emoji = containerMonitor.getServiceEmoji(change.container);
          const serviceName = containerMonitor.getServiceName(change.container);
          
          let message = '';
          let severity: 'info' | 'warning' | 'critical' = 'info';

          switch (change.type) {
            case 'started':
              message = `${emoji} *${serviceName} Started*\n\n` +
                       `Container: \`${change.container}\`\n` +
                       `Status: ${change.currentStatus}\n` +
                       `Time: ${change.timestamp.toLocaleString()}`;
              severity = 'info';
              break;

            case 'stopped':
              message = `${emoji} *${serviceName} Stopped*\n\n` +
                       `Container: \`${change.container}\`\n` +
                       `Previous Status: ${change.previousStatus}\n` +
                       `Current Status: ${change.currentStatus}\n` +
                       `Time: ${change.timestamp.toLocaleString()}`;
              severity = 'warning';
              break;

            case 'restarted':
              message = `${emoji} *${serviceName} Restarted*\n\n` +
                       `Container: \`${change.container}\`\n` +
                       `Restart Count: ${change.restartCount || 0}\n` +
                       `Time: ${change.timestamp.toLocaleString()}`;
              severity = 'warning';
              break;

            case 'crashed':
              message = `${emoji} *${serviceName} Crashed*\n\n` +
                       `Container: \`${change.container}\`\n` +
                       `Previous Status: ${change.previousStatus}\n` +
                       `Current Status: ${change.currentStatus}\n` +
                       `Time: ${change.timestamp.toLocaleString()}\n\n` +
                       `⚠️ Service may need manual intervention`;
              severity = 'critical';
              break;
          }

          if (change.type === 'crashed' || change.type === 'stopped') {
            logger.error(`Container ${change.type}: ${serviceName}`);
          } else if (change.type === 'restarted') {
            logger.warn(`Container restarted: ${serviceName} (count: ${change.restartCount || 0})`);
          }
          await this.telegram.sendAlert(severity, message, 'container_status');
        }
      } catch (error: any) {
        logger.error('Error checking container states:', error.message);
      }
    };

    checkContainers();
    this.containerCheckTimer = setInterval(checkContainers, 30 * 1000);
  }

  private startMetricsRecording() {
    logger.info('Starting metrics recording...');

    const recordMetrics = async () => {
      try {
        const metrics = await this.healthMonitor.getMetrics();
        const status = await this.observerMonitor.checkObserverStatus();

        metricsTracker.recordMetrics({
          timestamp: Date.now(),
          cpuUsage: metrics.cpuUsagePercent,
          memoryUsage: metrics.memoryUsagePercent,
          diskUsage: metrics.diskUsagePercent,
          uptimeSeconds: metrics.uptimeSeconds,
          blockHeight: metrics.lastHeightImported,
          heightDifference: metrics.heightDifference,
          httpRequests: metrics.httpRequestsTotal,
          arnsResolutions: metrics.arnsResolutions,
          arnsCacheHitRate: metrics.arnsCacheHitRate,
          graphqlRequests: metrics.graphqlRequestsTotal,
          errors: metrics.arnsErrors,
          observerSelected: status.isSelectedAsObserver,
          observerReportSubmitted: status.hasSubmittedReport || false,
          observerWeight: status.observerWeight,
        });

      } catch (error: any) {
        logger.error('Failed to record metrics:', error);
      }
    };

    // Record every minute
    recordMetrics();
    this.metricsRecordingTimer = setInterval(recordMetrics, 60 * 1000);
  }

  private startScheduledReports() {
    if (!config.reports.enableDailySummary && !config.reports.enableWeeklySummary) {
      logger.info('Scheduled reports disabled');
      return;
    }

    logger.info('Starting scheduled reports...');

    if (config.reports.enableDailySummary) {
      this.scheduleDailyReport();
    }

    if (config.reports.enableWeeklySummary) {
      this.scheduleWeeklyReport();
    }
  }

  private scheduleDailyReport() {
    const sendDailyReport = async () => {
      try {
        logger.info('Generating daily summary report...');
        const summary = metricsTracker.getDailySummary();
        
        // Try to get current epoch rewards
        let rewardsEarned: number | undefined;
        try {
          const rewards = await this.observerMonitor.getRewards();
          rewardsEarned = rewards.totalReward;
        } catch (error) {
          // Rewards unavailable
        }

        await this.telegram.sendDailySummary({ ...summary, rewardsEarned });
        logger.info('Daily summary sent');
      } catch (error: any) {
        logger.error('Failed to send daily summary:', error);
      }
    };

    // Calculate time until next scheduled report
    const scheduleNext = () => {
      const now = new Date();
      const [hours, minutes] = config.reports.dailySummaryTime.split(':').map(Number);
      
      const scheduledTime = new Date();
      scheduledTime.setHours(hours, minutes, 0, 0);
      
      // If scheduled time has passed today, schedule for tomorrow
      if (now >= scheduledTime) {
        scheduledTime.setDate(scheduledTime.getDate() + 1);
      }
      
      const msUntilReport = scheduledTime.getTime() - now.getTime();
      
      logger.info(`Daily summary scheduled for ${scheduledTime.toLocaleString()}`);
      
      this.dailySummaryTimer = setTimeout(async () => {
        await sendDailyReport();
        scheduleNext(); // Schedule next day's report
      }, msUntilReport);
    };

    scheduleNext();
  }

  private scheduleWeeklyReport() {
    const sendWeeklyReport = async () => {
      try {
        logger.info('Generating weekly summary report...');
        const summary = metricsTracker.getWeeklySummary();
        
        // Try to get rewards for the week
        let totalRewards: number | undefined;
        try {
          const rewards = await this.observerMonitor.getRewards();
          totalRewards = rewards.totalReward * 7; // Approximate
        } catch (error) {
          // Rewards unavailable
        }

        await this.telegram.sendWeeklySummary({ ...summary, totalRewards });
        logger.info('Weekly summary sent');
        
        metricsTracker.clearOldMetrics();
        logger.info('Old metrics cleared');
      } catch (error: any) {
        logger.error('Failed to send weekly summary:', error);
      }
    };

    // Calculate time until next scheduled report
    const scheduleNext = () => {
      const now = new Date();
      const [hours, minutes] = config.reports.weeklySummaryTime.split(':').map(Number);
      
      const scheduledTime = new Date();
      scheduledTime.setHours(hours, minutes, 0, 0);
      
      // Get current day of week (0 = Sunday)
      const currentDay = now.getDay();
      const targetDay = config.reports.weeklySummaryDay;
      
      // Calculate days until target day
      let daysUntilTarget = targetDay - currentDay;
      if (daysUntilTarget < 0) daysUntilTarget += 7;
      
      // If target day is today but time has passed, schedule for next week
      if (daysUntilTarget === 0 && now >= scheduledTime) {
        daysUntilTarget = 7;
      }
      
      scheduledTime.setDate(scheduledTime.getDate() + daysUntilTarget);
      
      const msUntilReport = scheduledTime.getTime() - now.getTime();
      
      logger.info(`Weekly summary scheduled for ${scheduledTime.toLocaleString()}`);
      
      this.weeklySummaryTimer = setTimeout(async () => {
        await sendWeeklyReport();
        scheduleNext(); // Schedule next week's report
      }, msUntilReport);
    };

    scheduleNext();
  }

  private startVersionChecking() {
    logger.info('Starting version checking...');

    const checkVersion = async () => {
      try {
        const { versionChecker } = await import('./monitors/version-checker.js');
        const versionInfo = await versionChecker.checkVersion();

        if (versionInfo && versionInfo.isOutdated) {
          logger.warn(`Gateway version is outdated: ${versionInfo.currentVersion} -> ${versionInfo.latestVersion}`);
          
          const message = 
            `📦 *Gateway Update Available*\n\n` +
            `Current: \`${versionInfo.currentVersion}\`\n` +
            `Latest: \`${versionInfo.latestVersion}\`\n\n` +
            `⚠️ A new version is available!\n` +
            `Consider updating to get the latest features and fixes.\n\n` +
            `Use /version for more details.`;

          await this.telegram.sendAlert('warning', message, 'version_update');
        } else if (versionInfo) {
          logger.info(`Gateway version is up to date: ${versionInfo.currentVersion}`);
        }
      } catch (error: any) {
        logger.error('Version check failed:', error.message);
      }
    };

    // Check immediately on startup (after 30 seconds)
    setTimeout(checkVersion, 30000);
    
    // Then check every 24 hours
    this.versionCheckTimer = setInterval(checkVersion, 86400000);
  }

}

function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

// Start the bot
const bot = new MonitoringBot();

bot.start().catch((error) => {
  logger.error('Failed to start monitoring bot:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await bot.stop();
  process.exit(0);
});
