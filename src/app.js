// ═══════════════════════════════════════════════════════════════
// src/app.js — TradeLog v2.0 主应用逻辑
// 数据层：Firestore（替换 localStorage）
// UI / 计算逻辑：与 v1.6 完全一致
// ═══════════════════════════════════════════════════════════════

import { signInWithGitHub, signOutUser, onAuthChange } from './auth.js';
import * as DB from './db.js';
import {
  calcAll, calcNavAtDate, buildNavSeries, calcPortAtDate,
  getFirstDepositDate, dtKey, cfKey, f2, fp, fs, f2l
} from './calc.js';
import {
  fetchAllPrices, fetchAllHistorical
} from './prices.js';
import {
  parseCSVLine, parseIBKRDate, parseCFCSV, parseTradeCSV,
  parseFlexXML, checkProxy, fetchFlexViaProxy
} from './import.js';

// ─── 全局状态 ────────────────────────────────────────────────
let S = {
  cashFlows: [], trades: [], trackStocks: [], analysisData: {},
  journalEntries: {}, dailySnapshots: {}, prices: {},
  flexConfig: { token: '', queryId: '', autoSync: 0, lastSync: null },
  sectorPlan: [], portOrder: []
};
window._HP  = {};   // 历史行情缓存（localStorage，非敏感）
let jImgs   = {};   // 日志图片（localStorage，非敏感）

let currentUser     = null;
let curChart        = 'ytdp', curRange = 'ytd';
let chartPtsG       = [], chartTypeG = '';
let closedSortKey   = 'lastSell', closedSortDir = -1;
let snapCalY        = new Date().getFullYear(), snapCalM = new Date().getMonth(), snapMode = 'saved';
let sharedCalY      = new Date().getFullYear(), sharedCalM = new Date().getMonth();
let sharedCalDate   = new Date().toISOString().split('T')[0];
let curAJView       = 'stock';
let openAccordions  = new Set();
let autoSaveTimers  = {};
let curJDate        = new Date().toISOString().split('T')[0];
let autoTimer       = null, flexAutoTimer = null;
let priceRefreshing = false, hpFetching = false, flexSyncing = false;
let tickerColorMap  = {};
let firstDepositDate = null;
let curDTick        = '';

const TECH = [{key:'kline',l:'K线形态',i:'🕯️'},{key:'wave',l:'波浪理论',i:'🌊'},{key:'fib',l:'斐波那契',i:'📐'},{key:'gann',l:'江恩角度线',i:'📏'},{key:'td9',l:'9转序列',i:'🔢'},{key:'ma',l:'均线分析',i:'〰️'},{key:'boll',l:'布林带',i:'📊'},{key:'macd',l:'MACD',i:'📉'},{key:'rsi',l:'RSI',i:'📡'}];
const FUND = [{key:'eps',l:'EPS/盈利',i:'💰'},{key:'pe',l:'PE',i:'🏷️'},{key:'rev',l:'营收增速',i:'📈'},{key:'margin',l:'利润率',i:'💹'},{key:'debt',l:'资产负债',i:'🏦'},{key:'cf2',l:'现金流',i:'💧'},{key:'guid',l:'业绩指引',i:'🎯'},{key:'earn',l:'财报日期',i:'📅'},{key:'sector',l:'行业/板块',i:'🗂️'}];
const SIGS = ['多头','空头','中性','观察'];
const SCLS = ['sbu','sbd','sbn','sbw'];
const SIGS_LABEL = {多头:'看多',空头:'看空',中性:'中性',观察:'观察'};
const SCOL = {多头:'var(--green)',空头:'var(--red)',中性:'var(--text2)',观察:'var(--yellow)'};
const CMAP = {看多:'var(--green)',看空:'var(--red)',观望:'var(--yellow)',减仓:'var(--text2)'};
const COLS = ['#4f8ef7','#26a66b','#f5a623','#e84545','#7c5cbf','#00d2d3','#ff9f43','#ee5a24','#a29bfe','#fd79a8','#b2bec3','#636e72'];
const CF_LABELS = {DEP:{l:'入金',c:'var(--green)'},WTH:{l:'出金',c:'var(--red)'},DIV:{l:'股息',c:'#00d2d3'},INT:{l:'利息',c:'#a29bfe'},TAX:{l:'预扣税',c:'var(--yellow)'},FEE:{l:'费用',c:'var(--text3)'}};
const srcTag = s => { if (!s || s === 'manual') return '<span class="source-tag source-manual">手动</span>'; if (s === 'flex') return '<span class="source-tag source-flex">Flex</span>'; return '<span class="source-tag source-csv">CSV</span>'; };
const tid = t => t.replace(/[^a-zA-Z0-9]/g, '_');

