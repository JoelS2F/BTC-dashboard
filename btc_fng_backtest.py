#!/usr/bin/env python3
"""
BTC Fear & Greed Index Backtest Engine
======================================
Fetches full F&G history (Feb 2018+) and BTC daily prices from CoinGecko.
Simulates contrarian strategy: enter LONG on Extreme Fear, exit on neutral recovery.
Outputs btc_fng_backtest.json for dashboard consumption.

Strategy variants tested:
  V1: Enter when 14d SMA < 25, exit when 14d SMA > 50
  V2: Enter when 14d SMA < 20, exit when 14d SMA > 45 (tighter)
  V3: Enter when 14d SMA < 30, exit when 14d SMA > 55 (looser)
  V4: Enter when raw F&G < 15, exit when raw F&G > 50 (no SMA, extreme only)
"""

import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import statistics

SCRIPT_DIR = Path(__file__).parent
OUTPUT_FILE = SCRIPT_DIR / "btc_fng_backtest.json"

# ─── DATA FETCHING ───────────────────────────────────────────────────────────

def fetch_fng_history():
    """Fetch full Fear & Greed history from Alternative.me (limit=0 = all)."""
    url = "https://api.alternative.me/fng/?limit=0&format=json"
    print("[Backtest] Fetching full F&G history...")
    req = Request(url)
    req.add_header("User-Agent", "BTC-Dashboard-Backtest/1.0")
    with urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    entries = data.get("data", [])
    # Convert to {date: value} sorted oldest first
    result = []
    for e in entries:
        ts = int(e["timestamp"])
        dt = datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
        result.append({"date": dt, "value": int(e["value"]), "classification": e["value_classification"]})
    result.sort(key=lambda x: x["date"])
    print(f"  [OK] {len(result)} days of F&G data ({result[0]['date']} to {result[-1]['date']})")
    return result


def fetch_btc_price_history():
    """Fetch BTC daily close from CryptoCompare (free, no key, 2000/call limit)."""
    print("[Backtest] Fetching BTC price history from CryptoCompare...")
    result = {}
    # CryptoCompare histoday: limit=2000 max, use toTs to paginate backwards
    # Call 1: latest 2000 days (~2020-now)
    # Call 2: 2000 days before that (~2015-2020)
    to_ts = None  # None = current time
    for chunk in range(2):
        url = "https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000"
        if to_ts:
            url += f"&toTs={to_ts}"
        req = Request(url)
        req.add_header("User-Agent", "BTC-Dashboard-Backtest/1.0")
        try:
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
            entries = data.get("Data", {}).get("Data", [])
            new_count = 0
            earliest_ts = None
            for e in entries:
                if e.get("close", 0) <= 0:
                    continue
                ts = e["time"]
                dt = datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
                if dt not in result:
                    result[dt] = e["close"]
                    new_count += 1
                if earliest_ts is None or ts < earliest_ts:
                    earliest_ts = ts
            print(f"  [OK] Chunk {chunk+1}: {len(entries)} entries, {new_count} new (total: {len(result)})")
            to_ts = earliest_ts - 86400 if earliest_ts else None
        except Exception as e:
            print(f"  [ERR] Chunk {chunk+1}: {e}")
            break
        time.sleep(1)
    print(f"  [OK] Total: {len(result)} unique daily prices")
    return result


# ─── SMA COMPUTATION ─────────────────────────────────────────────────────────

def compute_sma(fng_data, window=14):
    """Add SMA column to F&G data."""
    for i in range(len(fng_data)):
        start = max(0, i - window + 1)
        window_slice = fng_data[start:i + 1]
        fng_data[i]["sma"] = sum(d["value"] for d in window_slice) / len(window_slice)
    return fng_data


# ─── REGIME DETECTION (ported from FAI dashboard) ────────────────────────────

def compute_regime(btc_prices, fng_data, lookback=30):
    """
    Compute 30d autocorrelation regime for each date.
    Trending (autocorr > 0.15): sustained directional moves
    Mean-reverting (autocorr < -0.15): choppy, oscillating
    Mixed: in between

    Also compute 30d momentum (return) and 30d realized volatility.
    """
    # Build sorted daily returns
    dates = sorted(btc_prices.keys())
    returns_by_date = {}
    for i in range(1, len(dates)):
        prev = btc_prices[dates[i - 1]]
        curr = btc_prices[dates[i]]
        if prev > 0:
            returns_by_date[dates[i]] = (curr - prev) / prev

    regime_by_date = {}
    for i in range(lookback, len(dates)):
        window_dates = dates[i - lookback:i]
        rets = [returns_by_date.get(d, 0) for d in window_dates]
        if len(rets) < lookback:
            regime_by_date[dates[i]] = {"regime": "mixed", "autocorr": 0, "momentum": 0, "volatility": 0}
            continue

        # Autocorrelation (lag-1)
        mean_r = sum(rets) / len(rets)
        var_r = sum((r - mean_r) ** 2 for r in rets) / len(rets)
        if var_r > 0:
            autocorr = sum((rets[j] - mean_r) * (rets[j - 1] - mean_r) for j in range(1, len(rets))) / (len(rets) * var_r)
        else:
            autocorr = 0

        # 30d return (momentum)
        p_start = btc_prices.get(dates[i - lookback])
        p_end = btc_prices.get(dates[i])
        momentum = ((p_end - p_start) / p_start * 100) if p_start and p_end else 0

        # Realized volatility (annualized)
        vol = (sum(r ** 2 for r in rets) / len(rets)) ** 0.5 * (252 ** 0.5) if rets else 0

        if autocorr > 0.15:
            regime = "trending"
        elif autocorr < -0.15:
            regime = "mean_reverting"
        else:
            regime = "mixed"

        regime_by_date[dates[i]] = {
            "regime": regime,
            "autocorr": round(autocorr, 4),
            "momentum": round(momentum, 2),
            "volatility": round(vol * 100, 2),
        }

    return regime_by_date


