import Database from 'better-sqlite3';
import { logger } from './logger.js';
import path from 'path';
import fs from 'fs';

export interface MetricSnapshot {
  timestamp: number;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  uptimeSeconds?: number;
  blockHeight?: number;
  heightDifference?: number;
  httpRequests?: number;
  arnsResolutions?: number;
  arnsCacheHitRate?: number;
  graphqlRequests?: number;
  errors?: number;
  observerSelected?: boolean;
  observerReportSubmitted?: boolean;
  observerWeight?: number;
  alertsCount?: number;
}

export interface StoredAlert {
  timestamp: number;
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  category?: string;
}

export class MetricsDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor() {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    this.dbPath = path.join(dataDir, 'metrics.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initDatabase();
    this.ensureAlertColumns();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        cpu_usage REAL,
        memory_usage REAL,
        disk_usage REAL,
        uptime_seconds INTEGER,
        block_height INTEGER,
        height_difference INTEGER,
        http_requests INTEGER,
        arns_resolutions INTEGER,
        arns_cache_hit_rate REAL,
        graphql_requests INTEGER,
        errors INTEGER,
        observer_selected INTEGER,
        observer_report_submitted INTEGER,
        observer_weight REAL,
        alerts_count INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp DESC);
      
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);
      
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS network_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_type TEXT NOT NULL,
        snapshot_key TEXT NOT NULL,
        snapshot_data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(snapshot_type, snapshot_key)
      );
      
      CREATE INDEX IF NOT EXISTS idx_snapshots_type ON network_snapshots(snapshot_type);
    `);
    
    logger.info('SQLite database initialized');
  }

  private ensureAlertColumns() {
    const columns = this.db.prepare(`PRAGMA table_info(alerts)`).all().map((col: any) => col.name);

    if (!columns.includes('severity')) {
      this.db.exec(`ALTER TABLE alerts ADD COLUMN severity TEXT DEFAULT 'info'`);
    }

    if (!columns.includes('category')) {
      this.db.exec(`ALTER TABLE alerts ADD COLUMN category TEXT`);
    }

    if (!columns.includes('title')) {
      this.db.exec(`ALTER TABLE alerts ADD COLUMN title TEXT`);
    }

    this.db.exec(`UPDATE alerts SET title = COALESCE(title, type)`);
    this.db.exec(`UPDATE alerts SET severity = COALESCE(severity, 'info')`);
  }

  insertMetric(snapshot: MetricSnapshot) {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (
        timestamp, cpu_usage, memory_usage, disk_usage, uptime_seconds,
        block_height, height_difference, http_requests, arns_resolutions,
        arns_cache_hit_rate, graphql_requests, errors, observer_selected,
        observer_report_submitted, observer_weight, alerts_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      snapshot.timestamp,
      snapshot.cpuUsage,
      snapshot.memoryUsage,
      snapshot.diskUsage,
      snapshot.uptimeSeconds,
      snapshot.blockHeight,
      snapshot.heightDifference,
      snapshot.httpRequests,
      snapshot.arnsResolutions,
      snapshot.arnsCacheHitRate,
      snapshot.graphqlRequests,
      snapshot.errors,
      snapshot.observerSelected ? 1 : 0,
      snapshot.observerReportSubmitted ? 1 : 0,
      snapshot.observerWeight,
      snapshot.alertsCount
    );
  }

  insertAlert(entry: { title: string; message: string; severity: 'info' | 'warning' | 'critical'; category?: string; timestamp?: number }) {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (timestamp, type, message, severity, category, title)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      entry.timestamp ?? Date.now(),
      entry.title,
      entry.message,
      entry.severity,
      entry.category ?? null,
      entry.title
    );
  }

  getMetricsSince(since: number): MetricSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM metrics 
      WHERE timestamp >= ? 
      ORDER BY timestamp ASC
    `);
    
    const rows = stmt.all(since) as any[];
    return rows.map(row => this.rowToMetric(row));
  }

  getMetricsInRange(start: number, end: number): MetricSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM metrics 
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);
    
    const rows = stmt.all(start, end) as any[];
    return rows.map(row => this.rowToMetric(row));
  }

  getLatestMetric(): MetricSnapshot | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM metrics 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    
    const row = stmt.get() as any;
    return row ? this.rowToMetric(row) : undefined;
  }

  getAlertsSince(since: number): StoredAlert[] {
    const stmt = this.db.prepare(`
      SELECT 
        timestamp,
        COALESCE(title, type) AS title,
        message,
        COALESCE(severity, 'info') AS severity,
        category
      FROM alerts 
      WHERE timestamp >= ? 
      ORDER BY timestamp DESC
      LIMIT 100
    `);
    
    const rows = stmt.all(since) as any[];
    return rows.map((row) => this.mapAlertRow(row));
  }

  getRecentAlerts(limit: number = 100): StoredAlert[] {
    const stmt = this.db.prepare(`
      SELECT 
        timestamp,
        COALESCE(title, type) AS title,
        message,
        COALESCE(severity, 'info') AS severity,
        category
      FROM alerts 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    
    const rows = stmt.all(limit) as any[];
    return rows.map((row) => this.mapAlertRow(row));
  }

  getDailyAverages(days: number = 7): Array<{
    day: string;
    cpu: number;
    memory: number;
    requests: number;
  }> {
    const now = Date.now();
    const results: Array<{ day: string; cpu: number; memory: number; requests: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i * 86400000);
      const dayEnd = dayStart + 86400000;
      
      const stmt = this.db.prepare(`
        SELECT 
          AVG(cpu_usage) as avg_cpu,
          AVG(memory_usage) as avg_memory,
          SUM(http_requests) as total_requests
        FROM metrics
        WHERE timestamp >= ? AND timestamp < ?
      `);
      
      const row = stmt.get(dayStart, dayEnd) as any;
      const date = new Date(dayStart);
      
      results.push({
        day: date.toISOString().split('T')[0],
        cpu: row?.avg_cpu || 0,
        memory: row?.avg_memory || 0,
        requests: row?.total_requests || 0,
      });
    }

    return results;
  }

  deleteOlderThan(timestamp: number) {
    const metricsStmt = this.db.prepare('DELETE FROM metrics WHERE timestamp < ?');
    const alertsStmt = this.db.prepare('DELETE FROM alerts WHERE timestamp < ?');
    
    const metricsDeleted = metricsStmt.run(timestamp);
    const alertsDeleted = alertsStmt.run(timestamp);
    
    logger.info(`Cleaned up old data: ${metricsDeleted.changes} metrics, ${alertsDeleted.changes} alerts`);
  }

  vacuum() {
    this.db.exec('VACUUM');
    logger.info('Database vacuumed');
  }

  close() {
    this.db.close();
  }

  private rowToMetric(row: any): MetricSnapshot {
    return {
      timestamp: row.timestamp,
      cpuUsage: row.cpu_usage,
      memoryUsage: row.memory_usage,
      diskUsage: row.disk_usage,
      uptimeSeconds: row.uptime_seconds,
      blockHeight: row.block_height,
      heightDifference: row.height_difference,
      httpRequests: row.http_requests,
      arnsResolutions: row.arns_resolutions,
      arnsCacheHitRate: row.arns_cache_hit_rate,
      graphqlRequests: row.graphql_requests,
      errors: row.errors,
      observerSelected: row.observer_selected === 1,
      observerReportSubmitted: row.observer_report_submitted === 1,
      observerWeight: row.observer_weight,
      alertsCount: row.alerts_count,
    };
  }

  private mapAlertRow(row: any): StoredAlert {
    return {
      timestamp: row.timestamp,
      type: row.title,
      message: row.message,
      severity: (row.severity || 'info') as 'info' | 'warning' | 'critical',
      category: row.category || undefined,
    };
  }

  saveConfig(data: { config: any; preset: string }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    
    stmt.run('runtime_config', JSON.stringify(data), Date.now());
  }

  getConfig(): { config: any; preset: string } | null {
    const stmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
    const row = stmt.get('runtime_config') as any;
    
    if (row) {
      return JSON.parse(row.value);
    }
    
    return null;
  }

  saveMuteState(isMuted: boolean, muteUntil?: number) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    
    const muteState = {
      isMuted,
      muteUntil: muteUntil || null
    };
    
    stmt.run('mute_state', JSON.stringify(muteState), Date.now());
  }

  getMuteState(): { isMuted: boolean; muteUntil?: number } | null {
    const stmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
    const row = stmt.get('mute_state') as any;
    
    if (row) {
      return JSON.parse(row.value);
    }
    
    return null;
  }

  saveCategoryMutes(categoryMutes: Record<string, number>) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    stmt.run('category_mutes', JSON.stringify(categoryMutes), Date.now());
  }

  getCategoryMutes(): Record<string, number> | null {
    const stmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
    const row = stmt.get('category_mutes') as any;

    if (row) {
      return JSON.parse(row.value);
    }

    return null;
  }

  saveNetworkSnapshot(type: 'gateway' | 'arns', key: string, data: any) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO network_snapshots (snapshot_type, snapshot_key, snapshot_data, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(type, key, JSON.stringify(data), Date.now());
  }

  getNetworkSnapshot(type: 'gateway' | 'arns', key: string): any | null {
    const stmt = this.db.prepare(`
      SELECT snapshot_data FROM network_snapshots 
      WHERE snapshot_type = ? AND snapshot_key = ?
    `);
    const row = stmt.get(type, key) as any;
    
    if (row) {
      return JSON.parse(row.snapshot_data);
    }
    
    return null;
  }

  getAllNetworkSnapshots(type: 'gateway' | 'arns'): Map<string, any> {
    const stmt = this.db.prepare(`
      SELECT snapshot_key, snapshot_data FROM network_snapshots 
      WHERE snapshot_type = ?
    `);
    const rows = stmt.all(type) as any[];
    
    const snapshotMap = new Map<string, any>();
    for (const row of rows) {
      snapshotMap.set(row.snapshot_key, JSON.parse(row.snapshot_data));
    }
    
    return snapshotMap;
  }

  clearNetworkSnapshots(type: 'gateway' | 'arns') {
    const stmt = this.db.prepare('DELETE FROM network_snapshots WHERE snapshot_type = ?');
    stmt.run(type);
  }

  getStats() {
    const metricsCount = this.db.prepare('SELECT COUNT(*) as count FROM metrics').get() as any;
    const alertsCount = this.db.prepare('SELECT COUNT(*) as count FROM alerts').get() as any;
    const dbSize = fs.statSync(this.dbPath).size;
    
    return {
      metrics: metricsCount.count,
      alerts: alertsCount.count,
      sizeBytes: dbSize,
      sizeMB: (dbSize / 1024 / 1024).toFixed(2),
    };
  }
}

export const metricsDb = new MetricsDatabase();
