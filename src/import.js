// ═══════════════════════════════════════════════════════════════
// src/import.js — IBKR Flex XML + CSV 导入逻辑
// 与 v1.6 完全一致，模块化提取
// ═══════════════════════════════════════════════════════════════

const PROXY_BASE = 'http://127.0.0.1:3000';

export const TRADE_ACT_SET = new Set([
  'buy','sell','short','short sell','cover','cover short','exercise','assignment',
  'expiration','option exercise','option assignment','fractional share','trade','trades'
]);

// ─── 工具函数 ────────────────────────────────────────────────
export function parseCSVLine(line) {
  const res = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; continue; }
    if (c === ',' && !inQ) { res.push(cur); cur = ''; continue; }
    cur += c;
  }
  res.push(cur);
  return res.map(s => s.trim());
}

export function parseIBKRDate(raw) {
  if (!raw) return null;
  const s = raw.replace(/"/g, '').trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/) || s.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
}

export function parseFlexDateTime(raw) {
  if (!raw) return { date: null, time: '09:30:00' };
  const s  = raw.replace(/"/g, '').trim();
  const m1 = s.match(/^(\d{4})(\d{2})(\d{2})[;,\s]+(\d{2})(\d{2})(\d{2})/);
  if (m1) return { date: `${m1[1]}-${m1[2]}-${m1[3]}`, time: `${m1[4]}:${m1[5]}:${m1[6]}` };
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})[;,\s]+(\d{2}:\d{2}:\d{2})/);
  if (m2) return { date: m2[1], time: m2[2] };
  return { date: parseIBKRDate(s), time: '09:30:00' };
}

export function actToCFType(actCode, desc, amt) {
  const a = (actCode || '').toLowerCase().trim();
  const d = (desc || '').toLowerCase();
  if (TRADE_ACT_SET.has(a)) return null;
  if (a === 'deposit' || a === 'electronic fund transfer' || (/^(deposit|fund.?transfer|wire.?in|incoming|ach.?credit)/i.test(a)) || (!a && (d.includes('deposit') || d.includes('fund transfer')) && amt > 0)) return 'DEP';
  if (a === 'withdrawal' || a === 'disbursement' || (/^(withdraw|disburs|wire.?out|outgoing|ach.?debit)/i.test(a)) || (!a && (d.includes('withdraw') || d.includes('disburs')) && amt < 0)) return 'WTH';
  if (/dividend/i.test(a) || /dividend/i.test(d)) return amt >= 0 ? 'DIV' : 'TAX';
  if (/withhold/i.test(a) || /withhold/i.test(d)) return 'TAX';
  if (/tax/i.test(a) && !/dividend/i.test(d)) return 'TAX';
  if (/interest/i.test(a) || (/interest/i.test(d) && !TRADE_ACT_SET.has(a))) return amt >= 0 ? 'INT' : 'FEE';
  if (/fee|charge|subscription|platform|data/i.test(a)) return 'FEE';
  if (d.includes('fund transfer') || d.includes('wire') || d.includes('ach')) return amt > 0 ? 'DEP' : 'WTH';
  return null;
}

export function mapCFType(typeRaw, desc, amt) {
  const t = (typeRaw || '').toLowerCase();
  const d = (desc || '').toLowerCase();
  if (/deposit|fund transfer|ach credit|wire in|incoming|electronic fund/i.test(t) || (!t && d.includes('deposit') && amt > 0)) return 'DEP';
  if (/withdrawal|withdraw|disburs|wire out|outgoing|ach debit/i.test(t) || (!t && d.includes('withdraw') && amt < 0)) return 'WTH';
  if (/dividend|payment in lieu/i.test(t) || /dividend/i.test(d)) return amt >= 0 ? 'DIV' : 'TAX';
  if (/withhold|tax/i.test(t)) return 'TAX';
  if (/interest/i.test(t)) return amt >= 0 ? 'INT' : 'FEE';
  if (/fee|charge|subscription|platform|data/i.test(t)) return 'FEE';
  if (d.includes('fund transfer') || d.includes('wire')) return amt > 0 ? 'DEP' : 'WTH';
  return null;
}

