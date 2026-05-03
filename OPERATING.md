# Capital Pilot — Operating Instructions

_Last updated: 2026-05-03 by Kitty_

---

## Environment Setup

Copy `.env.example` to `.env` and fill in:

```
ALPHA_VANTAGE_API_KEY=[GET_FROM_ALPHAVANTAGE_CO_FREE]
MONTHLY_NET_INCOME=8500
PORTFOLIO_TOTAL=850000
GMAIL_USER=mathew.rohit.thomson@gmail.com
GMAIL_APP_PASSWORD=[GMAIL_APP_PASSWORD_FOR_IMAP]
# Telegram delivery handled automatically by OpenClaw cron announce
DISCOVER_CSV_PATH=./data/discover-transactions.csv
```

**Gmail App Password:** Create at Google Account → Security → 2-Step Verification → App Passwords. Required for IMAP access to scan Fidelity trade confirmation emails.

---

## Portfolio Baseline (from Fidelity Email Extraction — 2026-05-03)

The following holdings were discovered from Fidelity trade confirmation emails. Share counts must be entered manually from the Fidelity account dashboard.

| Ticker | Name | Avg Cost | Current Price | Trades |
|--------|------|----------|---------------|--------|
| NVDA | NVIDIA Corporation | ~$203 | $198.45 | 3 trades (Apr 8, 2026) |
| SMH | VanEck Semiconductor ETF | ~$494 | $509.82 | 1 trade (Apr 8, 2026) |
| SCHG | Schwab US Large-Cap Growth ETF | ~$30 | $33.14 | 5 trades (Apr 8, 2026) |
| QQQ | Invesco QQQ Trust | ~$597 | $674.15 | 4 trades (Apr 8, 2026) |
| SCHD | Schwab Dividend Equity ETF | ~$31 | $31.86 | 5 trades (Apr 8, 2026) |
| VXUS | Vanguard Total International Stock ETF | ~$78 | $82.97 | 5 trades (Apr 8, 2026) |
| VOOG | Vanguard S&P 500 Growth ETF | ~$425 | $78.46 | 2 trades (Apr 8, 2026) |

**Target allocation:** NVDA 40%, SMH 30%, SCHG 20%, CASH 10%

**Brokerage account:** Fidelity Investments (Account XXXXX8015)

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

**Schedule:** 8:00 AM EST daily via OpenClaw cron.

---

## Black Swan Rule (>8% Drop)

When any position drops >8% in a day:

1. **Detection:** `src/lib/market.ts:114` — `if (Math.abs(quote.changePercent) > 8)`
2. **Status:** Position marked as `black-swan` instead of `drifted`
3. **Confirmation Required:** Brief includes `⚠️ REQUIRES [CONFIRMED] REPLY`
4. **Execution:** Only after Mathew replies `[CONFIRMED]` to WhatsApp message

---

## Running Without Alpha Vantage Key / Telegram Setup

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
| `src/lib/fidelity.ts` | Gmail/Fidelity email scanner for trade confirmation context |
| `src/lib/profitMaximizer.ts` | Sector scanner |
| `src/lib/brief.ts` | Telegram message formatter |
| `src/lib/types.ts` | All interfaces |
| `data/portfolio.json` | Static portfolio positions with costs (share counts must be entered) |
| `data/portfolio-context.md` | Full portfolio baseline from email extraction |
| `data/discover-transactions.csv` | Weekly Discover CSV upload |

---

## Testing Workflow

1. **Unit test:** `npm test` (uses mock data)
2. **Full mock brief:** `npm run test:daily`
3. **Live brief:** `npm run test:live` (requires API keys)
4. **Delivery:** Via OpenClaw cron announce to Telegram (telegram:5607383477) — no manual send flag needed