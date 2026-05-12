// ═══════════════════════════════════════════════════════════════
// src/prices.js — Yahoo Finance 行情获取
// v2.1：更多代理、盘前/盘后价格、两阶段并发重试
// ═══════════════════════════════════════════════════════════════

const PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy?quest=',
  'https://proxy.cors.sh/',
  'https://thingproxy.freeboard.io/fetch/',
  'https://cors-anywhere.herokuapp.com/',
];

const yahooUrls = (ticker, range) => [
  `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}&includePrePost=true`,
  `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}&includePrePost=true`,
];

// 从 API 响应提取最新价格：盘前 > 常规 > 盘后 > 最近收盘
function extractBestPrice(data) {
  const meta   = data?.chart?.result?.[0]?.meta;
  const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0];
  if (!meta) return null;
  const state   = (meta.marketState || '').toUpperCase();
  const regular = meta.regularMarketPrice || 0;
  const preMkt  = meta.preMarketPrice     || 0;
  const postMkt = meta.postMarketPrice    || 0;
  if (state === 'PRE'  && preMkt  > 0) return preMkt;
  if ((state === 'POST' || state === 'CLOSED') && postMkt > 0) return postMkt;
  if (regular > 0) return regular;
  const closes = (quotes?.close || []).filter(v => v != null && v > 0);
  return closes.length ? closes[closes.length - 1] : null;
}

// 单只股票当前价（两阶段并发，取最快成功）
export async function fetchPriceSingle(ticker) {
  const allUrls = [];
  for (const base of yahooUrls(ticker, '5d'))
    for (const px of PROXIES)
      allUrls.push(px + encodeURIComponent(base));

  const tryBatch = (batch) => Promise.allSettled(
    batch.map(url => new Promise(async (res, rej) => {
      const ctrl = new AbortController();
      const tmr  = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data  = await r.json();
        const price = extractBestPrice(data);
        const state = data?.chart?.result?.[0]?.meta?.marketState || 'UNKNOWN';
        if (price && price > 0) res({ price, state });
        else throw new Error('no price');
      } catch (e) { clearTimeout(tmr); rej(e); }
    }))
  );

  const half   = Math.ceil(allUrls.length / 2);
  const batch1 = await tryBatch(allUrls.slice(0, half));
  for (const r of batch1) if (r.status === 'fulfilled') return r.value;
  const batch2 = await tryBatch(allUrls.slice(half));
  for (const r of batch2) if (r.status === 'fulfilled') return r.value;
  return null;
}

// 批量获取持仓当前价
export async function fetchAllPrices(tickers, currentPrices, onProgress) {
  const prices = { ...currentPrices };
  const states = {};
  let ok = 0, fail = 0;
  for (let i = 0; i < tickers.length; i += 4) {
    const batch = tickers.slice(i, i + 4);
    await Promise.all(batch.map(async tk => {
      const result = await fetchPriceSingle(tk);
      if (result) { prices[tk] = result.price; states[tk] = result.state; ok++; }
      else fail++;
    }));
    onProgress?.({ ok, fail, total: tickers.length });
    if (i + 4 < tickers.length) await sleep(300);
  }
  return { prices, states, ok, fail };
}

// 单只股票 2 年历史收盘价
export async function fetchHistoricalForTicker(ticker) {
  const allUrls = [];
  for (const base of yahooUrls(ticker, '2y'))
    for (const px of PROXIES.slice(0, 4))
      allUrls.push(px + encodeURIComponent(base));

  const results = await Promise.allSettled(allUrls.map(url =>
    new Promise(async (res, rej) => {
      const ctrl = new AbortController();
      const tmr  = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data   = await r.json();
        const result = data?.chart?.result?.[0];
        if (!result) throw new Error('no result');
        res(result);
      } catch (e) { clearTimeout(tmr); rej(e); }
    })
  ));

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const result     = r.value;
    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];
    const hpData     = {};
    let count = 0;
    timestamps.forEach((ts, i) => {
      const close = closes[i];
      if (close && close > 0) { hpData[new Date(ts * 1000).toISOString().split('T')[0]] = close; count++; }
    });
    const cp = extractBestPrice({ chart: { result: [result] } });
    if (cp && cp > 0) hpData[new Date().toISOString().split('T')[0]] = cp;
    return count > 0 ? { hpData, currentPrice: cp || null } : null;
  }
  return null;
}

// 批量获取全部历史收盘价
export async function fetchAllHistorical(tickers, onProgress) {
  const results = {};
  let ok = 0, fail = 0;
  for (let i = 0; i < tickers.length; i += 2) {
    const batch = tickers.slice(i, i + 2);
    await Promise.all(batch.map(async tk => {
      const r = await fetchHistoricalForTicker(tk);
      if (r) { results[tk] = r; ok++; } else fail++;
    }));
    onProgress?.({ ok, fail, total: tickers.length });
    if (i + 2 < tickers.length) await sleep(800);
  }
  return { results, ok, fail };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── K 线 OHLCV 数据获取 ─────────────────────────────────────
// interval: '1d' | '1wk'    range: '6mo' | '2y' 等
export async function fetchKlineOHLCV(ticker, interval, range) {
  const allUrls = [];
  for (const base of [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`
  ])
    for (const px of PROXIES.slice(0, 4))
      allUrls.push(px + encodeURIComponent(base));

  const results = await Promise.allSettled(allUrls.map(url =>
    new Promise(async (res, rej) => {
      const ctrl = new AbortController();
      const tmr  = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data   = await r.json();
        const result = data?.chart?.result?.[0];
        if (!result?.timestamp?.length) throw new Error('no data');
        const q = result.indicators?.quote?.[0];
        if (!q) throw new Error('no ohlcv');
        res({ timestamps: result.timestamp, ohlcv: q });
      } catch (e) { clearTimeout(tmr); rej(e); }
    })
  ));

  for (const r of results) if (r.status === 'fulfilled') return r.value;
  return null;
}