// ─── 资金流水 CSV 导入 ───────────────────────────────────────
export function parseCFCSV(text, existingHashes) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const newFlows = []; let imp = 0, skip = 0, tradeSkip = 0;
  const hasTransHistory = lines.some(l => l.trimStart().startsWith('Transaction History,'));

  if (hasTransHistory) {
    let hdr = null, hdrL = null, lineNum = 0;
    const gi = (cols, hdrArr, ...keys) => {
      for (const k of keys) {
        const idx = hdrArr.findIndex(h => h.replace(/[\s\/\.\-]/g,'').toLowerCase().includes(k.replace(/[\s\/\.\-]/g,'').toLowerCase()));
        if (idx >= 0 && idx < cols.length) return (cols[idx] || '').trim();
      }
      return '';
    };
    for (const line of lines) {
      lineNum++;
      const cols = parseCSVLine(line);
      if (!cols[0]) continue;
      if (cols[0].trim() !== 'Transaction History') continue;
      const rowType = (cols[1] || '').trim();
      if (rowType === 'Header') { hdr = cols; hdrL = cols.map(h => h.toLowerCase().trim()); continue; }
      if (rowType !== 'Data' || !hdr) continue;
      const dateRaw = gi(cols, hdrL, 'date/time','datetime','date','settledate','settle date');
      const actCode = gi(cols, hdrL, 'activitycode','activity code','activity','type','code');
      const desc    = gi(cols, hdrL, 'description','desc','narrative');
      const ccy     = gi(cols, hdrL, 'currency','ccy').toUpperCase();
      if (ccy && !['','USD','-','BASE CURRENCY SUMMARY'].includes(ccy)) { skip++; continue; }
      const date = parseIBKRDate(dateRaw);
      if (!date) { skip++; continue; }
      if (TRADE_ACT_SET.has(actCode.toLowerCase().trim())) { tradeSkip++; continue; }
      let amtStr = gi(cols, hdrL, 'net cash','netcash','net amount','netamount');
      if (!amtStr || amtStr === '-' || amtStr === '') amtStr = gi(cols, hdrL, 'amount','total');
      if (!amtStr || amtStr === '-' || amtStr === '') { skip++; continue; }
      const amt = parseFloat(amtStr.replace(/,/g, ''));
      if (isNaN(amt) || amt === 0) { skip++; continue; }
      const cfType = actToCFType(actCode, desc, amt);
      if (!cfType) { skip++; continue; }
      const rowHash = `L${lineNum}|${date}|${cfType}|${Math.abs(amt).toFixed(3)}`;
      if (existingHashes.has(rowHash)) { skip++; continue; }
      newFlows.push({
        id: crypto.randomUUID(),
        _h: rowHash, type: cfType, amount: Math.abs(amt),
        date, datetime: `${date} 08:00:00`,
        note: (actCode || desc || '').slice(0, 60), source: 'csv'
      });
      imp++;
    }
  } else {
    const secMap = { 'deposits & withdrawals':'DEPWTH','deposit & withdrawal':'DEPWTH','dividends':'DIV','withholding tax':'TAX','interest':'INT','fees':'FEE','other fees':'FEE' };
    const headers = {}; let lineNum = 0;
    for (const line of lines) {
      lineNum++;
      const cols = parseCSVLine(line); if (!cols[0]) continue;
      const sec = cols[0].toLowerCase().trim(), secType = secMap[sec];
      if (!secType) continue;
      if (cols[1] === 'Header') { headers[sec] = cols; continue; }
      if (cols[1] !== 'Data' || !headers[sec]) continue;
      const hdr = headers[sec], hdrL = hdr.map(h => h.toLowerCase().trim());
      const gi2 = (...names) => { for (const n of names) { const i = hdrL.findIndex(h => h.includes(n)); if (i >= 0) return (cols[i] || '').trim(); } return ''; };
      const dateRaw = gi2('settle date','date');
      const date = parseIBKRDate(dateRaw);
      if (!date) { skip++; continue; }
      const ccy = (gi2('currency','ccy') || '').toUpperCase();
      if (ccy && !['','USD','-'].includes(ccy)) { skip++; continue; }
      const amtStr = gi2('amount','net amount');
      const amt = parseFloat(amtStr.replace(/,/g, ''));
      if (isNaN(amt) || amt === 0) { skip++; continue; }
      const type = secType === 'DEPWTH' ? (amt > 0 ? 'DEP' : 'WTH') : secType === 'DIV' ? (amt >= 0 ? 'DIV' : 'TAX') : secType;
      const rowHash = `L${lineNum}|${date}|${type}|${Math.abs(amt).toFixed(3)}`;
      if (existingHashes.has(rowHash)) { skip++; continue; }
      newFlows.push({
        id: crypto.randomUUID(),
        _h: rowHash, type, amount: Math.abs(amt),
        date, datetime: `${date} 08:00:00`,
        note: gi2('description','desc').slice(0, 60), source: 'csv'
      });
      imp++;
    }
  }
  return { newFlows, imp, skip, tradeSkip };
}