// ─── 工具 ────────────────────────────────────────────────────
function showToast(msg, type = 'success', dur = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), dur);
}
function flexLog(msg, cls = 'log-info') {
  const el = document.getElementById('flex-sync-log'); if (!el) return;
  const d = new Date().toTimeString().slice(0, 8);
  el.innerHTML += `<div class="${cls}">[${d}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}
function openModal(id)  { if (id === 'modal-settings') populateSettingsUI(); document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function nav(p) {
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  const m = { dashboard: 0, positions: 1, trades: 2, analysis: 3 };
  document.querySelectorAll('.ni')[m[p]]?.classList.add('active');
}
function dirB(d) {
  return { BUY: '<span class="badge bgg">买入</span>', SELL: '<span class="badge bgr">卖出</span>', SHORT: '<span class="badge bgy">买空</span>', COVER: '<span class="badge bgb">回补</span>' }[d] || d;
}

// ─── 保存封装（写 Firestore + 内存）────────────────────────
function saveMeta()             { if (currentUser) DB.saveMeta(currentUser.uid, S); }
function addTradeAndSave(t)     { S.trades.push(t); if (currentUser) DB.addTrade(currentUser.uid, t); firstDepositDate = getFirstDepositDate(S.cashFlows); }
function removeTradeAndSave(id) { S.trades = S.trades.filter(t => String(t.id) !== String(id)); if (currentUser) DB.removeTrade(currentUser.uid, id); }
function addCFAndSave(c)        { S.cashFlows.push(c); if (currentUser) DB.addCashFlow(currentUser.uid, c); firstDepositDate = getFirstDepositDate(S.cashFlows); }
function removeCFAndSave(id)    { S.cashFlows = S.cashFlows.filter(c => String(c.id) !== String(id)); if (currentUser) DB.removeCashFlow(currentUser.uid, id); }
function saveSnapAndDB(date, snap)  { S.dailySnapshots[date] = snap; if (currentUser) DB.saveSnapshot(currentUser.uid, date, snap); }
function deleteSnapAndDB(date)      { delete S.dailySnapshots[date]; if (currentUser) DB.removeSnapshot(currentUser.uid, date); }
function saveAnalysisAndDB(key, d)  { if (!S.analysisData) S.analysisData = {}; S.analysisData[key] = d; if (currentUser) DB.saveAnalysis(currentUser.uid, key, d); }
function saveJournalAndDB(date, e)  { if (!S.journalEntries) S.journalEntries = {}; S.journalEntries[date] = e; if (currentUser) DB.saveJournal(currentUser.uid, date, e); }
function deleteJournalAndDB(date)   { delete S.journalEntries[date]; if (currentUser) DB.removeJournal(currentUser.uid, date); }

function saveHP() {
  try { localStorage.setItem('tl_hp_v2', JSON.stringify(window._HP)); } catch (e) { showToast('历史行情缓存过大', 'warn'); }
}

// ─── 初始化 ──────────────────────────────────────────────────
export function init() {
  try { const h = localStorage.getItem('tl_hp_v2'); if (h) window._HP = JSON.parse(h); } catch (e) {}
  try { const i = localStorage.getItem('tl_imgs_v2'); if (i) jImgs = JSON.parse(i); } catch (e) {}

  document.getElementById('today-date').textContent =
    new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  setDefaultFormDates();
  initChartEvents();

  // 监听认证状态
  onAuthChange(async user => {
    if (user) {
      currentUser = user;
      showAppLoading(true);
      hideLoginPage();
      await loadUserData();
      showAppLoading(false);
      updateUserUI(user);
      firstDepositDate = getFirstDepositDate(S.cashFlows);
      setSnapMode('saved');
      renderAll();
      startAutoRefresh();
      updateFlexStatus();
      populateSettingsUI();
      checkProxy().then(ok => { updateProxyStatusUI(ok); });
      setTimeout(() => {
        const d = calcAll(S);
        if (d.active.length && !Object.keys(S.prices || {}).length) fetchAllPricesWrapper(false);
      }, 1500);
    } else {
      currentUser = null;
      showLoginPage();
      showAppLoading(false);
    }
  });
}

async function loadUserData() {
  try {
    const data = await DB.loadAll(currentUser.uid);
    S = { ...S, ...data };
  } catch (e) {
    console.error('加载数据失败:', e);
    showToast('数据加载失败，请刷新重试', 'error', 5000);
  }
}

function setDefaultFormDates() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().slice(0, 8);
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('t-date', today); setVal('t-time', timeStr);
  setVal('cf-date', today);
}

// ─── 登录/加载 UI ────────────────────────────────────────────
function showLoginPage()    { document.getElementById('login-page').style.display = 'flex'; document.getElementById('app-shell').style.display = 'none'; }
function hideLoginPage()    { document.getElementById('login-page').style.display = 'none'; document.getElementById('app-shell').style.display = 'flex'; }
function showAppLoading(v)  { document.getElementById('app-loading').style.display = v ? 'flex' : 'none'; }
function updateUserUI(user) {
  const el = document.getElementById('user-info');
  if (el) el.innerHTML = `<img src="${user.photoURL || ''}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:5px;">${user.displayName || user.email || '已登录'}`;
}

// 登录按钮点击
window.handleLogin = async function() {
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-err');
  if (btn) btn.disabled = true;
  if (err) err.textContent = '';
  try {
    await signInWithGitHub();
  } catch (e) {
    if (err) err.textContent = '登录失败：' + (e.message || '请重试');
    if (btn) btn.disabled = false;
  }
};

window.handleSignOut = async function() {
  if (!confirm('确定登出？')) return;
  await signOutUser();
  S = { cashFlows: [], trades: [], trackStocks: [], analysisData: {}, journalEntries: {}, dailySnapshots: {}, prices: {}, flexConfig: { token: '', queryId: '', autoSync: 0, lastSync: null }, sectorPlan: [], portOrder: [] };
};

// ─── 渲染全部 ────────────────────────────────────────────────
function renderAll() {
  firstDepositDate = getFirstDepositDate(S.cashFlows);
  renderDash(); renderPos(); renderTrades(); renderCFPage();
  renderClosedPos(); renderAccordionList(); renderSharedCal();
  renderJRecent(); renderCFListDash(); renderSnapCal();
}

// ─── 仪表盘 ──────────────────────────────────────────────────
function renderDash() {
  const d = calcAll(S);
  document.getElementById('d-nav').textContent    = d.netDep ? f2(d.calcNav) : '—';
  document.getElementById('d-nav-s').textContent  = d.netDep ? `入金合计: ${f2(d.netDep)}` : '请先入金';

  const perf    = curRange === 'ytd' ? d.ytdP : d.allP;
  const perfEl  = document.getElementById('d-ytd');
  const perfLbl = document.getElementById('d-perf-lbl');
  if (perfLbl) perfLbl.textContent = curRange === 'ytd' ? '业绩 · YTD' : '业绩 · 全部历史';
  if (perf != null) { perfEl.textContent = fp(perf); perfEl.className = 'sv ' + (perf >= 0 ? 'up' : 'dn'); }
  else { perfEl.textContent = '—'; perfEl.className = 'sv neu'; }
  document.getElementById('d-ytd-s').textContent = curRange === 'ytd' ? '年初至今' : '全部历史';

  const hasPx = d.active.some(p => p.cp > 0);
  const unrEl = document.getElementById('d-unr');
  if (hasPx) {
    unrEl.textContent = fs(d.totalUnr); unrEl.className = 'sv ' + (d.totalUnr >= 0 ? 'up' : 'dn');
    const cb = d.active.reduce((s, p) => s + p.cb, 0);
    document.getElementById('d-unr-p').textContent = cb ? fp(d.totalUnr / cb * 100) : '';
  } else { unrEl.textContent = '—'; unrEl.className = 'sv neu'; document.getElementById('d-unr-p').textContent = '需刷新行情'; }

  const cashAmt = Math.max(0, d.cash), mvAmt = d.active.reduce((s, p) => s + p.mv, 0);
  document.getElementById('d-cash').textContent   = d.netDep ? f2(cashAmt) : '—';
  document.getElementById('d-cash-s').textContent = d.netDep ? `持仓市值: ${f2(mvAmt)}` : '—';

  const rlEl = document.getElementById('d-rl');
  rlEl.textContent = fs(d.totalReal + d.totalIncome); rlEl.className = 'sv ' + (d.totalReal + d.totalIncome >= 0 ? 'up' : 'dn');
  document.getElementById('d-rl-s').textContent = `已实现: ${fs(d.totalReal)} | 股息/利息: ${fs(d.totalIncome)}`;

  if (d.wr != null) { document.getElementById('d-wr').textContent = d.wr.toFixed(1) + '%'; document.getElementById('d-wr').className = 'sv ' + (d.wr >= 50 ? 'up' : 'dn'); document.getElementById('d-wr-s').textContent = `${d.wins.length}盈 ${d.losses.length}亏`; }
  else document.getElementById('d-wr').textContent = '—';
  if (d.rr != null) { document.getElementById('d-rr').textContent = d.rr.toFixed(2); document.getElementById('d-rr').className = 'sv ' + (d.rr >= 1 ? 'up' : 'dn'); }
  else document.getElementById('d-rr').textContent = '—';

  const wb = document.getElementById('warn-bar');
  if (d.errors?.length) { wb.style.display = 'block'; wb.innerHTML = '<b>数据异常：</b><br>' + d.errors.join('<br>'); }
  else if (wb) wb.style.display = 'none';

  const pb = document.getElementById('price-bar');
  if (d.active.length && Object.keys(S.prices || {}).length) {
    pb.style.display = 'flex';
    document.getElementById('price-chips').innerHTML = d.active.filter(p => p.cp > 0).map(p => {
      const c = p.cp >= p.ra ? 'var(--green)' : 'var(--red)';
      return `<div class="price-chip"><span style="font-weight:700;">${p.ticker}</span><span style="color:${c};">$${p.cp.toFixed(2)}</span></div>`;
    }).join('');
    if (S.lastPriceUpdate) { const ago = Math.floor((Date.now() - S.lastPriceUpdate) / 60000); document.getElementById('price-time').textContent = ago < 1 ? '刚刚' : ago + '分钟前'; }
  } else pb.style.display = 'none';

  renderChart();

  const recent = [...S.trades].sort((a, b) => dtKey(b).localeCompare(dtKey(a))).slice(0, 5);
  document.getElementById('d-recent').innerHTML = recent.length
    ? recent.map(t => `<tr><td style="font-size:12px;">${t.datetime || t.date}</td><td class="tk" onclick="window._openSD('${t.ticker}')">${t.ticker}</td><td>${dirB(t.dir)}</td><td>${t.qty}</td><td>$${(+t.price).toFixed(2)}</td><td>$${(t.qty * t.price).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>${srcTag(t.source)}</td></tr>`).join('')
    : '<tr><td colspan="7"><div class="empty" style="padding:10px">暂无记录</div></td></tr>';
}

function renderCFListDash() {
  const el = document.getElementById('cf-list-dash'); if (!el) return;
  const cfs = [...(S.cashFlows || [])].filter(c => c.type === 'DEP' || c.type === 'WTH').sort((a, b) => cfKey(b).localeCompare(cfKey(a))).slice(0, 10);
  if (!cfs.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:6px 0;">暂无入金/出金记录</div>'; return; }
  el.innerHTML = cfs.map(c => { const cfg = CF_LABELS[c.type]; const isNeg = c.type === 'WTH'; return `<div class="cf-row"><div style="flex:1;"><span class="cf-chip" style="background:${cfg.c}22;color:${cfg.c};">${cfg.l}</span><span style="margin-left:5px;font-weight:600;color:${isNeg ? 'var(--red)' : 'var(--green)'};">${isNeg ? '-' : '+'}${f2(c.amount)}</span>${srcTag(c.source)}<div style="font-size:10px;color:var(--text3);margin-top:1px;">${c.date} ${c.note ? '· ' + c.note.slice(0, 30) : ''}</div></div></div>`; }).join('');
}

// ─── 图表 ────────────────────────────────────────────────────
function switchChart(t) { curChart = t; ['ytdp','nav'].forEach(k => document.getElementById('cvbtn-' + k)?.classList.toggle('active', k === t)); renderChart(); }
function switchRange(r) { curRange = r; ['ytd','all'].forEach(k => document.getElementById('cvbtn-' + k + 'r')?.classList.toggle('active', k === r)); renderDash(); }

function renderChart() {
  const d    = calcAll(S);
  let   pts  = buildNavSeries(S, firstDepositDate);
  const isNav = curChart === 'nav';
  if (curRange === 'ytd') {
    const ys = new Date().getFullYear() + '-01-01';
    pts = pts.filter(p => p.date >= ys);
    if (!isNav && pts.length > 0) { const base = pts[0].pct; pts = pts.map(p => ({ ...p, pct: p.pct - base })); }
  }
  const perf = curRange === 'ytd' ? d.ytdP : d.allP;
  const hasHP = pts.some(p => p.hasP);
  document.getElementById('chart-title').textContent = (curRange === 'ytd' ? 'YTD ' : '全部历史 ') + (isNav ? '净值走势' : '业绩走势');
  const valEl = document.getElementById('chart-val');
  if (isNav && d.netDep) { const c = d.calcNav >= d.netDep ? 'var(--green)' : 'var(--red)'; valEl.innerHTML = `当前净值 <span style="color:${c};font-weight:700;">${f2(d.calcNav)}</span>`; }
  else if (!isNav && perf != null) { const c = perf >= 0 ? 'var(--green)' : 'var(--red)'; valEl.innerHTML = `${curRange === 'ytd' ? 'YTD' : '全部'} <span style="color:${c};font-weight:700;">${fp(perf)}</span>`; }
  else valEl.innerHTML = '';
  document.getElementById('chart-hint').textContent = pts.length >= 2
    ? `${pts.length}个数据点 · 起始 ${firstDepositDate || '—'}${hasHP ? ' · 📡含历史收盘价' : ''}`
    : '暂无数据（请先入金并导入交易）';
  const thresh = isNav ? (pts[0]?.netD + (pts[0]?.income || 0) || d.netDep || 0) : 0;
  chartPtsG = drawChart(document.getElementById('main-chart'), pts, isNav ? 'nav' : 'pct', thresh, isNav ? v => '$' + Math.round(v).toLocaleString() : v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
  chartTypeG = curChart;
}

function drawChart(canvas, pts, yKey, thresh, labelFn) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth || 700, H = 170;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const coord = [];
  if (pts.length < 2) { ctx.fillStyle = '#555b78'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无足够数据', W / 2, H / 2); return coord; }
  const vals = pts.map(p => p[yKey]);
  let mn = Math.min(...vals, thresh), mx = Math.max(...vals, thresh);
  const rng = mx - mn || 1; mn -= rng * .05; mx += rng * .05;
  const pad = { t: 14, r: 18, b: 28, l: 80 }, cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const xs = i => pad.l + (i / (pts.length - 1 || 1)) * cw, ys = v => pad.t + ch - ((v - mn) / (mx - mn)) * ch;
  const yT = ys(thresh); const GRN = '#26a66b', RED = '#e84545';
  const fnt = `10px ${getComputedStyle(document.body).fontFamily}`;
  for (let i = 0; i < 5; i++) { const y = pad.t + (i / 4) * ch, val = mx - (i / 4) * (mx - mn); ctx.strokeStyle = '#2d315055'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.fillStyle = '#555b78'; ctx.font = fnt; ctx.textAlign = 'right'; ctx.fillText(labelFn(val), pad.l - 3, y + 3.5); }
  if (mn < thresh && thresh < mx) { ctx.beginPath(); ctx.strokeStyle = '#666a8877'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.moveTo(pad.l, yT); ctx.lineTo(W - pad.r, yT); ctx.stroke(); ctx.setLineDash([]); }
  for (let i = 1; i < pts.length; i++) {
    const v1 = vals[i - 1], v2 = vals[i], x1 = xs(i - 1), y1 = ys(v1), x2 = xs(i), y2 = ys(v2);
    const seg = (xa, ya, xb, yb, col) => { ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.lineTo(xb, yT); ctx.lineTo(xa, yT); ctx.closePath(); ctx.fillStyle = col + '18'; ctx.fill(); };
    const ln = (xa, ya, xb, yb, col) => { ctx.beginPath(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke(); };
    if ((v1 >= thresh) === (v2 >= thresh)) { const c = v1 >= thresh ? GRN : RED; seg(x1, y1, x2, y2, c); ln(x1, y1, x2, y2, c); }
    else { const r = (thresh - v1) / (v2 - v1), xm = x1 + r * (x2 - x1); seg(x1, y1, xm, yT, v1 >= thresh ? GRN : RED); ln(x1, y1, xm, yT, v1 >= thresh ? GRN : RED); seg(xm, yT, x2, y2, v2 >= thresh ? GRN : RED); ln(xm, yT, x2, y2, v2 >= thresh ? GRN : RED); }
  }
  pts.forEach((p, i) => coord.push({ x: xs(i), date: p.date, nav: p.nav, pct: p.pct, hasP: p.hasP }));
  ctx.fillStyle = '#8b90a7'; ctx.font = fnt; ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(pts.length / 6));
  for (let i = 0; i < pts.length; i += step) ctx.fillText(pts[i].date.slice(5), xs(i), H - pad.b + 14);
  const lc = vals[pts.length - 1] >= thresh ? GRN : RED;
  ctx.beginPath(); ctx.arc(xs(pts.length - 1), ys(vals[pts.length - 1]), 4, 0, Math.PI * 2); ctx.fillStyle = lc; ctx.fill();
  return coord;
}

function initChartEvents() {
  const canvas = document.getElementById('main-chart'), tt = document.getElementById('chart-tt');
  if (!canvas) return;
  canvas.addEventListener('mousemove', e => {
    if (!chartPtsG.length) return;
    const rect = canvas.getBoundingClientRect(), mx = e.clientX - rect.left;
    let best = chartPtsG[0], bd = Infinity;
    chartPtsG.forEach(p => { const dist = Math.abs(p.x - mx); if (dist < bd) { bd = dist; best = p; } });
    tt.style.display = 'block';
    const isN = chartTypeG === 'nav', val = isN ? f2(best.nav) : fp(best.pct);
    const c = (isN ? best.nav >= (chartPtsG[0]?.nav || 0) : best.pct >= 0) ? 'var(--green)' : 'var(--red)';
    tt.innerHTML = `<b>${best.date}</b>${best.hasP ? ' 📡' : ''}<br>${isN ? '净值' : '收益'}: <b style="color:${c}">${val}</b>`;
    tt.style.left = Math.min(e.clientX - rect.left + 12, canvas.clientWidth - 130) + 'px';
    tt.style.top = (e.clientY - rect.top - 48) + 'px';
  });
  canvas.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
}

// ─── 持仓 ────────────────────────────────────────────────────
function renderPos() {
  const d = calcAll(S); const nav = d.calcNav || 1; const tb = document.getElementById('pos-table');
  if (!d.active.length) { tb.innerHTML = '<tr><td colspan="12"><div class="empty" style="padding:16px">暂无持仓</div></td></tr>'; }
  else tb.innerHTML = d.active.map(p => {
    const pp = d.netDep > 0 ? p.mv / nav * 100 : 0, pp2 = p.cb > 0 ? p.unr / p.cb * 100 : 0;
    return `<tr><td class="tk" onclick="window._openSD('${p.ticker}')">${p.ticker}</td><td>${p.hq % 1 === 0 ? p.hq : p.hq.toFixed(4)}</td><td>$${p.ra.toFixed(2)}</td><td style="color:var(--text2);">$${p.dilCost.toFixed(2)}</td><td>${p.cp ? '$' + p.cp.toFixed(2) : '<span style="color:var(--text3)">—</span>'}</td><td>$${p.cb.toFixed(2)}</td><td>${p.cp ? '$' + p.mv.toFixed(2) : '—'}</td><td>${d.netDep ? pp.toFixed(1) + '%' : '—'}</td><td class="${p.unr >= 0 ? 'up' : 'dn'}">${p.cp ? (p.unr >= 0 ? '+' : '-') + '$' + Math.abs(p.unr).toFixed(2) : '—'}</td><td class="${pp2 >= 0 ? 'up' : 'dn'}">${p.cp ? (pp2 >= 0 ? '+' : '') + pp2.toFixed(2) + '%' : '—'}</td><td class="${p.realPnL >= 0 ? 'up' : 'dn'}">${p.realPnL !== 0 ? (p.realPnL >= 0 ? '+' : '-') + '$' + Math.abs(p.realPnL).toFixed(2) : '—'}</td><td><button class="btn bs bsm" onclick="window._openSD('${p.ticker}')">详情</button></td></tr>`;
  }).join('');
  renderPortCharts(d);
}

function renderPortCharts(d) {
  const active = d.active, nav = d.calcNav || 1, cashAmt = Math.max(0, d.cash);
  let rawItems = [...active].map((p, i) => ({ l: p.ticker, v: p.mv, c: COLS[i % COLS.length], isCash: false }));
  if (cashAmt > 0.01) rawItems.push({ l: '现金', v: cashAmt, c: '#555b78', isCash: true });
  if (S.portOrder?.length) {
    const ordered = []; S.portOrder.forEach(lbl => { const it = rawItems.find(x => x.l === lbl); if (it) ordered.push(it); });
    rawItems.forEach(it => { if (!ordered.find(x => x.l === it.l)) ordered.push(it); }); rawItems = ordered;
  }
  tickerColorMap = {}; rawItems.forEach(it => { tickerColorMap[it.l] = it.c; });

  const barEl = document.getElementById('port-bar');
  if (!rawItems.length) { barEl.innerHTML = '<div class="empty" style="padding:14px;font-size:11px;">暂无数据</div>'; }
  else {
    barEl.innerHTML = '<div id="port-bar-inner" style="display:flex;flex-direction:column;gap:4px;"></div>';
    const inner = document.getElementById('port-bar-inner');
    rawItems.forEach(it => {
      const pct = nav > 0 ? it.v / nav * 100 : 0;
      const row = document.createElement('div');
      row.className = 'port-bar-item'; row.dataset.label = it.l; row.draggable = !it.isCash;
      row.innerHTML = `<div style="width:50px;font-size:12px;font-weight:700;color:${it.c};overflow:hidden;text-overflow:ellipsis;flex-shrink:0;">${it.l}</div><div style="flex:1;background:var(--bg3);border-radius:3px;height:16px;overflow:hidden;"><div style="width:${Math.max(pct, .3)}%;background:${it.c};height:100%;border-radius:3px;"></div></div><div style="width:40px;font-size:11px;text-align:right;color:var(--text2);flex-shrink:0;">${pct.toFixed(1)}%</div>`;
      if (!it.isCash) {
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'portbar:' + it.l); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => row.classList.add('dragging'), 0); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', e => { e.preventDefault(); inner.querySelectorAll('.port-bar-item').forEach(r => r.classList.remove('drag-over')); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
          e.preventDefault(); row.classList.remove('drag-over');
          const src = e.dataTransfer.getData('text/plain'); if (!src.startsWith('portbar:')) return;
          const srcLabel = src.slice(8); if (srcLabel === it.l) return;
          const labels = rawItems.map(x => x.l), si = labels.indexOf(srcLabel), ti = labels.indexOf(it.l);
          if (si < 0 || ti < 0) return;
          labels.splice(si, 1); labels.splice(ti, 0, srcLabel);
          S.portOrder = labels; saveMeta(); renderPortCharts(d);
        });
      }
      inner.appendChild(row);
    });
  }

  const canvas = document.getElementById('port-pie');
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth || 280, H = 220;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  if (!rawItems.length) { ctx.fillStyle = '#555b78'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无数据', W / 2, H / 2); renderSectorPlan(d); return; }
  const total = rawItems.reduce((s, it) => s + it.v, 0);
  const pW = Math.min(W * .48, H), cx = pW / 2, cy = H / 2, r = Math.min(cx, cy) - 10, ri = r * .52;
  let ang = -Math.PI / 2;
  rawItems.forEach(it => { const a = it.v / total * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, ang, ang + a); ctx.closePath(); ctx.fillStyle = it.c; ctx.fill(); ctx.strokeStyle = '#0f1117'; ctx.lineWidth = 1.5; ctx.stroke(); ang += a; });
  ctx.beginPath(); ctx.arc(cx, cy, ri, 0, Math.PI * 2); ctx.fillStyle = '#1a1d27'; ctx.fill();
  ctx.fillStyle = '#e8eaf0'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('组合', cx, cy + 4);
  const lx = pW + 6, lw = W - lx - 4, lh = Math.min(20, (H - 12) / rawItems.length), fz = Math.max(9, Math.min(11, lh - 3));
  rawItems.forEach((it, i) => { const y = 6 + i * lh, pct = (it.v / total * 100).toFixed(1); ctx.fillStyle = it.c; ctx.fillRect(lx, y, 9, 9); ctx.fillStyle = '#e8eaf0'; ctx.font = `bold ${fz}px sans-serif`; ctx.textAlign = 'left'; ctx.fillText(it.l, lx + 12, y + 9); ctx.fillStyle = '#8b90a7'; ctx.font = `${fz}px sans-serif`; ctx.textAlign = 'right'; ctx.fillText(pct + '%', lx + lw, y + 9); });
  renderSectorPlan(d);
}

// ─── 计划板块 ─────────────────────────────────────────────────
function renderSectorPlan(d) {
  const el = document.getElementById('sector-plan-content'); if (!el) return;
  const plan = S.sectorPlan || [], nav = d.calcNav || 1;
  const usedPct = plan.reduce((s, sp) => s + sp.pct, 0), cashPct = Math.max(0, 100 - usedPct);
  const refW = document.getElementById('port-pie')?.clientWidth || 280;
  if (!plan.length) {
    el.innerHTML = '<div style="display:grid;grid-template-columns:52% 48%;gap:14px;align-items:center;"><div class="empty" style="padding:20px;border:2px dashed var(--border);border-radius:8px;"><div style="font-size:24px;margin-bottom:6px;">📐</div><div style="font-size:12px;">点击「✏️ 编辑板块」新建计划分配</div></div><canvas id="sector-pie" style="width:100%;height:220px;"></canvas></div>';
    renderSectorPie([], cashPct, refW); return;
  }
  let barsHtml = '<div id="sector-bars-wrap" style="display:flex;flex-direction:column;gap:4px;">';
  plan.forEach(sp => {
    const spTickers = sp.tickers || [], planW = Math.min(sp.pct, 100);
    let segHtml = '';
    spTickers.forEach(tk => {
      const pos = d.active.find(p => p.ticker === tk); const mv = pos?.cp ? pos.mv : 0; const pct = nav > 0 ? mv / nav * 100 : 0;
      if (pct <= 0) return; const segW = planW > 0 ? Math.min(pct / planW * 100, 100) : 0; if (segW < 0.05) return;
      segHtml += `<div draggable="true" data-seg-ticker="${tk}" data-seg-sector="${sp.id}" style="width:${segW}%;background:${tickerColorMap[tk] || sp.color};height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:grab;pointer-events:auto;" title="${tk}">${segW > 10 ? `<span style="font-size:9px;font-weight:700;color:#fff;pointer-events:none;">${tk}</span>` : ''}</div>`;
    });
    barsHtml += `<div class="port-bar-item" data-sector-id="${sp.id}" style="cursor:default;border-radius:6px;"><div style="width:50px;font-size:12px;font-weight:700;color:${sp.color};flex-shrink:0;pointer-events:none;overflow:hidden;text-overflow:ellipsis;">${sp.name}</div><div style="flex:1;background:var(--bg3);border-radius:3px;height:16px;overflow:hidden;position:relative;pointer-events:none;"><div style="position:absolute;top:0;left:0;width:${planW}%;height:100%;background:${sp.color};opacity:0.2;border-radius:3px;pointer-events:none;"></div><div style="position:absolute;top:0;left:0;width:${planW}%;height:100%;display:flex;overflow:hidden;pointer-events:none;">${segHtml}</div></div><div style="width:40px;font-size:11px;text-align:right;color:var(--text2);flex-shrink:0;pointer-events:none;">${sp.pct.toFixed(1)}%</div></div>`;
  });
  if (cashPct > 0.05) barsHtml += `<div class="port-bar-item" style="cursor:default;"><div style="width:50px;font-size:12px;font-weight:700;color:#555b78;flex-shrink:0;">现金</div><div style="flex:1;background:var(--bg3);border-radius:3px;height:16px;overflow:hidden;"><div style="width:${Math.max(cashPct, 0.3)}%;background:#555b78;height:100%;opacity:0.35;border-radius:3px;"></div></div><div style="width:40px;font-size:11px;text-align:right;color:var(--text2);flex-shrink:0;">${cashPct.toFixed(1)}%</div></div>`;
  barsHtml += `<div id="sector-remove-zone" style="margin-top:5px;border:1.5px dashed var(--red)55;border-radius:6px;padding:4px 10px;font-size:11px;color:var(--text3);text-align:center;">🗑️ 拖动已分配个股至此处可移除</div></div>`;
  el.innerHTML = `<div style="display:grid;grid-template-columns:52% 48%;gap:14px;align-items:start;">${barsHtml}<canvas id="sector-pie" style="width:100%;height:220px;"></canvas></div>`;

  function assignTicker(ticker, targetSp) {
    (S.sectorPlan || []).forEach(o => { o.tickers = (o.tickers || []).filter(t => t !== ticker); });
    if (targetSp) { if (!targetSp.tickers) targetSp.tickers = []; if (!targetSp.tickers.includes(ticker)) targetSp.tickers.push(ticker); }
    saveMeta(); renderPos();
  }
  el.querySelectorAll('[data-seg-ticker]').forEach(seg => {
    seg.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'sectorbar:' + seg.dataset.segTicker); e.dataTransfer.effectAllowed = 'move'; });
  });
  el.querySelectorAll('[data-sector-id]').forEach(row => {
    const sid = Number(row.dataset.sectorId), sp = (S.sectorPlan || []).find(s => s.id === sid); if (!sp) return;
    row.addEventListener('dragover', e => { e.preventDefault(); row.style.outline = '2px dashed var(--accent)'; });
    row.addEventListener('dragleave', e => { if (!row.contains(e.relatedTarget)) row.style.outline = ''; });
    row.addEventListener('drop', e => {
      e.preventDefault(); row.style.outline = '';
      const src = e.dataTransfer.getData('text/plain');
      const ticker = src.startsWith('portbar:') ? src.slice(8) : src.startsWith('sectorbar:') ? src.slice(10) : null;
      if (!ticker || ticker === '现金') return; assignTicker(ticker, sp);
    });
  });
  const rz = el.querySelector('#sector-remove-zone');
  if (rz) {
    rz.addEventListener('dragover', e => { e.preventDefault(); rz.style.borderColor = 'var(--red)'; rz.style.background = 'var(--red)11'; });
    rz.addEventListener('dragleave', () => { rz.style.borderColor = ''; rz.style.background = ''; });
    rz.addEventListener('drop', e => {
      e.preventDefault(); rz.style.borderColor = ''; rz.style.background = '';
      const src = e.dataTransfer.getData('text/plain');
      const ticker = src.startsWith('portbar:') ? src.slice(8) : src.startsWith('sectorbar:') ? src.slice(10) : null;
      if (!ticker || ticker === '现金') return; assignTicker(ticker, null);
    });
  }
  renderSectorPie(plan, cashPct, refW);
}

function renderSectorPie(plan, cashPct, refW) {
  const canvas = document.getElementById('sector-pie'); if (!canvas) return;
  const dpr = window.devicePixelRatio || 1, H = 220, W = refW || 280;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const items = [...plan.map(sp => ({ l: sp.name, v: sp.pct, c: sp.color }))];
  if (cashPct > 0.05) items.push({ l: '现金', v: cashPct, c: '#555b78' });
  if (!items.length) { ctx.fillStyle = '#555b78'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无计划', W / 2, H / 2); return; }
  const total = items.reduce((s, it) => s + it.v, 0);
  const pW = Math.min(W * .48, H), cx = pW / 2, cy = H / 2, r = Math.min(cx, cy) - 10, ri = r * .52;
  let ang = -Math.PI / 2;
  items.forEach(it => { const a = it.v / total * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, ang, ang + a); ctx.closePath(); ctx.fillStyle = it.c + 'bb'; ctx.fill(); ctx.strokeStyle = '#0f1117'; ctx.lineWidth = 1.5; ctx.stroke(); ang += a; });
  ctx.beginPath(); ctx.arc(cx, cy, ri, 0, Math.PI * 2); ctx.fillStyle = '#1a1d27'; ctx.fill();
  ctx.fillStyle = '#e8eaf0'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('计划', cx, cy + 4);
  const lx = pW + 6, lw = W - lx - 4, lh = Math.min(20, (H - 12) / items.length), fz = Math.max(9, Math.min(11, lh - 3));
  items.forEach((it, i) => { const y = 6 + i * lh; ctx.fillStyle = it.c; ctx.fillRect(lx, y, 9, 9); ctx.fillStyle = '#e8eaf0'; ctx.font = `bold ${fz}px sans-serif`; ctx.textAlign = 'left'; ctx.fillText(it.l.slice(0, 8), lx + 12, y + 9); ctx.fillStyle = '#8b90a7'; ctx.font = `${fz}px sans-serif`; ctx.textAlign = 'right'; ctx.fillText(it.v.toFixed(1) + '%', lx + lw, y + 9); });
}

// 板块编辑器
function openSectorEditor() {
  const plan = S.sectorPlan || [];
  const listEl = document.getElementById('sector-editor-list');
  const usedPct = plan.reduce((s, sp) => s + sp.pct, 0);
  if (listEl) listEl.innerHTML = !plan.length ? '<div style="color:var(--text3);font-size:12px;padding:6px 0;">暂无板块</div>'
    : `<div style="font-size:11px;color:var(--text3);margin-bottom:8px;">已使用 ${usedPct.toFixed(1)}% · 剩余 ${Math.max(0, 100 - usedPct).toFixed(1)}%</div>` + plan.map(sp => `<div class="sector-editor-row"><div style="width:10px;height:10px;background:${sp.color};border-radius:2px;flex-shrink:0;"></div><div style="flex:1;font-size:13px;font-weight:600;">${sp.name}</div><div style="font-size:12px;color:var(--text2);">${sp.pct}%</div><button class="btn bd bsm" onclick="window._deleteSector(${sp.id})">删除</button></div>`).join('');
  ['sp-name','sp-pct'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const errEl = document.getElementById('sp-err'); if (errEl) errEl.style.display = 'none';
  openModal('modal-sector-editor');
}

window._deleteSector = function(id) {
  if (!confirm('确定删除此板块？')) return;
  S.sectorPlan = (S.sectorPlan || []).filter(sp => sp.id !== id);
  saveMeta(); openSectorEditor(); renderPos();
};

function pickFreshColor() {
  const used = new Set([...Object.values(tickerColorMap), ...(S.sectorPlan || []).map(sp => sp.color)]);
  const ext = [...COLS, '#06b6d4', '#d946ef', '#84cc16', '#f97316', '#0ea5e9', '#a855f7'];
  for (const col of ext) if (!used.has(col)) return col;
  return ext[((S.sectorPlan || []).length + 6) % ext.length];
}

window._addSector = function() {
  const name = (document.getElementById('sp-name')?.value || '').trim();
  const pctRaw = parseFloat(document.getElementById('sp-pct')?.value || '0');
  const errEl = document.getElementById('sp-err');
  if (!name) { if (errEl) { errEl.style.display = 'block'; errEl.textContent = '请输入板块名称'; } return; }
  if (isNaN(pctRaw) || pctRaw <= 0 || pctRaw > 100) { if (errEl) { errEl.style.display = 'block'; errEl.textContent = '占比须在 0.1~100'; } return; }
  const usedPct = (S.sectorPlan || []).reduce((s, sp) => s + sp.pct, 0);
  if (usedPct + pctRaw > 100.01) { if (errEl) { errEl.style.display = 'block'; errEl.textContent = `剩余 ${(100 - usedPct).toFixed(1)}%`; } return; }
  if (errEl) errEl.style.display = 'none';
  if (!S.sectorPlan) S.sectorPlan = [];
  S.sectorPlan.push({ id: Date.now(), name, pct: pctRaw, tickers: [], color: pickFreshColor() });
  saveMeta(); openSectorEditor(); renderPos();
};

// ─── 资金流水 ────────────────────────────────────────────────
window._saveCF = function() {
  const type = document.getElementById('cf-type').value, amt = parseFloat(document.getElementById('cf-amt').value);
  const date = document.getElementById('cf-date').value, time = document.getElementById('cf-time').value || '09:00:00';
  const note = document.getElementById('cf-note').value;
  if (!amt || !date) return alert('请填写金额和日期');
  addCFAndSave({ id: Date.now() + Math.random(), type, amount: Math.abs(amt), date, datetime: `${date} ${time}`, note, source: 'manual' });
  renderAll(); closeModal('modal-cf'); showToast('✅ 已保存');
  document.getElementById('cf-amt').value = ''; document.getElementById('cf-note').value = '';
};

window._deleteCF = function(id) { if (!confirm('确定删除？')) return; removeCFAndSave(id); renderAll(); };

function renderCFPage() {
  const el = document.getElementById('cf-page-table'), sumEl = document.getElementById('cf-page-summary'); if (!el) return;
  const filterType = document.getElementById('cf-filter-type')?.value || '';
  const cfs = [...(S.cashFlows || [])].filter(c => !filterType || c.type === filterType).sort((a, b) => cfKey(b).localeCompare(cfKey(a)));
  const totalDep = S.cashFlows.filter(c => c.type === 'DEP').reduce((s, c) => s + c.amount, 0);
  const totalWth = S.cashFlows.filter(c => c.type === 'WTH').reduce((s, c) => s + c.amount, 0);
  const totalInc = S.cashFlows.filter(c => c.type === 'DIV' || c.type === 'INT').reduce((s, c) => s + c.amount, 0);
  const totalTax = S.cashFlows.filter(c => c.type === 'TAX' || c.type === 'FEE').reduce((s, c) => s + c.amount, 0);
  if (sumEl) sumEl.innerHTML = `<span>入金: <b style="color:var(--green)">${f2(totalDep)}</b></span><span>出金: <b style="color:var(--red)">${f2(totalWth)}</b></span><span>净入金: <b>${fs(totalDep - totalWth)}</b></span><span>股息/利息净: <b class="${totalInc - totalTax >= 0 ? 'up' : 'dn'}">${fs(totalInc - totalTax)}</b></span><span>共 ${S.cashFlows.length} 条</span>`;
  if (!cfs.length) { el.innerHTML = '<tr><td colspan="7"><div class="empty" style="padding:14px">暂无记录</div></td></tr>'; return; }
  el.innerHTML = cfs.map(c => { const cfg = CF_LABELS[c.type] || { l: c.type, c: 'var(--text2)' }; const isNeg = c.type === 'WTH' || c.type === 'TAX' || c.type === 'FEE'; return `<tr><td><input type="checkbox" class="cf-cb" value="${c.id}" onchange="window._updCFBatch()"></td><td style="font-size:12px;">${c.date}</td><td><span class="cf-chip" style="background:${cfg.c}22;color:${cfg.c};">${cfg.l}</span></td><td style="font-weight:600;color:${isNeg ? 'var(--red)' : 'var(--green)'};">${isNeg ? '-' : '+'}${f2(c.amount)}</td><td>${srcTag(c.source)}</td><td style="color:var(--text2);max-width:200px;overflow:hidden;text-overflow:ellipsis;">${c.note || '—'}</td><td><button class="btn bd bsm" onclick="window._deleteCF('${c.id}')">删</button></td></tr>`; }).join('');
}

window._updCFBatch = function() {
  const sel = document.querySelectorAll('.cf-cb:checked'), bb = document.getElementById('cf-batch-bar');
  if (bb) bb.style.display = sel.length ? 'flex' : 'none';
  const sc = document.getElementById('cf-batch-cnt'); if (sc) sc.textContent = `已选 ${sel.length} 条`;
};
window._cfSelAll = function(cb) { document.querySelectorAll('.cf-cb').forEach(c => c.checked = cb.checked); window._updCFBatch(); };
window._batchDeleteCF = function() {
  const ids = Array.from(document.querySelectorAll('.cf-cb:checked')).map(c => c.value);
  if (!ids.length) return; if (!confirm(`确定删除 ${ids.length} 条？`)) return;
  ids.forEach(id => removeCFAndSave(id)); renderAll(); showToast(`✅ 已删除 ${ids.length} 条`);
};

// ─── 交易记录 ────────────────────────────────────────────────
window._saveTrade = function() {
  const tick = document.getElementById('t-tick').value.trim().toUpperCase();
  const date = document.getElementById('t-date').value, time = document.getElementById('t-time').value || '09:30:00';
  const dir = document.getElementById('t-dir').value;
  const qty = parseFloat(document.getElementById('t-qty').value), price = parseFloat(document.getElementById('t-price').value);
  const fee = parseFloat(document.getElementById('t-fee').value) || 0, note = document.getElementById('t-note').value;
  const errEl = document.getElementById('trade-err');
  if (!tick || !date || !qty || !price) { errEl.style.display = 'block'; errEl.textContent = '请填写完整信息'; return; }
  errEl.style.display = 'none';
  addTradeAndSave({ id: Date.now() + Math.random(), ticker: tick, date, datetime: `${date} ${time}`, dir, qty, price, fee, note, source: 'manual' });
  renderAll(); closeModal('modal-trade'); showToast('✅ 交易已保存');
  ['t-tick','t-qty','t-price','t-note'].forEach(id => document.getElementById(id).value = ''); document.getElementById('t-fee').value = '0';
};

function renderTrades() {
  const fT = (document.getElementById('tf-tick')?.value || '').toUpperCase();
  const fD = document.getElementById('tf-dir')?.value || '';
  const fFrom = document.getElementById('tf-from')?.value || '', fTo = document.getElementById('tf-to')?.value || '';
  const fSrc = document.getElementById('tf-source')?.value || '';
  const list = [...S.trades.filter(t => (!fT || t.ticker.includes(fT)) && (!fD || t.dir === fD) && (!fFrom || t.date >= fFrom) && (!fTo || t.date <= fTo) && (!fSrc || (t.source || 'manual') === fSrc))].sort((a, b) => dtKey(b).localeCompare(dtKey(a)));
  const tb = document.getElementById('tr-table');
  if (!list.length) { tb.innerHTML = '<tr><td colspan="11"><div class="empty" style="padding:12px">暂无记录</div></td></tr>'; updBatch(); return; }
  tb.innerHTML = list.map(t => `<tr><td><input type="checkbox" class="tcb" value="${t.id}" onchange="window._updBatch()"></td><td style="font-size:12px;">${t.datetime || t.date}</td><td class="tk" onclick="window._openSD('${t.ticker}')">${t.ticker}</td><td>${dirB(t.dir)}</td><td>${t.qty}</td><td>$${(+t.price).toFixed(2)}</td><td>$${(t.fee || 0).toFixed(2)}</td><td>$${(t.qty * t.price).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>${srcTag(t.source)}</td><td style="color:var(--text2);max-width:130px;overflow:hidden;text-overflow:ellipsis;">${t.note || '—'}</td><td><button class="btn bd bsm" onclick="window._delTrade(${t.id})">删</button></td></tr>`).join('');
  updBatch();
}

function updBatch() {
  const cbs = document.querySelectorAll('.tcb:checked'), all = document.querySelectorAll('.tcb');
  const bb = document.getElementById('batch-bar'); if (bb) bb.style.display = cbs.length ? 'flex' : 'none';
  const sc = document.getElementById('sel-cnt'); if (sc) sc.textContent = `已选 ${cbs.length} 条`;
  const sa = document.getElementById('sel-all'); if (sa) sa.checked = all.length > 0 && cbs.length === all.length;
}
window._updBatch   = updBatch;
window._selAll     = cb => { document.querySelectorAll('.tcb').forEach(c => c.checked = cb.checked); updBatch(); };
window._batchDel   = function() { const ids = Array.from(document.querySelectorAll('.tcb:checked')).map(c => +c.value); if (!ids.length) return; if (!confirm(`确定删除${ids.length}条？`)) return; ids.forEach(id => removeTradeAndSave(id)); renderAll(); };
window._delTrade   = function(id) { if (!confirm('确定删除？')) return; removeTradeAndSave(id); renderAll(); };

function renderClosedPos() {
  const d = calcAll(S); const closed = d.positions.filter(p => p.hq < 0.0001 && p.shQ < 0.0001 && (p.tbq > 0 || p.realPnL !== 0));
  const tb = document.getElementById('closed-table');
  if (!closed.length) { tb.innerHTML = '<tr><td colspan="10"><div class="empty" style="padding:12px">暂无已平仓股票</div></td></tr>'; return; }
  const sorted = [...closed].sort((a, b) => {
    if (closedSortKey === 'ticker') return closedSortDir * a.ticker.localeCompare(b.ticker);
    let va = 0, vb = 0;
    if (closedSortKey === 'realPnL') { va = a.realPnL; vb = b.realPnL; }
    else if (closedSortKey === 'roi') { va = a.tbc > 0 ? a.realPnL / a.tbc : 0; vb = b.tbc > 0 ? b.realPnL / b.tbc : 0; }
    else { va = a.lastSell || ''; vb = b.lastSell || ''; }
    return closedSortDir * (va > vb ? 1 : va < vb ? -1 : 0);
  });
  tb.innerHTML = sorted.map(p => { const roi = p.tbc > 0 ? p.realPnL / p.tbc * 100 : 0; return `<tr><td class="tk" onclick="window._openSD('${p.ticker}')">${p.ticker}</td><td style="font-size:12px;">${(p.firstBuy || '').slice(0, 10)}</td><td style="font-size:12px;">${(p.lastSell || '').slice(0, 10)}</td><td>${p.tbq}</td><td>${p.tsq}</td><td>$${f2l(p.tbc)}</td><td>$${f2l(p.tsp)}</td><td class="${p.realPnL >= 0 ? 'up' : 'dn'}">${p.realPnL >= 0 ? '+' : '-'}$${f2l(Math.abs(p.realPnL))}</td><td class="${roi >= 0 ? 'up' : 'dn'}">${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%</td><td><button class="btn bs bsm" onclick="window._openSD('${p.ticker}')">详情</button></td></tr>`; }).join('');
}

window._sortClosed = function(key) {
  if (closedSortKey === key) closedSortDir *= -1; else { closedSortKey = key; closedSortDir = -1; }
  document.getElementById('sort-ind').textContent = { ticker: '名称', realPnL: '盈亏', roi: '回报率', lastSell: '日期' }[key] + ' ' + (closedSortDir < 0 ? '↓' : '↑');
  renderClosedPos();
};

// ─── Tab 切换 ────────────────────────────────────────────────
window._trTab2 = function(el, s) {
  document.querySelectorAll('#page-trades .tab').forEach(t => t.classList.remove('active')); el.classList.add('active');
  ['tr-detail','tr-cf','tr-closed'].forEach(id => document.getElementById(id).style.display = id === s ? '' : 'none');
  const ta = document.getElementById('trades-actions');
  if (s === 'tr-cf') ta.innerHTML = '';
  else if (s === 'tr-detail') ta.innerHTML = '<button class="btn bs" onclick="document.getElementById(\'trade-csv-up\').click()">📂 导入CSV</button><input type="file" id="trade-csv-up" accept=".csv" style="display:none" onchange="window._importTradeCSV(this)"><button class="btn bp" onclick="openModal(\'modal-trade\')">+ 新增</button>';
  else ta.innerHTML = '';
};
window._sTab = function(el, id) { document.querySelectorAll('#stabs .tab').forEach(t => t.classList.remove('active')); el.classList.add('active'); ['st-flex','st-guide','st-manual'].forEach(s => document.getElementById(s).style.display = s === id ? '' : 'none'); };

// ─── CSV 导入 ────────────────────────────────────────────────
window._importTradeCSV = function(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const { newTrades, imp, skip, fmt } = parseTradeCSV(e.target.result);
    if (newTrades.length) { await DB.batchAddTrades(currentUser.uid, newTrades); S.trades.push(...newTrades); renderAll(); }
    showToast(`✅ [${fmt}] 导入 ${imp} 条${skip ? ` | 跳过${skip}` : ''}`, imp > 0 ? 'success' : 'warn');
  };
  reader.readAsText(file, 'utf-8'); input.value = '';
};

window._importCFCSV = function(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const existingHashes = new Set(S.cashFlows.map(c => c._h).filter(Boolean));
    const { newFlows, imp, skip, tradeSkip } = parseCFCSV(e.target.result, existingHashes);
    if (newFlows.length) { await DB.batchAddCashFlows(currentUser.uid, newFlows); S.cashFlows.push(...newFlows); firstDepositDate = getFirstDepositDate(S.cashFlows); renderAll(); }
    closeModal('modal-cf');
    showToast(imp > 0 ? `✅ 导入 ${imp} 条${tradeSkip ? ` (跳过${tradeSkip}条交易)` : ''}` : `导入0条 — 请确认CSV格式`, imp > 0 ? 'success' : 'warn', imp > 0 ? 3000 : 7000);
  };
  reader.readAsText(file, 'utf-8'); input.value = '';
};

// ─── Flex XML 导入 ──────────────────────────────────────────
window._handleFlexXMLUpload = function(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { flexLog(`载入文件: ${file.name}`, 'log-info'); processFlexXML(e.target.result, true); };
  reader.readAsText(file, 'utf-8'); input.value = '';
};

async function processFlexXML(xmlText, showToasts = true) {
  try {
    const existingTradeHashes = new Set(S.trades.map(t => t._h).filter(Boolean));
    const existingCFHashes    = new Set(S.cashFlows.map(c => c._h).filter(Boolean));
    const { newTrades, newFlows, impPos, skipT, skipCF } = parseFlexXML(xmlText, existingTradeHashes, existingCFHashes);

    if (newTrades.length) { await DB.batchAddTrades(currentUser.uid, newTrades); S.trades.push(...newTrades); }
    if (newFlows.length)  { await DB.batchAddCashFlows(currentUser.uid, newFlows); S.cashFlows.push(...newFlows); }
    if (Object.keys(impPos).length) { Object.assign(S.prices, impPos); const today = new Date().toISOString().split('T')[0]; Object.entries(impPos).forEach(([tk, p]) => { if (!window._HP[tk]) window._HP[tk] = {}; window._HP[tk][today] = p; }); S.lastPriceUpdate = Date.now(); saveHP(); }

    S.flexConfig.lastSync = new Date().toISOString(); S.lastPriceUpdate = Date.now();
    saveMeta(); firstDepositDate = getFirstDepositDate(S.cashFlows); renderAll();
    const dot = document.getElementById('flex-dot'); if (dot) dot.className = 'status-dot ok';
    const msg = `✅ 同步完成 · 交易+${newTrades.length} 资金+${newFlows.length} 价格+${Object.keys(impPos).length}${(skipT + skipCF) > 0 ? ` | 跳过${skipT + skipCF}` : ''}`;
    if (showToasts) showToast(msg, 'success', 5000); flexLog(msg, 'log-ok');
  } catch (err) { flexLog('解析异常: ' + err.message, 'log-err'); if (showToasts) showToast('❌ 解析出错: ' + err.message, 'error', 6000); }
}

// ─── Flex Web Service ────────────────────────────────────────
window._fetchFlexData = async function(showToasts = true) {
  if (flexSyncing) { if (showToasts) showToast('同步中...', 'info'); return; }
  const cfg = S.flexConfig || {};
  if (!cfg.token || !cfg.queryId) { showToast('请先配置 Flex Token 和 Query ID', 'warn', 4000); openModal('modal-settings'); return; }
  flexLog('检测本地代理...'); const alive = await checkProxy();
  if (!alive) { showToast('❌ 本地代理未运行，请执行 node tradelog-proxy.js', 'error', 8000); flexLog('代理未运行', 'log-err'); return; }
  flexSyncing = true; const dot = document.getElementById('flex-dot'); if (dot) dot.className = 'status-dot syncing';
  if (showToasts) showToast('🔗 正在同步...', 'info', 30000);
  try { const xmlText = await fetchFlexViaProxy(cfg.token, cfg.queryId); await processFlexXML(xmlText, showToasts); }
  catch (e) { showToast('❌ ' + e.message, 'error', 6000); flexLog(e.message, 'log-err'); if (dot) dot.className = 'status-dot warn'; }
  finally { flexSyncing = false; }
};

// ─── 行情 ────────────────────────────────────────────────────
async function fetchAllPricesWrapper(manual = false) {
  if (priceRefreshing) { if (manual) showToast('行情刷新中...', 'info'); return; }
  const d = calcAll(S); const tickers = [...new Set(d.active.map(p => p.ticker))];
  if (!tickers.length) { if (manual) showToast('暂无持仓', 'info'); return; }
  priceRefreshing = true; if (manual) showToast(`正在获取 ${tickers.length} 只行情...`, 'info', 10000);
  const { prices, ok, fail } = await fetchAllPrices(tickers, S.prices || {});
  S.prices = prices; S.lastPriceUpdate = Date.now();
  const today = new Date().toISOString().split('T')[0];
  Object.entries(prices).forEach(([tk, p]) => { if (!window._HP[tk]) window._HP[tk] = {}; window._HP[tk][today] = p; });
  saveMeta(); saveHP(); priceRefreshing = false; renderAll();
  if (manual) showToast(fail > 0 ? `✅ 更新${ok}只，${fail}只失败` : `✅ 已更新${ok}只`, fail > 0 ? 'warn' : 'success');
}

window._fetchAllPrices     = () => fetchAllPricesWrapper(true);
window._fetchAllHistorical = async function() {
  if (hpFetching) { showToast('历史行情获取中...', 'info'); return; }
  const allTickers = [...new Set(S.trades.map(t => t.ticker))];
  if (!allTickers.length) { showToast('暂无交易记录', 'warn'); return; }
  hpFetching = true; showToast(`📈 正在获取 ${allTickers.length} 只2年历史收盘价...`, 'info', 120000);
  const { results, ok, fail } = await fetchAllHistorical(allTickers);
  Object.entries(results).forEach(([tk, r]) => { if (!window._HP[tk]) window._HP[tk] = {}; Object.assign(window._HP[tk], r.hpData); if (r.currentPrice) S.prices[tk] = r.currentPrice; });
  hpFetching = false; saveHP(); saveMeta(); renderAll();
  showToast(`📈 历史行情完成: ${ok}只✅${fail ? ` ${fail}只❌` : ''}`, 'success', 6000);
};

function startAutoRefresh() { if (autoTimer) clearInterval(autoTimer); autoTimer = setInterval(() => fetchAllPricesWrapper(false), 5 * 60 * 1000); document.getElementById('auto-status').textContent = '自动刷新5min'; }

// ─── 快照 ────────────────────────────────────────────────────
function setSnapMode(m) {
  snapMode = m;
  document.getElementById('snap-mode-saved').classList.toggle('active', m === 'saved');
  document.getElementById('snap-mode-auto').classList.toggle('active', m === 'auto');
  const hintEl = document.getElementById('snap-hint');
  if (hintEl) hintEl.textContent = m === 'saved' ? '🟢有快照点击查看 · 空白点击保存快照' : '点击日期查看历史重算（需先获取📈历史行情）';
  renderSnapCal();
}

window._saveSnapshot = function() {
  const d = calcAll(S), today = new Date().toISOString().split('T')[0];
  const snap = { date: today, savedAt: new Date().toISOString(), nav: d.calcNav, cash: Math.max(0, d.cash), netDep: d.netDep, totalReal: d.totalReal, totalIncome: d.totalIncome, totalUnr: d.totalUnr, ytdP: d.ytdP, pricesUsed: { ...S.prices }, positions: d.active.map(p => ({ ticker: p.ticker, hq: p.hq, ra: p.ra, dilCost: p.dilCost, cb: p.cb, mv: p.mv, unr: p.unr, cp: p.cp, realPnL: p.realPnL })), trades: S.trades.filter(t => t.date === today) };
  if (S.dailySnapshots[today] && !confirm('今日已有快照，覆盖？')) return;
  saveSnapAndDB(today, snap); renderSnapCal(); showToast(`✅ 快照已保存 · 净值 ${f2(d.calcNav)}`, 'success', 3000);
};

function renderSnapCal() {
  document.getElementById('snap-cal-lbl').textContent = new Date(snapCalY, snapCalM, 1).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
  const today = new Date().toISOString().split('T')[0];
  const fd = new Date(snapCalY, snapCalM, 1).getDay(), dim = new Date(snapCalY, snapCalM + 1, 0).getDate(), pd = new Date(snapCalY, snapCalM, 0).getDate();
  const tradeDates = new Set(S.trades.map(t => t.date)); const startDate = firstDepositDate || today;
  let h = '';
  for (let i = 0; i < fd; i++) h += `<div class="cd om">${pd - fd + 1 + i}</div>`;
  for (let d2 = 1; d2 <= dim; d2++) {
    const ds = `${snapCalY}-${String(snapCalM + 1).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
    const hasSaved = !!S.dailySnapshots[ds], isBeforeStart = ds < startDate, hasTA = tradeDates.has(ds);
    let style = '', dot = '', oc = '', ec = '';
    if (snapMode === 'saved') { if (hasSaved) { style = 'background:var(--green)18;border-color:var(--green)44;'; dot = '<div class="cal-dots"><div class="cal-dot" style="background:var(--green);"></div></div>'; oc = `window._viewSnap('${ds}')`; } else oc = 'window._saveSnapshot()'; }
    else { if (!isBeforeStart) { if (hasTA) { style = 'background:var(--accent)11;border-color:var(--accent)33;'; dot = '<div class="cal-dots"><div class="cal-dot" style="background:var(--accent);"></div></div>'; } oc = `window._viewAutoCalc('${ds}')`; } else ec = 'disabled'; }
    h += `<div class="cd ${ds === today ? 'tdy' : ''} ${ec}" style="${style}" ${oc && !isBeforeStart ? `onclick="${oc}"` : ''}>${d2}${dot}</div>`;
  }
  document.getElementById('snap-cal').innerHTML = h;
}
window._snapCalNav = dir => { snapCalM += dir; if (snapCalM > 11) { snapCalM = 0; snapCalY++; } if (snapCalM < 0) { snapCalM = 11; snapCalY--; } renderSnapCal(); };
window._setSnapMode = setSnapMode;

window._viewSnap = function(date) {
  const snap = S.dailySnapshots[date]; if (!snap) return;
  document.getElementById('snap-title').textContent = `📸 已保存快照 · ${date}`;
  let html = `<div class="snap-mini"><div class="snap-stat"><div class="sl">账户净值</div><div class="sv2">${f2(snap.nav)}</div></div><div class="snap-stat"><div class="sl">YTD业绩</div><div class="sv2 ${(snap.ytdP || 0) >= 0 ? 'up' : 'dn'}">${snap.ytdP != null ? fp(snap.ytdP) : '—'}</div></div><div class="snap-stat"><div class="sl">已实现盈亏</div><div class="sv2 ${snap.totalReal >= 0 ? 'up' : 'dn'}">${fs(snap.totalReal)}</div></div><div class="snap-stat"><div class="sl">账户现金</div><div class="sv2">${f2(snap.cash)}</div></div></div>`;
  if (snap.positions?.length) { const px = snap.pricesUsed || {}; html += `<div class="ct" style="margin-top:14px;margin-bottom:6px;">当日持仓</div><div class="tw"><table><thead><tr><th>股票</th><th>持股数</th><th>均价</th><th>摊薄均价</th><th>价格</th><th>市值</th><th>未实现</th><th>已实现</th></tr></thead><tbody>${snap.positions.map(p => { const cp = px[p.ticker] || p.cp || 0, mv = cp ? p.hq * cp : p.cb, unr = cp ? (cp - (p.ra || 0)) * p.hq : 0; return `<tr><td class="tk">${p.ticker}</td><td>${p.hq}</td><td>$${(p.ra || 0).toFixed(2)}</td><td style="color:var(--text2);">$${(p.dilCost || 0).toFixed(2)}</td><td>${cp ? '$' + cp.toFixed(2) : '—'}</td><td>${cp ? '$' + mv.toFixed(2) : '—'}</td><td class="${unr >= 0 ? 'up' : 'dn'}">${cp ? (unr >= 0 ? '+' : '-') + '$' + Math.abs(unr).toFixed(2) : '—'}</td><td class="${p.realPnL >= 0 ? 'up' : 'dn'}">${p.realPnL ? (p.realPnL >= 0 ? '+' : '-') + '$' + Math.abs(p.realPnL).toFixed(2) : '—'}</td></tr>`; }).join('')}</tbody></table></div>`; }
  html += `<div style="font-size:11px;color:var(--text3);margin-top:10px;">保存于 ${snap.savedAt?.slice(0, 19) || date}</div><div class="mf"><button class="btn bd bsm" onclick="if(confirm('删除此快照？')){window._deleteSnap('${date}');}">删除快照</button></div>`;
  document.getElementById('snap-body').innerHTML = html; openModal('modal-snap');
};
window._deleteSnap = function(date) { deleteSnapAndDB(date); renderSnapCal(); closeModal('modal-snap'); };

window._viewAutoCalc = function(date) {
  const result = calcPortAtDate(S, date), hasHP = result.positions.some(p => p.cp > 0), hasAnyPos = result.positions.length > 0;
  document.getElementById('snap-title').textContent = `🔍 历史重算 · ${date}`;
  let html = '';
  if (!hasHP && hasAnyPos) html += `<div style="background:var(--yellow)11;border:1px solid var(--yellow)33;border-radius:7px;padding:10px;margin-bottom:12px;font-size:12px;color:var(--yellow);">⚠️ 未找到 ${date} 的历史收盘价，请先点击「📈 历史行情」</div>`;
  html += `<div class="snap-mini"><div class="snap-stat"><div class="sl">估算净值</div><div class="sv2">${hasHP || !hasAnyPos ? f2(result.nav) : '需历史行情'}</div></div><div class="snap-stat"><div class="sl">YTD业绩</div><div class="sv2 ${(result.ytdP || 0) >= 0 ? 'up' : 'dn'}">${result.ytdP != null && (hasHP || !hasAnyPos) ? fp(result.ytdP) : '—'}</div></div><div class="snap-stat"><div class="sl">账户现金</div><div class="sv2">${f2(result.cash)}</div></div><div class="snap-stat"><div class="sl">已实现盈亏</div><div class="sv2 ${result.real >= 0 ? 'up' : 'dn'}">${result.real !== 0 ? fs(result.real) : '—'}</div></div></div>`;
  if (hasAnyPos) html += `<div class="ct" style="margin-top:14px;margin-bottom:6px;">当日持仓</div><div class="tw"><table><thead><tr><th>股票</th><th>持股数</th><th>均价</th><th>摊薄均价</th><th>收盘价</th><th>市值</th><th>未实现</th><th>已实现</th></tr></thead><tbody>${result.positions.map(p => `<tr><td class="tk">${p.ticker}</td><td>${p.hq}</td><td>$${p.ra.toFixed(2)}</td><td style="color:var(--text2);">$${p.dilCost.toFixed(2)}</td><td>${p.cp ? '$' + p.cp.toFixed(2) : '<span style="color:var(--text3)">无数据</span>'}</td><td>${p.cp ? '$' + p.mv.toFixed(2) : '—'}</td><td class="${p.unr >= 0 ? 'up' : 'dn'}">${p.cp ? (p.unr >= 0 ? '+' : '-') + '$' + Math.abs(p.unr).toFixed(2) : '—'}</td><td class="${p.realPnL >= 0 ? 'up' : 'dn'}">${p.realPnL !== 0 ? (p.realPnL >= 0 ? '+' : '-') + '$' + Math.abs(p.realPnL).toFixed(2) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  else html += '<div class="empty"><div class="ei">📋</div><div>该日期之前暂无持仓</div></div>';
  document.getElementById('snap-body').innerHTML = html; openModal('modal-snap');
};

// ─── 分析 & 日志 ─────────────────────────────────────────────
window._sharedCalNav = dir => { sharedCalM += dir; if (sharedCalM > 11) { sharedCalM = 0; sharedCalY++; } if (sharedCalM < 0) { sharedCalM = 11; sharedCalY--; } renderSharedCal(); };

function hasAnalysisOnDate(date) {
  return Object.keys(S.analysisData || {}).filter(k => k.endsWith('__' + date)).some(k => {
    const d = S.analysisData[k]; if (!d) return false;
    if ((d.conclusion || '').trim() || (d.conclusionSignal || '').trim() || (d.news || '').trim()) return true;
    return ['tech','fund'].some(pfx => d[pfx] && (Object.values(d[pfx].signals || {}).some(v => (v || '').trim()) || Object.values(d[pfx].texts || {}).some(v => (v || '').trim())));
  });
}

function renderSharedCal() {
  const lbl = document.getElementById('shared-cal-lbl'); if (lbl) lbl.textContent = new Date(sharedCalY, sharedCalM, 1).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
  const today = new Date().toISOString().split('T')[0];
  const fd = new Date(sharedCalY, sharedCalM, 1).getDay(), dim = new Date(sharedCalY, sharedCalM + 1, 0).getDate(), pd = new Date(sharedCalY, sharedCalM, 0).getDate();
  let h = '';
  for (let i = 0; i < fd; i++) h += `<div class="cd om">${pd - fd + 1 + i}</div>`;
  for (let d2 = 1; d2 <= dim; d2++) {
    const ds = `${sharedCalY}-${String(sharedCalM + 1).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
    const hasJ = !!S.journalEntries?.[ds], hasA = hasAnalysisOnDate(ds), isSel = ds === sharedCalDate;
    let dots = '';
    if (hasJ || hasA) { dots = '<div class="cal-dots">'; if (hasJ) dots += '<div class="cal-dot" style="background:var(--accent);"></div>'; if (hasA) dots += '<div class="cal-dot" style="background:var(--yellow);"></div>'; dots += '</div>'; }
    h += `<div class="cd ${ds === today ? 'tdy' : ''} ${isSel ? 'sel' : ''}" onclick="window._selectSharedDate('${ds}')">${d2}${dots}</div>`;
  }
  const grid = document.getElementById('shared-cal'); if (grid) grid.innerHTML = h;
  const sdl = document.getElementById('scan-date-lbl'); if (sdl) sdl.textContent = sharedCalDate;
}

window._selectSharedDate = function(date) {
  flushAllOpenAccSaves(); sharedCalDate = date; curJDate = date;
  renderSharedCal();
  if (curAJView === 'stock') renderAccordionList();
  else if (curAJView === 'scan') renderScan();
  else if (curAJView === 'journal') viewJ(date);
};

window._setAJView = function(v) {
  curAJView = v;
  ['stock','scan','journal'].forEach(n => { document.getElementById('av-' + n).style.display = n === v ? '' : 'none'; document.getElementById('aj-tab-' + n)?.classList.toggle('active', n === v); });
  const addBtn = document.getElementById('aj-add-btn'); if (addBtn) addBtn.style.display = v === 'stock' ? '' : 'none';
  const jRecent = document.getElementById('j-recent-panel'); if (jRecent) jRecent.style.display = v === 'journal' ? '' : 'none';
  if (v === 'stock') renderAccordionList(); else if (v === 'scan') renderScan(); else if (v === 'journal') viewJ(sharedCalDate);
};

// ─── Accordion 分析 ──────────────────────────────────────────
function getSig(data, prefix, key) { return data[prefix]?.signals?.[key] || ''; }
function getTxt(data, prefix, key) { return data[prefix]?.texts?.[key] || ''; }

function renderAccordionList() {
  const el = document.getElementById('acc-list'); if (!el) return;
  if (!S.trackStocks.length) { el.innerHTML = '<div class="card"><div class="empty"><div class="ei">🔬</div><div>点击「+ 添加股票」开始跟踪</div></div></div>'; return; }
  const date = sharedCalDate;
  el.innerHTML = S.trackStocks.map(stk => {
    const t = stk.ticker, key = `${t}__${date}`, data = S.analysisData?.[key] || {}, cs = data.conclusionSignal || '', col = CMAP[cs] || 'var(--text3)', isOpen = openAccordions.has(t), tid_ = tid(t);
    return `<div class="acc-item ${isOpen ? 'open' : ''}" id="acc-${tid_}"><div class="acc-hdr" onclick="window._toggleAcc('${t}')"><span class="acc-hdr-tick">${t}</span><span class="acc-hdr-name">${stk.name || ''}</span><span class="acc-hdr-stats">${cs ? `<span style="background:${col}22;color:${col};padding:1px 8px;border-radius:20px;font-size:11px;font-weight:700;">${cs}</span>` : ''}</span><span class="acc-chevron">▼</span></div><div class="acc-body">${isOpen ? renderAccBody(t, tid_, date, data) : ''}</div></div>`;
  }).join('');
  openAccordions.forEach(t => { const item = document.getElementById('acc-' + tid(t)); if (item?.classList.contains('open')) { bindAccBodyEvents(t, tid(t)); aSubTabInAcc(item.querySelector('.a-stabs .tab'), `a-tech-${tid(t)}`, tid(t)); } });
}

function renderAccBody(ticker, tid_, date, data) {
  const cs = data.conclusionSignal || '', ct = data.conclusion || '';
  const cMapBtns = Object.entries(CMAP).map(([sig, col]) => `<button class="csb ${cs === sig ? 'active' : ''}" data-sig="${sig}" style="background:${col}22;color:${col};border:1px solid ${col}44;">${sig}</button>`).join('');
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px;"><span style="font-size:12px;color:var(--text3);">分析日期: <b style="color:var(--text);">${date}</b></span><div style="display:flex;gap:6px;"><button class="btn bs bsm btn-reset-acc" style="color:var(--text2);">恢复默认</button><button class="btn bd bsm btn-remove-stock">移除股票</button></div></div><div class="cb2"><div style="font-size:13px;font-weight:700;margin-bottom:8px;">🎯 综合结论</div><div class="csigs">${cMapBtns}</div><textarea id="acc_${tid_}_conc_txt" placeholder="综合多项指标，输出最终研判..." style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:9px;border-radius:7px;font-size:13px;min-height:60px;font-family:var(--f);outline:none;">${ct}</textarea><input type="hidden" id="acc_${tid_}_conc_sig" value="${cs}"></div><div class="tabs a-stabs" id="astabs-${tid_}"><div class="tab active" data-show="a-tech-${tid_}">📈 技术面</div><div class="tab" data-show="a-fund-${tid_}">📋 基本面</div><div class="tab" data-show="a-news-${tid_}">📰 消息面</div></div><div id="a-tech-${tid_}">${renderIRLAcc(TECH,'tech',tid_,data)}</div><div id="a-fund-${tid_}" style="display:none;">${renderIRLAcc(FUND,'fund',tid_,data)}</div><div id="a-news-${tid_}" style="display:none;"><textarea id="acc_${tid_}_news" placeholder="重要消息、公告、新闻事件..." style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:7px;font-size:13px;min-height:120px;font-family:var(--f);outline:none;margin-top:7px;">${data.news || ''}</textarea></div>`;
}

function renderIRLAcc(inds, prefix, tid_, data) {
  return inds.map(ind => {
    const sv = getSig(data, prefix, ind.key), tv = getTxt(data, prefix, ind.key), bc = sv === '多头' ? 'bull' : sv === '空头' ? 'bear' : sv === '观察' ? 'wtch' : '', id_ = 'acc_' + tid_ + '_' + prefix + '_' + ind.key;
    return `<div class="ir ${bc}" id="ir_${id_}"><div class="ir-lbl">${ind.i} ${ind.l}</div><div class="ir-txt"><textarea id="${id_}_txt" placeholder="${ind.l}...">${tv}</textarea></div><div class="ir-sigs">${SIGS.map((s, i) => `<button class="sb ${SCLS[i]} ${sv === s ? 'active' : ''}" data-sig="${s}">${SIGS_LABEL[s]}</button>`).join('')}</div><input type="hidden" id="${id_}_sig" value="${sv}"></div>`;
  }).join('');
}

function bindAccBodyEvents(ticker, tid_) {
  const body = document.getElementById('acc-' + tid_); if (!body) return;
  body.querySelectorAll('.csigs .csb').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = document.getElementById('acc_' + tid_ + '_conc_sig'); if (!el) return;
      const nv = el.value === btn.dataset.sig ? '' : btn.dataset.sig; el.value = nv;
      body.querySelectorAll('.csigs .csb').forEach(b => b.classList.remove('active')); if (nv) btn.classList.add('active');
      saveAndRefresh(ticker);
    });
  });
  TECH.concat(FUND).forEach(ind => {
    ['tech','fund'].forEach(prefix => {
      const id_ = 'acc_' + tid_ + '_' + prefix + '_' + ind.key;
      body.querySelectorAll('#ir_' + id_ + ' .ir-sigs .sb').forEach(btn => {
        btn.addEventListener('click', () => {
          const sigEl = document.getElementById(id_ + '_sig'); if (!sigEl) return;
          const nv = sigEl.value === btn.dataset.sig ? '' : btn.dataset.sig; sigEl.value = nv;
          btn.closest('.ir-sigs').querySelectorAll('.sb').forEach(b => b.classList.remove('active')); if (nv) btn.classList.add('active');
          const row = document.getElementById('ir_' + id_); if (row) { row.className = 'ir'; if (nv === '多头') row.classList.add('bull'); else if (nv === '空头') row.classList.add('bear'); else if (nv === '观察') row.classList.add('wtch'); }
          saveAndRefresh(ticker);
        });
      });
    });
  });
  body.querySelectorAll('textarea').forEach(ta => { ta.addEventListener('input', () => { if (autoSaveTimers[ticker]) clearTimeout(autoSaveTimers[ticker]); autoSaveTimers[ticker] = setTimeout(() => saveAndRefresh(ticker), 300); }); });
  body.querySelectorAll('.a-stabs .tab').forEach(tab => { tab.addEventListener('click', () => aSubTabInAcc(tab, tab.dataset.show, tid_)); });
  const resetBtn = body.querySelector('.btn-reset-acc');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!confirm('确定清空 ' + ticker + ' 在 ' + sharedCalDate + ' 的分析内容？')) return;
    const key = ticker + '__' + sharedCalDate;
    if (S.analysisData) delete S.analysisData[key];
    if (currentUser) DB.saveAnalysis(currentUser.uid, key, {});
    const item = document.getElementById('acc-' + tid_);
    if (item) { item.querySelector('.acc-body').innerHTML = renderAccBody(ticker, tid_, sharedCalDate, {}); bindAccBodyEvents(ticker, tid_); aSubTabInAcc(item.querySelector('.a-stabs .tab'), 'a-tech-' + tid_, tid_); item.querySelector('.acc-hdr-stats').innerHTML = ''; }
    renderSharedCal(); showToast('✅ ' + ticker + ' 当日分析已清空');
  });
  const removeBtn = body.querySelector('.btn-remove-stock');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    if (!confirm('移除 ' + ticker + '？')) return;
    S.trackStocks = S.trackStocks.filter(s => s.ticker !== ticker); openAccordions.delete(ticker); saveMeta(); renderAccordionList();
  });
}

