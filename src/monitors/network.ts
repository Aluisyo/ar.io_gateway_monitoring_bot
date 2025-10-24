/**
 * Network-wide monitoring for AR.IO ecosystem
 * Tracks gateway registry changes and ArNS activity
 */
import { ARIO } from '@ar.io/sdk';
import { logger } from '../utils/logger.js';
import config from '../config.js';
import { metricsDb } from '../utils/metrics-db.js';

export interface GatewayChange {
  type: 'joined' | 'left' | 'updated';
  address: string;
  label?: string;
  fqdn?: string;
  observerWallet?: string;
  operatorStake?: number;
  totalDelegatedStake?: number;
  status?: string;
  startTimestamp?: number;
  stats?: any;
  weights?: any;
  settings?: any;
  timestamp: Date;
  changes?: string[]; // For 'updated' type, list what changed
}

export interface ArnsChange {
  type: 'lease' | 'permabuy';
  name: string;
  purchaser: string;
  targetId: string;
  years?: number;
  processId?: string;
  purchasePrice?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  undernameLimit?: number;
  timestamp: Date;
}

export class NetworkMonitor {
  private ario: any;
  private lastGatewaySnapshot: Map<string, any> = new Map();
  private lastArnsSnapshot: Map<string, any> = new Map();
  private gatewayInitialized: boolean = false;
  private arnsInitialized: boolean = false;

  constructor() {
    try {
      this.ario = config.network === 'mainnet' ? ARIO.mainnet() : ARIO.testnet();
      logger.info(`NetworkMonitor initialized for ${config.network}`);
      logger.info(`Gateway registry monitoring: ${config.features.monitorGatewayRegistry ? 'ENABLED' : 'DISABLED'}`);
      logger.info(`ArNS activity monitoring: ${config.features.monitorArnsActivity ? 'ENABLED' : 'DISABLED'}`);
      this.loadFromDatabase();
    } catch (error: any) {
      logger.error('Failed to initialize NetworkMonitor:', error.message);
      throw error;
    }
  }

  /**
   * Load snapshots from database on startup
   */
  private async loadFromDatabase() {
    try {
      const gatewaySnapshots = metricsDb.getAllNetworkSnapshots('gateway');
      const arnsSnapshots = metricsDb.getAllNetworkSnapshots('arns');
      
      if (gatewaySnapshots.size > 0) {
        this.lastGatewaySnapshot = gatewaySnapshots;
        logger.info(`Loaded ${gatewaySnapshots.size} gateway snapshots from database`);
        // DON'T set isInitialized here - prevents false alerts on restart
      }
      
      if (arnsSnapshots.size > 0) {
        this.lastArnsSnapshot = arnsSnapshots;
        logger.info(`Loaded ${arnsSnapshots.size} ArNS snapshots from database`);
        // DON'T set isInitialized here - prevents false alerts on restart
      }
      
      logger.info('⚠️ Loaded snapshots from DB. First check will be silent to prevent restart alerts.');
    } catch (error: any) {
      logger.error('Failed to load network snapshots:', error.message);
    }
  }