# ─── MOVING AVERAGE FOR MAX PAIN PROXY ───────────────────────────────────────

def compute_price_ma(btc_prices, window=30):
    """Compute 30d SMA of BTC price as a Max Pain proxy for backtest.
    Rationale: Max Pain tends to cluster around recent price consensus (MA).
    When price is significantly below its 30d MA, it's analogous to being below Max Pain.
    """
    dates = sorted(btc_prices.keys())
    ma_by_date = {}
    for i in range(len(dates)):
        start = max(0, i - window + 1)
        window_prices = [btc_prices[dates[j]] for j in range(start, i + 1)]
        ma_by_date[dates[i]] = sum(window_prices) / len(window_prices)
    return ma_by_date


# ─── V5 FORTIFIED STRATEGY ──────────────────────────────────────────────────

def simulate_v5_fortified(fng_data, btc_prices, regime_data, price_ma,
                           fng_entry=15, fng_exit=50, circuit_breaker=0.15,
                           adaptive_trail=True, require_below_ma=True,
                           block_trending_bear=True, use_sma=False, name="V5"):
    """
    V5 Fortified Strategy — combines F&G entry with FAI-style protections.

    Entry conditions (ALL must be true):
      1. F&G signal < fng_entry (extreme fear)
      2. Price below 30d MA (Max Pain proxy) — if require_below_ma
      3. Regime is NOT trending + bearish — if block_trending_bear

    Exit conditions (ANY triggers exit):
      1. F&G signal > fng_exit (sentiment recovery)
      2. Circuit breaker: price drops > circuit_breaker % from entry
      3. Adaptive trailing stop (tightens as profit grows)
    """
    trades = []
    in_position = False
    entry_date = None
    entry_price = None
    entry_signal = None
    peak_price = 0
    skipped_entries = 0

    equity = 1.0
    equity_curve = []
    peak_equity = 1.0
    max_drawdown = 0.0
    daily_returns = []

    for i, day in enumerate(fng_data):
        date = day["date"]
        price = btc_prices.get(date)
        if price is None:
            continue

        signal = day["sma"] if use_sma else day["value"]
        regime = regime_data.get(date, {})
        ma = price_ma.get(date, price)

        if not in_position:
            if signal < fng_entry:
                # Check entry filters
                blocked = False

                # Filter: price must be below 30d MA (dislocation confirmation)
                if require_below_ma and price >= ma:
                    blocked = True

                # Filter: block trending bearish regime
                if block_trending_bear and regime.get("regime") == "trending" and regime.get("momentum", 0) < -10:
                    blocked = True

                if blocked:
                    skipped_entries += 1
                else:
                    in_position = True
                    entry_date = date
                    entry_price = price
                    entry_signal = signal
                    peak_price = price
        else:
            # Track daily return
            prev_date = fng_data[i - 1]["date"] if i > 0 else None
            prev_price = btc_prices.get(prev_date) if prev_date else None
            if prev_price and prev_price > 0:
                daily_ret = (price - prev_price) / prev_price
                daily_returns.append(daily_ret)
                equity *= (1 + daily_ret)

            peak_price = max(peak_price, price)
            pnl_pct = (price - entry_price) / entry_price
            drawdown_from_peak = (peak_price - price) / peak_price if peak_price > 0 else 0

            should_exit = False
            exit_reason = ""

            # Exit 1: Circuit breaker (hard stop from entry)
            if circuit_breaker and pnl_pct <= -circuit_breaker:
                should_exit = True
                exit_reason = f"CircuitBreaker -{circuit_breaker*100:.0f}%"

            # Exit 2: Adaptive trailing stop
            elif adaptive_trail:
                if pnl_pct >= 0.60:
                    trail = 0.07
                elif pnl_pct >= 0.30:
                    trail = 0.10
                elif pnl_pct >= 0.10:
                    trail = 0.15
                else:
                    trail = 0.20
                if drawdown_from_peak >= trail:
                    should_exit = True
                    exit_reason = f"AdaptTrail {trail*100:.0f}%"

            # Exit 3: F&G recovery
            if not should_exit and signal > fng_exit:
                should_exit = True
                exit_reason = f"F&G>{fng_exit}"

            if should_exit:
                ret_pct = (price - entry_price) / entry_price * 100
                hold_days = (datetime.strptime(date, "%Y-%m-%d") - datetime.strptime(entry_date, "%Y-%m-%d")).days
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": date,
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(price, 2),
                    "return_pct": round(ret_pct, 2),
                    "hold_days": hold_days,
                    "entry_signal": round(entry_signal, 1),
                    "exit_signal": round(signal, 1),
                    "exit_reason": exit_reason,
                    "peak_price": round(peak_price, 2),
                })
                in_position = False
                entry_date = None
                entry_price = None
                peak_price = 0

        if in_position:
            peak_equity = max(peak_equity, equity)
            dd = (peak_equity - equity) / peak_equity if peak_equity > 0 else 0
            max_drawdown = max(max_drawdown, dd)

        equity_curve.append({"date": date, "equity": round(equity, 4)})

    # Open position
    open_trade = None
    if in_position and entry_price:
        last_date = fng_data[-1]["date"]
        last_price = btc_prices.get(last_date, entry_price)
        ret_pct = (last_price - entry_price) / entry_price * 100
        hold_days = (datetime.strptime(last_date, "%Y-%m-%d") - datetime.strptime(entry_date, "%Y-%m-%d")).days
        open_trade = {
            "entry_date": entry_date,
            "current_date": last_date,
            "entry_price": round(entry_price, 2),
            "current_price": round(last_price, 2),
            "unrealized_pct": round(ret_pct, 2),
            "hold_days": hold_days,
            "entry_signal": round(entry_signal, 1),
            "peak_price": round(peak_price, 2),
        }

    # Stats
    if trades:
        returns = [t["return_pct"] for t in trades]
        wins = [r for r in returns if r > 0]
        losses = [r for r in returns if r <= 0]
        total_return = 1.0
        for r in returns:
            total_return *= (1 + r / 100)
        total_return = (total_return - 1) * 100
        sharpe = 0
        if daily_returns and len(daily_returns) > 30:
            mean_daily = statistics.mean(daily_returns)
            std_daily = statistics.stdev(daily_returns) if len(daily_returns) > 1 else 1
            sharpe = (mean_daily / std_daily) * (252 ** 0.5) if std_daily > 0 else 0
    else:
        returns, wins, losses = [], [], []
        total_return, sharpe = 0, 0

    first_price = btc_prices.get(fng_data[0]["date"])
    last_price_bh = btc_prices.get(fng_data[-1]["date"])
    bh_return = ((last_price_bh - first_price) / first_price * 100) if first_price and last_price_bh else 0

    stats = {
        "name": name,
        "exit_mode": "v5_fortified",
        "total_trades": len(trades),
        "win_rate": round(len(wins) / len(trades) * 100, 1) if trades else 0,
        "avg_return": round(statistics.mean(returns), 2) if returns else 0,
        "avg_win": round(statistics.mean(wins), 2) if wins else 0,
        "avg_loss": round(statistics.mean(losses), 2) if losses else 0,
        "best_trade": round(max(returns), 2) if returns else 0,
        "worst_trade": round(min(returns), 2) if returns else 0,
        "total_return": round(total_return, 2),
        "max_drawdown": round(max_drawdown * 100, 2),
        "sharpe_ratio": round(sharpe, 3),
        "buy_and_hold_return": round(bh_return, 2),
        "alpha": round(total_return - bh_return, 2),
        "avg_hold_days": round(statistics.mean([t["hold_days"] for t in trades]), 1) if trades else 0,
        "pct_time_in_market": round(sum(t["hold_days"] for t in trades) / max(1, len(fng_data)) * 100, 1),
        "skipped_entries": skipped_entries,
    }

    return {
        "stats": stats,
        "trades": trades,
        "open_trade": open_trade,
        "equity_curve": equity_curve[::7],
    }


