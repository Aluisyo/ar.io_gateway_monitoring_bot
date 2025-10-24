import { logger } from './logger.js';
import { metricsDb, MetricSnapshot } from './metrics-db.js';

export class MetricsTracker {
  constructor() {
    logger.info('Metrics tracker initialized with SQLite storage');
  }

  recordMetrics(snapshot: MetricSnapshot) {
    snapshot.timestamp = Date.now();
    metricsDb.insertMetric(snapshot);
  }

  recordAlert(entry: { title: string; message: string; severity: 'info' | 'warning' | 'critical'; category?: string; timestamp?: number }) {
    metricsDb.insertAlert(entry);
  }

  getDailySummary(): {
    current: MetricSnapshot | undefined;
    previous: MetricSnapshot | undefined;
    avgCpuUsage: number;
    avgMemoryUsage: number;
    avgDiskUsage: number;
    uptimePercentage: number;
    totalAlerts: number;
    blocksSynced: number;
    totalRequests: number;
    observerSelections: number;
    recentAlerts: Array<{ type: string; message: string; timestamp: number }>;
  } {
    const now = Date.now();
    const oneDayAgo = now - 86400000;

    const last24h = metricsDb.getMetricsSince(oneDayAgo);

    if (last24h.length === 0) {
      return {
        current: undefined,
        previous: undefined,
        avgCpuUsage: 0,
        avgMemoryUsage: 0,
        avgDiskUsage: 0,
        uptimePercentage: 0,
        totalAlerts: 0,
        blocksSynced: 0,
        totalRequests: 0,
        observerSelections: 0,
        recentAlerts: [],
      };
    }

    const current = last24h[last24h.length - 1];
    const previous = last24h[0];

    const avgCpuUsage = last24h.reduce((sum, m) => sum + (m.cpuUsage || 0), 0) / last24h.length;
    const avgMemoryUsage = last24h.reduce((sum, m) => sum + (m.memoryUsage || 0), 0) / last24h.length;
    const avgDiskUsage = last24h.reduce((sum, m) => sum + (m.diskUsage || 0), 0) / last24h.length;

    const uptimePercentage = last24h.filter(m => m.uptimeSeconds && m.uptimeSeconds > 0).length / last24h.length * 100;

    const recentAlerts = metricsDb.getAlertsSince(oneDayAgo);
    const totalAlerts = recentAlerts.length;

    const blocksSynced = (current.blockHeight || 0) - (previous.blockHeight || 0);
    const totalRequests = (current.httpRequests || 0) - (previous.httpRequests || 0);
    const observerSelections = last24h.filter(m => m.observerSelected).length;

    return {
      current,
      previous,
      avgCpuUsage,
      avgMemoryUsage,
      avgDiskUsage,
      uptimePercentage,
      totalAlerts,
      blocksSynced,
      totalRequests,
      observerSelections,
      recentAlerts: recentAlerts.slice(0, 10),
    };
  }

  getWeeklySummary(): {
    avgCpuUsage: number;
    avgMemoryUsage: number;
    avgDiskUsage: number;
    uptimePercentage: number;
    totalAlerts: number;
    blocksSynced: number;
    totalRequests: number;
    observerSelections: number;
    dailyAverages: Array<{ day: string; cpu: number; memory: number; requests: number }>;
  } {
    const now = Date.now();
    const oneWeekAgo = now - 604800000;

    const weekData = metricsDb.getMetricsSince(oneWeekAgo);

    if (weekData.length === 0) {
      return {
        avgCpuUsage: 0,
        avgMemoryUsage: 0,
        avgDiskUsage: 0,
        uptimePercentage: 0,
        totalAlerts: 0,
        blocksSynced: 0,
        totalRequests: 0,
        observerSelections: 0,
        dailyAverages: [],
      };
    }

    const avgCpuUsage = weekData.reduce((sum, m) => sum + (m.cpuUsage || 0), 0) / weekData.length;
    const avgMemoryUsage = weekData.reduce((sum, m) => sum + (m.memoryUsage || 0), 0) / weekData.length;
    const avgDiskUsage = weekData.reduce((sum, m) => sum + (m.diskUsage || 0), 0) / weekData.length;

    const uptimePercentage = weekData.filter(m => m.uptimeSeconds && m.uptimeSeconds > 0).length / weekData.length * 100;

    const alerts = metricsDb.getAlertsSince(oneWeekAgo);
    const totalAlerts = alerts.length;

    const firstMetric = weekData[0];
    const lastMetric = weekData[weekData.length - 1];
    const blocksSynced = (lastMetric.blockHeight || 0) - (firstMetric.blockHeight || 0);
    const totalRequests = (lastMetric.httpRequests || 0) - (firstMetric.httpRequests || 0);
    const observerSelections = weekData.filter(m => m.observerSelected).length;

    const dailyAverages = metricsDb.getDailyAverages(7);

    return {
      avgCpuUsage,
      avgMemoryUsage,
      avgDiskUsage,
      uptimePercentage,
      totalAlerts,
      blocksSynced,
      totalRequests,
      observerSelections,
      dailyAverages,
    };
  }

  clearOldMetrics() {
    const oneWeekAgo = Date.now() - 604800000;
    metricsDb.deleteOlderThan(oneWeekAgo);
    metricsDb.vacuum();
  }

  getStats() {
    return metricsDb.getStats();
  }
}

export const metricsTracker = new MetricsTracker();
