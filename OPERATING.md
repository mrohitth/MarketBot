# Capital Pilot — Operating Instructions

_Last updated: 2026-05-03 by Kitty_

---

## Environment Setup

Copy `.env.example` to `.env` and fill in:

```
ALPHA_VANTAGE_API_KEY=[GET_FROM_ALPHAVANTAGE_CO_FREE]
MONTHLY_NET_INCOME=[YOUR_NET_MONTHLY_INCOME]
WHATSAPP_WEBHOOK_SECRET=[FROM_OPENCLAW_CONFIG]
PORTFOLIO_TOTAL=[TOTAL_PORTFOLIO_VALUE_FOR_CASH_CALC]
```

---

## Weekly Discover CSV Upload

Mathew exports Discover transactions weekly. To import:

1. Mathew downloads Discover CSV from Discover.com → Account → Spending → Export CSV
2. Save file to: `MarketBot/data/discover-transactions.csv`
3. Filename must be `discover-transactions.csv`

**Format expected:**
```
Date,Description,Amount,Category
2026-05-01,UBER EATS PIZZA,-45.00,Dining
```

**Automatic import:** Add to cron or run manually:
```bash
npm run import:discover
```

---

## Daily Brief Generation

**Mock data (development):**
```bash
npm run test:daily   # Uses mock data, no API calls
```

**Live data (production):**
```bash
npm run test:live    # Pulls real prices from Alpha Vantage
```

**Schedule:** 8:00 AM EST daily via OpenClaw cron:
```json
{
  "name": "Capital Pilot Daily Brief",
  "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York" },
  "payload": { "kind": "agentTurn", "message": "Run MarketBot: node MarketBot/dist/index.js --live --send" }
}
```

---

## Black Swan Rule (>8% Drop)

When any position drops >8% in a day:

1. **Detection:** `src/lib/market.ts:114` — `if (Math.abs(quote.changePercent) > 8)`
2. **Status:** Position marked as `black-swan` instead of `drifted`
3. **Confirmation Required:** Brief includes `⚠️ REQUIRES [CONFIRMED] REPLY`
4. **Execution:** Only after Mathew replies `[CONFIRMED]` to WhatsApp message

---

## Running Without Alpha Vantage Key

If no Alpha Vantage key, the system gracefully falls back to mock data:
- Logs: `[MARKET] No API key — using mock data`
- Brief will note: `Using mock market data (update .env for live)`

---

## Troubleshooting

**"CSV not found" errors:**
- Verify `data/discover-transactions.csv` exists
- Check `DISCOVER_CSV_PATH` in `.env`

**"No quote data" errors:**
- Alpha Vantage free tier has 25 req/day limit
- If limit hit, system uses mock data
- Wait 1 minute for rate limit reset

**Budget showing 0 spent:**
- CSV might have different column format
- Check `src/lib/budget.ts:parseDiscoverCSV()` column mapping

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator — start here |
| `src/lib/budget.ts` | CSV parsing, budget pacing |
| `src/lib/market.ts` | Alpha Vantage, drift calc |
| `src/lib/profitMaximizer.ts` | Sector scanner |
| `src/lib/brief.ts` | WhatsApp message formatter |
| `src/lib/types.ts` | All interfaces |
| `data/discover-transactions.csv` | Weekly upload |

---

## Testing Workflow

1. **Unit test:** `npm test` (uses mock data)
2. **Full mock brief:** `npm run test:daily`
3. **Live brief:** `npm run test:live` (requires API keys)
4. **Send to WhatsApp:** `node dist/index.js --live --send`