# ─── STRATEGY SIMULATION ────────────────────────────────────────────────────

def simulate_strategy(fng_data, btc_prices, entry_threshold, exit_threshold, use_sma=True, name="V1"):
    """
    Simulate contrarian strategy.
    Entry: signal < entry_threshold
    Exit: signal > exit_threshold
    Signal = SMA if use_sma else raw F&G value.
    """
    trades = []
    in_position = False
    entry_date = None
    entry_price = None
    entry_signal = None

    # Track equity curve
    equity = 1.0
    equity_curve = []
    peak_equity = 1.0
    max_drawdown = 0.0
    daily_returns = []

    for i, day in enumerate(fng_data):
        date = day["date"]
        price = btc_prices.get(date)
        if price is None:
            continue

        signal = day["sma"] if use_sma else day["value"]

        if not in_position:
            # Check entry
            if signal < entry_threshold:
                in_position = True
                entry_date = date
                entry_price = price
                entry_signal = signal
        else:
            # Track daily return while in position
            prev_date = fng_data[i - 1]["date"] if i > 0 else None
            prev_price = btc_prices.get(prev_date) if prev_date else None
            if prev_price and prev_price > 0:
                daily_ret = (price - prev_price) / prev_price
                daily_returns.append(daily_ret)
                equity *= (1 + daily_ret)

            # Check exit
            if signal > exit_threshold:
                ret_pct = (price - entry_price) / entry_price * 100
                hold_days = (datetime.strptime(date, "%Y-%m-%d") - datetime.strptime(entry_date, "%Y-%m-%d")).days
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": date,
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(price, 2),
                    "return_pct": round(ret_pct, 2),
                    "hold_days": hold_days,
                    "entry_signal": round(entry_signal, 1),
                    "exit_signal": round(signal, 1),
                })
                in_position = False
                entry_date = None
                entry_price = None

        # Track equity for drawdown
        if in_position:
            peak_equity = max(peak_equity, equity)
            dd = (peak_equity - equity) / peak_equity if peak_equity > 0 else 0
            max_drawdown = max(max_drawdown, dd)

        equity_curve.append({"date": date, "equity": round(equity, 4)})

    # Handle open position
    open_trade = None
    if in_position and entry_price:
        last_date = fng_data[-1]["date"]
        last_price = btc_prices.get(last_date, entry_price)
        ret_pct = (last_price - entry_price) / entry_price * 100
        hold_days = (datetime.strptime(last_date, "%Y-%m-%d") - datetime.strptime(entry_date, "%Y-%m-%d")).days
        open_trade = {
            "entry_date": entry_date,
            "current_date": last_date,
            "entry_price": round(entry_price, 2),
            "current_price": round(last_price, 2),
            "unrealized_pct": round(ret_pct, 2),
            "hold_days": hold_days,
            "entry_signal": round(entry_signal, 1),
        }

    # Compute stats
    if trades:
        returns = [t["return_pct"] for t in trades]
        wins = [r for r in returns if r > 0]
        losses = [r for r in returns if r <= 0]
        total_return = 1.0
        for r in returns:
            total_return *= (1 + r / 100)
        total_return = (total_return - 1) * 100

        # Sharpe (annualized from daily returns)
        sharpe = 0
        if daily_returns and len(daily_returns) > 30:
            mean_daily = statistics.mean(daily_returns)
            std_daily = statistics.stdev(daily_returns) if len(daily_returns) > 1 else 1
            sharpe = (mean_daily / std_daily) * (252 ** 0.5) if std_daily > 0 else 0
    else:
        returns = []
        wins = []
        losses = []
        total_return = 0
        sharpe = 0

    # Buy-and-hold comparison (over same date range as F&G data)
    first_date = fng_data[0]["date"]
    last_date = fng_data[-1]["date"]
    first_price = btc_prices.get(first_date)
    last_price_bh = btc_prices.get(last_date)
    bh_return = ((last_price_bh - first_price) / first_price * 100) if first_price and last_price_bh else 0

    stats = {
        "name": name,
        "entry_threshold": entry_threshold,
        "exit_threshold": exit_threshold,
        "use_sma": use_sma,
        "total_trades": len(trades),
        "win_rate": round(len(wins) / len(trades) * 100, 1) if trades else 0,
        "avg_return": round(statistics.mean(returns), 2) if returns else 0,
        "avg_win": round(statistics.mean(wins), 2) if wins else 0,
        "avg_loss": round(statistics.mean(losses), 2) if losses else 0,
        "best_trade": round(max(returns), 2) if returns else 0,
        "worst_trade": round(min(returns), 2) if returns else 0,
        "total_return": round(total_return, 2),
        "max_drawdown": round(max_drawdown * 100, 2),
        "sharpe_ratio": round(sharpe, 3),
        "buy_and_hold_return": round(bh_return, 2),
        "alpha": round(total_return - bh_return, 2),
        "avg_hold_days": round(statistics.mean([t["hold_days"] for t in trades]), 1) if trades else 0,
        "total_days_in_market": sum(t["hold_days"] for t in trades),
        "pct_time_in_market": round(sum(t["hold_days"] for t in trades) / max(1, len(fng_data)) * 100, 1),
    }

    return {
        "stats": stats,
        "trades": trades,
        "open_trade": open_trade,
        "equity_curve": equity_curve[::7],  # Weekly samples to keep JSON small
    }


