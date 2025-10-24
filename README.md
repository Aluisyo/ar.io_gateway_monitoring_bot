# AR.IO Gateway Monitoring Bot

Self-hosted monitoring solution for AR.IO gateway operators. Get instant Telegram alerts for your gateway health, observer status, and epoch rewards.

## 🚀 Features

### Monitoring & Analytics
- **🔍 Service Health** – Continuous checks for Core & Observer endpoints with latency tracking
- **🌐 Network Watch** – Optional monitoring of gateway registry updates and ArNS activity snapshots
- **🧭 ArNS Resolution Guard** – Randomized hourly checks that verify gateway ARNS DNS resolution & headers
- **👁️ Observer Intelligence** – Selection tracking, report submission status, runtime weight analysis
- **💰 Rewards Insight** – Live per-epoch reward breakdowns sourced via the AR.IO SDK

### Alerting & Reporting
- **🔔 Smart Alerts** – Resource, performance, observer, SSL, and epoch change notifications (start/end summaries)
- **🕰️ Alert Cooldowns** – Global & category mute controls plus per-alert cooldown enforcement
- **📅 Daily & Weekly Briefings** – Automated Telegram reports with trend analysis and reward highlights
- **📜 Alert History** – On-demand recap of the most recent alerts directly in Telegram

### Telegram Experience
- **📱 Command & Menu UX** – Rich inline keyboards, quick actions, and guided settings flows
- **⚙️ Runtime Config Editor** – Toggle features, switch alert presets, or reset via `/settings`
- **📈 Visual Dashboards** – On-demand charts for resource usage, traffic, sync progress, and weekly trends
- **🗄️ Container & Log Tools** – Inspect container health or fetch Docker logs without leaving Telegram

### Deployment & Ops
- **🐳 Docker Ready** – Drop-in service for AR.IO stacks or standalone Node.js deployment
- **📦 Metrics Persistence** – Local SQLite storage for historical metrics and alert history
- **⚙️ Flexible Configuration** – Environment variables plus runtime overrides stored in the bot database

## 📋 Prerequisites

- Node.js 18+ (if running without Docker)
- Docker & Docker Compose (recommended)
- Telegram account
- Running AR.IO gateway

## ⚙️ Quick Start

### 1. Get Telegram Credentials

