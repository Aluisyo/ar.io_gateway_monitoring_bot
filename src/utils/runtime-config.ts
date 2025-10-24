import { metricsDb } from './metrics-db.js';
import { logger } from './logger.js';
import config from '../config.js';

export interface RuntimeConfig {
  // Alert Thresholds
  cpuThreshold: number;
  cpuDurationMinutes: number;
  memoryThreshold: number;
  diskThreshold: number;
  responseTimeThreshold: number;
  latencyThreshold: number;
  errorRateThreshold: number;
  errorRateMinRequests: number;
  blockSyncLagThreshold: number;
  arnsCacheHitRateThreshold: number;
  
  // Feature Toggles
  monitorGatewayRegistry: boolean;
  monitorArnsActivity: boolean;
  monitorSslCertificate: boolean;
  monitorArnsResolution: boolean;
  enableDailySummary: boolean;
  enableWeeklySummary: boolean;
  
  // Monitoring Intervals (in milliseconds)
  healthCheckInterval: number;
  observerCheckInterval: number;
  resourceCheckInterval: number;
  
  // Alert Behavior
  alertCooldown: number;
}

export type ConfigPreset = 'relaxed' | 'balanced' | 'strict';

const PRESETS: Record<ConfigPreset, Partial<RuntimeConfig>> = {
  relaxed: {
    cpuThreshold: 90,
    cpuDurationMinutes: 10,
    memoryThreshold: 95,
    diskThreshold: 90,
    responseTimeThreshold: 10000,
    latencyThreshold: 2000,
    errorRateThreshold: 10,
    errorRateMinRequests: 50,
    blockSyncLagThreshold: 2000,
    arnsCacheHitRateThreshold: 30,
    alertCooldown: 1800000, // 30 minutes
    monitorArnsResolution: false,
  },
  balanced: {
    cpuThreshold: 80,
    cpuDurationMinutes: 5,
    memoryThreshold: 90,
    diskThreshold: 85,
    responseTimeThreshold: 5000,
    latencyThreshold: 1000,
    errorRateThreshold: 5,
    errorRateMinRequests: 100,
    blockSyncLagThreshold: 1000,
    arnsCacheHitRateThreshold: 50,
    alertCooldown: 600000, // 10 minutes
    monitorArnsResolution: false,
  },
  strict: {
    cpuThreshold: 70,
    cpuDurationMinutes: 3,
    memoryThreshold: 85,
    diskThreshold: 80,
    responseTimeThreshold: 3000,
    latencyThreshold: 500,
    errorRateThreshold: 2,
    errorRateMinRequests: 150,
    blockSyncLagThreshold: 500,
    arnsCacheHitRateThreshold: 60,
    alertCooldown: 300000, // 5 minutes
    monitorArnsResolution: true,
  },
};

class RuntimeConfigManager {
  private runtimeConfig: RuntimeConfig;
  private currentPreset: ConfigPreset = 'balanced';

  constructor() {
    this.runtimeConfig = this.loadDefaultConfig();
    this.loadFromDatabase();
  }

  private loadDefaultConfig(): RuntimeConfig {
    return {
      cpuThreshold: config.alerts.cpuThreshold,
      cpuDurationMinutes: config.alerts.cpuDurationMinutes,
      memoryThreshold: config.alerts.memoryThreshold,
      diskThreshold: config.alerts.diskThreshold,
      responseTimeThreshold: config.alerts.responseTimeThreshold,
      latencyThreshold: config.alerts.latencyThreshold,
      errorRateThreshold: config.alerts.errorRateThreshold,
      errorRateMinRequests: config.alerts.errorRateMinRequests,
      blockSyncLagThreshold: config.alerts.blockSyncLagThreshold,
      arnsCacheHitRateThreshold: config.alerts.arnsCacheHitRateThreshold,
      
      monitorGatewayRegistry: config.features.monitorGatewayRegistry,
      monitorArnsActivity: config.features.monitorArnsActivity,
      monitorSslCertificate: config.features.monitorSslCertificate,
      monitorArnsResolution: config.features.monitorArnsResolution,
      enableDailySummary: config.reports.enableDailySummary,
      enableWeeklySummary: config.reports.enableWeeklySummary,
      
      healthCheckInterval: config.monitoring.healthCheckInterval,
      observerCheckInterval: config.monitoring.observerCheckInterval,
      resourceCheckInterval: 60000,
      
      alertCooldown: config.monitoring.alertCooldown,
    };
  }