function flushAccSave(ticker) {
  if (autoSaveTimers[ticker]) { clearTimeout(autoSaveTimers[ticker]); delete autoSaveTimers[ticker]; }
  const tid_ = tid(ticker); if (!document.getElementById('acc_' + tid_ + '_conc_txt')) return;
  const date = sharedCalDate, key = ticker + '__' + date;
  const ts = {}, tt = {}, fss = {}, ft = {};
  TECH.forEach(ind => { ts[ind.key] = (document.getElementById('acc_' + tid_ + '_tech_' + ind.key + '_sig') || { value: '' }).value; tt[ind.key] = (document.getElementById('acc_' + tid_ + '_tech_' + ind.key + '_txt') || { value: '' }).value; });
  FUND.forEach(ind => { fss[ind.key] = (document.getElementById('acc_' + tid_ + '_fund_' + ind.key + '_sig') || { value: '' }).value; ft[ind.key] = (document.getElementById('acc_' + tid_ + '_fund_' + ind.key + '_txt') || { value: '' }).value; });
  const d = { conclusion: (document.getElementById('acc_' + tid_ + '_conc_txt') || { value: '' }).value, conclusionSignal: (document.getElementById('acc_' + tid_ + '_conc_sig') || { value: '' }).value, tech: { signals: ts, texts: tt }, fund: { signals: fss, texts: ft }, news: (document.getElementById('acc_' + tid_ + '_news') || { value: '' }).value };
  saveAnalysisAndDB(key, d);
}

