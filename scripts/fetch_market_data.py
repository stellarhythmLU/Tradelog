#!/usr/bin/env python3
"""
scripts/fetch_market_data.py — TradeLog 市场数据抓取脚本
========================================================
用途：通过 yfinance 获取美股数据，写入 Firebase Firestore
触发：GitHub Actions 定时任务 或 手动执行

用法：
  python fetch_market_data.py prices      # 仅刷新当前价格（盘前/盘中/盘后）
  python fetch_market_data.py kline       # 刷新价格 + 日K + 周K
  python fetch_market_data.py historical  # 刷新全部历史收盘价（2年）
  python fetch_market_data.py all         # 全量刷新

环境变量（GitHub Secrets）：
  FIREBASE_SERVICE_ACCOUNT  Firebase 服务账号 JSON（完整内容）

配置步骤：
  1. Firebase Console → 项目设置 → 服务账号 → 生成新私钥 → 下载 JSON
  2. GitHub 仓库 → Settings → Secrets → New secret
     名称：FIREBASE_SERVICE_ACCOUNT，值：粘贴 JSON 全文
"""

import sys
import os
import json
import math
import pytz
import traceback
from datetime import datetime, timedelta

import yfinance as yf
import firebase_admin
from firebase_admin import credentials, firestore

# ════════════════════════════════════════════════════════════════
# Firebase 初始化
# ════════════════════════════════════════════════════════════════

def init_firebase():
    """从环境变量初始化 Firebase Admin SDK"""
    sa_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
    if not sa_json:
        raise EnvironmentError(
            "未找到 FIREBASE_SERVICE_ACCOUNT 环境变量\n"
            "请在 GitHub → Settings → Secrets 中添加服务账号 JSON"
        )
    cred = credentials.Certificate(json.loads(sa_json))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


# ════════════════════════════════════════════════════════════════
# 读取需要追踪的股票代码
# ════════════════════════════════════════════════════════════════

def get_all_tickers(db):
    """
    从所有用户数据中汇总需要抓取数据的股票代码。
    读取来源：
      · users/{uid}/config/main → prices 对象键（当前持仓）
      · users/{uid}/config/main → trackStocks 数组（跟踪股票）
      · users/{uid}/trades/{id} → ticker 字段（历史交易）
    """
    tickers = set()
    print("📋 正在读取用户股票清单...")

    # 遍历所有用户
    try:
        users = list(db.collection('users').stream())
    except Exception as e:
        print(f"  ❌ 读取用户列表失败: {e}")
        return []

    for user_doc in users:
        uid = user_doc.id
        try:
            # ── config/main（持仓价格 + 跟踪股票）────────────────
            config_ref = (db.collection('users').document(uid)
                            .collection('config').document('main'))
            config = config_ref.get()
            if config.exists:
                data = config.to_dict()
                # 当前有价格的持仓
                for tk in data.get('prices', {}).keys():
                    if tk and tk.isidentifier() or tk.replace('-','').isalpha():
                        tickers.add(tk.upper())
                # 用户手动添加的跟踪股票
                for stock in data.get('trackStocks', []):
                    tk = stock.get('ticker', '')
                    if tk:
                        tickers.add(tk.upper())

            # ── trades 子集合（含已平仓历史记录）───────────────────
            trades_ref = (db.collection('users').document(uid)
                            .collection('trades'))
            for trade in trades_ref.stream():
                tk = trade.to_dict().get('ticker', '')
                if tk:
                    tickers.add(tk.upper())

        except Exception as e:
            print(f"  ⚠️ 读取用户 {uid[:8]}... 数据失败: {e}")

    # 过滤掉明显无效的代码
    valid = {t for t in tickers if t and 1 <= len(t) <= 10 and t.replace('.','').replace('-','').isalpha()}
    print(f"  共找到 {len(valid)} 个有效股票代码: {', '.join(sorted(valid))}")
    return sorted(valid)


# ════════════════════════════════════════════════════════════════
# 工具函数
# ════════════════════════════════════════════════════════════════

def safe_float(val):
    """安全转换为 float，NaN/None 返回 None"""
    if val is None:
        return None
    try:
        f = float(val)
        return None if math.isnan(f) or math.isinf(f) else round(f, 6)
    except (TypeError, ValueError):
        return None

def safe_int(val):
    """安全转换为 int"""
    f = safe_float(val)
    return int(f) if f is not None else None

