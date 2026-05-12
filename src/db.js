// ═══════════════════════════════════════════════════════════════
// src/db.js — Firestore 数据层
//
// Firestore 数据结构：
//   users/{uid}/config/main          → 元数据（设置/价格/板块计划等）
//   users/{uid}/trades/{id}          → 每一笔交易（独立文档）
//   users/{uid}/cashFlows/{id}       → 每一条资金流水（独立文档）
//   users/{uid}/snapshots/{date}     → 每日快照（独立文档）
//   users/{uid}/analysis/{key}       → 个股分析（key = TICKER__DATE）
//   users/{uid}/journal/{date}       → 日志条目（date = YYYY-MM-DD）
//
// 说明：
//   · trades / cashFlows 使用子集合，支持无限条数
//   · 日志 / 分析 / 快照 体量小，也使用子集合保证可扩展
//   · HP（历史行情）/ jImgs（图片）仍存 localStorage（非敏感缓存）
// ═══════════════════════════════════════════════════════════════

import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { db } from './firebase-config.js';

// ─── 路径工具 ─────────────────────────────────────────────────
const metaRef  = uid => doc(db, 'users', uid, 'config', 'main');
const tradeRef = (uid, id) => doc(db, 'users', uid, 'trades', String(id));
const cfRef    = (uid, id) => doc(db, 'users', uid, 'cashFlows', String(id));
const snapRef  = (uid, date) => doc(db, 'users', uid, 'snapshots', date);
const anRef    = (uid, key) => doc(db, 'users', uid, 'analysis', key);
const jRef     = (uid, date) => doc(db, 'users', uid, 'journal', date);

const tradeCol = uid => collection(db, 'users', uid, 'trades');
const cfCol    = uid => collection(db, 'users', uid, 'cashFlows');
const snapCol  = uid => collection(db, 'users', uid, 'snapshots');
const anCol    = uid => collection(db, 'users', uid, 'analysis');
const jCol     = uid => collection(db, 'users', uid, 'journal');

// ─── 加载全部数据（登录后调用一次）──────────────────────────────
/**
 * 从 Firestore 加载用户全部数据，返回 S 兼容的对象
 * @param {string} uid
 * @returns {Promise<Object>}
 */
export async function loadAll(uid) {
  const [
    metaSnap,
    tradeSnaps,
    cfSnaps,
    snapSnaps,
    anSnaps,
    jSnaps
  ] = await Promise.all([
    getDoc(metaRef(uid)),
    getDocs(tradeCol(uid)),
    getDocs(cfCol(uid)),
    getDocs(snapCol(uid)),
    getDocs(anCol(uid)),
    getDocs(jCol(uid))
  ]);

  const meta = metaSnap.exists() ? metaSnap.data() : {};

  // 集合 → 数组 / 对象
  const trades     = tradeSnaps.docs.map(d => d.data());
  const cashFlows  = cfSnaps.docs.map(d => d.data());

  // snapshots: { date: snapData }
  const dailySnapshots = {};
  snapSnaps.docs.forEach(d => { dailySnapshots[d.id] = d.data(); });

  // analysisData: { 'TICKER__DATE': analysisData }
  const analysisData = {};
  anSnaps.docs.forEach(d => { analysisData[d.id] = d.data(); });

  // journalEntries: { 'YYYY-MM-DD': entry }
  const journalEntries = {};
  jSnaps.docs.forEach(d => { journalEntries[d.id] = d.data(); });

  return {
    // 集合数据
    trades,
    cashFlows,
    dailySnapshots,
    analysisData,
    journalEntries,
    // 元数据字段
    trackStocks:        meta.trackStocks        || [],
    prices:             meta.prices             || {},
    lastPriceUpdate:    meta.lastPriceUpdate    || null,
    flexConfig:         meta.flexConfig         || { token:'', queryId:'', autoSync:0, lastSync:null },
    sectorPlan:         meta.sectorPlan         || [],
    portOrder:          meta.portOrder          || [],
    customTickerColors: meta.customTickerColors || {}
  };
}

// ─── 元数据保存（设置/价格/板块计划等）──────────────────────────
/**
 * 保存元数据（非集合字段）
 * 包括：trackStocks, prices, lastPriceUpdate, flexConfig, sectorPlan, portOrder
 */
export function saveMeta(uid, S) {
  const data = {
    trackStocks:        S.trackStocks        || [],
    prices:             S.prices             || {},
    lastPriceUpdate:    S.lastPriceUpdate    || null,
    flexConfig:         S.flexConfig         || {},
    sectorPlan:         S.sectorPlan         || [],
    portOrder:          S.portOrder          || [],
    customTickerColors: S.customTickerColors || {}
  };
  // fire-and-forget：不阻塞 UI
  return setDoc(metaRef(uid), data)
    .catch(e => console.error('[db] saveMeta error:', e));
}

// ─── 交易记录 ─────────────────────────────────────────────────
export function addTrade(uid, trade) {
  return setDoc(tradeRef(uid, trade.id), trade)
    .catch(e => console.error('[db] addTrade error:', e));
}

export function removeTrade(uid, id) {
  return deleteDoc(tradeRef(uid, id))
    .catch(e => console.error('[db] removeTrade error:', e));
}

