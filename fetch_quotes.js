const yf = require('yahoo-finance2').default;
const q = new yf({ suppressNotices: ['yahooSurvey'] });

const tickers = ['VTI','NVDA','VOO','QQQ','SMH','SCHG','VXUS','SCHD','SPYD','ASTS','SPY','TLT','GLD','XLE','XLV'];
const sectors = ['SOXX','AMD','TSM','QCOM','AMAT','LRCX','KLAC','MPWR','QRVO'];

async function main() {
  const results = [];
  for (const t of tickers) {
    try {
      const r = await q.quote(t);
      results.push({ticker: t, price: r.regularMarketPrice, change: r.regularMarketChangePercent.toFixed(2)});
    } catch(e) {
      results.push({ticker: t, error: e.message});
    }
  }
  results.forEach(r => console.log(JSON.stringify(r)));
  console.log('TITTY_END');

  const sectorResults = [];
  for (const t of sectors) {
    try {
      const r = await q.quote(t);
      sectorResults.push({ticker: t, price: r.regularMarketPrice, change: r.regularMarketChangePercent.toFixed(2)});
    } catch(e) {
      sectorResults.push({ticker: t, error: e.message});
    }
  }
  sectorResults.forEach(r => console.log(JSON.stringify(r)));
  console.log('SECTOR_END');
}

main();
