/**
 * Observer monitoring for AR.IO network participation
 */
import axios from 'axios';
import { ARIO } from '@ar.io/sdk';
import { inspect } from 'util';
import { logger } from '../utils/logger.js';
import config from '../config.js';
import { metricsDb } from '../utils/metrics-db.js';

export interface ObserverReport {
  formatVersion: number;
  observerAddress: string;
  epochIndex: number;
  epochStartTimestamp: number;
  epochStartHeight: number;
  epochEndTimestamp: number;
  generatedAt: number;
}

export interface ObserverStatus {
  epochIndex: number;
  isSelectedAsObserver: boolean;
  observerWeight?: number;
  prescribedNames?: string[];
  epochEndTimestamp?: number;
  epochStartTimestamp?: number;
  hasSubmittedReport?: boolean;
  reportTxId?: string;
  localReport?: ObserverReport;
}

export interface GatewayInfo {
  wallet?: string;
  processId?: string;
  release?: string;
  fqdn?: string;
  port?: number;
  protocol?: string;
  observerWallet?: string;
  operatorStake?: number; // in ARIO
  totalDelegatedStake?: number; // in ARIO
  totalStake?: number; // in ARIO
  startTimestamp?: number; // epoch ms when gateway joined
}

export interface RewardsInfo {
  operatorReward: number;
  delegateRewards: number;
  totalReward: number;
  distributed: number;
  totalEligibleRewards: number;
  totalEligibleGateways: number;
  observerRewardPerGateway: number;
  gatewayRewardPerGateway: number;
  totalStake: number;
  operatorStake: number;
  delegatedStake: number;
  isDistributed: boolean;
  epochIndex: number;
}

export interface EpochStats {
  epochIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  distributionTimestamp?: number;
  totalEligibleGateways: number;
  totalEligibleRewards: number;
  observerReward: number;
  gatewayReward: number;
  totalDistributedRewards?: number;
  distributionPercentage?: number;
  observationCount?: number;
  totalObservers?: number;
  observationPercentage?: number;
  gatewaysPassed?: number;
  gatewaysFailed?: number;
  passPercentage?: number;
  failPercentage?: number;
  isDistributed: boolean;
}

export class ObserverMonitor {
  private ario: any;

  constructor() {
    this.ario = config.network === 'mainnet' ? ARIO.mainnet() : ARIO.testnet();
  }

