// ═══════════════════════════════════════════════════════════════
// src/prices.js — Yahoo Finance 行情获取（当前价 + 历史收盘价）
// 逻辑与 v1.6 完全一致
// ═══════════════════════════════════════════════════════════════

const PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',
  'https://api.codetabs.com/v1/proxy?quest='
];

// ─── 获取单只股票当前价 ──────────────────────────────────────
export async function fetchPriceSingle(ticker) {
  const yUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`
  ];
  const attempts = [];
  for (const yu of yUrls)
    for (const px of PROXIES)
      attempts.push(px + encodeURIComponent(yu));

  const results = await Promise.allSettled(attempts.map(url =>
    new Promise(async (res, rej) => {
      const ctrl = new AbortController();
      const tmr  = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (!r.ok) throw new Error('!ok');
        const data  = await r.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice
          || (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(Boolean).pop();
        if (price && price > 0) res(price);
        else throw new Error('no price');
      } catch (e) { clearTimeout(tmr); rej(e); }
    })
  ));

  for (const r of results) if (r.status === 'fulfilled') return r.value;
  return null;
}

// ─── 批量获取全部持仓当前价 ──────────────────────────────────
export async function fetchAllPrices(tickers, currentPrices, onProgress) {
  const prices = { ...currentPrices };
  let ok = 0, fail = 0;

  for (let i = 0; i < tickers.length; i += 3) {
    const batch = tickers.slice(i, i + 3);
    await Promise.all(batch.map(async tk => {
      const p = await fetchPriceSingle(tk);
      if (p) { prices[tk] = p; ok++; }
      else fail++;
    }));
    onProgress?.({ ok, fail, total: tickers.length });
    if (i + 3 < tickers.length) await sleep(200);
  }

  return { prices, ok, fail };
}

// ─── 获取单只股票 2 年历史收盘价 ────────────────────────────
export async function fetchHistoricalForTicker(ticker) {
  const yUrl    = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2y`;
  const attempts = PROXIES.map(px => px + encodeURIComponent(yUrl));

  const results = await Promise.allSettled(attempts.map(url =>
    new Promise(async (res, rej) => {
      const ctrl = new AbortController();
      const tmr  = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (!r.ok) throw new Error('!ok');
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
      if (close && close > 0) {
        const d = new Date(ts * 1000).toISOString().split('T')[0];
        hpData[d] = close;
        count++;
      }
    });
    const cp = result.meta?.regularMarketPrice;
    if (cp && cp > 0) {
      const today = new Date().toISOString().split('T')[0];
      hpData[today] = cp;
    }
    return count > 0 ? { hpData, currentPrice: cp || null } : null;
  }
  return null;
}

// ─── 批量获取全部股票历史收盘价 ─────────────────────────────
export async function fetchAllHistorical(tickers, onProgress) {
  const results = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < tickers.length; i += 2) {
    const batch = tickers.slice(i, i + 2);
    await Promise.all(batch.map(async tk => {
      const r = await fetchHistoricalForTicker(tk);
      if (r) { results[tk] = r; ok++; }
      else fail++;
    }));
    onProgress?.({ ok, fail, total: tickers.length });
    if (i + 2 < tickers.length) await sleep(800);
  }

  return { results, ok, fail };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