// ─── 交易 CSV 导入 ───────────────────────────────────────────
// existingHashes: Set<string> — 已有交易的 _h 哈希集合，用于去重
export function parseTradeCSV(text, existingHashes = new Set()) {
  const lines = text.split(/\r?\n/);
  const newTrades = []; let imp = 0, skip = 0, dup = 0, fmt = '通用';
  const sessionHashes = new Set(); // 本次导入内部去重（防止同文件内重复行）
  const isIBKR = lines.some(l => l.startsWith('Statement,') || l.startsWith('Trades,Header,'));

  // 生成交易哈希（与 Flex XML 格式保持一致，方便统一去重）
  const tradeHash = (date, ticker, dir, qty, price) =>
    `CSV|${date}|${ticker}|${dir}|${Math.abs(qty)}|${parseFloat(price).toFixed(4)}`;

  if (isIBKR) {
    fmt = 'IBKR'; let hdr = null;
    for (const line of lines) {
      const cols = parseCSVLine(line); if (!cols[0]) continue;
      if (cols[0] === 'Trades' && cols[1] === 'Header') { hdr = cols; continue; }
      if (cols[0] === 'Trades' && cols[1] === 'Data' && hdr) {
        const dc = cols[2]; if (!dc || dc === 'SubTotal' || dc === 'Total') continue;
        const g = k => { const idx = hdr.indexOf(k); return idx >= 0 ? (cols[idx] || '').trim() : null; };
        const sym    = g('Symbol');
        const dtRaw  = g('Date/Time');
        const qStr   = g('Quantity');
        const prStr  = g('T. Price') || g('Price');
        const fStr   = g('Comm/Fee');
        const asset  = g('Asset Category');
        if (asset && !['Stocks','STK',''].includes(asset)) { skip++; continue; }
        if (!sym || !dtRaw || qStr === null || !prStr) { skip++; continue; }
        const dtClean = dtRaw.replace(/"/g, '').split(',');
        const date = dtClean[0].trim(), time = (dtClean[1] || '').trim() || '09:30:00';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skip++; continue; }
        const rawQ  = parseFloat(qStr.replace(/,/g, ''));
        const price = parseFloat(prStr.replace(/,/g, ''));
        const fee   = Math.abs(parseFloat((fStr || '0').replace(/,/g, '')));
        if (isNaN(rawQ) || isNaN(price) || rawQ === 0) { skip++; continue; }
        const ticker = sym.replace(/\s+/g, '').toUpperCase();
        const dir    = rawQ > 0 ? 'BUY' : 'SELL';
        const qty    = Math.abs(rawQ);
        const h      = tradeHash(date, ticker, dir, qty, price);
        // 跳过已存在或本次重复
        if (existingHashes.has(h) || sessionHashes.has(h)) { dup++; continue; }
        sessionHashes.add(h);
        newTrades.push({
          id: crypto.randomUUID(),
          _h: h,
          ticker, date, datetime: `${date} ${time}`,
          dir, qty, price, fee,
          note: 'IBKR导入', source: 'csv'
        });
        imp++;
      }
    }
  } else {
    lines.slice(1).forEach(line => {
      if (!line.trim()) return;
      const c = parseCSVLine(line); if (c.length < 4 || !c[0]) return;
      const [date, ticker, dir, qty, price, fee, ...np] = c;
      if (!ticker || !qty || !price) return;
      const dm = { 'buy':'BUY','sell':'SELL','short':'SHORT','cover':'COVER','买入':'BUY','卖出':'SELL' };
      const normDir    = dm[dir?.toLowerCase()] || 'BUY';
      const normTicker = ticker.toUpperCase();
      const normQty    = Math.abs(parseFloat(qty));
      const normPrice  = parseFloat(price);
      const h = tradeHash(date, normTicker, normDir, normQty, normPrice);
      if (existingHashes.has(h) || sessionHashes.has(h)) { dup++; return; }
      sessionHashes.add(h);
      newTrades.push({
        id: crypto.randomUUID(),
        _h: h,
        ticker: normTicker, date, datetime: date + ' 09:30:00',
        dir: normDir, qty: normQty, price: normPrice,
        fee: parseFloat(fee) || 0,
        note: np.join(','), source: 'csv'
      });
      imp++;
    });
  }
  return { newTrades, imp, skip, dup, fmt };
}

