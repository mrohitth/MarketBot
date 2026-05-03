# SPEC.md — The Capital Pilot

**High-Conviction Financial Strategist**  
*Version 1.0 | Draft for Mathew's Approval*

---

## 1. Concept & Vision

The Capital Pilot is an automated financial strategist that bridges daily spending awareness with long-term portfolio growth. It operates on a "high-conviction, low-friction" principle: the agent monitors your finances silently and delivers a single, actionable Morning Brief that eliminates "financial fog" without demanding constant attention.

**Philosophy:** Move from passive saving to optimized, evidence-backed investing. Every dollar has a job; every action has a rationale.

---

## 2. What It Does

### Core Capabilities

1. **Budget Pacing Report (CSV + Gmail Hybrid)**
   - Weekly CSV import from Discover (sourced from `data/discover-transactions.csv`)
   - Real-time Gmail scanning for Discover transaction alerts (service@email.discover.com)
   - Deduplication: CSV takes priority over Gmail (CSV is audited record)
   - Alert thresholds: 80% warning, 100% exceeded

2. **Market Scan**
   - Daily price data for NVDA, SMH, SCHG via Alpha Vantage (FREE tier)
   - Technical indicators: RSI, 20-day MA, 50-day MA, volume spike detection
   - Portfolio drift calculation vs. targets

