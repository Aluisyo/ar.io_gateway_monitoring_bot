/**
 * Health monitoring for AR.IO gateway services
 */
import axios from 'axios';
import * as os from 'os';
import * as fs from 'fs';
import { logger } from '../utils/logger.js';
import config from '../config.js';

export interface HealthResult {
  isHealthy: boolean;
  uptime?: number;
  responseTime: number;
  error?: string;
}

export interface GatewayHealth {
  timestamp: Date;
  core: HealthResult;
  observer: HealthResult;
  overall: 'healthy' | 'degraded' | 'down';
}

export interface DetailedMetrics {
  // Block Heights
  lastHeightImported?: number;
  currentNetworkHeight?: number;
  heightDifference?: number;

  // System Resources
  cpuUsagePercent?: number;
  memoryUsagePercent?: number;
  memoryUsedMB?: number;
  memoryTotalMB?: number;
  diskUsagePercent?: number;
  diskUsedGB?: number;
  diskTotalGB?: number;

  // HTTP Metrics
  httpRequestsTotal?: number;
  httpRequestRate?: number;
  averageResponseTimeMs?: number;
  http2xxResponses?: number;
  http4xxResponses?: number;
  http5xxResponses?: number;

  // ArNS Metrics
  arnsResolutions?: number;
  arnsCacheHitRate?: number;
  arnsErrors?: number;

  // GraphQL Metrics
  graphqlRequestsTotal?: number;
  graphqlErrors?: number;

  // Performance
  uptimeSeconds?: number;
  requestQueueSize?: number;
}

export class HealthMonitor {
  async checkHealth(): Promise<GatewayHealth> {
    const [core, observer] = await Promise.all([
      this.checkService('core', `${config.gateway.coreUrl}/ar-io/healthcheck`),
      this.checkService('observer', `${config.gateway.observerUrl}/ar-io/observer/healthcheck`),
    ]);

    // Determine overall health
    let overall: 'healthy' | 'degraded' | 'down' = 'healthy';
    if (!core.isHealthy && !observer.isHealthy) {
      overall = 'down';
    } else if (!core.isHealthy || !observer.isHealthy) {
      overall = 'degraded';
    }

    return {
      timestamp: new Date(),
      core,
      observer,
      overall,
    };
  }

  private async checkService(name: string, url: string): Promise<HealthResult> {
    const startTime = Date.now();
    
    try {
      const response = await axios.get(url, {
        timeout: 5000,
        validateStatus: (status) => status === 200,
      });

      const responseTime = Date.now() - startTime;
      
      return {
        isHealthy: true,
        uptime: response.data?.uptime,
        responseTime,
      };
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      return {
        isHealthy: false,
        responseTime,
        error: error.message,
      };
    }
  }

