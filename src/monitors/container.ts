import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface ContainerState {
  name: string;
  status: 'running' | 'exited' | 'restarting' | 'paused' | 'dead' | 'created' | 'unknown';
  uptime: number; // seconds
  restartCount: number;
  lastStartTime: Date;
  exitCode?: number;
}

export class ContainerMonitor {
  private previousStates: Map<string, ContainerState> = new Map();
  private isInitialized: boolean = false;
  private readonly containers = [
    'ar-io-node-core-1',
    'ar-io-node-observer-1',
    'ar-io-node-envoy-1',
    'ar-io-node-redis-1'
  ];

  async getContainerStates(): Promise<ContainerState[]> {
    const states: ContainerState[] = [];

    for (const containerName of this.containers) {
      try {
        const state = await this.getContainerState(containerName);
        states.push(state);
      } catch (error) {
        logger.error(`Failed to get state for ${containerName}:`, error);
        states.push({
          name: containerName,
          status: 'unknown',
          uptime: 0,
          restartCount: 0,
          lastStartTime: new Date()
        });
      }
    }

    return states;
  }

  private async getContainerState(containerName: string): Promise<ContainerState> {
    try {
      const { stdout } = await execAsync(
        `docker inspect ${containerName} --format='{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.ExitCode}}'`
      );

      const [status, startedAt, restartCount, exitCode] = stdout.trim().split('|');
      const startTime = new Date(startedAt);
      const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);

      return {
        name: containerName,
        status: this.normalizeStatus(status),
        uptime,
        restartCount: parseInt(restartCount) || 0,
        lastStartTime: startTime,
        exitCode: parseInt(exitCode) || 0
      };
    } catch (error: any) {
      throw new Error(`Failed to inspect ${containerName}: ${error.message}`);
    }
  }

  private normalizeStatus(status: string): ContainerState['status'] {
    const normalized = status.toLowerCase();
    if (normalized.includes('running')) return 'running';
    if (normalized.includes('exited')) return 'exited';
    if (normalized.includes('restarting')) return 'restarting';
    if (normalized.includes('paused')) return 'paused';
    if (normalized.includes('dead')) return 'dead';
    if (normalized.includes('created')) return 'created';
    return 'unknown';
  }

  detectChanges(currentStates: ContainerState[]): ContainerStateChange[] {
    const changes: ContainerStateChange[] = [];

    for (const current of currentStates) {
      const previous = this.previousStates.get(current.name);

      if (!previous) {
        // Skip startup alerts for already-running containers
        if (this.isInitialized && current.status === 'running') {
          changes.push({
            container: current.name,
            type: 'started',
            previousStatus: 'unknown',
            currentStatus: current.status,
            timestamp: new Date()
          });
        }
      } else {
        if (previous.status !== current.status) {
          changes.push({
            container: current.name,
            type: this.determineChangeType(previous.status, current.status, current.exitCode),
            previousStatus: previous.status,
            currentStatus: current.status,
            timestamp: new Date()
          });
        }
        // Detect container restarts
        else if (
          current.status === 'running' &&
          (previous.lastStartTime.getTime() !== current.lastStartTime.getTime() ||
          previous.restartCount !== current.restartCount)
        ) {
          changes.push({
            container: current.name,
            type: 'restarted',
            previousStatus: previous.status,
            currentStatus: current.status,
            timestamp: new Date(),
            restartCount: current.restartCount
          });
        }
      }

      this.previousStates.set(current.name, current);
    }

    if (!this.isInitialized) {
      this.isInitialized = true;
    }

    return changes;
  }

  private determineChangeType(
    previousStatus: ContainerState['status'],
    currentStatus: ContainerState['status'],
    exitCode?: number
  ): 'started' | 'stopped' | 'restarted' | 'crashed' {
    if (currentStatus === 'running' && previousStatus !== 'running') {
      return 'started';
    }
    if (currentStatus === 'exited' || currentStatus === 'dead') {
      // Exit code 0 = clean shutdown, non-zero = crash
      if (exitCode === 0) {
        return 'stopped';
      }
      return previousStatus === 'running' ? 'crashed' : 'stopped';
    }
    return 'restarted';
  }

  getServiceEmoji(containerName: string): string {
    if (containerName.includes('core')) return '🔧';
    if (containerName.includes('observer')) return '👁️';
    if (containerName.includes('envoy')) return '🌐';
    if (containerName.includes('redis')) return '📦';
    return '📦';
  }

  getServiceName(containerName: string): string {
    if (containerName.includes('core')) return 'Gateway Core';
    if (containerName.includes('observer')) return 'Observer';
    if (containerName.includes('envoy')) return 'Envoy Proxy';
    if (containerName.includes('redis')) return 'Redis';
    return containerName;
  }
}

export interface ContainerStateChange {
  container: string;
  type: 'started' | 'stopped' | 'restarted' | 'crashed';
  previousStatus: string;
  currentStatus: string;
  timestamp: Date;
  restartCount?: number;
}

export const containerMonitor = new ContainerMonitor();
