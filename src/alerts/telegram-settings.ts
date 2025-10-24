import { Markup } from 'telegraf';
import { runtimeConfig } from '../utils/runtime-config.js';

export async function sendSettingsMenu(ctx: any) {
  await ctx.reply(
    `⚙️ *Settings*\n\n` +
    `Configure your monitoring bot:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Current Config', 'settings_view')],
        [
          Markup.button.callback('🎚️ Feature Toggles', 'settings_features'),
          Markup.button.callback('📈 Preset Profiles', 'settings_presets')
        ],
        [Markup.button.callback('🔄 Reset to Defaults', 'settings_reset')],
        [Markup.button.callback('« Back to Main Menu', 'menu_main')]
      ])
    }
  );
}

export async function sendConfigView(ctx: any) {
  const configText = runtimeConfig.formatForDisplay();
  
  await ctx.reply(configText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Settings', 'settings_menu')]
    ])
  });
}

export async function sendFeatureToggles(ctx: any) {
  const cfg = runtimeConfig.getAll();
  
  await ctx.reply(
    `🎚️ *Feature Toggles*\n\n` +
    `Enable or disable features:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `${cfg.monitorGatewayRegistry ? '✅' : '❌'} Gateway Registry`,
            'toggle_gateway_registry'
          )
        ],
        [
          Markup.button.callback(
            `${cfg.monitorArnsActivity ? '✅' : '❌'} ArNS Activity`,
            'toggle_arns_activity'
          )
        ],
        [
          Markup.button.callback(
            `${cfg.monitorArnsResolution ? '✅' : '❌'} ArNS Resolution`,
            'toggle_arns_resolution'
          )
        ],
        [
          Markup.button.callback(
            `${cfg.monitorSslCertificate ? '✅' : '❌'} SSL Monitoring`,
            'toggle_ssl_monitoring'
          )
        ],
        [
          Markup.button.callback(
            `${cfg.enableDailySummary ? '✅' : '❌'} Daily Reports`,
            'toggle_daily_reports'
          )
        ],
        [
          Markup.button.callback(
            `${cfg.enableWeeklySummary ? '✅' : '❌'} Weekly Reports`,
            'toggle_weekly_reports'
          )
        ],
        [Markup.button.callback('« Back to Settings', 'settings_menu')]
      ])
    }
  );
}

export async function sendPresetProfiles(ctx: any) {
  const currentPreset = runtimeConfig.getPreset();
  
  await ctx.reply(
    `📈 *Preset Profiles*\n\n` +
    `Current: *${currentPreset.toUpperCase()}*\n\n` +
    
    `🟢 *RELAXED*\n` +
    `• Higher alert thresholds\n` +
    `• Fewer alerts, less sensitive\n` +
    `• Best for: Stable gateways\n\n` +
    
    `🟡 *BALANCED* (Default)\n` +
    `• Moderate alert thresholds\n` +
    `• Good balance of monitoring\n` +
    `• Best for: Most gateways\n\n` +
    
    `🔴 *STRICT*\n` +
    `• Lower alert thresholds\n` +
    `• More alerts, very sensitive\n` +
    `• Best for: Critical production\n\n` +
    
    `Select a profile:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `${currentPreset === 'relaxed' ? '✅' : '🟢'} Relaxed`,
            'preset_relaxed'
          ),
          Markup.button.callback(
            `${currentPreset === 'balanced' ? '✅' : '🟡'} Balanced`,
            'preset_balanced'
          ),
          Markup.button.callback(
            `${currentPreset === 'strict' ? '✅' : '🔴'} Strict`,
            'preset_strict'
          )
        ],
        [Markup.button.callback('« Back to Settings', 'settings_menu')]
      ])
    }
  );
}

export async function handleFeatureToggle(ctx: any, feature: string) {
  const featureMap: Record<string, keyof any> = {
    gateway_registry: 'monitorGatewayRegistry',
    arns_activity: 'monitorArnsActivity',
    arns_resolution: 'monitorArnsResolution',
    ssl_monitoring: 'monitorSslCertificate',
    daily_reports: 'enableDailySummary',
    weekly_reports: 'enableWeeklySummary',
  };

  const configKey = featureMap[feature];
  if (configKey) {
    const newValue = runtimeConfig.toggle(configKey as any);
    const featureName = feature.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    await ctx.answerCbQuery(`${featureName}: ${newValue ? 'Enabled ✅' : 'Disabled ❌'}`);
    await sendFeatureToggles(ctx);
  }
}

export async function handlePresetChange(ctx: any, preset: 'relaxed' | 'balanced' | 'strict') {
  runtimeConfig.setPreset(preset);
  
  const emoji = preset === 'relaxed' ? '🟢' : preset === 'balanced' ? '🟡' : '🔴';
  await ctx.answerCbQuery(`${emoji} ${preset.toUpperCase()} profile applied!`);
  await sendPresetProfiles(ctx);
}

export async function handleResetConfig(ctx: any) {
  await ctx.reply(
    `⚠️ *Reset Configuration*\n\n` +
    `This will reset all settings to defaults.\n` +
    `Are you sure?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Reset', 'settings_reset_confirm'),
          Markup.button.callback('❌ Cancel', 'settings_menu')
        ]
      ])
    }
  );
}

export async function handleResetConfirm(ctx: any) {
  runtimeConfig.reset();
  
  await ctx.answerCbQuery('✅ Configuration reset to defaults');
  await ctx.reply(
    `✅ *Configuration Reset*\n\n` +
    `All settings have been restored to default values.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Config', 'settings_view')],
        [Markup.button.callback('« Back to Settings', 'settings_menu')]
      ])
    }
  );
}