// ─── Flex XML 解析 ──────────────────────────────────────────
export function parseFlexXML(xmlText, existingTradeHashes, existingCFHashes) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML格式错误');

  const newTrades = []; const newFlows = [];
  let skipT = 0, skipCF = 0, impPos = {};

  doc.querySelectorAll('Trade').forEach(t => {
    const assetCat = (t.getAttribute('assetCategory') || '').toUpperCase();
    if (assetCat && !['STK','STOCKS',''].includes(assetCat)) { skipT++; return; }
    const ccy = (t.getAttribute('currencyPrimary') || t.getAttribute('currency') || 'USD').toUpperCase();
    if (ccy !== 'USD') { skipT++; return; }
    const sym = (t.getAttribute('symbol') || '').trim().replace(/\s+/g,'').toUpperCase();
    if (!sym) { skipT++; return; }
    const dtRaw = t.getAttribute('dateTime') || t.getAttribute('tradeDate') || '';
    const { date, time } = parseFlexDateTime(dtRaw);
    if (!date) { skipT++; return; }
    const qtyRaw = parseFloat(t.getAttribute('quantity') || '0');
    const price  = parseFloat(t.getAttribute('tradePrice') || '0');
    const fee    = Math.abs(parseFloat(t.getAttribute('ibCommission') || t.getAttribute('commission') || '0'));
    if (!qtyRaw || !price) { skipT++; return; }
    const buySell = (t.getAttribute('buySell') || t.getAttribute('buy/sell') || '').toUpperCase();
    const dir = buySell.startsWith('BUY') ? 'BUY' : buySell.startsWith('SELL') ? 'SELL' : qtyRaw > 0 ? 'BUY' : 'SELL';
    const qty = Math.abs(qtyRaw);
    const rowHash = `FLEX|${date}|${sym}|${dir}|${qty}|${price.toFixed(4)}`;
    if (existingTradeHashes.has(rowHash)) { skipT++; return; }
    newTrades.push({
      id: crypto.randomUUID(),
      _h: rowHash, ticker: sym, date, datetime: `${date} ${time}`,
      dir, qty, price, fee, note: 'IBKR Flex', source: 'flex'
    });
  });

  doc.querySelectorAll('CashTransaction').forEach(ct => {
    const ccy = (ct.getAttribute('currencyPrimary') || ct.getAttribute('currency') || 'USD').toUpperCase();
    if (ccy !== 'USD') { skipCF++; return; }
    const typeRaw = ct.getAttribute('type') || ct.getAttribute('transactionType') || '';
    const dateRaw = ct.getAttribute('settleDate') || ct.getAttribute('reportDate') || ct.getAttribute('dateTime') || '';
    const date    = dateRaw ? parseIBKRDate(dateRaw.split(';')[0]) : null;
    if (!date) { skipCF++; return; }
    const amt  = parseFloat((ct.getAttribute('amount') || '0').replace(/,/g,''));
    if (amt === 0) { skipCF++; return; }
    const desc     = (ct.getAttribute('description') || '').trim();
    const actionId = ct.getAttribute('actionID') || ct.getAttribute('actionId') || '';
    const cfType   = mapCFType(typeRaw, desc, amt);
    if (!cfType) { skipCF++; return; }
    const rowHash = actionId ? `FLEXCF|AID:${actionId}|${cfType}` : `FLEXCF|${date}|${cfType}|${Math.abs(amt).toFixed(3)}|${desc.slice(0,15)}`;
    if (existingCFHashes.has(rowHash)) { skipCF++; return; }
    newFlows.push({
      id: crypto.randomUUID(),
      _h: rowHash, type: cfType, amount: Math.abs(amt),
      date, datetime: `${date} 08:00:00`, note: desc.slice(0, 60), source: 'flex'
    });
  });

  doc.querySelectorAll('OpenPosition').forEach(op => {
    const sym       = (op.getAttribute('symbol') || '').trim().toUpperCase();
    const markPrice = parseFloat(op.getAttribute('markPrice') || '0');
    const ccy       = (op.getAttribute('currencyPrimary') || op.getAttribute('currency') || 'USD').toUpperCase();
    const assetCat  = (op.getAttribute('assetCategory') || '').toUpperCase();
    if (!sym || markPrice <= 0 || ccy !== 'USD' || !['STK','STOCKS',''].includes(assetCat)) return;
    impPos[sym] = markPrice;
  });

  return { newTrades, newFlows, impPos, skipT, skipCF };
}

