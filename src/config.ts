/**
 * Configuration loader using environment variables
 */
import dotenv from 'dotenv';

dotenv.config();

const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key];
  if (value === undefined && defaultValue === undefined) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value ?? defaultValue!;
};

export const config = {
  telegram: {
    botToken: getEnv('TELEGRAM_BOT_TOKEN'),
    chatId: getEnv('TELEGRAM_CHAT_ID'),
  },

  gateway: {
    name: getEnv('GATEWAY_NAME', 'My AR.IO Gateway'),
    coreUrl: getEnv('GATEWAY_CORE_URL', 'http://ar-io-core:4000'),
    observerUrl: getEnv('GATEWAY_OBSERVER_URL', 'http://ar-io-observer:5050'),
    address: getEnv('GATEWAY_ADDRESS', ''),
    host: getEnv('GATEWAY_HOST', ''),
  },

  monitoring: {
    healthCheckInterval: parseInt(getEnv('HEALTH_CHECK_INTERVAL', '60')) * 1000,
    observerCheckInterval: parseInt(getEnv('OBSERVER_CHECK_INTERVAL', '300')) * 1000,
    alertCooldown: parseInt(getEnv('ALERT_COOLDOWN', '600')) * 1000,
    networkCheckInterval: parseInt(getEnv('NETWORK_CHECK_INTERVAL', '600')) * 1000,
    sslCheckInterval: parseInt(getEnv('SSL_CHECK_INTERVAL', '86400')) * 1000,
  },

  reports: {
    enableDailySummary: getEnv('ENABLE_DAILY_SUMMARY', 'true') === 'true',
    enableWeeklySummary: getEnv('ENABLE_WEEKLY_SUMMARY', 'true') === 'true',
    dailySummaryTime: getEnv('DAILY_SUMMARY_TIME', '09:00'), // HH:MM format
    weeklySummaryDay: parseInt(getEnv('WEEKLY_SUMMARY_DAY', '1')), // 0=Sunday, 1=Monday, etc.
    weeklySummaryTime: getEnv('WEEKLY_SUMMARY_TIME', '09:00'), // HH:MM format
  },

  alerts: {
    cpuThreshold: parseFloat(getEnv('ALERT_CPU_THRESHOLD', '80')),
    cpuDurationMinutes: parseInt(getEnv('ALERT_CPU_DURATION_MINUTES', '5')),
    memoryThreshold: parseFloat(getEnv('ALERT_MEMORY_THRESHOLD', '90')),
    diskThreshold: parseFloat(getEnv('ALERT_DISK_THRESHOLD', '85')),
    responseTimeThreshold: parseFloat(getEnv('ALERT_RESPONSE_TIME_THRESHOLD', '2000')),
    latencyThreshold: parseFloat(getEnv('ALERT_LATENCY_THRESHOLD', '1000')), // ms
    blockSyncLagThreshold: parseInt(getEnv('ALERT_BLOCK_SYNC_LAG_THRESHOLD', '100')),
    arnsCacheHitRateThreshold: parseFloat(getEnv('ALERT_ARNS_CACHE_HIT_RATE_THRESHOLD', '50')),
    errorRateThreshold: parseFloat(getEnv('ALERT_ERROR_RATE_THRESHOLD', '5')),
    errorRateMinRequests: parseInt(getEnv('ALERT_ERROR_RATE_MIN_REQUESTS', '100')),
    notSelectedEpochsThreshold: parseInt(getEnv('ALERT_NOT_SELECTED_EPOCHS_THRESHOLD', '5')),
    lowObserverWeightThreshold: parseFloat(getEnv('ALERT_LOW_OBSERVER_WEIGHT_THRESHOLD', '0.5')),
  },

  features: {
    monitorGatewayRegistry: getEnv('MONITOR_GATEWAY_REGISTRY', 'false') === 'true',
    monitorArnsActivity: getEnv('MONITOR_ARNS_ACTIVITY', 'false') === 'true',
    monitorSslCertificate: getEnv('MONITOR_SSL_CERTIFICATE', 'true') === 'true',
    monitorArnsResolution: getEnv('MONITOR_ARNS_RESOLUTION', 'false') === 'true',
  },

  ssl: {
    domain: getEnv('SSL_DOMAIN', ''),
  },

  network: getEnv('NETWORK', 'mainnet') as 'mainnet' | 'testnet',
  logLevel: getEnv('LOG_LEVEL', 'info'),
};

if (!config.telegram.botToken || config.telegram.botToken === 'your_bot_token_from_botfather') {
  throw new Error('Please set TELEGRAM_BOT_TOKEN in .env file');
}

if (!config.telegram.chatId || config.telegram.chatId === 'your_chat_id') {
  throw new Error('Please set TELEGRAM_CHAT_ID in .env file');
}

export default config;
