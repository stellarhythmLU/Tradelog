// ═══════════════════════════════════════════════════════════════
// src/calc.js — 所有财务计算逻辑（纯函数，不依赖存储层）
// 与 v1.6 完全一致，仅做模块化提取
// ═══════════════════════════════════════════════════════════════

export const dtKey = t => t.datetime || (t.date + ' 12:00:00');
export const cfKey = c => c.datetime || (c.date + ' 08:00:00');

export const f2  = n => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fp  = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
export const fs  = n => (n >= 0 ? '+' : '-') + f2(n);
export const f2l = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function getFirstDepositDate(cashFlows) {
  const deps = [...(cashFlows || [])].filter(c => c.type === 'DEP').map(c => c.date).sort();
  return deps[0] || null;
}

// ─── 持仓计算核心 ────────────────────────────────────────────
export function mkPos() {
  return { rq: 0, ra: 0, bQ: 0, bA: 0, sQ: 0, sA: 0, shQ: 0, shA: 0, rpnl: 0, fb: null, ls: null };
}

export function applyTrade(p, t) {
  const qty = +t.qty, price = +t.price, fee = +(t.fee || 0);
  if (t.dir === 'BUY') {
    p.ra = (p.ra * p.rq + price * qty + fee) / (p.rq + qty);
    p.rq += qty; p.bQ += qty; p.bA += qty * price + fee;
    if (!p.fb) p.fb = t.datetime || t.date;
  } else if (t.dir === 'SELL') {
    if (p.rq < 0.0001) return 'skip';
    const aQ = Math.min(qty, p.rq);
    p.rpnl += (price - p.ra) * aQ - fee;
    p.rq -= aQ; p.sQ += aQ; p.sA += aQ * price - fee;
    p.ls = t.datetime || t.date;
    if (qty > aQ + 0.0001) return 'oversell';
  } else if (t.dir === 'SHORT') {
    p.shQ += qty; p.shA += qty * price - fee;
  } else if (t.dir === 'COVER') {
    if (p.shQ < 0.0001) return 'skip';
    const aQ = Math.min(qty, p.shQ), avgS = p.shA / p.shQ;
    p.rpnl += (avgS - price) * aQ - fee;
    p.shQ -= aQ; p.shA = Math.max(0, p.shA - avgS * aQ);
  }
  return null;
}

// ─── 全量计算 ─────────────────────────────────────────────────
export function calcAll(S) {
  const evts = [
    ...S.trades.map(t => ({ ...t, _t: 'trade' })),
    ...S.cashFlows.map(c => ({ ...c, _t: 'cf' }))
  ].sort((a, b) => (a._t === 'trade' ? dtKey(a) : cfKey(a))
    .localeCompare(b._t === 'trade' ? dtKey(b) : cfKey(b)));

  const tix = {}; const errs = []; let netDep = 0, totalIncome = 0;

  evts.forEach(ev => {
    if (ev._t === 'cf') {
      if (ev.type === 'DEP') netDep += ev.amount;
      else if (ev.type === 'WTH') netDep -= ev.amount;
      else if (ev.type === 'DIV' || ev.type === 'INT') totalIncome += ev.amount;
      else if (ev.type === 'TAX' || ev.type === 'FEE') totalIncome -= ev.amount;
      return;
    }
    const tk = ev.ticker;
    if (!tix[tk]) tix[tk] = mkPos();
    const err = applyTrade(tix[tk], ev);
    if (err === 'oversell') errs.push(`⚠️ ${tk} [${(ev.datetime || ev.date).slice(0, 16)}] 卖出超持仓`);
  });

  const positions = Object.entries(tix).map(([tk, p]) => {
    const cp = S.prices?.[tk] || 0;
    const mv = cp ? p.rq * cp : p.ra * p.rq;
    const unr = cp ? (cp - p.ra) * p.rq : 0;
    const dilCost = p.rq > 0.0001 ? (p.bA - p.sA) / p.rq : 0;
    return { ticker: tk, hq: p.rq, ra: p.ra, dilCost, cb: p.ra * p.rq, mv, unr, realPnL: p.rpnl, cp, shQ: p.shQ, firstBuy: p.fb, lastSell: p.ls, tbq: p.bQ, tsq: p.sQ, tbc: p.bA, tsp: p.sA };
  });

  const totalReal = positions.reduce((s, p) => s + p.realPnL, 0);
  const active    = positions.filter(p => p.hq > 0.0001 || p.shQ > 0.0001);
  const totalUnr  = active.filter(p => p.cp > 0).reduce((s, p) => s + p.unr, 0);
  const allBuy    = positions.reduce((s, p) => s + p.tbc, 0);
  const allSell   = positions.reduce((s, p) => s + p.tsp, 0);
  const cash      = netDep + totalIncome - allBuy + allSell;
  const calcNav   = netDep + totalIncome + totalReal + totalUnr;

  const realPnLs = positions.filter(p => p.realPnL !== 0).map(p => p.realPnL);
  const wins     = realPnLs.filter(v => v > 0);
  const losses   = realPnLs.filter(v => v < 0);
  const wr       = realPnLs.length ? wins.length / realPnLs.length * 100 : null;
  const avgW     = wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avgL     = losses.length ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
  const rr       = avgL > 0 ? avgW / avgL : null;

  const yrStart    = new Date().getFullYear() + '-01-01';
  const ytdCFNew   = S.cashFlows.filter(c => c.date >= yrStart && (c.type === 'DEP' || c.type === 'WTH'))
    .reduce((s, c) => s + (c.type === 'DEP' ? c.amount : -c.amount), 0);
  const ytdStart   = calcNavAtDate(S, new Date(new Date().getFullYear() - 1, 11, 31).toISOString().split('T')[0]);
  const ytdP       = ytdStart > 0 ? (calcNav - ytdStart - ytdCFNew) / ytdStart * 100 : null;
  const totalDep   = S.cashFlows.filter(c => c.type === 'DEP').reduce((s, c) => s + c.amount, 0);
  const allP       = totalDep > 0 ? (totalReal + totalUnr + totalIncome) / totalDep * 100 : null;

  return { positions, active, totalReal, totalUnr, totalIncome, calcNav, netDep, cash, wins, losses, wr, avgW, avgL, rr, ytdP, allP, errors: errs };
}

