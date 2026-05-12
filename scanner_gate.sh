#!/bin/bash
# MarketBot Scanner Gate — Zero-agent scanner runner
# Handles market hours check + scanner execution + no_alert routing
# Called by cron. Outputs to stdout (cron delivers only non-"no_alert" text).

set -e
cd /home/mathew/MarketBot || exit 1

# ── Load Environment ────────────────────────────────────────────────────────
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# ── Market Hours Gate ──────────────────────────────────────────────────────
is_market_open() {
  local DAY=$(TZ=America/New_York date +%u)
  local RAW_TIME=$(TZ=America/New_York date +%H%M)
  # Strip leading zero to avoid octal interpretation (0008 -> 8)
  local TIME=$((10#$RAW_TIME))
  [[ "$DAY" -ge 1 && "$DAY" -le 5 ]] || return 1
  [[ "$TIME" -ge 930 && "$TIME" -lt 1600 ]]
}

if ! is_market_open; then
  echo "no_alert"
  exit 0
fi

# ── Run Scanner + Discovery Pipeline ───────────────────────────────────────
OUTPUT=$(node -e "
const { scanForOpportunities, formatOpportunityAlert } = require('./dist/lib/opportunity_scanner');
(async () => {
  try {
    const opps = await scanForOpportunities();
    const text = formatOpportunityAlert(opps);
    console.log(text || 'no_alert');
  } catch(e) { console.error('SCANNER_ERR:' + e.message); }
})();
" 2>&1)

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "[SCANNER ERROR] exit code $EXIT_CODE"
  echo "$OUTPUT"
  exit 1
fi

echo "$OUTPUT"

# ── Memory Log ─────────────────────────────────────────────────────────
# Only log if there's an actual alert (not no_alert)
if [ "$OUTPUT" != "no_alert" ]; then
  MEM_FILE="/home/mathew/.openclaw/workspace/memory/$(TZ=America/New_York date +%Y-%m-%d).md"
  echo "- [x] [K] MarketBot scanner — delivered" >> "$MEM_FILE"
fi
# If output is exactly "no_alert", cron stays silent (no Telegram ping)
# Otherwise, the full scanner output is delivered