  /**
   * Fetch gateway info from /ar-io/info endpoint and AR.IO contract
   */
  async getGatewayInfo(): Promise<GatewayInfo> {
    try {
      // Get local gateway info
      const response = await axios.get(`${config.gateway.coreUrl}/ar-io/info`, {
        timeout: 5000,
      });

      // Prefer locally cached gateway snapshot (includes FQDN/domain info)
      const snapshotGateway = metricsDb.getNetworkSnapshot('gateway', config.gateway.address);
      const snapshotSettings = snapshotGateway?.settings || {};
      if (snapshotGateway) {
        logger.debug('Gateway info snapshot found for address', {
          fqdn: snapshotSettings?.fqdn,
          port: snapshotSettings?.port,
          protocol: snapshotSettings?.protocol,
        });
      } else {
        logger.debug('No gateway snapshot found in metrics DB for info handler');
      }

      // Get contract data (stake, join date)
      let contractData: any = {};
      try {
        contractData = await this.ario.getGateway({ address: config.gateway.address });
        const settings = contractData?.settings || {};
        logger.info('Contract data keys:', Object.keys(contractData || {}));
        logger.info('Full contract data:', inspect(contractData, { depth: 6 }));
        logger.info('Contract settings keys:', Object.keys(settings || {}));
        logger.info('Contract settings JSON:', JSON.stringify(settings, null, 2));
        logger.info('FQDN from settings:', settings?.fqdn || settings?.domain || 'NOT FOUND');
        logger.info('FQDN from local endpoint:', response.data.fqdn || 'NOT FOUND');
      } catch (error) {
        logger.warn('Failed to fetch gateway contract data:', error);
      }

      const snapshotProtocol = snapshotSettings?.protocol || snapshotGateway?.protocol;
      const snapshotPort = snapshotSettings?.port || snapshotGateway?.port;
      const snapshotFqdn = snapshotSettings?.fqdn || snapshotSettings?.domain;
      const snapshotObserver = snapshotGateway?.observerAddress;
      const snapshotOperatorStake = snapshotGateway?.operatorStake;
      const snapshotDelegatedStake = snapshotGateway?.totalDelegatedStake;
      const snapshotStartTimestamp = snapshotGateway?.startTimestamp;

      const contractSettings = contractData?.settings || {};
      const contractFqdn = contractSettings?.fqdn || contractSettings?.domain || contractData?.fqdn;
      const contractPort = contractSettings?.port || contractData?.port;
      const contractProtocol = contractSettings?.protocol || contractData?.protocol;
      const contractObserver = contractData?.observerAddress || contractData?.observerWallet;
      const contractOperatorStake = contractData?.operatorStake;
      const contractDelegatedStake = contractData?.totalDelegatedStake;
      const contractStartTimestamp = contractData?.startTimestamp;

      const rawOperatorStake = snapshotOperatorStake ?? contractOperatorStake;
      const rawDelegatedStake = snapshotDelegatedStake ?? contractDelegatedStake;

      const operatorStake = typeof rawOperatorStake === 'number' ? rawOperatorStake / 1_000_000 : undefined;
      const delegatedStake = typeof rawDelegatedStake === 'number' ? rawDelegatedStake / 1_000_000 : undefined;
      const totalStake =
        typeof rawOperatorStake === 'number' && typeof rawDelegatedStake === 'number'
          ? (rawOperatorStake + rawDelegatedStake) / 1_000_000
          : operatorStake !== undefined || delegatedStake !== undefined
            ? (operatorStake || 0) + (delegatedStake || 0)
            : undefined;

      return {
        wallet: response.data.wallet || snapshotGateway?.wallet,
        processId: response.data.processId || snapshotGateway?.processId,
        release: response.data.release || snapshotGateway?.release,
        fqdn: snapshotFqdn || contractFqdn || response.data.fqdn,
        port: snapshotPort || contractPort || response.data.port,
        protocol: snapshotProtocol || contractProtocol || response.data.protocol,
        observerWallet: snapshotObserver || contractObserver || response.data.wallet,
        operatorStake,
        totalDelegatedStake: delegatedStake,
        totalStake,
        startTimestamp: snapshotStartTimestamp || contractStartTimestamp,
      };
    } catch (error: any) {
      return {};
    }
  }

  /**
   * Fetch current observer report from local observer service
   */
  async getCurrentObserverReport(): Promise<ObserverReport | null> {
    try {
      const response = await axios.get(`${config.gateway.observerUrl}/ar-io/observer/reports/${config.gateway.address}`);

      if (response.data.message === 'Report pending') {
        return null;
      }

      return {
        formatVersion: response.data.formatVersion,
        observerAddress: response.data.observerAddress,
        epochIndex: response.data.epochIndex,
        epochStartTimestamp: response.data.epochStartTimestamp,
        epochStartHeight: response.data.epochStartHeight,
        epochEndTimestamp: response.data.epochEndTimestamp,
        generatedAt: response.data.generatedAt,
      };
    } catch (error: any) {
      return null;
    }
  }

