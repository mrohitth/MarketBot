const yf = require('yahoo-finance2').default;
const q = new yf({ suppressNotices: ['yahooSurvey'] });

const tickers = ['SPY','XLK','XLE','XLV','XLF','XLY','XLI','XBI','ARKK'];
Promise.all(tickers.map(t => 
  q.quote(t).then(r => ({ticker: t, price: r.regularMarketPrice, change: r.regularMarketChangePercent, volume: r.regularMarketVolume}))).catch(e => ({ticker: t, error: e.message}))
)).then(results => { results.forEach(r => console.log(JSON.stringify(r))); });