3. **Morning Brief (Daily by 8:00 AM EST)**
   - Delivered via WhatsApp (via OpenClaw's WhatsApp integration)
   - Sections: Liquidity Snapshot, Overnight Market Shifts, Budget Pacing, Trade Recommendations, Profit Maximizer

4. **Profit Maximizer**
   - Scans top 5 semi/tech sector plays for high-probability setups
   - Based on RSI < 30 (oversold bounce) or breaking 20-day MA with volume
   - All recommendations are "flagged for decision" — no auto-execution

5. **8% Black Swan Rule**
   - If any position drops > 8% in a day → require explicit [CONFIRMED] reply before logging action
   - Prevents panic-driven decisions during volatile market events

### Data Sources

| Source | Purpose | Cost |
|--------|---------|------|
| Alpha Vantage | Market data (NVDA, SMH, SCHG, sector scans) | FREE ($0/mo) |
| Discover CSV | Budget/spending tracking | FREE ($0/mo) |
| Fidelity (manual) | Portfolio positions (future) | N/A |

### Operating Cost Target
**$0/month** — All integrations use free tiers.

---

## 3. Budget Parameters

| Category | Monthly Limit | Alert Threshold |
|----------|--------------|-----------------|
| Dining | $600 | 80% = $480 |
| Housing | $2,800 | 80% = $2,240 |
| Discretionary | $500 | 80% = $400 |
| Savings Rate Target | >30% of net income | N/A |

---

## 4. Portfolio Targets

| Ticker | Target % | Drift Trigger |
|--------|----------|---------------|
| NVDA | 40% | 7% |
| SMH | 30% | 7% |
| SCHG | 20% | 5% |
| Cash | 10% | N/A |

---

## 5. Architecture

```
/MarketBot
├── SPEC.md
├── README.md
├── .env.example                    # ALPHA_VANTAGE_KEY, WHATSAPP_WEBHOOK_SECRET
├── .gitignore
├── src/
│   ├── index.ts                     # Main orchestrator — runs daily via cron
│   ├── lib/
│   │   ├── budget.ts                # CSV parsing, spend tracking, pacing calculation
│   │   ├── market.ts               # Alpha Vantage calls, technicals, drift calculation
│   │   ├── brief.ts                # Morning brief composition (WhatsApp format)
│   │   ├── profitMaximizer.ts      # Sector scan for high-probability setups
│   │   └── types.ts                # Interfaces: Transaction, Position, BriefSection
│   └── scripts/
│       └── import-discover.ts      # Manual CSV import script
├── data/
│   ├── discover-transactions.csv    # Weekly Discover export (gitignored)
│   └── positions.csv               # Current portfolio positions (gitignored)
├── tests/
│   ├── budget.test.ts              # Spend tracking with dummy data
│   ├── market.test.ts              # Drift calculation with mock prices
│   └── brief.test.ts               # Brief composition logic
└── scripts/
    └── daily-brief.ts              # Standalone script for manual testing
```

---

## 6. Tech Stack

- **Runtime:** Node.js with TypeScript
- **APIs:** Alpha Vantage (free tier: 25 req/day) for market data
- **Budget:** CSV parsing (no DB needed)
- **Delivery:** WhatsApp via OpenClaw's WhatsApp webhook integration
- **Scheduler:** `node-cron` or OpenClaw cron (`0 8 * * *` → 8:00 AM EST)
- **Storage:** Local CSV files (no cloud DB)

---

## 7. API Keys Needed

| Key | Source | Purpose |
|-----|--------|---------|
| `ALPHA_VANTAGE_KEY` | alpha-vantage.com (free) | Market data for NVDA, SMH, SCHG |
| `WHATSAPP_WEBHOOK_SECRET` | OpenClaw config | WhatsApp delivery |
| `PORTFOLIO_TOTAL` | Your total portfolio value | For cash % calculation |

---

## 8. Mock Data Test Plan

Before scheduling the daily run, test with **dummy data** to verify:

1. **Budget Pacing:** Create `discover-transactions.csv` with $400 Dining spend, $2,000 Housing, $300 Discretionary. Verify correct % calculated.

2. **Market Drift:** Mock NVDA at $120 (down 5%), SMH at $180 (down 3%), SCHG at $95 (flat). Verify drift calculation triggers only NVDA alert (>4% drift from 40%).

3. **Trade Recommendation:** Mock SCHG below 50-day MA. Verify recommendation format.

4. **Profit Maximizer:** Mock SOXX with RSI=28 and volume spike. Verify it appears in brief.

5. **Black Swan:** Mock NVDA down 9%. Verify it requires [CONFIRMED] reply.

**Test Command:** `npm run test:daily` → generates brief, logs to console, does NOT send WhatsApp.

---

## 9. What I Need From Mathew

Before building, I need clarification on:

1. **Net Income:** What is your monthly net income (post-tax)? Needed to calculate >30% savings rate target.

2. **WhatsApp Setup:** Do you have OpenClaw's WhatsApp integration configured? If not, I can deliver to Telegram or Email as fallback.

3. **Frequency:** Daily is the goal, but would you accept "only on market days" (Mon-Fri)? This saves API calls.

4. **Profit Maximizer Depth:** Should I scan 5 tickers max, or are you comfortable with more (up to 20) given the free tier limits?

---

## 10. Questions for Mathew

1. What is your monthly net income (post-tax)?  
   → Needed to calculate whether you're hitting the >30% savings rate target.

2. WhatsApp integration — is it set up in OpenClaw, or should I use Telegram as fallback?

3. Daily or Market-day-only (Mon-Fri)?  
   → Daily = more data, but uses more Alpha Vantage API calls.

4. Profit Maximizer scan depth: 5 tickers or up to 20?

---

## 11. Delivery Target

| Item | Format | When |
|------|--------|------|
| Morning Brief | WhatsApp text | 8:00 AM EST daily |
| Budget Pacing | Inline table in brief | Included in brief |
| Trade Recommendations | Bulleted list with $ amounts | Included in brief |
| Profit Maximizer | 1-3 ideas max, flagged for decision | Included in brief |
| Black Swan Alerts | `[CONFIRMED]` required | Triggered on >8% drop |

---

## 12. Constraints Compliance

| Constraint | How Met |
|------------|---------|
| Under $5/month | All free tiers, no paid APIs |
| Runs autonomously | Daily cron via OpenClaw |
| Private/data not shared | All data stays local, no LLM training |
| 8% Black Swan rule | Requires explicit confirmation |
| No auto-execution | All actions are "recommendations" |

---

## 13. Files to Create

1. `SPEC.md` (this file)
2. `src/index.ts` — Main orchestrator
3. `src/lib/budget.ts` — CSV parsing + pacing
4. `src/lib/market.ts` — Alpha Vantage + technicals
5. `src/lib/brief.ts` — Brief composition
6. `src/lib/profitMaximizer.ts` — Sector scans
7. `src/lib/types.ts` — Interfaces
8. `tests/dummy-data.ts` — Mock data for testing
9. `.env.example` — Required env vars
10. `README.md` — Setup instructions

---

_Last updated: 2026-05-03 by Kitty_