function flushAllOpenAccSaves() { openAccordions.forEach(t => flushAccSave(t)); }

function saveAndRefresh(ticker) {
  flushAccSave(ticker);
  const tid_ = tid(ticker), key = ticker + '__' + sharedCalDate, data = (S.analysisData || {})[key] || {}, cs = data.conclusionSignal || '', col = CMAP[cs] || 'var(--text3)';
  const item = document.getElementById('acc-' + tid_); if (item) { const statsEl = item.querySelector('.acc-hdr-stats'); if (statsEl) statsEl.innerHTML = cs ? `<span style="background:${col}22;color:${col};padding:1px 8px;border-radius:20px;font-size:11px;font-weight:700;">${cs}</span>` : ''; }
  renderSharedCal();
}

window._toggleAcc = function(ticker) {
  const tid_ = tid(ticker), item = document.getElementById('acc-' + tid_); if (!item) return;
  if (openAccordions.has(ticker)) { flushAccSave(ticker); openAccordions.delete(ticker); item.classList.remove('open'); item.querySelector('.acc-body').innerHTML = ''; }
  else {
    Array.from(openAccordions).forEach(other => { flushAccSave(other); openAccordions.delete(other); const o = document.getElementById('acc-' + tid(other)); if (o) { o.classList.remove('open'); o.querySelector('.acc-body').innerHTML = ''; } });
    openAccordions.add(ticker); item.classList.add('open');
    const date = sharedCalDate, data = (S.analysisData || {})[ticker + '__' + date] || {};
    item.querySelector('.acc-body').innerHTML = renderAccBody(ticker, tid_, date, data);
    bindAccBodyEvents(ticker, tid_); aSubTabInAcc(item.querySelector('.a-stabs .tab'), 'a-tech-' + tid_, tid_);
  }
};

