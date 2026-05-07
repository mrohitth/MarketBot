const yf = require('yahoo-finance2').default;
const q = new yf({ suppressNotices: ['yahooSurvey'] });

async function main() {
  // Sector ETF data
  const tickers = ['SPY','XLK','XLE','XLV','XLF','XLY','XLI','XBI','ARKK'];
  const sectorResults = [];
  for (const t of tickers) {
    try {
      const r = await q.quote(t);
      sectorResults.push({ticker: t, price: r.regularMarketPrice, change: r.regularMarketChangePercent, volume: r.regularMarketVolume});
    } catch(e) {
      sectorResults.push({ticker: t, error: e.message});
    }
  }
  console.log('=== SECTOR ETF DATA ===');
  sectorResults.forEach(r => console.log(JSON.stringify(r)));

  // NVDA fundamentals
  console.log('\n=== NVDA FUNDAMENTALS ===');
  try {
    const nvda = await q.quoteSummary('NVDA', { modules: ['defaultKeyStatistics', 'financialData'] });
    const dk = nvda.defaultKeyStatistics || {};
    const fd = nvda.financialData || {};
    console.log(JSON.stringify({
      marketCap: dk.marketCap?.raw,
      sharesOutstanding: dk.sharesOutstanding?.raw,
      shortPercent: dk.sharesPercentSharesHeldByInstitutions?.raw,
      profitMargins: dk.profitMargins?.raw,
      forwardPE: dk.forwardPE?.raw,
      epsTrailingTwelveMonths: dk.epsTrailingTwelveMonths?.raw,
      epsForward: dk.epsForward?.raw,
      earningsQuarterlyGrowth: fd.earningsGrowth?.raw,
      revenueGrowth: fd.revenueGrowth?.raw,
      targetMeanPrice: fd.targetMeanPrice?.raw,
      numberOfAnalystOpinions: dk.numberOfAnalystOpinions?.raw,
    }, null, 2));
  } catch(e) {
    console.error('NVDA fundamentals error:', e.message);
  }

  // Short squeeze candidates
  console.log('\n=== SHORT SQUEEZE CANDIDATES ===');
  const squeezeTickers = ['ASTS', 'GPRO', 'SPWR', 'CHPT', 'LAZR'];
  for (const t of squeezeTickers) {
    try {
      const r = await q.quote(t);
      console.log(JSON.stringify({ticker: t, price: r.regularMarketPrice, change: r.regularMarketChangePercent.toFixed(2), volume: r.regularMarketVolume, avgVolume: r.averageDailyVolume10Week}));
    } catch(e) {
      console.log(JSON.stringify({ticker: t, error: e.message}));
    }
  }
}

main().catch(console.error);