# ─── COMBINED V1+V2 STRATEGY ─────────────────────────────────────────────────

def simulate_combined_strategy(fng_data, btc_prices, fng_entry=25, fng_exit=50,
                                exit_mode="fng", trailing_stop=None, take_profit=None,
                                max_hold_days=None, use_sma=True, name="Combined"):
    """
    Combined strategy with multiple exit modes:
      entry: F&G SMA (or raw) < fng_entry
      exit modes:
        "fng"       - exit when F&G SMA > fng_exit (original)
        "trailing"  - trailing stop loss (e.g. 0.15 = 15% from peak)
        "tp_sl"     - take profit + stop loss
        "hybrid"    - F&G exit OR trailing stop, whichever first
        "time"      - exit after max_hold_days
        "adaptive"  - trailing stop tightens as profit grows
    """
    trades = []
    in_position = False
    entry_date = None
    entry_price = None
    entry_signal = None
    peak_price = 0  # For trailing stop

    equity = 1.0
    equity_curve = []
    peak_equity = 1.0
    max_drawdown = 0.0
    daily_returns = []

    for i, day in enumerate(fng_data):
        date = day["date"]
        price = btc_prices.get(date)
        if price is None:
            continue

        signal = day["sma"] if use_sma else day["value"]

        if not in_position:
            if signal < fng_entry:
                in_position = True
                entry_date = date
                entry_price = price
                entry_signal = signal
                peak_price = price
        else:
            # Track daily return
            prev_date = fng_data[i - 1]["date"] if i > 0 else None
            prev_price = btc_prices.get(prev_date) if prev_date else None
            if prev_price and prev_price > 0:
                daily_ret = (price - prev_price) / prev_price
                daily_returns.append(daily_ret)
                equity *= (1 + daily_ret)

            peak_price = max(peak_price, price)
            hold_days = (datetime.strptime(date, "%Y-%m-%d") - datetime.strptime(entry_date, "%Y-%m-%d")).days
            pnl_pct = (price - entry_price) / entry_price
            drawdown_from_peak = (peak_price - price) / peak_price if peak_price > 0 else 0

            should_exit = False
            exit_reason = ""

            if exit_mode == "fng":
                if signal > fng_exit:
                    should_exit = True
                    exit_reason = f"F&G>{fng_exit}"

            elif exit_mode == "trailing":
                if trailing_stop and drawdown_from_peak >= trailing_stop:
                    should_exit = True
                    exit_reason = f"Trail {trailing_stop*100:.0f}%"
                elif signal > fng_exit:
                    should_exit = True
                    exit_reason = f"F&G>{fng_exit}"

            elif exit_mode == "tp_sl":
                if take_profit and pnl_pct >= take_profit:
                    should_exit = True
                    exit_reason = f"TP {take_profit*100:.0f}%"
                elif trailing_stop and pnl_pct <= -trailing_stop:
                    should_exit = True
                    exit_reason = f"SL {trailing_stop*100:.0f}%"
                elif signal > fng_exit:
                    should_exit = True
                    exit_reason = f"F&G>{fng_exit}"

            elif exit_mode == "hybrid":
                if trailing_stop and drawdown_from_peak >= trailing_stop:
                    should_exit = True
                    exit_reason = f"Trail {trailing_stop*100:.0f}%"
                elif signal > fng_exit:
                    should_exit = True
                    exit_reason = f"F&G>{fng_exit}"
                elif max_hold_days and hold_days >= max_hold_days:
                    should_exit = True
                    exit_reason = f"MaxHold {max_hold_days}d"

            elif exit_mode == "adaptive":
                # Trailing stop tightens as profit grows
                # At 0% profit: 20% trailing stop
                # At 30%+ profit: 10% trailing stop
                # At 60%+ profit: 7% trailing stop
                if pnl_pct >= 0.60:
                    adaptive_trail = 0.07
                elif pnl_pct >= 0.30:
                    adaptive_trail = 0.10
                elif pnl_pct >= 0.10:
                    adaptive_trail = 0.15
                else:
                    adaptive_trail = 0.20
                if drawdown_from_peak >= adaptive_trail:
                    should_exit = True
                    exit_reason = f"AdaptTrail {adaptive_trail*100:.0f}%"
                elif signal > fng_exit:
                    should_exit = True
                    exit_reason = f"F&G>{fng_exit}"

            if should_exit:
                ret_pct = (price - entry_price) / entry_price * 100
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": date,
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(price, 2),
                    "return_pct": round(ret_pct, 2),
                    "hold_days": hold_days,
                    "entry_signal": round(entry_signal, 1),
                    "exit_signal": round(signal, 1),
                    "exit_reason": exit_reason,
                    "peak_price": round(peak_price, 2),
                })
                in_position = False
                entry_date = None
                entry_price = None
                peak_price = 0

        if in_position:
            peak_equity = max(peak_equity, equity)
            dd = (peak_equity - equity) / peak_equity if peak_equity > 0 else 0
            max_drawdown = max(max_drawdown, dd)

        equity_curve.append({"date": date, "equity": round(equity, 4)})

    # Open position
    open_trade = None
    if in_position and entry_price:
        last_date = fng_data[-1]["date"]
        last_price = btc_prices.get(last_date, entry_price)
        ret_pct = (last_price - entry_price) / entry_price * 100
        hold_days = (datetime.strptime(last_date, "%Y-%m-%d") - datetime.strptime(entry_date, "%Y-%m-%d")).days
        open_trade = {
            "entry_date": entry_date,
            "current_date": last_date,
            "entry_price": round(entry_price, 2),
            "current_price": round(last_price, 2),
            "unrealized_pct": round(ret_pct, 2),
            "hold_days": hold_days,
            "entry_signal": round(entry_signal, 1),
            "peak_price": round(peak_price, 2),
        }

    # Stats
    if trades:
        returns = [t["return_pct"] for t in trades]
        wins = [r for r in returns if r > 0]
        losses = [r for r in returns if r <= 0]
        total_return = 1.0
        for r in returns:
            total_return *= (1 + r / 100)
        total_return = (total_return - 1) * 100
        sharpe = 0
        if daily_returns and len(daily_returns) > 30:
            mean_daily = statistics.mean(daily_returns)
            std_daily = statistics.stdev(daily_returns) if len(daily_returns) > 1 else 1
            sharpe = (mean_daily / std_daily) * (252 ** 0.5) if std_daily > 0 else 0
    else:
        returns, wins, losses = [], [], []
        total_return, sharpe = 0, 0

    first_price = btc_prices.get(fng_data[0]["date"])
    last_price_bh = btc_prices.get(fng_data[-1]["date"])
    bh_return = ((last_price_bh - first_price) / first_price * 100) if first_price and last_price_bh else 0

    stats = {
        "name": name,
        "exit_mode": exit_mode,
        "total_trades": len(trades),
        "win_rate": round(len(wins) / len(trades) * 100, 1) if trades else 0,
        "avg_return": round(statistics.mean(returns), 2) if returns else 0,
        "avg_win": round(statistics.mean(wins), 2) if wins else 0,
        "avg_loss": round(statistics.mean(losses), 2) if losses else 0,
        "best_trade": round(max(returns), 2) if returns else 0,
        "worst_trade": round(min(returns), 2) if returns else 0,
        "total_return": round(total_return, 2),
        "max_drawdown": round(max_drawdown * 100, 2),
        "sharpe_ratio": round(sharpe, 3),
        "buy_and_hold_return": round(bh_return, 2),
        "alpha": round(total_return - bh_return, 2),
        "avg_hold_days": round(statistics.mean([t["hold_days"] for t in trades]), 1) if trades else 0,
        "pct_time_in_market": round(sum(t["hold_days"] for t in trades) / max(1, len(fng_data)) * 100, 1),
    }

    return {
        "stats": stats,
        "trades": trades,
        "open_trade": open_trade,
        "equity_curve": equity_curve[::7],
    }


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("BTC Fear & Greed Backtest Engine")
    print("=" * 60)

    # Fetch data
    fng_raw = fetch_fng_history()
    time.sleep(1)  # Rate limit courtesy
    btc_prices = fetch_btc_price_history()

    # Compute SMAs, regime, and price MA
    fng_data = compute_sma(fng_raw, window=14)
    regime_data = compute_regime(btc_prices, fng_data)
    price_ma = compute_price_ma(btc_prices, window=30)

    print(f"\n[Backtest] Date range: {fng_data[0]['date']} to {fng_data[-1]['date']}")
    trending_days = sum(1 for v in regime_data.values() if v["regime"] == "trending")
    mr_days = sum(1 for v in regime_data.values() if v["regime"] == "mean_reverting")
    print(f"[Backtest] Regime: {trending_days} trending days, {mr_days} mean-reverting, {len(regime_data)-trending_days-mr_days} mixed")

    # ── Phase 1: Original F&G-only strategies ──
    print(f"\n{'='*60}")
    print("PHASE 1: F&G Entry Signal Variants")
    print(f"{'='*60}\n")

    strategies = {
        "v1_standard": simulate_strategy(fng_data, btc_prices, entry_threshold=25, exit_threshold=50, use_sma=True, name="V1: SMA<25 -> SMA>50"),
        "v2_tight": simulate_strategy(fng_data, btc_prices, entry_threshold=20, exit_threshold=45, use_sma=True, name="V2: SMA<20 -> SMA>45"),
        "v3_loose": simulate_strategy(fng_data, btc_prices, entry_threshold=30, exit_threshold=55, use_sma=True, name="V3: SMA<30 -> SMA>55"),
        "v4_raw_extreme": simulate_strategy(fng_data, btc_prices, entry_threshold=15, exit_threshold=50, use_sma=False, name="V4: Raw<15 -> Raw>50"),
    }

    print(f"{'Strategy':<35} {'Trades':>6} {'Win%':>6} {'AvgRet':>8} {'Total':>8} {'MaxDD':>7} {'Sharpe':>7}")
    print("-" * 85)
    for key, result in strategies.items():
        s = result["stats"]
        print(f"{s['name']:<35} {s['total_trades']:>6} {s['win_rate']:>5.1f}% {s['avg_return']:>7.1f}% {s['total_return']:>7.1f}% {s['max_drawdown']:>6.1f}% {s['sharpe_ratio']:>7.3f}")

    # ── Phase 2: Combined V1+V2 with Exit Optimization ──
    print(f"\n{'='*60}")
    print("PHASE 2: Combined V1+V2 with Exit Optimization")
    print("Entry: F&G 14d SMA < 25 (same as V1)")
    print(f"{'='*60}\n")

    combined = {
        # Baseline: same as V1
        "c1_fng_only": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="fng", name="C1: F&G exit only"),

        # Trailing stop 15% from peak
        "c2_trail_15": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="trailing", trailing_stop=0.15, name="C2: Trail 15%"),

        # Trailing stop 20% from peak
        "c3_trail_20": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="trailing", trailing_stop=0.20, name="C3: Trail 20%"),

        # Trailing stop 25% from peak
        "c4_trail_25": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="trailing", trailing_stop=0.25, name="C4: Trail 25%"),

        # Take profit 40% + stop loss 15%
        "c5_tp40_sl15": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="tp_sl", take_profit=0.40, trailing_stop=0.15, name="C5: TP40/SL15"),

        # Take profit 60% + stop loss 20%
        "c6_tp60_sl20": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="tp_sl", take_profit=0.60, trailing_stop=0.20, name="C6: TP60/SL20"),

        # Hybrid: trailing 20% OR F&G>50 OR max 120 days
        "c7_hybrid": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="hybrid", trailing_stop=0.20, max_hold_days=120, name="C7: Hybrid T20/120d"),

        # Hybrid: trailing 15% OR F&G>50 OR max 90 days
        "c8_hybrid_tight": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="hybrid", trailing_stop=0.15, max_hold_days=90, name="C8: Hybrid T15/90d"),

        # Adaptive trailing: tightens as profit grows
        "c9_adaptive": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=25, fng_exit=50,
            exit_mode="adaptive", name="C9: Adaptive Trail"),

        # Tighter entry (SMA<20) + adaptive exit
        "c10_tight_adaptive": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=20, fng_exit=45,
            exit_mode="adaptive", name="C10: Tight+Adaptive"),

        # Raw extreme entry + adaptive exit
        "c11_extreme_adaptive": simulate_combined_strategy(
            fng_data, btc_prices, fng_entry=15, fng_exit=50,
            exit_mode="adaptive", use_sma=False, name="C11: Extreme+Adaptive"),
    }

    print(f"{'Strategy':<35} {'Trades':>6} {'Win%':>6} {'AvgRet':>8} {'Total':>8} {'MaxDD':>7} {'Sharpe':>7} {'AvgDays':>8}")
    print("-" * 95)
    for key, result in combined.items():
        s = result["stats"]
        print(f"{s['name']:<35} {s['total_trades']:>6} {s['win_rate']:>5.1f}% {s['avg_return']:>7.1f}% {s['total_return']:>7.1f}% {s['max_drawdown']:>6.1f}% {s['sharpe_ratio']:>7.3f} {s['avg_hold_days']:>7.1f}")

    # ── Phase 3: V5 Fortified Strategy ──
    print(f"\n{'='*60}")
    print("PHASE 3: V5 Fortified (F&G + Regime + Circuit Breaker)")
    print("Entry: F&G + below-MA filter + regime filter")
    print("Exit: Adaptive trail + circuit breaker + F&G recovery")
    print(f"{'='*60}\n")

    fortified = {
        # V5a: Full fortified — all filters + circuit breaker 15%
        "v5a_full": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=15, fng_exit=50, circuit_breaker=0.15,
            adaptive_trail=True, require_below_ma=True, block_trending_bear=True,
            use_sma=False, name="V5a: Full Fortified"),

        # V5b: Relaxed entry (SMA<25) + all protections
        "v5b_sma_entry": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=25, fng_exit=50, circuit_breaker=0.15,
            adaptive_trail=True, require_below_ma=True, block_trending_bear=True,
            use_sma=True, name="V5b: SMA<25 Fortified"),

        # V5c: No regime filter (test regime filter value)
        "v5c_no_regime": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=15, fng_exit=50, circuit_breaker=0.15,
            adaptive_trail=True, require_below_ma=True, block_trending_bear=False,
            use_sma=False, name="V5c: No Regime Filter"),

        # V5d: No MA filter (test MA filter value)
        "v5d_no_ma": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=15, fng_exit=50, circuit_breaker=0.15,
            adaptive_trail=True, require_below_ma=False, block_trending_bear=True,
            use_sma=False, name="V5d: No MA Filter"),

        # V5e: Circuit breaker 20% (looser stop)
        "v5e_cb20": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=15, fng_exit=50, circuit_breaker=0.20,
            adaptive_trail=True, require_below_ma=True, block_trending_bear=True,
            use_sma=False, name="V5e: CB 20%"),

        # V5f: Circuit breaker 10% (tighter stop)
        "v5f_cb10": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=15, fng_exit=50, circuit_breaker=0.10,
            adaptive_trail=True, require_below_ma=True, block_trending_bear=True,
            use_sma=False, name="V5f: CB 10%"),

        # V5g: No circuit breaker (adaptive only)
        "v5g_no_cb": simulate_v5_fortified(
            fng_data, btc_prices, regime_data, price_ma,
            fng_entry=15, fng_exit=50, circuit_breaker=None,
            adaptive_trail=True, require_below_ma=True, block_trending_bear=True,
            use_sma=False, name="V5g: No CB (Adapt only)"),
    }

    print(f"{'Strategy':<35} {'Trades':>6} {'Win%':>6} {'AvgRet':>8} {'Total':>8} {'MaxDD':>7} {'Sharpe':>7} {'AvgDays':>8} {'Skip':>5}")
    print("-" * 105)
    for key, result in fortified.items():
        s = result["stats"]
        print(f"{s['name']:<35} {s['total_trades']:>6} {s['win_rate']:>5.1f}% {s['avg_return']:>7.1f}% {s['total_return']:>7.1f}% {s['max_drawdown']:>6.1f}% {s['sharpe_ratio']:>7.3f} {s['avg_hold_days']:>7.1f} {s['skipped_entries']:>5}")

    # Print trade detail for all V5 variants
    for key, result in fortified.items():
        if result["trades"]:
            print(f"\n  [{result['stats']['name']} Trades]")
            for t in result["trades"]:
                reason = t.get("exit_reason", "")
                print(f"    {t['entry_date']} -> {t['exit_date']}  ${t['entry_price']:>9,.0f} -> ${t['exit_price']:>9,.0f}  {t['return_pct']:>+7.1f}%  {t['hold_days']:>3}d  {reason}")

    # Find best strategy by Sharpe
    all_strats = {**strategies, **combined, **fortified}
    best_key = max(all_strats.keys(), key=lambda k: all_strats[k]["stats"]["sharpe_ratio"])
    best = all_strats[best_key]["stats"]
    print(f"\n** BEST BY SHARPE: {best['name']} (Sharpe={best['sharpe_ratio']:.3f}, WR={best['win_rate']:.1f}%, Total={best['total_return']:.1f}%) **")

    # Best by total return
    best_ret_key = max(all_strats.keys(), key=lambda k: all_strats[k]["stats"]["total_return"])
    best_ret = all_strats[best_ret_key]["stats"]
    print(f"** BEST BY RETURN: {best_ret['name']} (Total={best_ret['total_return']:.1f}%, Sharpe={best_ret['sharpe_ratio']:.3f}) **")

    # Best by win rate (min 5 trades)
    qualified = {k: v for k, v in all_strats.items() if v["stats"]["total_trades"] >= 5}
    if qualified:
        best_wr_key = max(qualified.keys(), key=lambda k: qualified[k]["stats"]["win_rate"])
        best_wr = qualified[best_wr_key]["stats"]
        print(f"** BEST BY WIN RATE: {best_wr['name']} (WR={best_wr['win_rate']:.1f}%, Trades={best_wr['total_trades']}) **")

    # Open positions
    print("\n[Open Positions]")
    for key, result in all_strats.items():
        if result["open_trade"]:
            ot = result["open_trade"]
            print(f"  {result['stats']['name']}: Entered {ot['entry_date']} at ${ot['entry_price']:,.0f}, now ${ot['current_price']:,.0f} ({ot['unrealized_pct']:+.1f}%, {ot['hold_days']}d)")

    # Trade detail for best strategies
    for label, key in [("BEST SHARPE", best_key), ("BEST RETURN", best_ret_key)]:
        result = all_strats[key]
        if result["trades"]:
            print(f"\n[{label}: {result['stats']['name']} - Trade Detail]")
            print(f"  {'Entry':<12} {'Exit':<12} {'EntryPx':>10} {'ExitPx':>10} {'Return':>8} {'Days':>5} {'Reason':<20}")
            for t in result["trades"]:
                reason = t.get("exit_reason", "F&G")
                print(f"  {t['entry_date']:<12} {t['exit_date']:<12} ${t['entry_price']:>9,.0f} ${t['exit_price']:>9,.0f} {t['return_pct']:>+7.1f}% {t['hold_days']:>5} {reason:<20}")

    # Build output
    output = {
        "_meta": {
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "fng_range": f"{fng_data[0]['date']} to {fng_data[-1]['date']}",
            "fng_days": len(fng_data),
            "btc_price_days": len(btc_prices),
            "best_sharpe": best["name"],
            "best_return": best_ret["name"],
        },
        "strategies": strategies,
        "combined": combined,
        "fortified": fortified,
        "fng_summary": {
            "total_days": len(fng_data),
            "avg_value": round(statistics.mean([d["value"] for d in fng_data]), 1),
            "days_extreme_fear": sum(1 for d in fng_data if d["value"] < 25),
            "days_fear": sum(1 for d in fng_data if 25 <= d["value"] < 45),
            "days_neutral": sum(1 for d in fng_data if 45 <= d["value"] <= 55),
            "days_greed": sum(1 for d in fng_data if 55 < d["value"] <= 75),
            "days_extreme_greed": sum(1 for d in fng_data if d["value"] > 75),
        },
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n[Backtest] Wrote {OUTPUT_FILE} ({OUTPUT_FILE.stat().st_size:,} bytes)")
    print("Done.")


if __name__ == "__main__":
    main()