function aSubTabInAcc(el, showId, tid_) {
  if (!el) return; const stabs = el.closest('.a-stabs'); if (!stabs) return;
  stabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); el.classList.add('active');
  ['a-tech-' + tid_, 'a-fund-' + tid_, 'a-news-' + tid_].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = id === showId ? '' : 'none'; });
}

window._addStock = function() {
  const tick = document.getElementById('as-tick').value.trim().toUpperCase(), name = document.getElementById('as-name').value.trim();
  if (!tick) return; if (S.trackStocks.find(s => s.ticker === tick)) { showToast('已在列表中', 'warn'); return; }
  S.trackStocks.push({ ticker: tick, name }); saveMeta(); renderAccordionList(); closeModal('modal-addstock');
  document.getElementById('as-tick').value = ''; document.getElementById('as-name').value = '';
};

// 扫股
function renderScan() {
  const date = sharedCalDate, wrap = document.getElementById('scan-wrap');
  if (!S.trackStocks.length) { wrap.innerHTML = '<div class="empty"><div class="ei">📊</div><div>请先添加跟踪股票</div></div>'; return; }
  const stocks = S.trackStocks;
  const sc = (sig, isC) => { if (!sig) return `<td style="padding:6px 10px;text-align:center;"><span style="color:var(--text3);font-size:11px;">—</span></td>`; const c = isC ? (CMAP[sig] || 'var(--text2)') : (SCOL[sig] || 'var(--text2)'); return `<td style="padding:6px 10px;text-align:center;"><span style="background:${c}22;color:${c};padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;">${sig}</span></td>`; };
  const sd = stocks.map(s => { const k = `${s.ticker}__${date}`; return { stk: s, d: S.analysisData?.[k] || {} }; });
  let h = `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr><th style="background:var(--bg4);padding:8px 12px;text-align:left;min-width:120px;">指标</th>${stocks.map(s => `<th style="background:var(--bg4);padding:8px 12px;text-align:center;min-width:85px;">${s.ticker}</th>`).join('')}</tr></thead><tbody>`;
  h += `<tr style="background:var(--bg3)55;"><td style="font-weight:700;padding:7px 12px;border-bottom:1px solid var(--border);">🎯 综合结论</td>${sd.map(({ d }) => sc(d.conclusionSignal, true)).join('')}</tr>`;
  h += `<tr><td colspan="${stocks.length + 1}" style="padding:4px 12px;font-size:10px;color:var(--text3);background:var(--bg3)33;border-bottom:1px solid var(--border);">📈 技术面</td></tr>`;
  TECH.forEach(ind => { h += `<tr><td style="padding:6px 12px;border-bottom:1px solid var(--border);">${ind.i} ${ind.l}</td>${sd.map(({ d }) => sc(getSig(d, 'tech', ind.key), false)).join('')}</tr>`; });
  h += `<tr><td colspan="${stocks.length + 1}" style="padding:4px 12px;font-size:10px;color:var(--text3);background:var(--bg3)33;border-bottom:1px solid var(--border);">📋 基本面</td></tr>`;
  FUND.forEach(ind => { h += `<tr><td style="padding:6px 12px;border-bottom:1px solid var(--border);">${ind.i} ${ind.l}</td>${sd.map(({ d }) => sc(getSig(d, 'fund', ind.key), false)).join('')}</tr>`; });
  h += `<tr style="background:var(--bg3)55;"><td style="font-weight:700;padding:7px 12px;">📊 汇总</td>${sd.map(({ d }) => { const b = [...TECH,...FUND].filter(ind => getSig(d,'tech',ind.key)==='多头'||getSig(d,'fund',ind.key)==='多头').length; const br = [...TECH,...FUND].filter(ind => getSig(d,'tech',ind.key)==='空头'||getSig(d,'fund',ind.key)==='空头').length; return `<td style="text-align:center;padding:7px;">${b?`<span style="color:var(--green);font-weight:700;">+${b}</span>`:''} ${br?`<span style="color:var(--red);font-weight:700;">-${br}</span>`:''}</td>`; }).join('')}</tr></tbody></table>`;
  wrap.innerHTML = h;
}

