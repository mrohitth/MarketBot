#!/bin/bash
# Opportunity Scanner — runs every 2 hours, silently logs. Only alerts on critical/high severity.
# Zero token cost — pure market data fetch + logic.
# To be run every 2 hours pre/post market. Log-level alert only; Mathew is not interrupted for medium severity.

cd /home/mathew/MarketBot || exit 1

OUTPUT=$(node dist/lib/opportunity_scanner.js 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "[OPPORTUNITY SCANNER] Error: exit code $EXIT_CODE"
  echo "$OUTPUT"
  exit 1
fi

# If output contains critical/high severity alerts, pipe to Telegram
if echo "$OUTPUT" | grep -q "🚨\|BLACK SWAN\|critical\|🟢.*BUY TARGET"; then
  echo "$OUTPUT"
  # Write to alert log for review
  echo "[OPPORTUNITY SCAN $(date '+%Y-%m-%d %H:%M')] CRITICAL/HIGH ALERT — see output above"
else
  echo "[OPPORTUNITY SCAN $(date '+%Y-%m-%d %H:%M')] Clean — no actionable alerts"
fi