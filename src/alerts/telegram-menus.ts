/**
 * Menu navigation and new features for Telegram bot
 */
import { Markup } from 'telegraf';
import { containerMonitor } from '../monitors/container.js';
import { logger } from '../utils/logger.js';

type InlineKeyboard = ReturnType<typeof Markup.inlineKeyboard>;

async function replyOrEdit(ctx: any, text: string, keyboard?: InlineKeyboard) {
  const options = keyboard ? { parse_mode: 'Markdown', ...keyboard } : { parse_mode: 'Markdown' };

  if (ctx.updateType === 'callback_query' && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error: any) {
      if (error?.description?.includes('message is not modified')) {
        return;
      }
    }
  }

  await ctx.reply(text, options);
}

export async function sendMainMenu(ctx: any) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⚡ Quick Check', 'menu_quick')],
    [
      Markup.button.callback('📊 Metrics', 'menu_metrics'),
      Markup.button.callback('⚙️ Services', 'menu_services')
    ],
    [
      Markup.button.callback('🔔 Alerts', 'menu_alerts'),
      Markup.button.callback('📈 Reports', 'menu_reports')
    ]
  ]);

  await replyOrEdit(
    ctx,
    `📚 *AR.IO Gateway Monitor*\n\n` +
    `Quick access to your gateway:`,
    keyboard
  );
}

export async function sendMetricsMenu(ctx: any) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📈 Current Metrics', 'action_metrics')],
    [Markup.button.callback('💰 Rewards', 'action_rewards')],
    [Markup.button.callback('ℹ️ Gateway Info', 'action_info')],
    [Markup.button.callback('⬅️ Back', 'menu_main')]
  ]);

  await replyOrEdit(ctx, `📊 *Metrics & Data*`, keyboard);
}

export async function sendServicesMenu(ctx: any) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🏥 Health Status', 'action_status')],
    [Markup.button.callback('👁️ Observer', 'action_observer')],
    [Markup.button.callback('🐳 Containers', 'action_containers')],
    [Markup.button.callback('📋 Container Logs', 'action_logs')],
    [Markup.button.callback('🔒 SSL Status', 'action_ssl')],
    [Markup.button.callback('⬅️ Back', 'menu_main')]
  ]);

  await replyOrEdit(ctx, `⚙️ *Services & Containers*`, keyboard);
}

export async function sendAlertsMenu(ctx: any) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📜 Recent Alerts', 'action_alert_history')],
    [Markup.button.callback('🔕 Mute Alerts', 'action_mute_menu')],
    [Markup.button.callback('⬅️ Back', 'menu_main')]
  ]);

  await replyOrEdit(ctx, `🔔 *Alerts & Notifications*`, keyboard);
}

export async function sendReportsMenu(ctx: any) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Performance Charts', 'action_charts')],
    [Markup.button.callback('⬅️ Back', 'menu_main')]
  ]);

  await replyOrEdit(ctx, `📈 *Reports & Charts*`, keyboard);
}