// ─── 指定日期的净值 ──────────────────────────────────────────
export function calcNavAtDate(S, upTo) {
  const evts = [
    ...S.trades.filter(t => t.date <= upTo).map(t => ({ ...t, _t: 'trade' })),
    ...S.cashFlows.filter(c => c.date <= upTo).map(c => ({ ...c, _t: 'cf' }))
  ].sort((a, b) => (a._t === 'trade' ? dtKey(a) : cfKey(a))
    .localeCompare(b._t === 'trade' ? dtKey(b) : cfKey(b)));

  let netD = 0, income = 0; const tix = {};

  evts.forEach(ev => {
    if (ev._t === 'cf') {
      if (ev.type === 'DEP') netD += ev.amount;
      else if (ev.type === 'WTH') netD -= ev.amount;
      else if (ev.type === 'DIV' || ev.type === 'INT') income += ev.amount;
      else if (ev.type === 'TAX' || ev.type === 'FEE') income -= ev.amount;
      return;
    }
    const tk = ev.ticker;
    if (!tix[tk]) tix[tk] = mkPos();
    applyTrade(tix[tk], ev);
  });

  const HP = window._HP || {};
  const real = Object.values(tix).reduce((s, p) => s + p.rpnl, 0);
  const unr  = Object.entries(tix).reduce((s, [tk, p]) => {
    if (p.rq < 0.0001) return s;
    let cp = 0;
    if (HP[tk]) { const dates = Object.keys(HP[tk]).filter(d => d <= upTo).sort(); if (dates.length) cp = HP[tk][dates[dates.length - 1]]; }
    if (!cp && upTo >= new Date().toISOString().split('T')[0]) cp = S.prices?.[tk] || 0;
    if (!cp) return s;
    return s + (cp - p.ra) * p.rq;
  }, 0);

  return netD + income + real + unr;
}