  /**
   * Monitor gateway registry for changes
   */
  async checkGatewayChanges(): Promise<GatewayChange[]> {
    if (!config.features.monitorGatewayRegistry) {
      logger.info('Gateway registry monitoring is disabled');
      return [];
    }

    try {
      logger.info('🔍 Checking gateway changes...');
      
      // Fetch ALL gateways with pagination
      let allGateways: any[] = [];
      let cursor: string | undefined = undefined;
      let pageCount = 0;
      
      do {
        pageCount++;
        const response: any = await this.ario.getGateways({ limit: 1000, cursor });
        const gateways = response.items || response;
        
        if (Array.isArray(gateways)) {
          allGateways = allGateways.concat(gateways);
        } else {
          allGateways = allGateways.concat(Object.values(gateways));
        }
        
        cursor = response.nextCursor;
        logger.info(`📄 Page ${pageCount}: Fetched ${Array.isArray(gateways) ? gateways.length : Object.keys(gateways).length} gateways`);
        
        if (!response.hasMore) break;
      } while (cursor);
      
      logger.info(`📡 Total fetched: ${allGateways.length} gateways across ${pageCount} page(s)`);
      
      const changes: GatewayChange[] = [];
      const currentSnapshot = new Map<string, any>();

      // Build current snapshot
      for (const gateway of allGateways) {
        const address = gateway.id || gateway.gatewayAddress;
        if (address) {
          currentSnapshot.set(address, gateway);
        }
      }

      const hadPreviousSnapshot = this.lastGatewaySnapshot.size > 0;

      // Detect changes once initialization completed
      if (hadPreviousSnapshot && this.gatewayInitialized) {
        // Check for new gateways (joined)
        for (const [address, gateway] of currentSnapshot.entries()) {
          if (!this.lastGatewaySnapshot.has(address)) {
            logger.info(`Gateway joined: ${address} (${(gateway as any).settings?.label || 'No label'})`);
            changes.push({
              type: 'joined',
              address,
              label: (gateway as any).settings?.label,
              fqdn: (gateway as any).settings?.fqdn,
              observerWallet: (gateway as any).observerAddress,
              operatorStake: (gateway as any).operatorStake,
              totalDelegatedStake: (gateway as any).totalDelegatedStake,
              status: (gateway as any).status,
              startTimestamp: (gateway as any).startTimestamp,
              stats: (gateway as any).stats,
              weights: (gateway as any).weights,
              settings: (gateway as any).settings,
              timestamp: new Date(),
            });
          } else {
            // Check for updates
            const oldGateway = this.lastGatewaySnapshot.get(address);
            const changesList: string[] = [];
            
            if ((gateway as any).settings?.label !== oldGateway.settings?.label) {
              changesList.push(`Label: ${oldGateway.settings?.label || 'None'} → ${(gateway as any).settings?.label || 'None'}`);
            }
            if ((gateway as any).settings?.fqdn !== oldGateway.settings?.fqdn) {
              changesList.push(`FQDN: ${oldGateway.settings?.fqdn || 'None'} → ${(gateway as any).settings?.fqdn || 'None'}`);
            }
            if ((gateway as any).observerAddress !== oldGateway.observerAddress) {
              changesList.push(`Observer: ${oldGateway.observerAddress?.slice(0, 8) || 'None'}... → ${(gateway as any).observerAddress?.slice(0, 8) || 'None'}...`);
            }
            if ((gateway as any).status !== oldGateway.status) {
              changesList.push(`Status: ${oldGateway.status} → ${(gateway as any).status}`);
            }

            if (changesList.length > 0) {
              logger.info(`Gateway updated: ${address} - ${changesList.join(', ')}`);
              changes.push({
                type: 'updated',
                address,
                label: (gateway as any).settings?.label,
                fqdn: (gateway as any).settings?.fqdn,
                observerWallet: (gateway as any).observerAddress,
                operatorStake: (gateway as any).operatorStake,
                totalDelegatedStake: (gateway as any).totalDelegatedStake,
                status: (gateway as any).status,
                startTimestamp: (gateway as any).startTimestamp,
                stats: (gateway as any).stats,
                weights: (gateway as any).weights,
                settings: (gateway as any).settings,
                changes: changesList,
                timestamp: new Date(),
              });
            }
          }
        }

        // Check for removed gateways (left)
        for (const [address, gateway] of this.lastGatewaySnapshot.entries()) {
          if (!currentSnapshot.has(address)) {
            logger.info(`Gateway left: ${address} (${(gateway as any).settings?.label || 'No label'})`);
            changes.push({
              type: 'left',
              address,
              label: (gateway as any).settings?.label,
              fqdn: (gateway as any).settings?.fqdn,
              observerWallet: (gateway as any).observerAddress,
              operatorStake: (gateway as any).operatorStake,
              totalDelegatedStake: (gateway as any).totalDelegatedStake,
              status: (gateway as any).status,
              startTimestamp: (gateway as any).startTimestamp,
              stats: (gateway as any).stats,
              weights: (gateway as any).weights,
              settings: (gateway as any).settings,
              timestamp: new Date(),
            });
          }
        }
      } else if (!this.gatewayInitialized) {
        // First pass (after startup) - initialize without emitting alerts
        logger.info(`Gateway snapshot initialized with ${currentSnapshot.size} gateways`);
        this.gatewayInitialized = true;
      }

      // Update snapshot in memory and database
      this.lastGatewaySnapshot = currentSnapshot;
      
      // Save to database
      try {
        for (const [address, gateway] of currentSnapshot.entries()) {
          metricsDb.saveNetworkSnapshot('gateway', address, gateway);
        }
      } catch (error: any) {
        logger.error('Failed to save gateway snapshots to database:', error.message);
      }

      if (changes.length > 0) {
        logger.info(`Detected ${changes.length} gateway registry changes`);
      }

      return changes;
    } catch (error: any) {
      logger.error('Failed to check gateway changes:', error.message || error);
      if (error.stack) {
        logger.debug('Gateway check error stack:', error.stack);
      }
      return [];
    }
  }