  private loadFromDatabase() {
    try {
      const stored = metricsDb.getConfig();
      if (stored) {
        Object.assign(this.runtimeConfig, stored.config);
        this.currentPreset = (stored.preset as ConfigPreset) || 'balanced';
        logger.info(`Loaded runtime config (preset: ${this.currentPreset})`);
      }
    } catch (error: any) {
      logger.warn('Failed to load runtime config, using defaults');
    }
  }

  get<K extends keyof RuntimeConfig>(key: K): RuntimeConfig[K] {
    return this.runtimeConfig[key];
  }

  set<K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) {
    this.runtimeConfig[key] = value;
    this.saveToDatabase();
    logger.info(`Config updated: ${key} = ${value}`);
  }

  setPreset(preset: ConfigPreset) {
    const presetConfig = PRESETS[preset];
    Object.assign(this.runtimeConfig, presetConfig);
    this.currentPreset = preset;
    this.saveToDatabase();
    logger.info(`Applied ${preset} preset`);
  }

  getPreset(): ConfigPreset {
    return this.currentPreset;
  }

  getAll(): RuntimeConfig {
    return { ...this.runtimeConfig };
  }

  toggle<K extends keyof RuntimeConfig>(key: K): boolean {
    if (typeof this.runtimeConfig[key] === 'boolean') {
      const newValue = !this.runtimeConfig[key] as RuntimeConfig[K];
      this.set(key, newValue);
      return newValue as boolean;
    }
    return false;
  }

  private saveToDatabase() {
    try {
      metricsDb.saveConfig({
        config: this.runtimeConfig,
        preset: this.currentPreset,
      });
    } catch (error: any) {
      logger.error('Failed to save runtime config:', error.message);
    }
  }

  reset() {
    this.runtimeConfig = this.loadDefaultConfig();
    this.currentPreset = 'balanced';
    this.saveToDatabase();
    logger.info('Config reset to defaults');
  }

  formatForDisplay(): string {
    const cfg = this.runtimeConfig;
    
    return `⚙️ *Current Configuration*\n` +
      `Profile: *${this.currentPreset.toUpperCase()}*\n\n` +
      
      `*📊 Alert Thresholds*\n` +
      `• CPU: ${cfg.cpuThreshold}% (${cfg.cpuDurationMinutes}min)\n` +
      `• Memory: ${cfg.memoryThreshold}%\n` +
      `• Disk: ${cfg.diskThreshold}%\n` +
      `• Response Time: ${cfg.responseTimeThreshold}ms\n` +
      `• Latency: ${cfg.latencyThreshold}ms\n` +
      `• Error Rate: ${cfg.errorRateThreshold}%\n` +
      `• Error Rate Min Requests: ${cfg.errorRateMinRequests}\n` +
      `• Block Lag: ${cfg.blockSyncLagThreshold} blocks\n` +
      `• Cache Hit Rate: ${cfg.arnsCacheHitRateThreshold}%\n\n` +
      
      `*🎚️ Features*\n` +
      `• Gateway Registry: ${cfg.monitorGatewayRegistry ? '✅' : '❌'}\n` +
      `• ArNS Activity: ${cfg.monitorArnsActivity ? '✅' : '❌'}\n` +
      `• ArNS Resolution: ${cfg.monitorArnsResolution ? '✅' : '❌'}\n` +
      `• SSL Monitoring: ${cfg.monitorSslCertificate ? '✅' : '❌'}\n` +
      `• Daily Reports: ${cfg.enableDailySummary ? '✅' : '❌'}\n` +
      `• Weekly Reports: ${cfg.enableWeeklySummary ? '✅' : '❌'}\n\n` +
      
      `*⏰ Check Intervals*\n` +
      `• Health: ${cfg.healthCheckInterval / 1000}s\n` +
      `• Observer: ${cfg.observerCheckInterval / 1000}s\n` +
      `• Resources: ${cfg.resourceCheckInterval / 1000}s\n\n` +
      
      `*🔔 Alert Behavior*\n` +
      `• Cooldown: ${cfg.alertCooldown / 60000}min`;
  }
}

export const runtimeConfig = new RuntimeConfigManager();