// ─── Flex Web Service（通过本地代理）────────────────────────
export async function checkProxy() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${PROXY_BASE}/health`, { signal: ctrl.signal });
    if (r.ok) { const j = await r.json(); return j.status === 'ok'; }
  } catch (e) {}
  return false;
}

export async function fetchFlexViaProxy(token, queryId) {
  // Step 1: request
  const resp1 = await proxyFetch(`/flex/request?token=${token}&queryId=${queryId}`, 15000);
  const doc1  = new DOMParser().parseFromString(resp1, 'text/xml');
  const refCode = doc1.querySelector('ReferenceCode')?.textContent || '';
  const errMsg  = doc1.querySelector('ErrorMessage')?.textContent || '';
  if (errMsg && !['','success'].includes(errMsg.toLowerCase())) throw new Error('IBKR: ' + errMsg);
  if (!refCode) throw new Error('未收到 ReferenceCode');

  // Step 2: poll for result
  await sleep(3000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const txt = await proxyFetch(`/flex/download?token=${token}&refCode=${refCode}`, 25000);
    if (txt.includes('<FlexQueryResponse') || txt.includes('<FlexStatements')) return txt;
    const docChk = new DOMParser().parseFromString(txt, 'text/xml');
    const s = (docChk.querySelector('Status')?.textContent || '').toLowerCase();
    const e2 = docChk.querySelector('ErrorMessage')?.textContent || '';
    if (s.includes('progress') || s.includes('generating')) { await sleep(3000); continue; }
    if (e2) throw new Error(e2);
    await sleep(2500);
  }
  throw new Error('报表下载超时，请稍后重试');
}

async function proxyFetch(path, timeout = 30000) {
  const ctrl = new AbortController();
  const tmr  = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${PROXY_BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(tmr);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) { clearTimeout(tmr); throw e; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
