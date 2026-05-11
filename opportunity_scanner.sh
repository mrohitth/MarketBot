#!/bin/bash
# Opportunity Scanner — runs every 30 min, silently logs. Only alerts on critical/high severity during market hours.
# Zero token cost — pure market data fetch + logic.
# Market hours check: Mon-Fri 9:30 AM - 4:00 PM ET. Outside hours: scan runs but no Telegram ping.

cd /home/mathew/MarketBot || exit 1

# ── Market Hours Gate ──────────────────────────────────────────────────────────
is_market_open() {
  # TZ prefix inside $(...) only affects the date command, not the variable assignment
  local day time
  day=$(TZ=America/New_York date +%u)    # 1=Mon … 7=Sun
  time_raw=$(TZ=America/New_York date +%H%M)
  time=$((10#$time_raw))  # strip leading zero (0008 -> 8)

  # Weekend → closed
  [[ "$day" -ge 1 && "$day" -le 5 ]] || return 1

  # 9:30 AM–4:00 PM ET → open
  [[ "$time" -ge 930 && "$time" -lt 1600 ]]
}

# ── Run Scanner ────────────────────────────────────────────────────────────────
OUTPUT=$(node dist/lib/opportunity_scanner.js 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "[OPPORTUNITY SCANNER] Error: exit code $EXIT_CODE"
  echo "$OUTPUT"
  exit 1
fi

# ── Alert Routing ──────────────────────────────────────────────────────────────
if echo "$OUTPUT" | grep -q "🚨\|BLACK SWAN\|critical\|🟢.*BUY TARGET"; then
  if is_market_open; then
    echo "[OPPORTUNITY SCAN $(date '+%Y-%m-%d %H:%M')] MARKET OPEN — CRITICAL/HIGH ALERT:"
    echo "$OUTPUT"
    echo "[OPPORTUNITY SCAN $(date '+%Y-%m-%d %H:%M')] ALERT DELIVERED"
  else
    echo "[OPPORTUNITY SCAN $(date '+%Y-%m-%d %H:%M')] MARKET CLOSED — alert suppressed (scanner ran, logged):"
    echo "$OUTPUT"
  fi
else
  echo "[OPPORTUNITY SCAN $(date '+%Y-%m-%d %H:%M')] Clean — no actionable alerts"
fi