export async function sendQuickCheck(ctx: any, statusHandler: any, metricsHandler: any) {
  try {
    const [health, metrics] = await Promise.all([
      statusHandler ? statusHandler() : null,
      metricsHandler ? metricsHandler() : null
    ]);

    if (!health || !metrics) {
      await ctx.reply('⚠️ Quick check unavailable');
      return;
    }

    const statusEmoji = health.overall === 'healthy' ? '🟢' : 
                       health.overall === 'degraded' ? '🟡' : '🔴';
    
    const cpuEmoji = (metrics.cpuUsagePercent || 0) >= 80 ? '⚠️' : '✅';
    const memEmoji = (metrics.memoryUsagePercent || 0) >= 90 ? '⚠️' : '✅';
    
    const message = 
      `⚡ *Quick Health Check*\n\n` +
      `${statusEmoji} Overall: ${health.overall}\n\n` +
      `*Services*\n` +
      `${health.core.isHealthy ? '✅' : '❌'} Core: ${health.core.isHealthy ? 'Running' : 'Down'}\n` +
      `${health.observer.isHealthy ? '✅' : '❌'} Observer: ${health.observer.isHealthy ? 'Healthy' : 'Down'}\n\n` +
      `*Resources*\n` +
      `${cpuEmoji} CPU: ${(metrics.cpuUsagePercent || 0).toFixed(1)}%\n` +
      `${memEmoji} Memory: ${(metrics.memoryUsagePercent || 0).toFixed(1)}%\n` +
      `✅ Disk: ${(metrics.diskUsagePercent || 0).toFixed(1)}%\n\n` +
      `${statusEmoji} Status: ${health.overall === 'healthy' ? 'All systems operational' : 'Issues detected'}`;

    const keyboard = Markup.inlineKeyboard([[
      Markup.button.callback('🔄 Refresh', 'menu_quick'),
      Markup.button.callback('📊 Details', 'action_status')
    ]]);

    await replyOrEdit(ctx, message, keyboard);
  } catch (error: any) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

export async function sendContainerStats(ctx: any) {
  try {
    const states = await containerMonitor.getContainerStates();
    
    let message = `🐳 *Container Status*\n\n`;
    
    for (const state of states) {
      const emoji = containerMonitor.getServiceEmoji(state.name);
      const serviceName = containerMonitor.getServiceName(state.name);
      const statusEmoji = state.status === 'running' ? '✅' : '❌';
      const uptime = state.status === 'running' 
        ? `${Math.floor(state.uptime / 86400)}d ${Math.floor((state.uptime % 86400) / 3600)}h`
        : 'N/A';
      
      // Determine restart indicator
      let restartIndicator = '🟢';
      if (state.restartCount > 0) {
        restartIndicator = state.restartCount >= 3 ? '🔴' : '🟡';
      }
      
      message += `${emoji} ${serviceName}\n`;
      message += `${statusEmoji} Status: ${state.status}\n`;
      message += `⏱️ Uptime: ${uptime}\n`;
      
      // Only show restart count if greater than 0
      if (state.restartCount > 0) {
        const timeSinceRestart = state.status === 'running' 
          ? `(last: ${Math.floor(state.uptime / 3600)}h ago)`
          : '';
        message += `${restartIndicator} Restarts: ${state.restartCount} ${timeSinceRestart}\n`;
      }
      
      message += `\n`;
    }

    const keyboard = Markup.inlineKeyboard([[
      Markup.button.callback('🔄 Refresh', 'action_containers'),
      Markup.button.callback('📋 Logs', 'action_logs')
    ]]);

    await replyOrEdit(ctx, message, keyboard);
  } catch (error: any) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

export async function sendAlertHistory(ctx: any, alertHistory: any[]) {
  // Get alerts from database for full history
  const { metricsDb } = await import('../utils/metrics-db.js');
  const dbAlerts = metricsDb.getRecentAlerts(50); // Get last 50 from DB
  
  // Combine DB alerts with in-memory alerts (in case DB insert hasn't happened yet)
  const allAlerts = [...dbAlerts.map(a => ({
    timestamp: a.timestamp,
    type: a.type,
    message: a.message,
    severity: a.type.includes('CRITICAL') || a.type.includes('CRASH') ? 'critical' :
              a.type.includes('WARNING') || a.type.includes('HIGH') ? 'warning' : 'info'
  })), ...alertHistory];
  
  // Deduplicate and sort by timestamp
  const uniqueAlerts = Array.from(
    new Map(allAlerts.map(a => [`${a.timestamp}-${a.type}`, a])).values()
  ).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  
  if (uniqueAlerts.length === 0) {
    await ctx.reply('📋 No recent alerts');
    return;
  }

  // Split into chunks to avoid Telegram message limit
  const alertsPerPage = 10;
  const pages: string[] = [];
  
  for (let i = 0; i < Math.min(uniqueAlerts.length, 30); i += alertsPerPage) {
    const pageAlerts = uniqueAlerts.slice(i, i + alertsPerPage);
    let pageMessage = `📋 *Alert History*\nPage ${Math.floor(i / alertsPerPage) + 1}/${Math.ceil(Math.min(uniqueAlerts.length, 30) / alertsPerPage)}\n\n`;
    
    for (const alert of pageAlerts) {
      const emoji = alert.severity === 'critical' ? '🔴' : 
                   alert.severity === 'warning' ? '🟡' : '🟢';
      const timestamp = new Date(alert.timestamp);
      const timeDisplay = timestamp.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      const ago = Math.floor((Date.now() - alert.timestamp) / 60000);
      const agoText = ago < 60 ? `${ago}m` : 
                      ago < 1440 ? `${Math.floor(ago / 60)}h` :
                      `${Math.floor(ago / 1440)}d`;
      
      pageMessage += `${emoji} *${alert.type}*\n`;
      pageMessage += `🕒 ${timeDisplay} (${agoText} ago)\n`;
      
      // Add message details if available and not too long
      if (alert.message) {
        const msgLines = alert.message.split('\n');
        // Show first 3 lines of detail
        const details = msgLines.slice(0, 3).join('\n').substring(0, 200);
        if (details && details !== alert.type) {
          pageMessage += `📝 ${details}`;
          if (msgLines.length > 3 || alert.message.length > 200) {
            pageMessage += '...';
          }
          pageMessage += '\n';
        }
      }
      
      pageMessage += `\n`;
    }
    
    if (uniqueAlerts.length > 30) {
      pageMessage += `\n_Showing 30 of ${uniqueAlerts.length} total alerts_`;
    }
    
    pages.push(pageMessage);
  }

  // Send first page
  await ctx.reply(pages[0], { parse_mode: 'Markdown' });
  
  // Send additional pages if needed
  for (let i = 1; i < pages.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between messages
    await ctx.reply(pages[i], { parse_mode: 'Markdown' });
  }
}

export async function sendMuteMenu(ctx: any, isMuted: boolean, muteUntil?: number) {
  const status = isMuted 
    ? `🔕 Currently: Muted ${muteUntil ? `until ${new Date(muteUntil).toLocaleTimeString()}` : ''}`
    : `✅ Currently: Unmuted`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('1 hour', 'mute_1h'),
      Markup.button.callback('6 hours', 'mute_6h')
    ],
    [
      Markup.button.callback('24 hours', 'mute_24h'),
      Markup.button.callback('🔔 Unmute', 'mute_unmute')
    ],
    [Markup.button.callback('⬅️ Back', 'menu_alerts')]
  ]);

  await replyOrEdit(ctx, `🔕 *Alert Controls*\n\n${status}`, keyboard);
}
