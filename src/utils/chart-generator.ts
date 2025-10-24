/**
 * Chart Generator - Creates visual charts from metrics data
 */
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { logger } from './logger.js';

const width = 800;
const height = 400;

const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
  width, 
  height,
  backgroundColour: 'white',
});

export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    borderColor?: string;
    backgroundColor?: string;
    fill?: boolean;
  }>;
}

export class ChartGenerator {
  /**
   * Generate CPU/Memory usage chart
   */
  async generateResourceChart(
    cpuData: number[],
    memoryData: number[],
    labels: string[]
  ): Promise<Buffer> {
    try {
      const configuration = {
        type: 'line' as const,
        data: {
          labels,
          datasets: [
            {
              label: 'CPU Usage (%)',
              data: cpuData,
              borderColor: 'rgb(255, 99, 132)',
              backgroundColor: 'rgba(255, 99, 132, 0.1)',
              fill: true,
              tension: 0.4,
            },
            {
              label: 'Memory Usage (%)',
              data: memoryData,
              borderColor: 'rgb(54, 162, 235)',
              backgroundColor: 'rgba(54, 162, 235, 0.1)',
              fill: true,
              tension: 0.4,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            title: {
              display: true,
              text: 'Resource Usage (24h)',
              font: { size: 16 },
            },
            legend: {
              display: true,
              position: 'top' as const,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
              title: {
                display: true,
                text: 'Usage (%)',
              },
            },
            x: {
              title: {
                display: true,
                text: 'Time',
              },
            },
          },
        },
      };

      return await chartJSNodeCanvas.renderToBuffer(configuration);
    } catch (error: any) {
      logger.error('Failed to generate resource chart:', error);
      throw error;
    }
  }

  /**
   * Generate request volume chart
   */
  async generateRequestChart(
    requestData: number[],
    labels: string[]
  ): Promise<Buffer> {
    try {
      const configuration = {
        type: 'bar' as const,
        data: {
          labels,
          datasets: [
            {
              label: 'HTTP Requests',
              data: requestData,
              backgroundColor: 'rgba(75, 192, 192, 0.6)',
              borderColor: 'rgb(75, 192, 192)',
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            title: {
              display: true,
              text: 'Request Volume (24h)',
              font: { size: 16 },
            },
            legend: {
              display: false,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              title: {
                display: true,
                text: 'Requests',
              },
            },
            x: {
              title: {
                display: true,
                text: 'Time',
              },
            },
          },
        },
      };

      return await chartJSNodeCanvas.renderToBuffer(configuration);
    } catch (error: any) {
      logger.error('Failed to generate request chart:', error);
      throw error;
    }
  }

  /**
   * Generate block sync progress chart
   */
  async generateBlockSyncChart(
    blockHeights: number[],
    labels: string[]
  ): Promise<Buffer> {
    try {
      const configuration = {
        type: 'line' as const,
        data: {
          labels,
          datasets: [
            {
              label: 'Block Height',
              data: blockHeights,
              borderColor: 'rgb(153, 102, 255)',
              backgroundColor: 'rgba(153, 102, 255, 0.1)',
              fill: true,
              tension: 0.1,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            title: {
              display: true,
              text: 'Block Sync Progress (7 days)',
              font: { size: 16 },
            },
            legend: {
              display: false,
            },
          },
          scales: {
            y: {
              title: {
                display: true,
                text: 'Block Height',
              },
            },
            x: {
              title: {
                display: true,
                text: 'Date',
              },
            },
          },
        },
      };

      return await chartJSNodeCanvas.renderToBuffer(configuration);
    } catch (error: any) {
      logger.error('Failed to generate block sync chart:', error);
      throw error;
    }
  }

  /**
   * Generate performance metrics dashboard
   */
  async generatePerformanceDashboard(metrics: {
    cpu: number;
    memory: number;
    disk: number;
    uptime: number;
    cacheHitRate: number;
  }): Promise<Buffer> {
    try {
      const configuration = {
        type: 'bar' as const,
        data: {
          labels: ['CPU', 'Memory', 'Disk', 'Uptime', 'Cache Hit'],
          datasets: [
            {
              label: 'Current Metrics (%)',
              data: [
                metrics.cpu,
                metrics.memory,
                metrics.disk,
                metrics.uptime,
                metrics.cacheHitRate,
              ],
              backgroundColor: [
                'rgba(255, 99, 132, 0.6)',
                'rgba(54, 162, 235, 0.6)',
                'rgba(255, 206, 86, 0.6)',
                'rgba(75, 192, 192, 0.6)',
                'rgba(153, 102, 255, 0.6)',
              ],
              borderColor: [
                'rgb(255, 99, 132)',
                'rgb(54, 162, 235)',
                'rgb(255, 206, 86)',
                'rgb(75, 192, 192)',
                'rgb(153, 102, 255)',
              ],
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            title: {
              display: true,
              text: 'Gateway Performance Dashboard',
              font: { size: 16 },
            },
            legend: {
              display: false,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
              title: {
                display: true,
                text: 'Percentage (%)',
              },
            },
          },
        },
      };

      return await chartJSNodeCanvas.renderToBuffer(configuration);
    } catch (error: any) {
      logger.error('Failed to generate performance dashboard:', error);
      throw error;
    }
  }

  /**
   * Generate weekly trends chart
   */
  async generateWeeklyTrends(dailyData: Array<{
    day: string;
    cpu: number;
    memory: number;
    requests: number;
  }>): Promise<Buffer> {
    try {
      const labels = dailyData.map(d => d.day.split('-').slice(1).join('/'));
      
      const configuration = {
        type: 'line' as const,
        data: {
          labels,
          datasets: [
            {
              label: 'CPU Usage (%)',
              data: dailyData.map(d => d.cpu),
              borderColor: 'rgb(255, 99, 132)',
              backgroundColor: 'rgba(255, 99, 132, 0.1)',
              yAxisID: 'y',
              tension: 0.4,
            },
            {
              label: 'Memory Usage (%)',
              data: dailyData.map(d => d.memory),
              borderColor: 'rgb(54, 162, 235)',
              backgroundColor: 'rgba(54, 162, 235, 0.1)',
              yAxisID: 'y',
              tension: 0.4,
            },
          ],
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'index' as const,
            intersect: false,
          },
          plugins: {
            title: {
              display: true,
              text: 'Weekly Performance Trends',
              font: { size: 16 },
            },
          },
          scales: {
            y: {
              type: 'linear' as const,
              display: true,
              position: 'left' as const,
              beginAtZero: true,
              max: 100,
              title: {
                display: true,
                text: 'Usage (%)',
              },
            },
          },
        },
      };

      return await chartJSNodeCanvas.renderToBuffer(configuration);
    } catch (error: any) {
      logger.error('Failed to generate weekly trends chart:', error);
      throw error;
    }
  }
}

export const chartGenerator = new ChartGenerator();
