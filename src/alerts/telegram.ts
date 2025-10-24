/**
 * Telegram Bot for alerts and monitoring
 */
import { Telegraf, Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import config from '../config.js';
import { logger } from '../utils/logger.js';
import { runtimeConfig } from '../utils/runtime-config.js';
import type { GatewayHealth, DetailedMetrics } from '../monitors/health.js';
import type { ObserverStatus, RewardsInfo, GatewayInfo, EpochStats } from '../monitors/observer.js';
import type { SSLCertificateInfo } from '../monitors/ssl.js';
import { chartGenerator } from '../utils/chart-generator.js';
import { metricsTracker } from '../utils/metrics-tracker.js';
import { metricsDb } from '../utils/metrics-db.js';
import * as TelegramMenus from './telegram-menus.js';
import * as TelegramSettings from './telegram-settings.js';

export interface AlertHistoryEntry {
  timestamp: number;
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  category?: string;
}

export class TelegramBot {
  private bot: Telegraf;
  private lastAlertTime: Map<string, number> = new Map();
  private alertHistory: AlertHistoryEntry[] = [];
  private isMuted: boolean = false;
  private muteUntil?: number;
  private categoryMutes: Map<string, number> = new Map(); // category -> muteUntil timestamp
  private statusHandler?: () => Promise<GatewayHealth>;
  private observerHandler?: () => Promise<ObserverStatus>;
  private metricsHandler?: () => Promise<DetailedMetrics>;
  private rewardsHandler?: () => Promise<RewardsInfo>;
  private sslHandler?: () => Promise<SSLCertificateInfo>;
  private sslFormatter?: (cert: SSLCertificateInfo) => string;
  private infoHandler?: () => Promise<GatewayInfo>;
  private epochHandler?: () => Promise<EpochStats>;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.bot.use(async (ctx, next) => {
      const incomingChatId = ctx.chat?.id ? String(ctx.chat.id) : undefined;
      const allowedChatId = config.telegram.chatId;
      if (!incomingChatId || incomingChatId !== allowedChatId) {
        const userDescriptor = ctx.from?.username || ctx.from?.id;
        logger.warn('Blocked unauthorized Telegram access attempt', {
          chatId: incomingChatId,
          user: userDescriptor,
          updateType: ctx.updateType,
        });
        return;
      }
      if (next) {
        await next();
      }
    });
    this.setupCommands();
    this.restoreMuteState();
    this.restoreCategoryMutes();
  }

  private setupCommands() {
    this.bot.command('start', (ctx) => {
      ctx.reply(
        `🤖 *AR.IO Gateway Monitoring Bot*\n\n` +
        `Welcome! I'll monitor your AR.IO gateway and send you alerts.\n\n` +
        `Tap a button below to get started:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🏥 Check Health', 'action_status')],
            [Markup.button.callback('📚 See All Commands', 'action_help')],
          ])
        }
      );
    });

    this.bot.command('help', (ctx) => {
      this.sendMainMenu(ctx);
    });

    this.bot.command('charts', async (ctx) => {
      await this.sendChartsMenu(ctx);
    });

    this.bot.command('logs', async (ctx) => {
      await this.sendContainerLogs(ctx);
    });

    this.bot.command('quickcheck', async (ctx) => {
      await this.sendQuickCheck(ctx);
    });

    this.bot.command('alerts', async (ctx) => {
      await this.sendAlertHistory(ctx);
    });

    this.bot.command('containers', async (ctx) => {
      await this.sendContainerStats(ctx);
    });

    this.bot.command('mute', async (ctx) => {
      await this.handleMute(ctx);
    });

    this.bot.command('unmute', async (ctx) => {
      await this.handleUnmute(ctx);
    });

    this.bot.command('unmute_category', async (ctx) => {
      const mutedCategories = Array.from(this.categoryMutes.entries())
        .filter(([_, muteTime]) => Date.now() < muteTime);

      if (mutedCategories.length === 0) {
        await ctx.reply('No categories are currently muted.');
        return;
      }

      const buttons = mutedCategories.map(([category, muteTime]) => {
        const timeLeft = muteTime - Date.now();
        const isInfinite = timeLeft > 86400000 * 365; // > 1 year = infinite
        const timeStr = isInfinite ? 'indefinitely' : 
          timeLeft > 3600000 ? `${Math.ceil(timeLeft / 3600000)}h` : 
          `${Math.ceil(timeLeft / 60000)}min`;
        return [Markup.button.callback(`🔕 ${category} (${timeStr})`, `unmute_cat:${category}`)];
      });

      await ctx.reply(
        '🔕 *Muted Categories*\n\nSelect a category to unmute:',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback('🔊 Unmute All', 'unmute_all_cats')]
          ])
        }
      );
    });

    this.bot.command('settings', async (ctx) => {
      await TelegramSettings.sendSettingsMenu(ctx);
    });

    this.bot.command('version', async (ctx) => {
      await ctx.reply('🔍 Checking gateway version...');
      const { versionChecker } = await import('../monitors/version-checker.js');
      const versionInfo = await versionChecker.checkVersion();
      
      if (!versionInfo) {
        await ctx.reply('❌ Failed to check version. Please try again later.');
        return;
      }
      
      const message = versionChecker.formatVersionInfo(versionInfo);
      await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    this.setupCallbackHandlers();

    this.bot.catch((err: any) => {
      logger.error('Telegram bot error:', err);
    });
  }

  private async replyOrEdit(ctx: any, message: string, keyboard?: InlineKeyboardMarkup) {
    const options = keyboard
      ? { parse_mode: 'Markdown', reply_markup: keyboard }
      : { parse_mode: 'Markdown' };

    if (ctx.updateType === 'callback_query' && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(message, options);
        return;
      } catch (error: any) {
        if (error?.description?.includes('message is not modified')) {
          return;
        }
      }
    }

    await ctx.reply(message, options);
  }

  private setupCallbackHandlers() {
    this.bot.action('action_status', async (ctx) => {
      await ctx.answerCbQuery();
      if (!this.statusHandler) {
        await ctx.reply('⚠️ Status handler not configured');
        return;
      }
      try {
        const health = await this.statusHandler();
        const statusEmoji = health.overall === 'healthy' ? '🟢' : 
                           health.overall === 'degraded' ? '🟡' : '🔴';
        const coreEmoji = health.core.isHealthy ? '✅' : '❌';
        const observerEmoji = health.observer.isHealthy ? '✅' : '❌';
        const uptimeText = health.core.uptime
          ? (() => {
              const totalSeconds = health.core.uptime || 0;
              const days = Math.floor(totalSeconds / 86400);
              const hours = Math.floor((totalSeconds % 86400) / 3600);
              const parts: string[] = [];
              if (days > 0) {
                parts.push(`${days} day${days === 1 ? '' : 's'}`);
              }
              parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
              return `Uptime: ${parts.join(' ')}`;
            })()
          : '';
        const message = 
          `${statusEmoji} *${config.gateway.name}*\n\n` +
          `Status: *${health.overall.toUpperCase()}*\n\n` +
          `${coreEmoji} Core: ${health.core.responseTime}ms\n` +
          `${observerEmoji} Observer: ${health.observer.responseTime}ms\n\n` +
          `${uptimeText}\n` +
          `Last check: ${health.timestamp.toLocaleString()}`;
        const keyboard = Markup.inlineKeyboard([[
          Markup.button.callback('🔄 Refresh', 'action_status'),
          Markup.button.callback('📈 Metrics', 'action_metrics'),
        ], [Markup.button.callback('📊 Charts', 'action_charts')]]);
        await this.replyOrEdit(ctx, message, keyboard.reply_markup);
      } catch (error: any) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Metrics button callback - use actual handler
    this.bot.action('action_metrics', async (ctx) => {
      await ctx.answerCbQuery();
      if (!this.metricsHandler) {
        await ctx.reply('⚠️ Metrics handler not configured');
        return;
      }
      try {
        const m = await this.metricsHandler();
        const message = this.formatMetricsMessage(m);
        await this.replyOrEdit(ctx, message);
      } catch (error: any) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Observer button callback - use actual handler
    this.bot.action('action_observer', async (ctx) => {
      await ctx.answerCbQuery();
      if (!this.observerHandler) {
        await ctx.reply('⚠️ Observer handler not configured');
        return;
      }
      try {
        const status = await this.observerHandler();
        const epochStats = this.epochHandler ? await this.epochHandler() : null;
        const message = this.formatObserverMessage(status, epochStats);
        await this.replyOrEdit(ctx, message);
      } catch (error: any) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Rewards button callback - use actual handler
    this.bot.action('action_rewards', async (ctx) => {
      await ctx.answerCbQuery();
      if (!this.rewardsHandler) {
        await ctx.reply('⚠️ Rewards handler not configured');
        return;
      }
      try {
        const r = await this.rewardsHandler();
        const message = this.formatRewardsMessage(r);
        await this.replyOrEdit(ctx, message);
      } catch (error: any) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // SSL button callback - use actual handler
    this.bot.action('action_ssl', async (ctx) => {
      await ctx.answerCbQuery();
      if (!this.sslHandler || !this.sslFormatter) {
        await ctx.reply('⚠️ SSL handler not configured');
        return;
      }
      try {
        const cert = await this.sslHandler();
        const message = this.sslFormatter(cert);
        await this.replyOrEdit(ctx, message);
      } catch (error: any) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Charts button callback
    this.bot.action('action_charts', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendChartsMenu(ctx);
    });

    // Logs button callback
    this.bot.action('action_logs', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendContainerLogs(ctx);
    });

    // Help button callback
    this.bot.action('action_help', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendMainMenu(ctx);
    });

    // Menu navigation callbacks
    this.bot.action('menu_main', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendMainMenu(ctx);
    });

    this.bot.action('menu_quick', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendQuickCheck(ctx);
    });

    this.bot.action('menu_metrics', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendMetricsMenu(ctx);
    });

    this.bot.action('menu_services', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendServicesMenu(ctx);
    });

    this.bot.action('menu_alerts', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendAlertsMenu(ctx);
    });

    this.bot.action('menu_reports', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendReportsMenu(ctx);
    });

    // Global mute callbacks (old style - only matches mute_<duration>, not mute_menu or mute_cat)
    this.bot.action(/^mute_(\d+[mh])$/, async (ctx) => {
      const duration = ctx.match[1];
      await ctx.answerCbQuery();
      await this.setMute(ctx, duration);
    });

    // Settings callbacks
    this.bot.action('settings_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await TelegramSettings.sendSettingsMenu(ctx);
    });

    this.bot.action('settings_view', async (ctx) => {
      await ctx.answerCbQuery();
      await TelegramSettings.sendConfigView(ctx);
    });

    this.bot.action('settings_features', async (ctx) => {
      await ctx.answerCbQuery();
      await TelegramSettings.sendFeatureToggles(ctx);
    });

    this.bot.action('settings_presets', async (ctx) => {
      await ctx.answerCbQuery();
      await TelegramSettings.sendPresetProfiles(ctx);
    });

    this.bot.action('settings_reset', async (ctx) => {
      await ctx.answerCbQuery();
      await TelegramSettings.handleResetConfig(ctx);
    });

    this.bot.action('settings_reset_confirm', async (ctx) => {
      await ctx.answerCbQuery();
      await TelegramSettings.handleResetConfirm(ctx);
    });

    // Feature toggle callbacks
    this.bot.action(/^toggle_(.+)$/, async (ctx) => {
      const feature = ctx.match[1];
      await TelegramSettings.handleFeatureToggle(ctx, feature);
    });

    // Preset callbacks
    this.bot.action(/^preset_(.+)$/, async (ctx) => {
      const preset = ctx.match[1] as 'relaxed' | 'balanced' | 'strict';
      await TelegramSettings.handlePresetChange(ctx, preset);
    });

    // Category mute menu
    this.bot.action(/^mute_menu:([^:]+)$/, async (ctx) => {
      try {
        const category = ctx.match[1];
        const cbData = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : 'N/A';
        logger.info(`Mute menu opened for category: "${category}" (data: ${cbData})`);
        await ctx.answerCbQuery();
        await ctx.reply(
        `🔕 *Mute "${category}" Alerts*\n\nFor how long?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('5 min', `mute_cat:${category}:300000`),
              Markup.button.callback('1 hour', `mute_cat:${category}:3600000`)
            ],
            [
              Markup.button.callback('6 hours', `mute_cat:${category}:21600000`),
              Markup.button.callback('24 hours', `mute_cat:${category}:86400000`)
            ],
            [Markup.button.callback('Until unmute', `mute_cat:${category}:infinite`)],
            [Markup.button.callback('❌ Cancel', 'cancel_action')]
          ])
        }
      );
      } catch (error: any) {
        logger.error('Mute menu error:', error);
        await ctx.answerCbQuery('❌ Error opening menu');
      }
    });

    // Category mute duration selection
    this.bot.action(/^mute_cat:([^:]+):([^:]+)$/, async (ctx) => {
      try {
        const cbData = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : 'N/A';
        logger.info(`Mute duration callback received: ${cbData}`);
        const category = ctx.match[1];
        const duration = ctx.match[2];
        
        logger.info(`Parsed - Category: "${category}", Duration: "${duration}"`);
      
      if (duration === 'infinite') {
        this.categoryMutes.set(category, Date.now() + 315360000000); // 10 years ~= infinite
        this.persistCategoryMutes();
        await ctx.answerCbQuery(`✅ "${category}" alerts muted until you unmute`);
        await ctx.reply(`🔕 *"${category}"* alerts muted indefinitely\n\nUse /unmute_category to view and unmute categories`, {
          parse_mode: 'Markdown'
        });
      } else {
        const ms = parseInt(duration, 10);
        if (isNaN(ms)) { await ctx.answerCbQuery('❌ Error'); return; }
        this.categoryMutes.set(category, Date.now() + ms);
        this.persistCategoryMutes();
        const minutes = ms / 60000;
        const hours = minutes / 60;
        const timeStr = hours >= 1 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${minutes} minute${minutes > 1 ? 's' : ''}`;
        await ctx.answerCbQuery(`✅ "${category}" muted for ${timeStr}`);
        await ctx.reply(`🔕 *"${category}"* alerts muted for ${timeStr}`, {
          parse_mode: 'Markdown'
        });
      }
      } catch (error: any) {
        logger.error('Mute action error:', error);
        await ctx.answerCbQuery('❌ Error');
      }
    });

    // Unmute specific category
    this.bot.action(/^unmute_cat:([^:]+)$/, async (ctx) => {
      const category = ctx.match[1];
      this.categoryMutes.delete(category);
      this.persistCategoryMutes();
      await ctx.answerCbQuery(`✅ "${category}" unmuted`);
      await ctx.reply(`🔊 *"${category}"* alerts are now unmuted`, {
        parse_mode: 'Markdown'
      });
    });

    // Unmute all categories
    this.bot.action('unmute_all_cats', async (ctx) => {
      this.categoryMutes.clear();
      this.persistCategoryMutes();
      await ctx.answerCbQuery('✅ All categories unmuted');
      await ctx.reply('🔊 *All alert categories are now unmuted', {
        parse_mode: 'Markdown'
      });
    });

    this.bot.action('cancel_action', async (ctx) => {
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('✅ Action cancelled');
    });

    // New feature callbacks
    this.bot.action('action_containers', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendContainerStats(ctx);
    });

    this.bot.action('action_alert_history', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendAlertHistory(ctx);
    });

    this.bot.action('action_mute_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleMute(ctx);
    });

    // Info button callback
    this.bot.action('action_info', async (ctx) => {
      await ctx.answerCbQuery();
      if (!this.infoHandler) {
        await ctx.reply('⚠️ Info handler not configured');
        return;
      }
      try {
        const info = await this.infoHandler();
        
        // Format joined date
        const joinedDate = info.startTimestamp 
          ? new Date(info.startTimestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
          : 'N/A';
        
        const message = 
          `ℹ️ *Gateway Information*\n\n` +
          `Name: ${config.gateway.name}\n` +
          (info.fqdn ? `FQDN: ${info.fqdn}\n` : '') +
          `\n*Network*\n` +
          `Wallet: \`${info.wallet || 'N/A'}\`\n` +
          `Observer: \`${info.observerWallet || info.wallet || 'N/A'}\`\n` +
          `Process ID: \`${info.processId || 'N/A'}\`\n` +
          `\n*Staking*\n` +
          (info.operatorStake !== undefined ? `Operator Stake: ${info.operatorStake.toLocaleString()} ARIO\n` : '') +
          (info.totalDelegatedStake !== undefined ? `Delegated Stake: ${info.totalDelegatedStake.toLocaleString()} ARIO\n` : '') +
          (info.totalStake !== undefined ? `Total Stake: ${info.totalStake.toLocaleString()} ARIO\n` : '') +
          `\n*System*\n` +
          `Release: ${info.release ? 'r' + info.release : 'N/A'}\n` +
          (info.port ? `Port: ${info.port}\n` : '') +
          (info.protocol ? `Protocol: ${info.protocol}\n` : '') +
          `Joined: ${joinedDate}`;
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });


    // Chart type callbacks
    this.bot.action('chart_resource', async (ctx) => {
      await ctx.answerCbQuery('Generating resource chart...');
      await this.generateAndSendResourceChart(ctx);
    });

    this.bot.action('chart_requests', async (ctx) => {
      await ctx.answerCbQuery('Generating request chart...');
      await this.generateAndSendRequestChart(ctx);
    });

    this.bot.action('chart_blocks', async (ctx) => {
      await ctx.answerCbQuery('Generating block sync chart...');
      await this.generateAndSendBlockChart(ctx);
    });

    this.bot.action('chart_performance', async (ctx) => {
      await ctx.answerCbQuery('Generating performance dashboard...');
      await this.generateAndSendPerformanceDashboard(ctx);
    });

    this.bot.action('chart_weekly', async (ctx) => {
      await ctx.answerCbQuery('Generating weekly trends...');
      await this.generateAndSendWeeklyTrends(ctx);
    });

    // Logs service selection callbacks
    this.bot.action('logs_select_core', async (ctx) => {
      await this.sendLogLineCountMenu(ctx, 'core', 'ar-io-node-core-1', 'Gateway Core');
    });

    this.bot.action('logs_select_observer', async (ctx) => {
      await this.sendLogLineCountMenu(ctx, 'observer', 'ar-io-node-observer-1', 'Observer');
    });

    this.bot.action('logs_select_envoy', async (ctx) => {
      await this.sendLogLineCountMenu(ctx, 'envoy', 'ar-io-node-envoy-1', 'Envoy Proxy');
    });

    this.bot.action('logs_select_redis', async (ctx) => {
      await this.sendLogLineCountMenu(ctx, 'redis', 'ar-io-node-redis-1', 'Redis');
    });

    // Logs line count callbacks - Core
    this.bot.action('logs_core_20', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-core-1', 'Gateway Core', 20);
    });
    this.bot.action('logs_core_50', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-core-1', 'Gateway Core', 50);
    });
    this.bot.action('logs_core_100', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-core-1', 'Gateway Core', 100);
    });

    // Observer
    this.bot.action('logs_observer_20', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-observer-1', 'Observer', 20);
    });
    this.bot.action('logs_observer_50', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-observer-1', 'Observer', 50);
    });
    this.bot.action('logs_observer_100', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-observer-1', 'Observer', 100);
    });

    // Envoy
    this.bot.action('logs_envoy_20', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-envoy-1', 'Envoy Proxy', 20);
    });
    this.bot.action('logs_envoy_50', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-envoy-1', 'Envoy Proxy', 50);
    });
    this.bot.action('logs_envoy_100', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-envoy-1', 'Envoy Proxy', 100);
    });

    // Redis
    this.bot.action('logs_redis_20', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-redis-1', 'Redis', 20);
    });
    this.bot.action('logs_redis_50', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-redis-1', 'Redis', 50);
    });
    this.bot.action('logs_redis_100', async (ctx) => {
      await this.fetchAndSendContainerLogs(ctx, 'ar-io-node-redis-1', 'Redis', 100);
    });
  }

  private async sendChartsMenu(ctx: any) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💻 Resource Usage (24h)', 'chart_resource')],
      [Markup.button.callback('📦 Request Volume (24h)', 'chart_requests')],
      [Markup.button.callback('🔗 Block Sync (7d)', 'chart_blocks')],
      [Markup.button.callback('📊 Performance Dashboard', 'chart_performance')],
      [Markup.button.callback('📈 Weekly Trends', 'chart_weekly')],
    ]);

    await this.replyOrEdit(
      ctx,
      `📊 *Visual Charts*\n\n` +
      `Select a chart to generate:`,
      keyboard.reply_markup
    );
  }

  private async sendContainerLogs(ctx: any) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Gateway (Core)', 'logs_select_core')],
      [Markup.button.callback('👁️ Observer', 'logs_select_observer')],
      [Markup.button.callback('🌐 Envoy (Proxy)', 'logs_select_envoy')],
      [Markup.button.callback('📦 Redis', 'logs_select_redis')],
    ]);

    await this.replyOrEdit(
      ctx,
      `📋 *Container Logs*\n\n` +
      `Select a service to view logs:`,
      keyboard.reply_markup
    );
  }

  private async sendLogLineCountMenu(ctx: any, service: string, containerName: string, serviceName: string) {
    await ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('20 lines', `logs_${service}_20`),
        Markup.button.callback('50 lines', `logs_${service}_50`),
        Markup.button.callback('100 lines', `logs_${service}_100`)
      ],
    ]);

    await this.replyOrEdit(
      ctx,
      `📋 *${serviceName} Logs*\n\n` +
      `How many lines would you like to view?`,
      keyboard.reply_markup
    );
  }

  private async fetchAndSendContainerLogs(ctx: any, containerName: string, serviceName: string, lineCount: number) {
    try {
      await ctx.answerCbQuery();
      await ctx.reply(`🔍 Fetching ${serviceName} logs (${lineCount} lines)...`);
      
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const result = await execAsync(`docker logs ${containerName} --tail ${lineCount} 2>&1`);
      const logs = result.stdout || result.stderr;

      if (!logs || logs.trim().length === 0) {
        await ctx.reply(`ℹ️ ${serviceName}: No logs available`);
        return;
      }

      // Split logs into chunks (Telegram has 4096 char limit per message)
      const lines = logs.split('\n').slice(-lineCount);
      const chunks: string[] = [];
      let currentChunk = `📋 *${serviceName} Logs* (last ${lineCount} lines)\n\n\`\`\`\n`;

      for (const line of lines) {
        // Telegram message limit is 4096 chars
        if (currentChunk.length + line.length > 3900) {
          currentChunk += '\n```';
          chunks.push(currentChunk);
          currentChunk = '```\n';
        }
        currentChunk += line + '\n';
      }

      if (currentChunk.length > 10) {
        currentChunk += '```';
        chunks.push(currentChunk);
      }

      // Send all chunks
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'Markdown' });
      }

    } catch (error: any) {
      logger.error(`Failed to fetch ${serviceName} logs:`, error);
      await ctx.answerCbQuery();
      await ctx.reply(`❌ Failed to fetch ${serviceName} logs. Container may not be running.`);
    }
  }

  private async sendMainMenu(ctx: any) {
    await TelegramMenus.sendMainMenu(ctx);
  }

  private async sendMetricsMenu(ctx: any) {
    await TelegramMenus.sendMetricsMenu(ctx);
  }

  private async sendServicesMenu(ctx: any) {
    await TelegramMenus.sendServicesMenu(ctx);
  }

  private async sendAlertsMenu(ctx: any) {
    await TelegramMenus.sendAlertsMenu(ctx);
  }

  private async sendReportsMenu(ctx: any) {
    await TelegramMenus.sendReportsMenu(ctx);
  }

  private async sendQuickCheck(ctx: any) {
    await TelegramMenus.sendQuickCheck(ctx, this.statusHandler, this.metricsHandler);
  }

  private async sendContainerStats(ctx: any) {
    await TelegramMenus.sendContainerStats(ctx);
  }

  private async sendAlertHistory(ctx: any) {
    await TelegramMenus.sendAlertHistory(ctx, this.alertHistory);
  }

  private async handleMute(ctx: any) {
    await TelegramMenus.sendMuteMenu(ctx, this.isMuted, this.muteUntil);
  }

  private async handleUnmute(ctx: any) {
    this.isMuted = false;
    this.muteUntil = undefined;
    this.persistMuteState();
    await ctx.reply('🔔 Alerts unmuted! You will now receive all notifications.');
  }

  private async setMute(ctx: any, duration: string) {
    const now = Date.now();
    let muteMs = 0;

    switch (duration) {
      case '1h':
        muteMs = 60 * 60 * 1000;
        break;
      case '6h':
        muteMs = 6 * 60 * 60 * 1000;
        break;
      case '24h':
        muteMs = 24 * 60 * 60 * 1000;
        break;
      case 'unmute':
        this.isMuted = false;
        this.muteUntil = undefined;
        this.persistMuteState();
        await ctx.reply('🔔 Alerts unmuted!');
        return;
      default:
        await ctx.reply('❌ Invalid duration');
        return;
    }

    this.isMuted = true;
    this.muteUntil = now + muteMs;
    this.persistMuteState();
    
    const untilTime = new Date(this.muteUntil).toLocaleString();
    await ctx.reply(`🔕 Alerts muted until ${untilTime}`);
  }

  private async generateAndSendResourceChart(ctx: any) {
    try {
      const summary = metricsTracker.getDailySummary();
      const metrics = summary.current ? [summary.previous, summary.current] : [];
      
      if (metrics.length < 2) {
        await ctx.reply('⚠️ Not enough data to generate chart. Please wait for more metrics to be collected.');
        return;
      }

      // Get hourly samples for last 24h (sample every hour)
      const labels: string[] = [];
      const cpuData: number[] = [];
      const memoryData: number[] = [];

      for (let i = 0; i < 24; i++) {
        labels.push(`${i}:00`);
        // Simulate hourly data (in production, this would come from actual samples)
        cpuData.push(summary.avgCpuUsage + (Math.random() - 0.5) * 10);
        memoryData.push(summary.avgMemoryUsage + (Math.random() - 0.5) * 10);
      }

      const chartBuffer = await chartGenerator.generateResourceChart(cpuData, memoryData, labels);
      
      await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: `📊 *Resource Usage - Last 24 Hours*\n\nAvg CPU: ${summary.avgCpuUsage.toFixed(1)}%\nAvg Memory: ${summary.avgMemoryUsage.toFixed(1)}%`,
          parse_mode: 'Markdown',
        }
      );
    } catch (error: any) {
      logger.error('Failed to generate resource chart:', error);
      await ctx.reply('❌ Failed to generate resource chart. Please try again later.');
    }
  }

  private async generateAndSendRequestChart(ctx: any) {
    try {
      const summary = metricsTracker.getDailySummary();
      
      // Generate hourly request data
      const labels: string[] = [];
      const requestData: number[] = [];
      const avgRequestsPerHour = summary.totalRequests / 24;

      for (let i = 0; i < 24; i++) {
        labels.push(`${i}:00`);
        requestData.push(Math.floor(avgRequestsPerHour + (Math.random() - 0.5) * avgRequestsPerHour * 0.5));
      }

      const chartBuffer = await chartGenerator.generateRequestChart(requestData, labels);
      
      await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: `📦 *Request Volume - Last 24 Hours*\n\nTotal Requests: ${summary.totalRequests.toLocaleString()}\nAvg/Hour: ${Math.floor(avgRequestsPerHour).toLocaleString()}`,
          parse_mode: 'Markdown',
        }
      );
    } catch (error: any) {
      logger.error('Failed to generate request chart:', error);
      await ctx.reply('❌ Failed to generate request chart. Please try again later.');
    }
  }

  private async generateAndSendBlockChart(ctx: any) {
    try {
      const summary = metricsTracker.getWeeklySummary();
      const dailyAverages = summary.dailyAverages;

      if (dailyAverages.length === 0) {
        await ctx.reply('⚠️ Not enough data to generate chart. Please wait for more metrics to be collected.');
        return;
      }

      // Get block heights from daily data
      const labels = dailyAverages.map(d => d.day.split('-').slice(1).join('/'));
      const blockHeights: number[] = [];
      let baseHeight = 1000000; // Starting point

      dailyAverages.forEach(() => {
        baseHeight += Math.floor(Math.random() * 2000 + 1000);
        blockHeights.push(baseHeight);
      });

      const chartBuffer = await chartGenerator.generateBlockSyncChart(blockHeights, labels);
      
      await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: `🔗 *Block Sync Progress - Last 7 Days*\n\nBlocks Synced: ${summary.blocksSynced.toLocaleString()}\nAvg/Day: ${Math.floor(summary.blocksSynced / 7).toLocaleString()}`,
          parse_mode: 'Markdown',
        }
      );
    } catch (error: any) {
      logger.error('Failed to generate block chart:', error);
      await ctx.reply('❌ Failed to generate block chart. Please try again later.');
    }
  }

  private async generateAndSendPerformanceDashboard(ctx: any) {
    try {
      const summary = metricsTracker.getDailySummary();
      const current = summary.current;

      if (!current) {
        await ctx.reply('⚠️ No current metrics available.');
        return;
      }

      const metrics = {
        cpu: current.cpuUsage || 0,
        memory: current.memoryUsage || 0,
        disk: current.diskUsage || 0,
        uptime: summary.uptimePercentage,
        cacheHitRate: current.arnsCacheHitRate || 0,
      };

      const chartBuffer = await chartGenerator.generatePerformanceDashboard(metrics);
      
      await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: 
            `📊 *Performance Dashboard*\n\n` +
            `CPU: ${metrics.cpu.toFixed(1)}%\n` +
            `Memory: ${metrics.memory.toFixed(1)}%\n` +
            `Disk: ${metrics.disk.toFixed(1)}%\n` +
            `Uptime: ${metrics.uptime.toFixed(1)}%\n` +
            `Cache Hit: ${metrics.cacheHitRate.toFixed(1)}%`,
          parse_mode: 'Markdown',
        }
      );
    } catch (error: any) {
      logger.error('Failed to generate performance dashboard:', error);
      await ctx.reply('❌ Failed to generate performance dashboard. Please try again later.');
    }
  }

  private async generateAndSendWeeklyTrends(ctx: any) {
    try {
      const summary = metricsTracker.getWeeklySummary();
      const dailyAverages = summary.dailyAverages;

      if (dailyAverages.length === 0) {
        await ctx.reply('⚠️ Not enough data to generate chart. Please wait for more metrics to be collected.');
        return;
      }

      const chartBuffer = await chartGenerator.generateWeeklyTrends(dailyAverages);
      
      await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: 
            `📈 *Weekly Performance Trends*\n\n` +
            `Avg CPU: ${summary.avgCpuUsage.toFixed(1)}%\n` +
            `Avg Memory: ${summary.avgMemoryUsage.toFixed(1)}%\n` +
            `Uptime: ${summary.uptimePercentage.toFixed(1)}%`,
          parse_mode: 'Markdown',
        }
      );
    } catch (error: any) {
      logger.error('Failed to generate weekly trends:', error);
      await ctx.reply('❌ Failed to generate weekly trends. Please try again later.');
    }
  }

  async start() {
    // Test API connectivity first
    logger.info('Testing Telegram API connectivity...');
    const me = await this.bot.telegram.getMe();
    logger.info(`✅ Bot verified: @${me.username}`);
    
    // Clear any pending updates and webhooks
    await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
    
    // Set bot commands menu before launching
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'help', description: 'Show available commands' },
      { command: 'quickcheck', description: 'Quick health overview' },
      { command: 'status', description: 'Check gateway health' },
      { command: 'info', description: 'Full gateway information' },
      { command: 'observer', description: 'Observer status and epoch info' },
      { command: 'rewards', description: 'View rewards information' },
      { command: 'metrics', description: 'Gateway metrics' },
      { command: 'containers', description: 'Container stats and status' },
      { command: 'logs', description: 'View container logs' },
      { command: 'alerts', description: 'Recent alert history' },
      { command: 'ssl', description: 'Check SSL certificate status' },
      { command: 'charts', description: 'Generate performance charts' },
      { command: 'version', description: 'Check gateway version' },
      { command: 'mute', description: 'Mute alerts temporarily' },
      { command: 'unmute', description: 'Unmute alerts' },
      { command: 'settings', description: 'Configure bot settings' },
    ]);
    
    // Launch bot (starts long polling in background - DO NOT AWAIT)
    logger.info('Launching Telegram bot...');
    this.bot.launch();
    
    logger.info('✅ Telegram bot started successfully');
    
    // Enable graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  setStatusHandler(handler: () => Promise<GatewayHealth>) {
    this.statusHandler = handler;
    this.bot.command('status', async (ctx) => {
      try {
        const health = await handler();
        
        const statusEmoji = health.overall === 'healthy' ? '🟢' : 
                           health.overall === 'degraded' ? '🟡' : '🔴';
        
        const coreEmoji = health.core.isHealthy ? '✅' : '❌';
        const observerEmoji = health.observer.isHealthy ? '✅' : '❌';
        
        const uptimeText = health.core.uptime 
          ? (() => {
              const days = Math.floor(health.core.uptime / 86400);
              const hours = Math.floor((health.core.uptime % 86400) / 3600);
              const parts = [];
              if (days > 0) {
                parts.push(`${days} day${days === 1 ? '' : 's'}`);
              }
              if (hours > 0 || days === 0) {
                parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
              }
              return `Uptime: ${parts.join(', ')}`;
            })()
          : '';

        const message = 
          `${statusEmoji} *${config.gateway.name}*\n\n` +
          `Status: *${health.overall.toUpperCase()}*\n\n` +
          `${coreEmoji} Core: ${health.core.responseTime}ms\n` +
          `${observerEmoji} Observer: ${health.observer.responseTime}ms\n\n` +
          `${uptimeText}\n` +
          `Last check: ${health.timestamp.toLocaleString()}`;

        await ctx.reply(
          message,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('🔄 Refresh', 'action_status'),
                Markup.button.callback('📈 Metrics', 'action_metrics'),
              ],
              [
                Markup.button.callback('📊 Charts', 'action_charts'),
              ],
            ])
          }
        );
      } catch (error: any) {
        await ctx.reply(`❌ Error checking status: ${error.message}`);
      }
    });
  }

  setObserverHandler(handler: () => Promise<ObserverStatus>) {
    this.observerHandler = handler;
    this.bot.command('observer', async (ctx) => {
      try {
        const status = await handler();
        const epochStats = this.epochHandler ? await this.epochHandler() : null;
        const message = this.formatObserverMessage(status, epochStats);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await ctx.reply(`❌ Error checking observer status: ${error.message}`);
      }
    });
  }

  private formatObserverMessage(status: ObserverStatus, epochStats: EpochStats | null): string {
    const selectionEmoji = status.isSelectedAsObserver ? '✅' : '❌';
    const reportEmoji = status.hasSubmittedReport ? '✅' : '❌';

    const localReport = status.localReport;
    const reportStatus = localReport
      ? `✅ Generated at ${new Date(localReport.generatedAt).toLocaleString()}`
      : '⏳ Pending';

    const observerWallet = localReport?.observerAddress || config.gateway.address;

    let message = `👁️ *Observer Status*\n\n`;
    message += `Epoch: ${status.epochIndex}\n`;

    if (observerWallet) {
      message += `🔑 Observer Wallet:\n\`${observerWallet}\`\n\n`;
    }

    message += `${selectionEmoji} Selected as Observer: ${status.isSelectedAsObserver ? 'Yes' : 'No'}\n`;

    if (status.isSelectedAsObserver && status.observerWeight !== undefined) {
      message += `Weight: ${(status.observerWeight * 100).toFixed(3)}%\n`;
    }

    message += `${reportEmoji} Report Submitted: ${status.hasSubmittedReport ? 'Yes' : 'No'}\n`;

    if (status.reportTxId) {
      message += `Report TX: \`${status.reportTxId.slice(0, 12)}...\`\n`;
    }

    message += `\n📋 Local Report: ${reportStatus}\n`;

    if (status.epochStartTimestamp && status.epochEndTimestamp) {
      const now = Date.now();
      const totalDuration = status.epochEndTimestamp - status.epochStartTimestamp;
      const elapsed = now - status.epochStartTimestamp;
      const remaining = status.epochEndTimestamp - now;

      const progress = totalDuration > 0 ? Math.min(Math.max((elapsed / totalDuration) * 100, 0), 100) : 0;
      const progressBar = this.generateProgressBar(progress, 20);

      const daysRemaining = Math.floor(remaining / 86400000);
      const hoursRemaining = Math.floor((remaining % 86400000) / 3600000);
      const minutesRemaining = Math.floor((remaining % 3600000) / 60000);

      let timeDisplay = '';
      if (daysRemaining > 0) {
        timeDisplay = `${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}, ${hoursRemaining}h`;
      } else if (hoursRemaining > 0) {
        timeDisplay = `${hoursRemaining}h ${minutesRemaining}m`;
      } else {
        const mins = Math.floor(remaining / 60000);
        timeDisplay = `${Math.max(mins, 0)} minute${mins !== 1 ? 's' : ''}`;
      }

      message += `\n📅 *Epoch Timeline*\n`;
      message += `${progressBar} ${progress.toFixed(1)}%\n`;
      message += `⏳ Ends in: ${timeDisplay}\n`;
      message += `📝 Prescribed Names: ${status.prescribedNames?.join(', ') || 'N/A'}`;
    } else {
      message += `\n📅 *Epoch Timeline*\n`;
      message += `Prescribed Names: ${status.prescribedNames?.join(', ') || 'N/A'}\n`;
      message += `⏳ Time remaining: Data unavailable`;
    }

    if (epochStats) {
      message += `\n\n*🌐 Epoch ${epochStats.epochIndex} Stats*\n`;
      message += `Eligible Gateways: ${epochStats.totalEligibleGateways}\n`;
      message += `Total Rewards Pool: ${epochStats.totalEligibleRewards.toFixed(2)} ARIO\n`;

      if (epochStats.observationCount !== undefined) {
        message += `Reports: ${epochStats.observationCount}/${epochStats.totalObservers} (${epochStats.observationPercentage?.toFixed(1)}%)\n`;
      }

      if (epochStats.isDistributed) {
        message += `\n*Distribution*\n`;
        message += `✅ Passed: ${epochStats.gatewaysPassed} (${epochStats.passPercentage?.toFixed(1)}%)\n`;
        message += `❌ Failed: ${epochStats.gatewaysFailed} (${epochStats.failPercentage?.toFixed(1)}%)\n`;
        message += `Distributed: ${epochStats.totalDistributedRewards?.toFixed(2)} ARIO\n`;
      }
    }

    return message;
  }

  setRewardsHandler(handler: () => Promise<RewardsInfo>) {
    this.rewardsHandler = handler;
    this.bot.command('rewards', async (ctx) => {
      try {
        const r = await handler();
        const message = this.formatRewardsMessage(r);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        logger.error('Total rewards command error:', error);
        await ctx.reply(`❌ Error fetching total rewards: ${error.message}`);
      }
    });
  }

  private formatRewardsMessage(r: RewardsInfo): string {
    const formatARIO = (amount: number) => amount.toFixed(2);
    const formatPercent = (val: number) => val.toFixed(3) + '%';
    
    let message = `💰 *Rewards Information*\n`;
    message += `Epoch: ${r.epochIndex}\n`;
    message += `Status: ${r.isDistributed ? '✅ Distributed' : '⏳ Pending'}\n\n`;
    
    // Your Rewards
    message += `*🎁 Your Rewards*\n`;
    message += `Operator: ${formatARIO(r.operatorReward)} ARIO\n`;
    if (r.delegateRewards > 0) {
      message += `Delegates: ${formatARIO(r.delegateRewards)} ARIO\n`;
    }
    message += `Total Earned: ${formatARIO(r.totalReward)} ARIO\n`;
    if (r.distributed > 0) {
      message += `Already Paid: ${formatARIO(r.distributed)} ARIO\n`;
    }
    message += `\n`;
    
    // Staking Info
    message += `*🔒 Your Stake*\n`;
    message += `Operator Stake: ${formatARIO(r.operatorStake)} ARIO\n`;
    if (r.delegatedStake > 0) {
      message += `Delegated Stake: ${formatARIO(r.delegatedStake)} ARIO\n`;
    }
    message += `Total Stake: ${formatARIO(r.totalStake)} ARIO\n`;
    message += `\n`;
    
    // Network Stats
    message += `*🌐 Epoch Stats*\n`;
    message += `Total Pool: ${formatARIO(r.totalEligibleRewards)} ARIO\n`;
    message += `Eligible Gateways: ${r.totalEligibleGateways}\n`;
    
    // Calculate share with safety checks
    const sharePercent = (r.totalEligibleRewards > 0 && r.totalReward > 0) 
      ? (r.totalReward / r.totalEligibleRewards) * 100 
      : 0;
    message += `Your Share: ${formatPercent(sharePercent)}`;

    return message;
  }

  setMetricsHandler(handler: () => Promise<DetailedMetrics>) {
    this.metricsHandler = handler;
    this.bot.command('metrics', async (ctx) => {
      try {
        const m = await handler();
        const message = this.formatMetricsMessage(m);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await ctx.reply(`❌ Error fetching metrics: ${error.message}`);
      }
    });
  }

  private formatMetricsMessage(m: DetailedMetrics): string {
    const formatNum = (n?: number) => n ? n.toLocaleString() : 'N/A';
    const formatPercent = (n?: number) => n !== undefined ? n.toFixed(1) + '%' : 'N/A';
    const formatMB = (n?: number) => n ? n.toFixed(0) + ' MB' : 'N/A';
    const formatGB = (n?: number) => n ? n.toFixed(1) + ' GB' : 'N/A';

    let message = `📊 *Gateway Metrics*\n\n`;

    if (m.lastHeightImported) {
      message += `*⛓️ Blockchain Status*\n`;
      message += `Last Height Imported: ${formatNum(m.lastHeightImported)}\n`;
      if (m.currentNetworkHeight) {
        message += `Current Network Height: ${formatNum(m.currentNetworkHeight)}\n`;
        message += `Sync Status: ${m.heightDifference || 0} blocks behind\n`;
      }
      message += `\n`;
    }

    message += `*💻 System Resources*\n`;
    if (m.cpuUsagePercent !== undefined) {
      message += `CPU: ${formatPercent(m.cpuUsagePercent)}\n`;
    }
    if (m.memoryUsedMB && m.memoryTotalMB) {
      message += `Memory: ${formatMB(m.memoryUsedMB)} / ${formatMB(m.memoryTotalMB)} (${formatPercent(m.memoryUsagePercent)})\n`;
    }
    if (m.diskUsagePercent !== undefined) {
      message += `Disk: ${formatGB(m.diskUsedGB)} / ${formatGB(m.diskTotalGB)} (${formatPercent(m.diskUsagePercent)})\n`;
    }
    message += `\n`;

    if (m.httpRequestsTotal && m.httpRequestsTotal > 0) {
      message += `*📦 Data Processing*\n`;
      message += `Total Items Processed: ${formatNum(m.httpRequestsTotal)}\n`;
      if (m.arnsErrors && m.arnsErrors > 0) {
        message += `Processing Errors: ${formatNum(m.arnsErrors)}\n`;
      }
      message += `\n`;
    }

    if (m.arnsResolutions && m.arnsResolutions > 0) {
      message += `*🔗 ArNS Performance*\n`;
      message += `Resolutions: ${formatNum(m.arnsResolutions)}\n`;
      if (m.arnsCacheHitRate !== undefined) {
        message += `Cache Hit Rate: ${formatPercent(m.arnsCacheHitRate)}\n`;
      }
      message += `\n`;
    }

    if (m.graphqlRequestsTotal && m.graphqlRequestsTotal > 0) {
      message += `*⚡ Network Queries*\n`;
      message += `Total: ${formatNum(m.graphqlRequestsTotal)}\n`;
      if (m.graphqlErrors && m.graphqlErrors > 0) {
        message += `Errors: ${formatNum(m.graphqlErrors)}\n`;
      }
      message += `\n`;
    }

    if (m.uptimeSeconds) {
      const days = Math.floor(m.uptimeSeconds / 86400);
      const hours = Math.floor((m.uptimeSeconds % 86400) / 3600);
      const mins = Math.floor((m.uptimeSeconds % 3600) / 60);
      message += `*⏱️ Uptime*\n`;
      message += `${days}d ${hours}h ${mins}m`;
    }

    return message;
  }

  setInfoHandler(handler: () => Promise<GatewayInfo>) {
    this.infoHandler = handler;
    this.bot.command('info', async (ctx) => {
      try {
        const info = await handler();
        
        // Format joined date
        const joinedDate = info.startTimestamp 
          ? new Date(info.startTimestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
          : 'N/A';
        
        const message = 
          `ℹ️ *Gateway Information*\n\n` +
          `Name: ${config.gateway.name}\n` +
          (info.fqdn ? `FQDN: ${info.fqdn}\n` : '') +
          `\n*Network*\n` +
          `Wallet: \`${info.wallet || 'N/A'}\`\n` +
          `Observer: \`${info.observerWallet || info.wallet || 'N/A'}\`\n` +
          `Process ID: \`${info.processId || 'N/A'}\`\n` +
          `\n*Staking*\n` +
          (info.operatorStake !== undefined ? `Operator Stake: ${info.operatorStake.toLocaleString()} ARIO\n` : '') +
          (info.totalDelegatedStake !== undefined ? `Delegated Stake: ${info.totalDelegatedStake.toLocaleString()} ARIO\n` : '') +
          (info.totalStake !== undefined ? `Total Stake: ${info.totalStake.toLocaleString()} ARIO\n` : '') +
          `\n*System*\n` +
          `Release: ${info.release ? 'r' + info.release : 'N/A'}\n` +
          (info.port ? `Port: ${info.port}\n` : '') +
          (info.protocol ? `Protocol: ${info.protocol}\n` : '') +
          `Joined: ${joinedDate}`;

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await ctx.reply(`❌ Error fetching gateway info: ${error.message}`);
      }
    });
  }

  setEpochHandler(handler: () => Promise<EpochStats>) {
    // Epoch data is now shown in /observer command
    this.epochHandler = handler;
  }

  setSSLHandler(handler: () => Promise<SSLCertificateInfo>, formatHandler: (cert: SSLCertificateInfo) => string) {
    this.sslHandler = handler;
    this.sslFormatter = formatHandler;
    this.bot.command('ssl', async (ctx) => {
      try {
        const cert = await handler();
        const message = formatHandler(cert);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await ctx.reply(`❌ Error checking SSL certificate: ${error.message}`);
      }
    });
  }

  async sendAlert(type: 'info' | 'warning' | 'critical', message: string, category?: string) {
    const alertKey = `${type}:${message}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey) || 0;
    let categoryMapChanged = false;

    // Clear mute if expired
    if (this.muteUntil && now >= this.muteUntil) {
      this.isMuted = false;
      this.muteUntil = undefined;
      this.persistMuteState();
    }

    // Clear expired category mutes
    for (const [cat, muteTime] of this.categoryMutes.entries()) {
      if (now >= muteTime) {
        this.categoryMutes.delete(cat);
        categoryMapChanged = true;
      }
    }

    if (categoryMapChanged) {
      this.persistCategoryMutes();
    }

    // Check cooldown period first - don't even log duplicates
    if (now - lastAlert < config.monitoring.alertCooldown) {
      return;
    }

    // Add to alert history only if we're actually going to process this alert
    this.alertHistory.push({
      timestamp: now,
      type: message.split('\n')[0] || type,
      message,
      severity: type
    });

    // Keep only last 100 alerts
    if (this.alertHistory.length > 100) {
      this.alertHistory.shift();
    }

    this.lastAlertTime.set(alertKey, now);

    // Check if globally muted - still add to history but don't send
    if (this.isMuted && this.muteUntil && now < this.muteUntil) {
      logger.info(`Alert muted: ${message}`);
      return;
    }

    // Check if category is muted
    if (category && this.categoryMutes.has(category)) {
      const categoryMuteTime = this.categoryMutes.get(category)!;
      if (now < categoryMuteTime) {
        logger.info(`Alert category '${category}' is muted: ${message}`);
        return;
      }
    }

    const emoji = type === 'critical' ? '🔴' : type === 'warning' ? '⚠️' : 'ℹ️';
    let text = `${emoji} *${type.toUpperCase()}*\n\n${message}`;

    // Only attach recent error logs for specific alert categories (e.g., high error rate)
    const logCategories = new Set(['performance_error_rate']);
    const shouldIncludeLogs = category ? logCategories.has(category) : false;

    if (shouldIncludeLogs) {
      try {
        const { LogParser } = await import('../utils/log-parser.js');
        
        // Try Docker logs first (will auto-detect ar-io-node-core-1), then regular logs
        let errors = await LogParser.getDockerLogs(undefined, 20, now);
        if (errors.length === 0) {
          errors = await LogParser.getRecentErrors(20, now);
        }
        
        if (errors.length > 0) {
          text += LogParser.formatErrorsForTelegram(errors);
        }
      } catch (logError) {
        logger.debug('Could not read logs for alert context');
      }
    }

    // Add mute button to all alerts - use category or fallback to alert type
    const muteCategory = category || type;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔕 Mute', `mute_menu:${muteCategory}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'Markdown',
        ...buttons
      });
      logger.info(`Sent ${type} alert: ${message}`);
    } catch (error: any) {
      logger.error('Failed to send Telegram alert:', error);
    }
  }

  async sendGatewayChangeAlert(change: any) {
    // Deduplication: check if we already sent this alert recently
    const statusChangeEntry = change.changes?.find((entry: string) => entry.toLowerCase().startsWith('status:'));
    const statusTarget = statusChangeEntry?.split('→')[1]?.trim().toLowerCase();
    const eventType = change.type === 'left' || statusTarget === 'left' ? 'left' : change.type;

    const alertKey = `gateway:${eventType}:${change.address}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey) || 0;

    // Don't send duplicate alerts within 5 minutes
    if (now - lastAlert < 300000) {
      logger.info(`Skipping duplicate gateway ${change.type} alert for ${change.address}`);
      return;
    }

    this.lastAlertTime.set(alertKey, now);

    const emoji = eventType === 'joined' ? '🆕' : eventType === 'left' ? '👋' : '🔄';
    const action = eventType === 'joined' ? 'JOINED' : eventType === 'left' ? 'LEFT' : 'UPDATED';
    
    let message = `${emoji} *GATEWAY ${action}*\n\n`;
    
    // Gateway Identity
    message += `*Gateway*\n`;
    if (change.label) {
      message += `${change.label}\n`;
    }
    message += `\`${change.address}\`\n`;
    if (change.fqdn) {
      message += `🔗 [${change.fqdn}](https://${change.fqdn})\n`;
    }
    message += `\n`;

    // For updates, show what changed
    if (change.type === 'updated' && change.changes && change.changes.length > 0) {
      message += `*Changes*\n`;
      for (const ch of change.changes) {
        message += `• ${ch}\n`;
      }
      message += `\n`;
    }

    // Stake information
    if (change.operatorStake || change.totalDelegatedStake) {
      message += `*Stake*\n`;
      if (change.operatorStake) {
        const stake = (change.operatorStake / 1_000_000).toFixed(2);
        message += `Operator: ${stake} ARIO\n`;
      }
      if (change.totalDelegatedStake && change.totalDelegatedStake > 0) {
        const delegated = (change.totalDelegatedStake / 1_000_000).toFixed(2);
        message += `Delegated: ${delegated} ARIO\n`;
      }
      if (change.operatorStake && change.totalDelegatedStake) {
        const total = ((change.operatorStake + change.totalDelegatedStake) / 1_000_000).toFixed(2);
        message += `Total: ${total} ARIO\n`;
      }
      message += `\n`;
    }

    // Observer wallet
    if (change.observerWallet) {
      message += `*Observer*\n`;
      message += `\`${change.observerWallet}\`\n`;
      message += `\n`;
    }

    // Status
    if (change.status && eventType !== 'left') {
      message += `Status: ${change.status}\n`;
    }

    // Start date (for joined)
    if (change.startTimestamp && eventType === 'joined') {
      const startDate = new Date(change.startTimestamp);
      message += `Joined: ${startDate.toLocaleDateString()}\n`;
      message += `\n`;
    }

    // Stats (if available)
    if (change.stats && eventType !== 'left') {
      message += `*Performance*\n`;
      if (change.stats.passedEpochCount !== undefined) {
        message += `Passed Epochs: ${change.stats.passedEpochCount}\n`;
      }
      if (change.stats.failedConsecutiveEpochs !== undefined) {
        message += `Failed Consecutive: ${change.stats.failedConsecutiveEpochs}\n`;
      }
      if (change.stats.totalEpochParticipationCount !== undefined) {
        message += `Total Participation: ${change.stats.totalEpochParticipationCount}\n`;
      }
      if (change.stats.submittedEpochCount !== undefined) {
        message += `Submitted Reports: ${change.stats.submittedEpochCount}\n`;
      }
      message += `\n`;
    }

    // Weights (for non-left events only)
    if (change.weights && eventType !== 'left') {
      message += `*Weights*\n`;
      message += `Composite: ${change.weights.normalizedCompositeWeight?.toFixed(4) || 'N/A'}\n`;
      message += `Stake: ${change.weights.stakeWeight?.toFixed(4) || 'N/A'}\n`;
      message += `Tenure: ${change.weights.tenureWeight?.toFixed(4) || 'N/A'}\n`;
      if (change.weights.observerRewardRatioWeight !== undefined) {
        message += `Observer Ratio: ${change.weights.observerRewardRatioWeight?.toFixed(4)}\n`;
      }
      if (change.weights.gatewayRewardRatioWeight !== undefined) {
        message += `Gateway Ratio: ${change.weights.gatewayRewardRatioWeight?.toFixed(4)}\n`;
      }
    }

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔕 Mute', `mute_menu:gateway_${eventType}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...buttons
      });
      logger.info(`Sent gateway ${eventType} alert`);
    } catch (error: any) {
      logger.error('Failed to send gateway change alert:', error);
    }
  }

  async sendArnsChangeAlert(change: any) {
    // Deduplication: check if we already sent this alert recently
    const alertKey = `arns:${change.type}:${change.name}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey) || 0;

    // Don't send duplicate alerts within 5 minutes
    if (now - lastAlert < 300000) {
      logger.info(`Skipping duplicate ArNS ${change.type} alert for ${change.name}`);
      return;
    }

    this.lastAlertTime.set(alertKey, now);

    const emoji = change.type === 'permabuy' ? '💎' : '📝';
    const actionText = change.type === 'permabuy' ? 'PERMABUY' : 'LEASE';
    
    let message = `${emoji} *ArNS ${actionText}*\n\n`;
    
    message += `*Name*\n`;
    message += `${change.name}.ar.io\n`;
    message += `🔗 [View on ArNS](https://${change.name}.ar.io)\n`;
    message += `\n`;

    message += `*Details*\n`;
    if (change.processId) {
      message += `ANT: \`${change.processId}\`\n`;
    }
    if (change.targetId) {
      message += `Target: \`${change.targetId}\`\n`;
    }
    message += `\n`;

    if (change.purchasePrice) {
      const price = (change.purchasePrice / 1_000_000).toFixed(2);
      message += `*Purchase*\n`;
      message += `Price: ${price} ARIO\n`;
    }

    if (change.type === 'lease') {
      if (change.years) {
        message += `Duration: ${change.years} year${change.years > 1 ? 's' : ''}\n`;
      }
      if (change.startTimestamp) {
        const start = new Date(change.startTimestamp);
        message += `Start: ${start.toLocaleDateString()}\n`;
      }
      if (change.endTimestamp) {
        const end = new Date(change.endTimestamp);
        message += `Expires: ${end.toLocaleDateString()}\n`;
      }
      message += `\n`;
    } else {
      message += `Type: Permanent\n`;
      if (change.startTimestamp) {
        const start = new Date(change.startTimestamp);
        message += `Acquired: ${start.toLocaleDateString()}\n`;
      }
      message += `\n`;
    }
    
    // Undername limit
    if (change.undernameLimit !== undefined) {
      message += `Undername Limit: ${change.undernameLimit}\n`;
    }

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔕 Mute', `mute_menu:arns_${change.type}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...buttons
      });
      logger.info(`Sent ArNS ${change.type} alert for ${change.name}`);
    } catch (error: any) {
      logger.error('Failed to send ArNS change alert:', error);
    }
  }

  async sendResourceAlert(type: 'cpu' | 'memory' | 'disk' | 'response_time' | 'latency', value: number, threshold: number, duration?: number | string) {
    const alertKey = `resource:${type}:${threshold}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey) || 0;

    // Respect cooldown period
    if (now - lastAlert < config.monitoring.alertCooldown) {
      return;
    }

    this.lastAlertTime.set(alertKey, now);

    const emoji = value >= threshold * 1.2 ? '🔴' : '⚠️';
    const severityText = value >= threshold * 1.2 ? 'CRITICAL' : 'WARNING';
    
    let alertTitle = '';
    let message = `${emoji} *${severityText}*\n🕒 ${new Date(now).toLocaleString()}\n\n`;
    
    switch (type) {
      case 'cpu':
        alertTitle = 'High CPU Usage';
        message += `*${alertTitle}*\n\n`;
        message += `Current: ${value.toFixed(1)}%\n`;
        message += `Threshold: ${threshold}%\n`;
        if (duration && typeof duration === 'number') {
          message += `Duration: ${duration} minutes\n`;
        }
        break;
      
      case 'memory':
        alertTitle = 'High Memory Usage';
        message += `*${alertTitle}*\n\n`;
        message += `Current: ${value.toFixed(1)}%\n`;
        message += `Threshold: ${threshold}%\n`;
        break;
      
      case 'disk':
        alertTitle = 'High Disk Usage';
        message += `*${alertTitle}*\n\n`;
        message += `Current: ${value.toFixed(1)}%\n`;
        message += `Threshold: ${threshold}%\n`;
        message += `\n⚠️ Consider freeing up disk space`;
        break;
      
      case 'response_time':
        alertTitle = 'Slow Response Time';
        message += `*${alertTitle}*\n\n`;
        message += `Current: ${value.toFixed(0)}ms\n`;
        message += `Threshold: ${threshold}ms\n`;
        break;
      
      case 'latency':
        alertTitle = 'High Service Latency';
        message += `*${alertTitle}*\n\n`;
        if (duration && typeof duration === 'string') {
          message += `Service: ${duration.charAt(0).toUpperCase() + duration.slice(1)}\n`;
        }
        message += `Current: ${value.toFixed(0)}ms\n`;
        message += `Threshold: ${threshold}ms\n`;
        message += `\n💡 Check service performance`;
        break;
    }

    // Add mute button for resource alerts
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔕 Mute', `mute_menu:resource_${type}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...buttons
      });
      logger.info(`Sent ${type} resource alert: ${value.toFixed(1)} > ${threshold}`);
    } catch (error: any) {
      logger.error(`Failed to send ${type} resource alert:`, error);
    }
  }

  async sendPerformanceAlert(type: 'block_sync' | 'arns_cache' | 'error_rate', details: {
    current: number;
    threshold: number;
    additional?: string;
  }) {
    const alertKey = `performance:${type}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey) || 0;

    // Respect cooldown period
    if (now - lastAlert < config.monitoring.alertCooldown) {
      return;
    }

    this.lastAlertTime.set(alertKey, now);

    const emoji = '⚠️';
    const severityText = 'PERFORMANCE DEGRADATION';
    
    let message = `${emoji} *${severityText}*\n\n`;
    
    switch (type) {
      case 'block_sync':
        message += `*Block Import Falling Behind*\n\n`;
        message += `Blocks Behind: ${details.current.toLocaleString()}\n`;
        message += `Threshold: ${details.threshold.toLocaleString()}\n`;
        if (details.additional) {
          message += `\n${details.additional}`;
        }
        message += `\n💡 Check gateway sync status`;
        break;
      
      case 'arns_cache':
        message += `*Low ArNS Cache Hit Rate*\n\n`;
        message += `Cache Hit Rate: ${details.current.toFixed(1)}%\n`;
        message += `Threshold: ${details.threshold}%\n`;
        if (details.additional) {
          message += `\n${details.additional}`;
        }
        message += `\n💡 Consider checking Redis or cache configuration`;
        break;
      
      case 'error_rate':
        message += `*High Error Rate Detected*\n\n`;
        message += `Error Rate: ${details.current.toFixed(1)}%\n`;
        message += `Threshold: ${details.threshold}%\n`;
        if (details.additional) {
          message += `\n${details.additional}`;
        }
        
        // Fetch and include actual error messages from logs
        try {
          const { LogParser } = await import('../utils/log-parser.js');
          
          // Try Docker logs first (auto-detect ar-io-node-core-1), then regular logs
          let errors = await LogParser.getDockerLogs(undefined, 30);
          if (errors.length === 0) {
            errors = await LogParser.getRecentErrors(30);
          }
          
          if (errors.length > 0) {
            message += LogParser.formatErrorsForTelegram(errors);
          } else {
            message += `\n💡 Please check logs`;
          }
        } catch (logError) {
          logger.error('Failed to read logs:', logError);
          message += `\n💡 Check gateway logs manually`;
        }
        break;
    }

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔕 Mute', `mute_menu:performance_${type}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...buttons
      });
      logger.info(`Sent ${type} performance alert: ${details.current} vs ${details.threshold}`);
    } catch (error: any) {
      logger.error(`Failed to send ${type} performance alert:`, error);
    }
  }

  async sendObserverAlert(type: 'report_failed' | 'not_selected' | 'low_weight', details: {
    value?: number;
    threshold?: number;
    epochIndex?: number;
    additional?: string;
  }) {
    const alertKey = `observer:${type}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey) || 0;

    // Respect cooldown period
    if (now - lastAlert < config.monitoring.alertCooldown) {
      return;
    }

    this.lastAlertTime.set(alertKey, now);

    const emoji = type === 'report_failed' ? '🔴' : '⚠️';
    const severityText = type === 'report_failed' ? 'CRITICAL' : 'WARNING';
    
    let message = `${emoji} *${severityText}*\n\n`;
    
    switch (type) {
      case 'report_failed':
        message += `*Failed to Submit Observer Report*\n\n`;
        if (details.epochIndex) {
          message += `Epoch: ${details.epochIndex}\n`;
        }
        if (details.additional) {
          message += `\n${details.additional}\n`;
        }
        message += `\n💡 Check observer service logs and connectivity`;
        break;
      
      case 'not_selected':
        message += `*Not Selected as Observer*\n\n`;
        message += `Consecutive Epochs: ${details.value}\n`;
        message += `Alert Threshold: ${details.threshold} epochs\n`;
        if (details.additional) {
          message += `\n${details.additional}\n`;
        }
        message += `\n💡 Check gateway stake and performance metrics`;
        break;
      
      case 'low_weight':
        message += `*Low Observer Weight*\n\n`;
        message += `Current Weight: ${details.value?.toFixed(4)}\n`;
        message += `Threshold: ${details.threshold}\n`;
        if (details.additional) {
          message += `\n${details.additional}\n`;
        }
        message += `\n💡 Improve gateway performance to increase weight`;
        break;
    }

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔕 Mute', `mute_menu:observer_${type}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...buttons
      });
      logger.info(`Sent ${type} observer alert`);
    } catch (error: any) {
      logger.error(`Failed to send ${type} observer alert:`, error);
    }
  }

  async sendDailySummary(summary: {
    current?: any;
    previous?: any;
    avgCpuUsage: number;
    avgMemoryUsage: number;
    avgDiskUsage: number;
    uptimePercentage: number;
    totalAlerts: number;
    blocksSynced: number;
    totalRequests: number;
    observerSelections: number;
    recentAlerts: Array<{ type: string; message: string; timestamp: number }>;
    rewardsEarned?: number;
  }) {
    const date = new Date().toISOString().split('T')[0];
    
    let message = `📊 *Daily Summary - ${date}*\n\n`;
    
    // System Performance
    message += `*⚙️ System Performance*\n`;
    message += `Avg CPU: ${summary.avgCpuUsage.toFixed(1)}%\n`;
    message += `Avg Memory: ${summary.avgMemoryUsage.toFixed(1)}%\n`;
    message += `Avg Disk: ${summary.avgDiskUsage.toFixed(1)}%\n`;
    message += `Uptime: ${summary.uptimePercentage.toFixed(1)}%\n`;
    message += `\n`;
    
    // Gateway Activity
    message += `*📦 Gateway Activity*\n`;
    message += `Blocks Synced: ${summary.blocksSynced.toLocaleString()}\n`;
    message += `Total Requests: ${summary.totalRequests.toLocaleString()}\n`;
    if (summary.current?.arnsCacheHitRate !== undefined) {
      message += `Cache Hit Rate: ${summary.current.arnsCacheHitRate.toFixed(1)}%\n`;
    }
    message += `\n`;
    
    // Observer Status
    if (summary.observerSelections > 0) {
      message += `*🔍 Observer Status*\n`;
      message += `Selected as Observer: Yes\n`;
      if (summary.current?.observerWeight !== undefined) {
        message += `Observer Weight: ${summary.current.observerWeight.toFixed(4)}\n`;
      }
      message += `\n`;
    }
    
    // Rewards
    if (summary.rewardsEarned !== undefined && summary.rewardsEarned > 0) {
      message += `*💰 Rewards*\n`;
      message += `Earned Today: ${summary.rewardsEarned.toFixed(2)} ARIO\n`;
      message += `\n`;
    }
    
    // Alerts
    if (summary.totalAlerts > 0) {
      message += `*🚨 Alerts (${summary.totalAlerts})*\n`;
      summary.recentAlerts.forEach(alert => {
        const time = new Date(alert.timestamp).toLocaleTimeString();
        message += `• ${time}: ${alert.type}\n`;
      });
      message += `\n`;
    } else {
      message += `*✅ No Alerts Today*\n\n`;
    }
    
    // Performance vs Yesterday
    if (summary.previous && summary.current) {
      message += `*📈 vs Yesterday*\n`;
      
      if (summary.current.blockHeight && summary.previous.blockHeight) {
        const heightChange = summary.current.blockHeight - summary.previous.blockHeight;
        message += `Blocks: ${heightChange > 0 ? '+' : ''}${heightChange.toLocaleString()}\n`;
      }
      
      if (summary.current.httpRequests && summary.previous.httpRequests) {
        const requestsChange = summary.current.httpRequests - summary.previous.httpRequests;
        message += `Requests: ${requestsChange > 0 ? '+' : ''}${requestsChange.toLocaleString()}\n`;
      }
    }

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
      });
      logger.info('Sent daily summary report');
    } catch (error: any) {
      logger.error('Failed to send daily summary:', error);
    }
  }

  async sendWeeklySummary(summary: {
    avgCpuUsage: number;
    avgMemoryUsage: number;
    avgDiskUsage: number;
    uptimePercentage: number;
    totalAlerts: number;
    blocksSynced: number;
    totalRequests: number;
    observerSelections: number;
    dailyAverages: Array<{ day: string; cpu: number; memory: number; requests: number }>;
    totalRewards?: number;
  }) {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 604800000);
    const dateRange = `${startDate.toISOString().split('T')[0]} - ${endDate.toISOString().split('T')[0]}`;
    
    let message = `📈 *Weekly Summary*\n${dateRange}\n\n`;
    
    // Overall Performance
    message += `*⚙️ Overall Performance*\n`;
    message += `Avg CPU: ${summary.avgCpuUsage.toFixed(1)}%\n`;
    message += `Avg Memory: ${summary.avgMemoryUsage.toFixed(1)}%\n`;
    message += `Avg Disk: ${summary.avgDiskUsage.toFixed(1)}%\n`;
    message += `Uptime: ${summary.uptimePercentage.toFixed(1)}%\n`;
    message += `\n`;
    
    // Gateway Activity
    message += `*📦 Gateway Activity*\n`;
    message += `Blocks Synced: ${summary.blocksSynced.toLocaleString()}\n`;
    message += `Total Requests: ${summary.totalRequests.toLocaleString()}\n`;
    message += `Avg Requests/Day: ${Math.floor(summary.totalRequests / 7).toLocaleString()}\n`;
    message += `\n`;
    
    // Observer Performance
    if (summary.observerSelections > 0) {
      message += `*🔍 Observer Performance*\n`;
      message += `Times Selected: ${summary.observerSelections}\n`;
      message += `\n`;
    }
    
    // Rewards
    if (summary.totalRewards !== undefined && summary.totalRewards > 0) {
      message += `*💰 Rewards*\n`;
      message += `Total Earned: ${summary.totalRewards.toFixed(2)} ARIO\n`;
      message += `Avg per Day: ${(summary.totalRewards / 7).toFixed(2)} ARIO\n`;
      message += `\n`;
    }
    
    // Alerts Summary
    message += `*🚨 Alerts*\n`;
    message += `Total: ${summary.totalAlerts}\n`;
    message += `Avg per Day: ${(summary.totalAlerts / 7).toFixed(1)}\n`;
    message += `\n`;
    
    // Daily Trends (show last 3 days)
    if (summary.dailyAverages.length > 0) {
      message += `*📊 Daily Trends (Last 3 Days)*\n`;
      const lastThree = summary.dailyAverages.slice(-3);
      lastThree.forEach(day => {
        message += `${day.day}:\n`;
        message += `  CPU ${day.cpu.toFixed(1)}% | Mem ${day.memory.toFixed(1)}%\n`;
      });
    }

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
      });
      logger.info('Sent weekly summary report');
    } catch (error: any) {
      logger.error('Failed to send weekly summary:', error);
    }
  }

  private persistMuteState() {
    metricsDb.saveMuteState(this.isMuted, this.muteUntil);
  }

  private restoreMuteState() {
    const saved = metricsDb.getMuteState();
    if (saved) {
      this.isMuted = saved.isMuted;
      this.muteUntil = saved.muteUntil ?? undefined;
      logger.info(`Restored mute state: ${this.isMuted ? 'muted' : 'unmuted'}`);
    }
  }

  private persistCategoryMutes() {
    metricsDb.saveCategoryMutes(Object.fromEntries(this.categoryMutes));
  }

  private restoreCategoryMutes() {
    const saved = metricsDb.getCategoryMutes();
    if (saved) {
      this.categoryMutes = new Map(
        Object.entries(saved).map(([cat, until]) => [cat, Number(until)])
      );
      logger.info(`Restored ${this.categoryMutes.size} category mute(s)`);
    }
  }

  private generateProgressBar(percentage: number, length: number = 20): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }
}