/** 批量写入交易（CSV/Flex 导入时用） */
export async function batchAddTrades(uid, trades) {
  // Firestore 每批最多 500 条
  for (let i = 0; i < trades.length; i += 400) {
    const chunk  = trades.slice(i, i + 400);
    const batch  = writeBatch(db);
    chunk.forEach(t => batch.set(tradeRef(uid, t.id), t));
    await batch.commit();
  }
}

/** 批量删除交易 */
export async function batchRemoveTrades(uid, ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach(id => batch.delete(tradeRef(uid, id)));
    await batch.commit();
  }
}

// ─── 资金流水 ─────────────────────────────────────────────────
export function addCashFlow(uid, cf) {
  return setDoc(cfRef(uid, cf.id), cf)
    .catch(e => console.error('[db] addCashFlow error:', e));
}

export function removeCashFlow(uid, id) {
  return deleteDoc(cfRef(uid, id))
    .catch(e => console.error('[db] removeCashFlow error:', e));
}

export async function batchAddCashFlows(uid, flows) {
  for (let i = 0; i < flows.length; i += 400) {
    const chunk = flows.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach(c => batch.set(cfRef(uid, c.id), c));
    await batch.commit();
  }
}

export async function batchRemoveCashFlows(uid, ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach(id => batch.delete(cfRef(uid, id)));
    await batch.commit();
  }
}

// ─── 快照 ────────────────────────────────────────────────────
export function saveSnapshot(uid, date, snap) {
  return setDoc(snapRef(uid, date), snap)
    .catch(e => console.error('[db] saveSnapshot error:', e));
}

export function removeSnapshot(uid, date) {
  return deleteDoc(snapRef(uid, date))
    .catch(e => console.error('[db] removeSnapshot error:', e));
}

// ─── 个股分析 ────────────────────────────────────────────────
export function saveAnalysis(uid, key, data) {
  return setDoc(anRef(uid, key), data)
    .catch(e => console.error('[db] saveAnalysis error:', e));
}

// ─── 交易日志 ────────────────────────────────────────────────
export function saveJournal(uid, date, entry) {
  return setDoc(jRef(uid, date), entry)
    .catch(e => console.error('[db] saveJournal error:', e));
}

export function removeJournal(uid, date) {
  return deleteDoc(jRef(uid, date))
    .catch(e => console.error('[db] removeJournal error:', e));
}

// ─── 清除操作（设置页使用）──────────────────────────────────────
/** 仅清除 Flex 来源的交易和资金记录 */
export async function clearFlexRecords(uid, trades, cashFlows) {
  const flexTrades = trades.filter(t => t.source === 'flex');
  const flexCFs    = cashFlows.filter(c => c.source === 'flex');
  await Promise.all([
    batchRemoveTrades(uid, flexTrades.map(t => t.id)),
    batchRemoveCashFlows(uid, flexCFs.map(c => c.id))
  ]);
}

// ─── 市场行情读取（Python 脚本写入的公共数据）──────────────────

/** 读取单只股票当前价格（Python 定时写入）*/
export async function loadMarketPrice(ticker) {
  try {
    const snap = await getDoc(
      doc(db, 'marketData', 'prices', 'tickers', ticker)
    );
    return snap.exists() ? snap.data() : null;
  } catch (e) { return null; }
}

/** 批量读取多只股票当前价格 */
export async function loadMarketPrices(tickers) {
  const results = {};
  await Promise.all(tickers.map(async tk => {
    const d = await loadMarketPrice(tk);
    if (d) results[tk] = d;
  }));
  return results;
}

/** 读取 K 线数据（interval: '1d' | '1wk'）*/
export async function loadKlineFromFirebase(ticker, interval) {
  const docId = `${ticker}_${interval === '1wk' ? '1wk' : '1d'}`;
  try {
    const snap = await getDoc(
      doc(db, 'marketData', 'kline', 'data', docId)
    );
    return snap.exists() ? snap.data() : null;
  } catch (e) { return null; }
}

/** 读取历史收盘价（Python 写入的 HP 数据，可替代 localStorage）*/
export async function loadHistoricalCloses(ticker) {
  try {
    const snap = await getDoc(
      doc(db, 'marketData', 'historical', 'closes', ticker)
    );
    return snap.exists() ? snap.data() : null;
  } catch (e) { return null; }
}

/** 读取多只股票的历史收盘价，合并进 window._HP */
export async function syncHPFromFirebase(tickers) {
  let synced = 0;
  await Promise.all(tickers.map(async tk => {
    const data = await loadHistoricalCloses(tk);
    if (data?.closes) {
      window._HP[tk] = { ...(window._HP[tk] || {}), ...data.closes };
      synced++;
    }
  }));
  return synced;
}
export async function clearAllUserData(uid) {
  // 读取所有文档 ID，然后批量删除
  const [ts, cfs, sn, an, js] = await Promise.all([
    getDocs(tradeCol(uid)),
    getDocs(cfCol(uid)),
    getDocs(snapCol(uid)),
    getDocs(anCol(uid)),
    getDocs(jCol(uid))
  ]);
  const allDocs = [...ts.docs, ...cfs.docs, ...sn.docs, ...an.docs, ...js.docs];
  for (let i = 0; i < allDocs.length; i += 400) {
    const chunk = allDocs.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  // 删除 meta
  await deleteDoc(metaRef(uid)).catch(() => {});
}