  /**
   * Monitor ArNS for new purchases
   */
  async checkArnsChanges(): Promise<ArnsChange[]> {
    if (!config.features.monitorArnsActivity) {
      logger.info('ArNS activity monitoring is disabled');
      return [];
    }

    try {
      logger.info('🔍 Checking ArNS changes...');
      
      // Fetch ALL ArNS records with pagination
      let allRecords: any[] = [];
      let cursor: string | undefined = undefined;
      let pageCount = 0;
      
      do {
        pageCount++;
        const response: any = await this.ario.getArNSRecords({ limit: 1000, cursor });
        const records = response.items || response;
        
        if (Array.isArray(records)) {
          allRecords = allRecords.concat(records);
        } else {
          allRecords = allRecords.concat(Object.values(records));
        }
        
        cursor = response.nextCursor;
        logger.info(`📄 Page ${pageCount}: Fetched ${Array.isArray(records) ? records.length : Object.keys(records).length} ArNS records`);
        
        if (!response.hasMore) break;
      } while (cursor);
      
      logger.info(`📡 Total fetched: ${allRecords.length} ArNS records across ${pageCount} page(s)`);
      
      const changes: ArnsChange[] = [];
      const currentSnapshot = new Map<string, any>();

      // Build current snapshot
      for (const record of allRecords) {
        const name = record.name || record.domain;
        if (name) {
          currentSnapshot.set(name, record);
        }
      }

      const hadPreviousSnapshot = this.lastArnsSnapshot.size > 0;

      // Detect new purchases once initialization completed
      if (hadPreviousSnapshot && this.arnsInitialized) {
        for (const [name, record] of currentSnapshot.entries()) {
          if (!this.lastArnsSnapshot.has(name)) {
            const isPermanent = (record as any).type === 'permabuy';
            logger.info(`ArNS ${isPermanent ? 'permabuy' : 'lease'}: ${name}.arweave.dev`);
            
            changes.push({
              type: isPermanent ? 'permabuy' : 'lease',
              name,
              purchaser: (record as any).contractTxId || (record as any).processId || 'unknown',
              targetId: (record as any).targetId || (record as any).transactionId,
              years: isPermanent ? undefined : (record as any).years,
              processId: (record as any).processId,
              purchasePrice: (record as any).purchasePrice,
              startTimestamp: (record as any).startTimestamp,
              endTimestamp: (record as any).endTimestamp,
              undernameLimit: (record as any).undernameLimit,
              timestamp: new Date(),
            });
          }
        }
      } else if (!this.arnsInitialized) {
        // First pass (after startup) - initialize without emitting alerts
        logger.info(`ArNS snapshot initialized with ${currentSnapshot.size} names`);
        this.arnsInitialized = true;
      }

      // Update snapshot in memory and database
      this.lastArnsSnapshot = currentSnapshot;
      
      // Save to database
      try {
        for (const [name, record] of currentSnapshot.entries()) {
          metricsDb.saveNetworkSnapshot('arns', name, record);
        }
      } catch (error: any) {
        logger.error('Failed to save ArNS snapshots to database:', error.message);
      }

      if (changes.length > 0) {
        logger.info(`Detected ${changes.length} ArNS changes`);
      }

      return changes;
    } catch (error: any) {
      logger.error('Failed to check ArNS changes:', error.message || error);
      if (error.stack) {
        logger.debug('ArNS check error stack:', error.stack);
      }
      return [];
    }
  }

  /**
   * Get current network statistics
   */
  async getNetworkStats() {
    try {
      const [gateways, records] = await Promise.all([
        this.ario.getGateways(),
        this.ario.getArNSRecords(),
      ]);

      return {
        totalGateways: Object.keys(gateways).length,
        totalArnsNames: Object.keys(records).length,
      };
    } catch (error: any) {
      logger.error('Failed to get network stats:', error.message);
      return {
        totalGateways: 0,
        totalArnsNames: 0,
      };
    }
  }
}