  async getMetrics(): Promise<DetailedMetrics> {
    try {
      const [prometheusMetrics, systemMetrics, networkHeight] = await Promise.all([
        this.fetchPrometheusMetrics(),
        this.getSystemMetrics(),
        this.getCurrentNetworkHeight(),
      ]);

      return {
        ...prometheusMetrics,
        ...systemMetrics,
        currentNetworkHeight: networkHeight,
        heightDifference: networkHeight && prometheusMetrics.lastHeightImported
          ? networkHeight - prometheusMetrics.lastHeightImported
          : undefined,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch metrics: ${error.message}`);
      return {};
    }
  }

  private async fetchPrometheusMetrics(): Promise<Partial<DetailedMetrics>> {
    try {
      const response = await axios.get(`${config.gateway.coreUrl}/ar-io/__gateway_metrics`, {
        timeout: 5000,
      });

      const raw = this.parsePrometheusMetrics(response.data);
      
      // Parse block heights (AR.IO gateway metric)
      const lastHeightImported = raw['last_height_imported'];
      
      // ArNS metrics (AR.IO specific)
      const arnsCacheHits = raw['arns_cache_hit_total'] || 0;
      const arnsCacheMisses = raw['arns_cache_miss_total'] || 0;
      const arnsResolutions = raw['arns_resolution_resolver_count'] || 0;
      const arnsCacheHitRate = (arnsCacheHits + arnsCacheMisses) > 0
        ? (arnsCacheHits / (arnsCacheHits + arnsCacheMisses)) * 100
        : 0;

      // Data processing metrics
      const dataItemsIndexed = raw['data_items_indexed_total'] || 0;
      const bundlesTotal = raw['bundles_total'] || 0;
      const blocksImported = raw['blocks_imported_total'] || 0;

      // Error metrics
      const getDataErrors = raw['get_data_errors_total'] || 0;
      const blockImportErrors = raw['block_import_errors_total'] || 0;

      // GraphQL metrics - get from circuit breaker specifically for GraphQL
      const graphqlRequests = this.extractLabeledMetric(response.data, 'circuit', 'GraphQLRootTxIndex', 'fire');
      
      // Calculate processing stats
      const httpRequestsTotal = dataItemsIndexed + bundlesTotal;
      
      return {
        lastHeightImported,
        httpRequestsTotal: httpRequestsTotal || undefined,
        arnsResolutions: arnsResolutions || undefined,
        arnsCacheHitRate: arnsCacheHitRate || undefined,
        arnsErrors: getDataErrors || undefined,
        graphqlRequestsTotal: graphqlRequests || undefined,
      };
    } catch (error: any) {
      return {};
    }
  }

  private extractLabeledMetric(text: string, metricName: string, labelValue: string, event: string): number | undefined {
    // Extract metric with specific labels: circuit{name="GraphQLRootTxIndex",event="fire",release="55-pre"} 382300
    const regex = new RegExp(`${metricName}\\{[^}]*name="${labelValue}"[^}]*event="${event}"[^}]*\\}\\s+(\\d+\\.?\\d*)`, 'm');
    const match = text.match(regex);
    return match ? parseFloat(match[1]) : undefined;
  }

  private async getCurrentNetworkHeight(): Promise<number | undefined> {
    try {
      // Try to get current height from ar.io/info endpoint
      const response = await axios.get(`${config.gateway.coreUrl}/ar-io/info`, {
        timeout: 5000,
      });
      
      // If gateway provides network info, use it
      if (response.data?.height) {
        return response.data.height;
      }
      
      // Otherwise query arweave.net for current height
      const arweaveResponse = await axios.get('https://arweave.net/info', {
        timeout: 5000,
      });
      
      return arweaveResponse.data?.height;
    } catch (error: any) {
      return undefined;
    }
  }

  private async getSystemMetrics(): Promise<Partial<DetailedMetrics>> {
    try {
      // CPU Usage
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type as keyof typeof cpu.times];
        }
        totalIdle += cpu.times.idle;
      });

      const cpuUsagePercent = 100 - ~~(100 * totalIdle / totalTick);

      // Memory Usage
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      const memoryUsagePercent = (usedMemory / totalMemory) * 100;

      // Disk Usage (try to get from gateway data directory if accessible)
      let diskMetrics = {};
      try {
        const stats = fs.statfsSync('/');
        const totalDisk = stats.blocks * stats.bsize;
        const freeDisk = stats.bfree * stats.bsize;
        const usedDisk = totalDisk - freeDisk;
        
        diskMetrics = {
          diskUsagePercent: (usedDisk / totalDisk) * 100,
          diskUsedGB: usedDisk / (1024 ** 3),
          diskTotalGB: totalDisk / (1024 ** 3),
        };
      } catch (e) {
        // statfs not available, skip disk metrics
      }

      // Get AR.IO gateway uptime (from Docker container if available)
      const uptimeSeconds = await this.getGatewayUptime();

      return {
        cpuUsagePercent,
        memoryUsagePercent,
        memoryUsedMB: usedMemory / (1024 ** 2),
        memoryTotalMB: totalMemory / (1024 ** 2),
        uptimeSeconds,
        ...diskMetrics,
      };
    } catch (error: any) {
      return {};
    }
  }

  private async getGatewayUptime(): Promise<number | undefined> {
    try {
      // Try to get uptime from Docker container (ar-io-node-core-1)
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Check if Docker is available and get container uptime
      const { stdout } = await execAsync('docker inspect --format="{{.State.StartedAt}}" ar-io-node-core-1 2>/dev/null', {
        timeout: 2000,
      });

      if (stdout && stdout.trim()) {
        const startTime = new Date(stdout.trim()).getTime();
        const uptimeMs = Date.now() - startTime;
        return Math.floor(uptimeMs / 1000);
      }

      return undefined;
    } catch (error: any) {
      return undefined;
    }
  }

  private parsePrometheusMetrics(text: string): Record<string, number> {
    const metrics: Record<string, number> = {};
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue;

      // Match metric name with optional labels: metric_name{labels} value
      // or simple: metric_name value
      const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/);
      if (match) {
        const metricName = match[1];
        
        // Extract the value - it's the last token after whitespace
        const parts = line.trim().split(/\s+/);
        const value = parts[parts.length - 1];
        
        if (value && !isNaN(parseFloat(value))) {
          // For metrics with same name but different labels, keep the first value
          if (!metrics[metricName]) {
            metrics[metricName] = parseFloat(value);
          }
        }
      }
    }

    return metrics;
  }
}