1. Create a Telegram bot:
   - Message [@BotFather](https://t.me/botfather) on Telegram
   - Send `/newbot` and follow the instructions
   - Save the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. Get your Chat ID:
   - Message [@userinfobot](https://t.me/userinfobot) on Telegram
   - It will reply with your chat ID (looks like `123456789`)

### 2. Install

**Option A: Alongside AR.IO Stack (Recommended)**

```bash
# Navigate to your AR.IO directory
cd /path/to/ar-io-node

# Clone the monitoring bot
git clone https://github.com/Aluisyo/ar.io_gateway_monitoring_bot monitoring
cd monitoring

# Configure
cp .env.example .env
nano .env  # Add your Telegram credentials
```

**Option B: Standalone**

```bash
git clone https://github.com/Aluisyo/ar.io_gateway_monitoring_bot
cd ario-monitoring-bot
cp .env.example .env
nano .env  # Configure all settings
```

### 3. Configure

Edit `.env` with your settings:

```env
# Required - Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789

# Required - Gateway identity
GATEWAY_NAME=My AR.IO Gateway
GATEWAY_ADDRESS=your_arweave_wallet_address
GATEWAY_HOST=your.gateway.domain  # needed for ArNS resolution checks

# Optional - Service URLs (auto-detected if co-hosted with AR.IO stack)
GATEWAY_CORE_URL=http://ar-io-core:4000
GATEWAY_OBSERVER_URL=http://ar-io-observer:5050

# Optional - Feature toggles
MONITOR_GATEWAY_REGISTRY=false
MONITOR_ARNS_ACTIVITY=false
MONITOR_ARNS_RESOLUTION=false
```

### 4. Run

**With Docker (Recommended):**

```bash
docker-compose up -d
```

**Without Docker:**

```bash
npm install
npm run build
npm start
```

### 5. Test

Send `/start` to your Telegram bot. Use `/settings` to verify your runtime configuration and ensure feature toggles (including ArNS resolution monitoring) reflect your `.env` defaults.

## 📱 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message plus quick action buttons |
| `/help` | Open the main inline menu |
| `/status` | Core & Observer health summary with response times |
| `/observer` | Observer selection, report status, and current epoch stats |
| `/rewards` | Reward breakdown for the current epoch |
| `/quickcheck` | One-tap overall status + resource snapshot |
| `/alerts` | Recent alert history with mute shortcuts |
| `/charts` | Open chart picker (resource, traffic, sync, weekly) |
| `/logs` | Fetch Docker container logs directly in chat |
| `/containers` | Container health and restart counters |
| `/mute` / `/unmute` | Temporarily silence or re-enable all alerts |
| `/unmute_category` | Manage per-category alert mutes |
| `/settings` | Interactive runtime configuration & feature toggles |
| `/version` | Check your gateway version against the latest release |

### 📊 Interactive Features

**Inline Keyboard Buttons** - Quick actions at your fingertips:
- Status responses include 🔄 Refresh, 📈 Metrics, and 📊 Charts buttons
- Start menu provides quick access to all major functions
- Chart menu offers easy selection of different visualizations

**Visual Charts** - Generate beautiful performance charts on demand:
- **💻 Resource Usage**: CPU and Memory trends over 24 hours
- **📦 Request Volume**: HTTP request distribution across the day
- **🔗 Block Sync Progress**: 7-day block height progression
- **📊 Performance Dashboard**: Current system metrics overview
- **📈 Weekly Trends**: Performance patterns over the week

## 📅 Scheduled Reports

The bot automatically sends comprehensive reports:

### Daily Summary (Default: 09:00)
Sent every 24 hours with:
- **System Performance**: Avg CPU, Memory, Disk usage, and uptime
- **Gateway Activity**: Blocks synced, total requests, cache hit rate
- **Observer Status**: Selection status and observer weight
- **Rewards**: ARIO earned in the current epoch
- **Alerts**: Summary of any alerts triggered
- **Performance vs Yesterday**: Block and request comparisons

### Weekly Report (Default: Monday 09:00)
Sent every 7 days with:
- **Overall Performance**: Weekly averages for CPU, memory, disk, uptime
- **Gateway Activity**: Total blocks synced, requests served, daily averages
- **Observer Performance**: Number of times selected as observer
- **Rewards**: Total ARIO earned for the week
- **Alerts Summary**: Total alerts and daily average
- **Daily Trends**: Performance trends over last 3 days

**Customize Schedule:**
```env
ENABLE_DAILY_SUMMARY=true
DAILY_SUMMARY_TIME=09:00  # 24h format HH:MM

ENABLE_WEEKLY_SUMMARY=true
WEEKLY_SUMMARY_DAY=1  # 0=Sunday, 1=Monday, etc.
WEEKLY_SUMMARY_TIME=09:00
```

## 🔔 Alerts

The bot automatically sends alerts for:

### Service Health
- **🔴 Critical**: Service down (Core or Observer)
- **⚠️ Warning**: Missing observation report (when epoch deadline approaches)
- **ℹ️ Info**: Service recovery, startup notifications

### Resource Alerts (Configurable)
- **🔴 CPU**: High CPU usage sustained for configured duration (default: >80% for 5+ minutes)
- **⚠️ Memory**: High memory usage (default: >90%)
- **⚠️ Disk**: High disk usage (default: >85%)
- **⚠️ Response Time**: Slow gateway response (default: >2000ms)

### Performance Degradation Alerts (Configurable)
- **⚠️ Block Sync**: Gateway falling behind network (default: >100 blocks behind)
- **⚠️ ArNS Cache**: Low cache hit rate affecting performance (default: <50%)
- **⚠️ Error Rate**: High percentage of failed requests (default: >5% error rate)

### Observer Performance Alerts (Configurable)
- **🔴 Report Failed**: Selected as observer but failed to submit report by deadline
- **⚠️ Not Selected**: Not selected as observer for X consecutive epochs (default: 5)
- **⚠️ Low Weight**: Observer weight below threshold affecting selection probability (default: <0.5)
- **ℹ️ Epoch Transitions**: Epoch start/end summaries with observation coverage and distribution stats

### SSL Certificate Alerts
- **⚠️ Warning**: Certificate expiring within 30 days
- **🔴 Critical**: Certificate expiring within 7 days
- **🔴 Critical**: Certificate invalid or unreachable

**Alert Customization:**
Configure thresholds in `.env`:
```env
# Resource Alerts
ALERT_CPU_THRESHOLD=80
ALERT_CPU_DURATION_MINUTES=5
ALERT_MEMORY_THRESHOLD=90
ALERT_DISK_THRESHOLD=85
ALERT_RESPONSE_TIME_THRESHOLD=2000

# Performance Degradation Alerts
ALERT_BLOCK_SYNC_LAG_THRESHOLD=100
ALERT_ARNS_CACHE_HIT_RATE_THRESHOLD=50
ALERT_ERROR_RATE_THRESHOLD=5

# Observer Performance Alerts
ALERT_NOT_SELECTED_EPOCHS_THRESHOLD=5
ALERT_LOW_OBSERVER_WEIGHT_THRESHOLD=0.5
```

All alerts respect cooldown periods (default: 10 minutes) to avoid spam.

### Understanding & Responding to Alerts

**Block Sync Lag Alert**
- **What it means**: Your gateway is falling behind the Arweave network
- **Impact**: Serving outdated data, may affect observer eligibility
- **Response**: 
  - Check gateway logs for sync errors
  - Verify network connectivity
  - Consider increasing resources if consistently behind
  - Note: AR.IO gateways don't need every historical block

**ArNS Cache Hit Rate Alert**
- **What it means**: Low percentage of ArNS resolutions served from cache
- **Impact**: Slower ArNS resolution, more load on gateway
- **Response**:
  - Check Redis service status
  - Verify cache configuration
  - Monitor memory usage
  - Check for cache invalidation issues

**Error Rate Alert**
- **What it means**: High percentage of failed requests
- **Impact**: Poor user experience, potential issues with gateway
- **Response**:
  - Check gateway logs for error patterns
  - Verify all services are running
  - Check disk space and resources
  - Review recent configuration changes

**Report Failed Alert**
- **What it means**: Selected as observer but failed to submit report by epoch deadline
- **Impact**: No rewards for this epoch, affects gateway reputation
- **Response**:
  - Check observer service logs
  - Verify observer service is running
  - Check network connectivity to Arweave
  - Ensure gateway is synced and healthy

**Not Selected as Observer Alert**
- **What it means**: Haven't been selected as observer for multiple consecutive epochs
- **Impact**: Missing out on observer rewards
- **Response**:
  - Check your gateway stake amount
  - Review gateway uptime and performance
  - Compare observer weight with network average
  - Ensure gateway is properly registered
  - Consider increasing stake if competitive

**Low Observer Weight Alert**
- **What it means**: Your observer weight is below threshold
- **Impact**: Lower probability of being selected as observer
- **Response**:
  - Improve gateway performance metrics
  - Maintain high uptime
  - Ensure gateway passes all health checks
  - Keep gateway synced with network
  - Monitor and fix any recurring errors

## 🐳 Docker Deployment

### Add to Existing AR.IO Stack

Add this to your AR.IO `docker-compose.yaml`:

```yaml
services:
  # ... existing AR.IO services ...

  monitoring-bot:
    build: ./monitoring
    container_name: ario-monitoring-bot
    restart: unless-stopped
    env_file:
      - ./monitoring/.env
    volumes:
      - ./monitoring/logs:/app/logs
    networks:
      - ar-io-network
    depends_on:
      - ar-io-core
```

Then run:
```bash
docker-compose up -d monitoring-bot
```

### Standalone Docker

```bash
docker-compose up -d
```

## 🔧 Configuration Options

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | – | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | – | Telegram chat to notify |
| `GATEWAY_NAME` | No | My AR.IO Gateway | Display name for alerts & menus |
| `GATEWAY_ADDRESS` | Yes | – | Gateway wallet address (observer/rewards lookups) |
| `GATEWAY_HOST` | No | – | Public hostname for ArNS resolution checks |
| `GATEWAY_CORE_URL` | No | http://ar-io-core:4000 | Core service URL |
| `GATEWAY_OBSERVER_URL` | No | http://ar-io-observer:5050 | Observer service URL |
| `MONITOR_GATEWAY_REGISTRY` | No | false | Watch registry changes (uses network snapshots) |
| `MONITOR_ARNS_ACTIVITY` | No | false | Track ArNS records for changes |
| `MONITOR_ARNS_RESOLUTION` | No | false | Enable ArNS resolution spot checks |
| `MONITOR_SSL_CERTIFICATE` | No | true | Monitor certificate expiry/validity |
| `HEALTH_CHECK_INTERVAL` | No | 60 | Health check cadence (seconds) |
| `OBSERVER_CHECK_INTERVAL` | No | 300 | Observer polling cadence (seconds) |
| `ALERT_COOLDOWN` | No | 600 | Minimum seconds between identical alerts |
| `NETWORK` | No | mainnet | AR.IO network (mainnet/testnet) |
| `LOG_LEVEL` | No | info | Log verbosity (debug, info, warn, error) |

## 📊 Monitoring Details

### Health Checks
- Monitors Core service (`/ar-io/healthcheck`)
- Monitors Observer service (`/healthcheck`)
- Tracks uptime and response times
- Alerts on service failures

### Prometheus Metrics
- Block height (`last_height_imported`)
- HTTP request counts
- Error rates
- Custom AR.IO metrics

### Observer Monitoring
- Checks if selected as prescribed observer
- Monitors observation report submission
- Tracks observer weight and composite scores
- Alerts when reports are missing

### Rewards Tracking
- Operator rewards per epoch
- Distribution status
- Share of total rewards pool

## 🛠️ Development

```bash
# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Build
npm run build

# Run production build
npm start
```

## 📝 Logs

Logs are stored in the `logs/` directory:
- `combined.log` - All logs
- `error.log` - Error logs only

View logs:
```bash
# Docker
docker logs ario-monitoring-bot -f

# Direct
tail -f logs/combined.log
```

## ❓ Troubleshooting

### Bot not responding
1. Check bot is running: `docker ps` or `ps aux | grep node`
2. Check logs: `docker logs ario-monitoring-bot`
3. Verify Telegram token: `echo $TELEGRAM_BOT_TOKEN`
4. Test bot manually: Send `/start` on Telegram

### Services showing as down
1. Verify URLs are correct: Check `.env` file
2. Test connectivity: `curl http://ar-io-core:4000/ar-io/healthcheck`
3. Check Docker network: `docker network ls`
4. Ensure services are running: `docker ps | grep ar-io`

### Observer monitoring not working
1. Verify gateway address is set: Check `GATEWAY_ADDRESS` in `.env`
2. Check AR.IO SDK connectivity (requires internet)
3. View debug logs: Set `LOG_LEVEL=debug` in `.env`

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

## 📄 License

MIT License - See LICENSE file for details

## 🔗 Links

- [AR.IO Documentation](https://docs.ar.io)
- [AR.IO Node Repository](https://github.com/ar-io/ar-io-node)
- [AR.IO SDK](https://github.com/ar-io/ar-io-sdk)

## 💬 Support

For issues and questions:
- Open a GitHub issue
- Join Discord https://discord.gg/Cze88g29Ue

---
If you love this work, you can buy me a coffee or a Lambo: jVkr55dzNnsjz_hmj0TFvUcG08a5qBqWi28pa_hAwNc

Built with ❤️ for the AR.IO community