// ─── 日志 ────────────────────────────────────────────────────
function renderJRecent() {
  const el = document.getElementById('j-recent'); if (!el) return;
  const ents = Object.entries(S.journalEntries || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
  if (!ents.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:7px 0;">暂无日志</div>'; return; }
  el.innerHTML = ents.map(([date, e]) => `<div class="j-entry-row" onclick="window._selectSharedDate('${date}');window._setAJView('journal')"><div style="font-size:12px;font-weight:600;">${date}</div><div style="font-size:10px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">${(e.market || e.insights || e.ops || '').slice(0, 35) || '（无摘要）'}</div></div>`).join('');
}

function viewJ(date) {
  curJDate = date; const el = document.getElementById('j-viewer'); if (!el) return;
  const e = S.journalEntries?.[date];
  el.innerHTML = `<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;"><div style="font-size:15px;font-weight:700;">📔 ${date}</div><div class="flex">${e ? `<button class="btn bd bsm" onclick="window._delJ('${date}')">删除</button>` : ''}<button class="btn bp bsm" onclick="window._openJE('${date}')">✏️ ${e ? '编辑' : '新建'}</button></div></div>${e ? `${e.market ? `<div style="margin-bottom:10px;"><div class="ct">市场概述</div><div style="line-height:1.7;white-space:pre-wrap;">${e.market}</div></div>` : ''}${e.ops ? `<div style="margin-bottom:10px;"><div class="ct">操作记录</div><div style="line-height:1.7;white-space:pre-wrap;">${e.ops}</div></div>` : ''}${e.insights ? `<div style="margin-bottom:10px;"><div class="ct">心得体会</div><div style="line-height:1.7;white-space:pre-wrap;">${e.insights}</div></div>` : ''}${e.tags ? `<div><div class="ct">关联股票</div>${e.tags.split(',').map(t => `<span class="tag">${t.trim()}</span>`).join('')}</div>` : ''}${(jImgs[date] || []).length ? `<div style="margin-top:10px;"><div class="ct">图片附件</div><div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:7px;">${(jImgs[date] || []).map(src => `<img src="${src}" style="height:88px;border-radius:6px;object-fit:cover;cursor:zoom-in;" onclick="showLightbox('${src}')">`).join('')}</div></div>` : ''}` : `<div class="empty"><div class="ei">📝</div><div>该日期暂无日志<br><button class="btn bp bsm" style="margin-top:10px;" onclick="window._openJE('${date}')">+ 新建日志</button></div></div>`}</div>`;
}

window._openJE = function(date) {
  const d = date || curJDate; curJDate = d; const e = S.journalEntries?.[d] || {};
  document.getElementById('j-ed-dt').textContent = d;
  ['j-mkt','j-ops','j-ins','j-tags'].forEach((id, i) => document.getElementById(id).value = [e.market, e.ops, e.insights, e.tags][i] || '');
  document.getElementById('j-img-pre').innerHTML = (jImgs[d] || []).map(src => `<img src="${src}" style="height:52px;border-radius:5px;cursor:zoom-in;" onclick="showLightbox('${src}')">`).join('');
  openModal('modal-journal');
};
window._handleImgs = function(input) {
  const prev = document.getElementById('j-img-pre');
  Array.from(input.files).forEach(f => { const r = new FileReader(); r.onload = e => { if (!jImgs[curJDate]) jImgs[curJDate] = []; jImgs[curJDate].push(e.target.result); prev.innerHTML += `<img src="${e.target.result}" style="height:52px;border-radius:5px;cursor:zoom-in;" onclick="showLightbox('${e.target.result}')">`; try { localStorage.setItem('tl_imgs_v2', JSON.stringify(jImgs)); } catch (ex) {} }; r.readAsDataURL(f); });
};
window._saveJournal = function() {
  const entry = { market: document.getElementById('j-mkt').value, ops: document.getElementById('j-ops').value, insights: document.getElementById('j-ins').value, tags: document.getElementById('j-tags').value };
  saveJournalAndDB(curJDate, entry); renderSharedCal(); renderJRecent(); closeModal('modal-journal'); if (curAJView === 'journal') viewJ(curJDate);
};
window._delJ = function(date) { if (!confirm('确定删除该日志？')) return; deleteJournalAndDB(date); renderSharedCal(); renderJRecent(); viewJ(date); };

// ─── 股票详情弹窗 ─────────────────────────────────────────────
window._openSD = function(ticker) {
  curDTick = ticker; document.getElementById('sd-title').textContent = `📈 ${ticker}`;
  document.querySelectorAll('#modal-sd .tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  ['sd-tr','sd-an'].forEach((id, i) => document.getElementById(id).style.display = i === 0 ? '' : 'none');
  const today = new Date().toISOString().split('T')[0], key = `${ticker}__${today}`, adata = S.analysisData?.[key] || {}, cs = adata.conclusionSignal || '', ct = adata.conclusion || '', col = CMAP[cs] || 'var(--border)';
  document.getElementById('sd-concl').innerHTML = `<div style="background:var(--bg3);border:1px solid ${cs ? col + '66' : 'var(--border)'};border-radius:8px;padding:11px;${cs ? 'border-left:4px solid ' + col : ''}"><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:13px;font-weight:700;">🎯 综合结论</span>${cs ? `<span style="background:${col}22;color:${col};padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;">${cs}</span>` : '<span style="color:var(--text3);font-size:12px;">暂无研判</span>'}</div>${ct ? `<div style="font-size:12px;line-height:1.7;margin-top:7px;white-space:pre-wrap;">${ct}</div>` : ''}</div>`;
  const trades = [...S.trades.filter(t => t.ticker === ticker)].sort((a, b) => dtKey(b).localeCompare(dtKey(a)));
  document.getElementById('sd-tr-body').innerHTML = trades.length ? trades.map(t => `<tr><td style="font-size:12px;">${t.datetime || t.date}</td><td>${dirB(t.dir)}</td><td>${t.qty}</td><td>$${(+t.price).toFixed(2)}</td><td>$${(t.qty * t.price).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>$${(t.fee || 0).toFixed(2)}</td><td>${srcTag(t.source)}</td><td style="color:var(--text2)">${t.note || '—'}</td></tr>`).join('') : '<tr><td colspan="8"><div class="empty" style="padding:12px">暂无记录</div></td></tr>';
  openModal('modal-sd');
};
window._sdTab = function(el, showId) { document.querySelectorAll('#modal-sd .tab').forEach(t => t.classList.remove('active')); el.classList.add('active'); ['sd-tr','sd-an'].forEach(id => document.getElementById(id).style.display = id === showId ? '' : 'none'); if (showId === 'sd-an') renderSDAn(); };
function renderSDAn() {
  const today = new Date().toISOString().split('T')[0], key = `${curDTick}__${today}`, data = S.analysisData?.[key] || {};
  const ts = TECH.map(i => getSig(data, 'tech', i.key)), fs2 = FUND.map(i => getSig(data, 'fund', i.key));
  const SCOL2 = { 多头: 'var(--green)', 空头: 'var(--red)', 中性: 'var(--text2)', 观察: 'var(--yellow)' };
  const grid = (inds, pfx, sigs) => `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px;">${inds.map((ind, i) => { const s = sigs[i], t = getTxt(data, pfx, ind.key), c = SCOL2[s] || 'var(--border)'; return `<div style="background:var(--bg3);border:1px solid ${s ? c + '55' : 'var(--border)'};border-radius:7px;padding:9px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;"><span style="font-size:11px;font-weight:600;">${ind.i} ${ind.l}</span>${s ? `<span style="background:${c}22;color:${c};padding:1px 7px;border-radius:20px;font-size:10px;font-weight:700;">${s}</span>` : ''}</div><div style="font-size:10px;color:var(--text2);line-height:1.5;">${t || '暂无记录'}</div></div>`; }).join('')}</div>`;
  document.getElementById('sd-an').innerHTML = `<div style="margin-top:8px;"><div class="ct">📈 技术面</div>${grid(TECH,'tech',ts)}<div class="ct">📋 基本面</div>${grid(FUND,'fund',fs2)}</div>`;
}

// ─── 设置 UI ─────────────────────────────────────────────────
function populateSettingsUI() {
  const cfg = S.flexConfig || {};
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('set-token', cfg.token || ''); setVal('set-queryid', cfg.queryId || ''); setVal('set-autosync', String(cfg.autoSync || 0));
  const lst = document.getElementById('last-sync-time'); if (lst) lst.textContent = cfg.lastSync ? new Date(cfg.lastSync).toLocaleString('zh-CN') : '—';
}

window._saveSettings = function() {
  if (!S.flexConfig) S.flexConfig = {};
  S.flexConfig.token    = document.getElementById('set-token')?.value?.trim() || '';
  S.flexConfig.queryId  = document.getElementById('set-queryid')?.value?.trim() || '';
  S.flexConfig.autoSync = parseInt(document.getElementById('set-autosync')?.value || '0');
  saveMeta(); updateFlexStatus(); startFlexAutoTimer(); showToast('✅ 设置已保存'); flexLog('配置已保存', 'log-ok');
};

function updateFlexStatus() {
  const cfg = S.flexConfig || {}, dot = document.getElementById('flex-dot'), txt = document.getElementById('flex-status-txt'), banner = document.getElementById('flex-banner');
  if (!cfg.token || !cfg.queryId) { if (dot) dot.className = 'status-dot off'; if (txt) txt.textContent = 'Flex 未配置'; if (banner) banner.style.display = 'none'; }
  else { if (dot) dot.className = 'status-dot warn'; if (txt) txt.textContent = 'Flex已配置'; if (banner) banner.style.display = 'flex'; document.getElementById('flex-banner-txt').textContent = cfg.lastSync ? `上次同步: ${new Date(cfg.lastSync).toLocaleString('zh-CN')}` : '尚未同步'; }
}
function updateProxyStatusUI(online) {
  const dot = document.getElementById('flex-dot'), txt = document.getElementById('flex-status-txt'), cfg = S.flexConfig || {};
  if (!cfg.token || !cfg.queryId) return;
  if (online) { if (dot) dot.className = 'status-dot ok'; if (txt) txt.textContent = '代理在线 ✅'; }
  else { if (dot) dot.className = 'status-dot warn'; if (txt) txt.textContent = '代理未运行 ⚠️'; }
}
function startFlexAutoTimer() { if (flexAutoTimer) clearInterval(flexAutoTimer); const mins = S.flexConfig?.autoSync || 0; if (mins > 0) flexAutoTimer = setInterval(() => window._fetchFlexData(false), mins * 60 * 1000); }

window._clearFlexData = function() { if (!confirm('确定清除所有Flex导入的数据？')) return; if (currentUser) DB.clearFlexRecords(currentUser.uid, S.trades, S.cashFlows); S.trades = S.trades.filter(t => t.source !== 'flex'); S.cashFlows = S.cashFlows.filter(c => c.source !== 'flex'); renderAll(); showToast('✅ Flex数据已清除', 'warn'); };
window._clearAllData = async function() { if (!confirm('⚠️ 确定清除全部数据？')) return; if (!confirm('再次确认：不可撤销！')) return; if (currentUser) await DB.clearAllUserData(currentUser.uid); S = { cashFlows: [], trades: [], trackStocks: [], analysisData: {}, journalEntries: {}, dailySnapshots: {}, prices: {}, flexConfig: S.flexConfig || {}, sectorPlan: [], portOrder: [] }; renderAll(); showToast('✅ 数据已清除', 'warn'); };

// ─── Lightbox ────────────────────────────────────────────────
window.showLightbox  = src => { document.getElementById('lightbox-img').src = src; document.getElementById('lightbox').classList.add('show'); };
window.closeLightbox = ()  => document.getElementById('lightbox').classList.remove('show');

// ─── 全局暴露给 HTML onclick ─────────────────────────────────
window.nav           = nav;
window.openModal     = openModal;
window.closeModal    = closeModal;
window.switchChart   = switchChart;
window.switchRange   = switchRange;
window.openSectorEditor = openSectorEditor;

window.addEventListener('resize', () => { renderChart(); const d = calcAll(S); if (d.active.length) renderPortCharts(d); });