  async checkObserverStatus(): Promise<ObserverStatus> {
    // Fetch local observer report first (always available)
    const localReport = await this.getCurrentObserverReport();

    // Try to fetch network data from AR.IO SDK
    try {
      if (!config.gateway.address) {
        return {
          epochIndex: localReport?.epochIndex || 0,
          isSelectedAsObserver: false,
          localReport: localReport || undefined,
          epochStartTimestamp: localReport?.epochStartTimestamp,
          epochEndTimestamp: localReport?.epochEndTimestamp,
        };
      }

      // Use local report data as fallback
      const fallbackEpoch = localReport?.epochIndex || 0;
      const fallbackEndTime = localReport?.epochEndTimestamp;
      const fallbackStartTime = localReport?.epochStartTimestamp;

      const epoch = await this.ario.getCurrentEpoch();
      const observers = await this.ario.getPrescribedObservers();
      
      const myObserverStatus = observers.find(
        (obs: any) => obs.gatewayAddress === config.gateway.address
      );

      let hasSubmittedReport = false;
      let reportTxId: string | undefined;

      try {
        const observations = await this.ario.getObservations();
        reportTxId = observations.reports?.[config.gateway.address];
        hasSubmittedReport = !!reportTxId;
      } catch (error: any) {
        // Reports unavailable
      }

      return {
        epochIndex: epoch.epochIndex || fallbackEpoch,
        isSelectedAsObserver: !!myObserverStatus,
        observerWeight: myObserverStatus?.normalizedCompositeWeight,
        prescribedNames: epoch.prescribedNames,
        epochEndTimestamp: epoch.endTimestamp || fallbackEndTime,
        epochStartTimestamp: epoch.startTimestamp || fallbackStartTime,
        hasSubmittedReport,
        reportTxId,
        localReport: localReport || undefined,
      };
    } catch (error: any) {
      // SDK unavailable, use local data
      return {
        epochIndex: localReport?.epochIndex || 0,
        isSelectedAsObserver: false,
        localReport: localReport || undefined,
        epochStartTimestamp: localReport?.epochStartTimestamp,
        epochEndTimestamp: localReport?.epochEndTimestamp,
      };
    }
  }