def get_market_state():
    """判断当前美东时间的市场状态"""
    et = pytz.timezone('America/New_York')
    now = datetime.now(et)
    h = now.hour + now.minute / 60.0
    if not (0 <= now.weekday() <= 4):   # 周末
        return 'CLOSED'
    if 4.0 <= h < 9.5:
        return 'PRE'
    if 9.5 <= h < 16.0:
        return 'REGULAR'
    if 16.0 <= h < 20.0:
        return 'POST'
    return 'CLOSED'


# ════════════════════════════════════════════════════════════════
# 价格抓取
# ════════════════════════════════════════════════════════════════

def fetch_and_save_prices(db, tickers):
    """
    获取当前价格（含盘前/盘后）并写入 Firestore。
    路径：marketData/prices/tickers/{TICKER}
    """
    if not tickers:
        return
    print(f"\n💹 获取当前价格（共 {len(tickers)} 只）...")
    market_state = get_market_state()
    ok_count = 0

    for ticker in tickers:
        try:
            tkr  = yf.Ticker(ticker)
            info = tkr.fast_info          # 轻量接口，速度快

            regular   = safe_float(getattr(info, 'last_price',       None))
            pre_mkt   = safe_float(getattr(info, 'pre_market_price',  None))
            post_mkt  = safe_float(getattr(info, 'post_market_price', None))
            prev_close= safe_float(getattr(info, 'previous_close',    None))

            # 选取最佳当前价
            if market_state == 'PRE'  and pre_mkt:
                best = pre_mkt
            elif market_state == 'POST' and post_mkt:
                best = post_mkt
            else:
                best = regular

            change_pct = None
            if best and prev_close and prev_close > 0:
                change_pct = round((best - prev_close) / prev_close * 100, 4)

            doc_data = {
                'ticker':              ticker,
                'regularMarketPrice':  regular,
                'preMarketPrice':      pre_mkt,
                'postMarketPrice':     post_mkt,
                'previousClose':       prev_close,
                'bestPrice':           best,
                'changePercent':       change_pct,
                'marketState':         market_state,
                'updatedAt':           firestore.SERVER_TIMESTAMP,
                'updatedAtISO':        datetime.utcnow().isoformat() + 'Z',
            }

            (db.collection('marketData').document('prices')
               .collection('tickers').document(ticker).set(doc_data))

            tag = {'PRE':'盘前','REGULAR':'盘中','POST':'盘后','CLOSED':'收盘后'}.get(market_state, '')
            pct_str = f" ({change_pct:+.2f}%)" if change_pct is not None else ""
            print(f"  ✅ {ticker:<6} ${best or '—'}{pct_str} [{tag}]")
            ok_count += 1

        except Exception as e:
            print(f"  ❌ {ticker}: {e}")

    print(f"  价格更新完成：{ok_count}/{len(tickers)} 只")


# ════════════════════════════════════════════════════════════════
# K 线（OHLCV）抓取
# ════════════════════════════════════════════════════════════════

def fetch_and_save_kline(db, tickers, interval='1d', period='6mo'):
    """
    获取 K 线 OHLCV 数据并写入 Firestore。
    路径：marketData/kline/data/{TICKER}_1d 或 _1wk
    """
    if not tickers:
        return
    suffix = '1d' if interval == '1d' else '1wk'
    label  = '日K' if interval == '1d' else '周K'
    print(f"\n📊 获取{label}数据（interval={interval}, period={period}）...")
    ok_count = 0

    for ticker in tickers:
        try:
            tkr  = yf.Ticker(ticker)
            hist = tkr.history(period=period, interval=interval, auto_adjust=True)

            if hist.empty:
                print(f"  ⚠️ {ticker}: 无数据")
                continue

            # 转为列表格式，NaN → None
            doc_data = {
                'ticker':    ticker,
                'interval':  interval,
                'period':    period,
                'dates':     [d.strftime('%Y-%m-%d') for d in hist.index],
                'open':      [safe_float(v) for v in hist['Open'].tolist()],
                'high':      [safe_float(v) for v in hist['High'].tolist()],
                'low':       [safe_float(v) for v in hist['Low'].tolist()],
                'close':     [safe_float(v) for v in hist['Close'].tolist()],
                'volume':    [safe_int(v)   for v in hist['Volume'].tolist()],
                'count':     len(hist),
                'updatedAt':    firestore.SERVER_TIMESTAMP,
                'updatedAtISO': datetime.utcnow().isoformat() + 'Z',
            }

            doc_id = f"{ticker}_{suffix}"
            (db.collection('marketData').document('kline')
               .collection('data').document(doc_id).set(doc_data))

            start = doc_data['dates'][0] if doc_data['dates'] else '?'
            end   = doc_data['dates'][-1] if doc_data['dates'] else '?'
            print(f"  ✅ {ticker:<6} {label} {len(hist)} 根K线 [{start} → {end}]")
            ok_count += 1

        except Exception as e:
            print(f"  ❌ {ticker} {label}: {e}")
            traceback.print_exc()

    print(f"  {label}更新完成：{ok_count}/{len(tickers)} 只")


