#!/bin/bash
# Budget Update — runs nightly at 11:30 PM ET
# Scans Gmail for Discover transactions, updates budget, logs to daily memory

set -e
cd /home/mathew/MarketBot

# Run budget update via Node.js
OUTPUT=$(node -e "
const { scanGmailForDiscoverAlerts, gmailToTransaction } = require('./dist/lib/gmail');
const { calculateBudgetPacing, formatBudgetPacingForBrief } = require('./dist/lib/budget');
const { BUDGET_LIMITS } = require('./dist/index');
const { MONTHLY_NET_INCOME } = require('./dist/index');

(async () => {
  try {
    const gmail = await scanGmailForDiscoverAlerts(
      process.env.GMAIL_USER,
      process.env.GMAIL_APP_PASSWORD
    );
    const transactions = gmail.map(gmailToTransaction);
    const report = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
    console.log(JSON.stringify(report));
  } catch(e) {
    console.error('BUDGET_ERR:', e.message);
  }
})();
" 2>&1)

if [ $? -eq 0 ] && [ -n "$OUTPUT" ] && [ "$OUTPUT" != "null" ]; then
  DATE=$(TZ=America/New_York date +%Y-%m-%d)
  MEM_FILE="/home/mathew/.openclaw/workspace/memory/${DATE}.md"
  
  # Extract key metrics from JSON
  SPENT=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.totalSpent.toFixed(0))")
  BUDGET=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.totalBudget.toFixed(0))")
  RATE=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.savingsRate.toFixed(1))")
  STATUS=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.status)")
  
  echo "## Budget Update — $(date '+%Y-%m-%d %I:%M %p ET')" >> "$MEM_FILE"
  echo "Spent: \$$SPENT / \$$BUDGET | Savings rate: ${RATE}% | Status: $STATUS" >> "$MEM_FILE"
  echo "✅ Budget updated" >> "$MEM_FILE"
  
  echo "Budget: \$$SPENT / \$$BUDGET | Rate: ${RATE}% | $STATUS"
else
  echo "Budget update failed: $OUTPUT"
  exit 1
fi