  async getRewards(epochIndex?: number): Promise<RewardsInfo> {
    try {
      // Ensure we have a valid epoch index
      let currentEpochIndex: number;
      if (epochIndex) {
        currentEpochIndex = epochIndex;
      } else {
        const currentEpoch = await this.ario.getCurrentEpoch();
        currentEpochIndex = currentEpoch.epochIndex;
      }

      logger.info(`Fetching rewards for epoch ${currentEpochIndex}...`);

      // Add timeout to prevent hanging
      const timeout = (ms: number) => new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timed out')), ms)
      );

      const [distributions, gatewayInfo, epoch] = await Promise.race([
        Promise.all([
          this.ario.getDistributions({ epochIndex: currentEpochIndex }),
          this.ario.getGateway({ address: config.gateway.address }),
          this.ario.getEpoch({ epochIndex: currentEpochIndex }),
        ]),
        timeout(15000) // 15 second timeout
      ]) as any[];

      if (!distributions) {
        throw new Error('Distributions data is null or undefined');
      }
      if (!gatewayInfo) {
        throw new Error('Gateway info is null or undefined');
      }
      if (!epoch) {
        throw new Error('Epoch data is null or undefined');
      }
      
      logger.info('Successfully fetched all rewards data');

      const myRewards = distributions.rewards?.eligible?.[config.gateway.address];
      const distributed = distributions.rewards?.distributed?.[config.gateway.address] || 0;

      // Calculate rewards (convert from mARIO to ARIO) with proper number handling
      const operatorRewardRaw = myRewards?.operatorReward ?? 0;
      const delegateRewardsRaw = myRewards?.delegateRewards ?? 0;
      
      const operatorReward = (typeof operatorRewardRaw === 'number' ? operatorRewardRaw : 0) / 1_000_000;
      const delegateRewards = (typeof delegateRewardsRaw === 'number' ? delegateRewardsRaw : 0) / 1_000_000;
      const totalReward = operatorReward + delegateRewards;
      const distributedARIO = (typeof distributed === 'number' ? distributed : 0) / 1_000_000;
      
      logger.info(`Rewards - Operator: ${operatorReward}, Delegate: ${delegateRewards}, Total: ${totalReward}`);

      // Get staking info with safe number handling
      const operatorStakeRaw = gatewayInfo?.operatorStake ?? 0;
      const delegatedStakeRaw = gatewayInfo?.totalDelegatedStake ?? 0;
      const operatorStake = (typeof operatorStakeRaw === 'number' ? operatorStakeRaw : 0) / 1_000_000;
      const delegatedStake = (typeof delegatedStakeRaw === 'number' ? delegatedStakeRaw : 0) / 1_000_000;
      const totalStake = operatorStake + delegatedStake;

      // Calculate per-gateway rewards (average rewards each gateway receives)
      const totalEligibleGateways = distributions.totalEligibleGateways || 1;
      const totalObserverReward = typeof distributions.totalEligibleObserverReward === 'number' ? distributions.totalEligibleObserverReward : 0;
      const totalGatewayReward = typeof distributions.totalEligibleGatewayReward === 'number' ? distributions.totalEligibleGatewayReward : 0;
      const observerRewardPerGateway = totalObserverReward / 1_000_000 / totalEligibleGateways;
      const gatewayRewardPerGateway = totalGatewayReward / 1_000_000 / totalEligibleGateways;

      const totalEligibleRewardsRaw = typeof distributions.totalEligibleRewards === 'number' ? distributions.totalEligibleRewards : 0;
      
      return {
        operatorReward,
        delegateRewards,
        totalReward,
        distributed: distributedARIO,
        totalEligibleRewards: totalEligibleRewardsRaw / 1_000_000,
        totalEligibleGateways,
        observerRewardPerGateway,
        gatewayRewardPerGateway,
        totalStake,
        operatorStake,
        delegatedStake,
        isDistributed: !!distributions.distributedTimestamp,
        epochIndex: currentEpochIndex,
      };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace';
      logger.error(`Failed to check rewards: ${errorMsg}`);
      logger.error(`Stack trace: ${errorStack}`);
      throw new Error(`Failed to fetch rewards: ${errorMsg}`);
    }
  }

  /**
   * Get comprehensive epoch statistics including distributions
   */
  async getEpochStats(epochIndex?: number): Promise<EpochStats> {
    try {
      const epoch = epochIndex 
        ? await this.ario.getEpoch({ epochIndex })
        : await this.ario.getCurrentEpoch();
      
      const distributions = await this.ario.getDistributions({ 
        epochIndex: epoch.epochIndex 
      });

      // Calculate observation stats
      const observations = epoch.observations || {};
      const reports = observations.reports || {};
      const observationCount = Object.keys(reports).length;
      const totalObservers = epoch.prescribedObservers?.length || 0;
      const observationPercentage = totalObservers > 0 
        ? (observationCount / totalObservers) * 100 
        : 0;

      // Calculate pass/fail stats from failureSummaries
      const failureSummaries = observations.failureSummaries || {};
      const gatewaysFailed = Object.keys(failureSummaries).length;
      const totalEligibleGateways = distributions.totalEligibleGateways || 0;
      const gatewaysPassed = totalEligibleGateways - gatewaysFailed;
      const passPercentage = totalEligibleGateways > 0
        ? (gatewaysPassed / totalEligibleGateways) * 100
        : 0;
      const failPercentage = totalEligibleGateways > 0
        ? (gatewaysFailed / totalEligibleGateways) * 100
        : 0;

      // Calculate rewards (convert from mARIO)
      const totalEligibleRewards = (distributions.totalEligibleRewards || 0) / 1_000_000;
      const totalDistributedRewards = (distributions.totalDistributedRewards || 0) / 1_000_000;
      const distributionPercentage = totalEligibleRewards > 0
        ? (totalDistributedRewards / totalEligibleRewards) * 100
        : 0;

      // Calculate per-gateway rewards
      const observerReward = (distributions.totalEligibleObserverReward || 0) / 1_000_000 / Math.max(1, totalObservers);
      const gatewayReward = (distributions.totalEligibleGatewayReward || 0) / 1_000_000 / Math.max(1, totalEligibleGateways);

      const isDistributed = !!distributions.distributedTimestamp;

      return {
        epochIndex: epoch.epochIndex,
        startTimestamp: epoch.startTimestamp,
        endTimestamp: epoch.endTimestamp,
        distributionTimestamp: distributions.distributedTimestamp,
        totalEligibleGateways,
        totalEligibleRewards,
        observerReward,
        gatewayReward,
        totalDistributedRewards,
        distributionPercentage,
        observationCount,
        totalObservers,
        observationPercentage,
        gatewaysPassed,
        gatewaysFailed,
        passPercentage,
        failPercentage,
        isDistributed,
      };
    } catch (error: any) {
      logger.error('Failed to get epoch stats:', error.message);
      throw error;
    }
  }
}