# ════════════════════════════════════════════════════════════════
# 历史收盘价抓取（HP 数据，供业绩图表使用）
# ════════════════════════════════════════════════════════════════

def fetch_and_save_historical(db, tickers, period='2y'):
    """
    获取 2 年历史收盘价并写入 Firestore。
    路径：marketData/historical/closes/{TICKER}
    前端可用此数据替换 localStorage 的 HP 缓存，实现跨设备同步。
    """
    if not tickers:
        return
    print(f"\n📈 获取历史收盘价（period={period}）...")
    ok_count = 0

    for ticker in tickers:
        try:
            tkr  = yf.Ticker(ticker)
            hist = tkr.history(period=period, interval='1d', auto_adjust=True)

            if hist.empty:
                print(f"  ⚠️ {ticker}: 无数据")
                continue

            # { 'YYYY-MM-DD': price }
            closes = {
                d.strftime('%Y-%m-%d'): safe_float(v)
                for d, v in hist['Close'].items()
                if safe_float(v) is not None
            }

            doc_data = {
                'ticker':       ticker,
                'closes':       closes,
                'count':        len(closes),
                'startDate':    min(closes.keys()) if closes else None,
                'endDate':      max(closes.keys()) if closes else None,
                'updatedAt':    firestore.SERVER_TIMESTAMP,
                'updatedAtISO': datetime.utcnow().isoformat() + 'Z',
            }

            (db.collection('marketData').document('historical')
               .collection('closes').document(ticker).set(doc_data))

            print(f"  ✅ {ticker:<6} {len(closes)} 个交易日 [{doc_data['startDate']} → {doc_data['endDate']}]")
            ok_count += 1

        except Exception as e:
            print(f"  ❌ {ticker}: {e}")

    print(f"  历史数据更新完成：{ok_count}/{len(tickers)} 只")


# ════════════════════════════════════════════════════════════════
# 主入口
# ════════════════════════════════════════════════════════════════

MODES = {
    'prices':    '当前价格（盘前/盘中/盘后）',
    'kline':     '当前价格 + 日K + 周K',
    'historical':'历史收盘价（2年）+ 日K + 周K',
    'all':       '全量：价格 + 日K + 周K + 历史',
}

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'kline'

    if mode not in MODES:
        print(f"❌ 未知模式: {mode}")
        print(f"   可用模式: {', '.join(MODES.keys())}")
        sys.exit(1)

    print("=" * 60)
    print(f"🚀 TradeLog 市场数据抓取器")
    print(f"   模式：{mode} — {MODES[mode]}")
    print(f"   时间：{datetime.now(pytz.UTC).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"   美东：{datetime.now(pytz.timezone('America/New_York')).strftime('%H:%M ET')} [{get_market_state()}]")
    print("=" * 60)

    # Firebase 初始化
    try:
        db = init_firebase()
        print("✅ Firebase 连接成功\n")
    except Exception as e:
        print(f"❌ Firebase 初始化失败: {e}")
        sys.exit(1)

    # 获取股票列表
    tickers = get_all_tickers(db)
    if not tickers:
        print("⚠️ 未找到任何股票代码，请先在 TradeLog 中导入交易记录")
        sys.exit(0)

    # 按模式执行
    if mode == 'prices':
        fetch_and_save_prices(db, tickers)

    elif mode == 'kline':
        fetch_and_save_prices(db, tickers)
        fetch_and_save_kline(db, tickers, '1d',  '6mo')
        fetch_and_save_kline(db, tickers, '1wk', '2y')

    elif mode == 'historical':
        fetch_and_save_historical(db, tickers, '2y')
        fetch_and_save_kline(db, tickers, '1d',  '6mo')
        fetch_and_save_kline(db, tickers, '1wk', '2y')

    elif mode == 'all':
        fetch_and_save_prices(db, tickers)
        fetch_and_save_kline(db, tickers, '1d',  '6mo')
        fetch_and_save_kline(db, tickers, '1wk', '2y')
        fetch_and_save_historical(db, tickers, '2y')

    print("\n" + "=" * 60)
    print("✅ 全部完成！")
    print("=" * 60)


if __name__ == '__main__':
    main()