// ─── 构建净值时间序列（用于图表）────────────────────────────────
export function buildNavSeries(S, firstDepositDate) {
  const startDate = firstDepositDate || getFirstDepositDate(S.cashFlows);
  if (!startDate || (!S.trades.length && !S.cashFlows.length)) return [];

  const HP = window._HP || {};
  const allTickers = [...new Set(S.trades.map(t => t.ticker))];
  const datesSet   = new Set();

  S.trades.forEach(t => { if (t.date >= startDate) datesSet.add(t.date); });
  S.cashFlows.forEach(c => { if (c.date >= startDate) datesSet.add(c.date); });
  allTickers.forEach(tk => { if (HP[tk]) Object.keys(HP[tk]).forEach(d => { if (d >= startDate) datesSet.add(d); }); });

  const today  = new Date().toISOString().split('T')[0];
  const sorted = [...datesSet].filter(d => d <= today).sort();
  if (!sorted.length) return [];

  const allEvts = [
    ...S.trades.map(t => ({ ...t, _t: 'trade' })),
    ...S.cashFlows.map(c => ({ ...c, _t: 'cf' }))
  ].sort((a, b) => (a._t === 'trade' ? dtKey(a) : cfKey(a))
    .localeCompare(b._t === 'trade' ? dtKey(b) : cfKey(b)));

  let netD = 0, income = 0;
  const tix = {}; const pts = []; let ei = 0;

  sorted.forEach(date => {
    while (ei < allEvts.length && allEvts[ei].date <= date) {
      const ev = allEvts[ei++];
      if (ev._t === 'cf') {
        if (ev.type === 'DEP') netD += ev.amount;
        else if (ev.type === 'WTH') netD -= ev.amount;
        else if (ev.type === 'DIV' || ev.type === 'INT') income += ev.amount;
        else if (ev.type === 'TAX' || ev.type === 'FEE') income -= ev.amount;
      } else {
        const tk = ev.ticker;
        if (!tix[tk]) tix[tk] = mkPos();
        applyTrade(tix[tk], ev);
      }
    }
    const real = Object.values(tix).reduce((s, p) => s + p.rpnl, 0);
    const unr  = Object.entries(tix).reduce((s, [tk, p]) => {
      if (p.rq < 0.0001) return s;
      const cp = (HP[tk] && HP[tk][date]) || S.prices?.[tk] || 0;
      if (!cp) return s;
      return s + (cp - p.ra) * p.rq;
    }, 0);
    const nav  = netD + income + real + unr;
    const base = netD + income;
    const hasP = Object.entries(tix).some(([tk, p]) => p.rq > 0.0001 && ((HP[tk] && HP[tk][date]) || S.prices?.[tk]));
    pts.push({ date, nav, pct: base > 0 ? (nav - base) / base * 100 : 0, netD, income, hasP });
  });

  return pts;
}

// ─── 历史重算某日持仓（用于快照详情）────────────────────────────
export function calcPortAtDate(S, date) {
  const HP = window._HP || {};
  const evts = [
    ...S.trades.filter(t => t.date <= date).map(t => ({ ...t, _t: 'trade' })),
    ...S.cashFlows.filter(c => c.date <= date).map(c => ({ ...c, _t: 'cf' }))
  ].sort((a, b) => (a._t === 'trade' ? dtKey(a) : cfKey(a))
    .localeCompare(b._t === 'trade' ? dtKey(b) : cfKey(b)));

  let netD = 0, income = 0; const tix = {};

  evts.forEach(ev => {
    if (ev._t === 'cf') {
      if (ev.type === 'DEP') netD += ev.amount;
      else if (ev.type === 'WTH') netD -= ev.amount;
      else if (ev.type === 'DIV' || ev.type === 'INT') income += ev.amount;
      else if (ev.type === 'TAX' || ev.type === 'FEE') income -= ev.amount;
    } else {
      const tk = ev.ticker;
      if (!tix[tk]) tix[tk] = mkPos();
      applyTrade(tix[tk], ev);
    }
  });

  const real   = Object.values(tix).reduce((s, p) => s + p.rpnl, 0);
  const allBuy = Object.values(tix).reduce((s, p) => s + p.bA, 0);
  const allSel = Object.values(tix).reduce((s, p) => s + p.sA, 0);
  const cash   = Math.max(0, netD + income - allBuy + allSel);

  const positions = Object.entries(tix).filter(([, p]) => p.rq > 0.0001).map(([tk, p]) => {
    const cp  = (HP[tk] && HP[tk][date]) || 0;
    const mv  = cp ? p.rq * cp : 0;
    const unr = cp ? (cp - p.ra) * p.rq : 0;
    return { ticker: tk, hq: p.rq, ra: p.ra, dilCost: p.rq > 0 ? (p.bA - p.sA) / p.rq : 0, cp, mv, unr, realPnL: p.rpnl };
  });

  const totalUnr = positions.reduce((s, p) => s + p.unr, 0);
  const nav      = netD + income + real + totalUnr;
  const ytdStart = calcNavAtDate(S, new Date(new Date(date).getFullYear() - 1, 11, 31).toISOString().split('T')[0]);
  const ytdCFNew = S.cashFlows
    .filter(c => c.date >= date.slice(0, 4) + '-01-01' && c.date <= date && (c.type === 'DEP' || c.type === 'WTH'))
    .reduce((s, c) => s + (c.type === 'DEP' ? c.amount : -c.amount), 0);
  const ytdP = ytdStart > 0 ? (nav - ytdStart - ytdCFNew) / ytdStart * 100 : null;

  return { positions, nav, cash, netD, income, real, totalUnr, ytdP };
}
