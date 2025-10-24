#!/usr/bin/env node
import { metricsDb } from './metrics-db.js';

const stats = metricsDb.getStats();

console.log('\n📊 SQLite Database Statistics:');
console.log('================================');
console.log(`Metrics stored: ${stats.metrics.toLocaleString()}`);
console.log(`Alerts stored: ${stats.alerts.toLocaleString()}`);
console.log(`Database size: ${stats.sizeMB} MB`);
console.log(`Storage efficiency: ~${(stats.metrics / parseFloat(stats.sizeMB)).toFixed(0)} metrics per MB`);
console.log('================================\n');

process.exit(0);
