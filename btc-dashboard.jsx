import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';

// ═══════════════════════════════════════════════════════════════════════════════
// BTC Max Pain Intelligence Dashboard
// 6 tabs: Overview, Max Pain Signal, Options Structure, On-Chain, Derivatives, Allocation
// ═══════════════════════════════════════════════════════════════════════════════

const COLORS = {
  bg: '#F4F6F9', surface: '#FFFFFF', card: '#FFFFFF', cardHover: '#F0F3F7',
  accent: '#f7931a', accentDark: '#d97706', accentLight: '#fbbf24',
  green: '#16A34A', greenDark: '#15803d', greenLight: '#22c55e',
  red: '#DC2626', redDark: '#b91c1c', redLight: '#ef4444',
  amber: '#D97706', blue: '#2563EB', purple: '#7C3AED',
  text: '#1E293B', textSecondary: '#64748B', textMuted: '#94A3B8',
  border: '#E2E8F0', borderSubtle: '#CBD5E1',
};

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'maxpain', label: 'Max Pain Signal' },
  { id: 'options', label: 'Options Structure' },
  { id: 'onchain', label: 'On-Chain' },
  { id: 'derivatives', label: 'Derivatives' },
  { id: 'v2strategy', label: 'V2 Strategy' },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmt(n, decimals = 0) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(decimals);
}

function fmtUSD(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function pctColor(n) { return n >= 0 ? COLORS.green : COLORS.red; }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ─── MAX PAIN 30D MA CROSSOVER SIGNAL ─────────────────────────────────────────
function computeMaxPainSignal(priceHistory, maxPainHistory) {
  if (!priceHistory || priceHistory.length === 0) {
    return { currentSignal: 'NEUTRAL', entryPrice: null, entryDate: null, daysInSignal: 0, unrealizedPnl: 0, signalHistory: [], winRate: 0, merged: [], warmingUp: true, historyDays: 0 };
  }

  // Build price map by date
  var priceMap = {};
  priceHistory.forEach(function (p) { priceMap[p.date] = p.price; });

  // Build max pain map by date
  var mpMap = {};
  if (maxPainHistory) maxPainHistory.forEach(function (m) { mpMap[m.date] = m.maxPain; });

  // Merge into date-aligned series
  var allDates = Object.keys(priceMap).sort();
  var merged = allDates.map(function (d) {
    return { date: d, price: priceMap[d], maxPain: mpMap[d] || null };
  });

  // Compute 30D SMA of max pain
  for (var i = 0; i < merged.length; i++) {
    var windowSlice = merged.slice(Math.max(0, i - 29), i + 1);
    var valid = windowSlice.filter(function (d) { return d.maxPain != null; });
    merged[i].maxPain30dMA = valid.length >= 5
      ? valid.reduce(function (s, d) { return s + d.maxPain; }, 0) / valid.length
      : null;
  }

  var warmingUp = !merged.some(function (d) { return d.maxPain30dMA != null; });
  var historyDays = maxPainHistory ? maxPainHistory.length : 0;

  // Detect crossovers
  var signals = [];
  var currentSignal = 'NEUTRAL';
  var entryPrice = null;
  var entryDate = null;
  var daysInSignal = 0;

  for (var j = 1; j < merged.length; j++) {
    if (merged[j].maxPain30dMA == null || merged[j - 1].maxPain30dMA == null) continue;
    var prevAbove = merged[j - 1].price > merged[j - 1].maxPain30dMA;
    var currAbove = merged[j].price > merged[j].maxPain30dMA;

    if (currAbove && !prevAbove) {
      if (currentSignal !== 'NEUTRAL' && entryPrice) {
        var ret = currentSignal === 'LONG'
          ? ((merged[j].price - entryPrice) / entryPrice * 100)
          : ((entryPrice - merged[j].price) / entryPrice * 100);
        signals.push({ date: entryDate, direction: currentSignal, entry: entryPrice, exit: merged[j].price, returnPct: ret, days: daysInSignal });
      }
      currentSignal = 'LONG'; entryPrice = merged[j].price; entryDate = merged[j].date; daysInSignal = 0;
    } else if (!currAbove && prevAbove) {
      if (currentSignal !== 'NEUTRAL' && entryPrice) {
        var ret2 = currentSignal === 'LONG'
          ? ((merged[j].price - entryPrice) / entryPrice * 100)
          : ((entryPrice - merged[j].price) / entryPrice * 100);
        signals.push({ date: entryDate, direction: currentSignal, entry: entryPrice, exit: merged[j].price, returnPct: ret2, days: daysInSignal });
      }
      currentSignal = 'SHORT'; entryPrice = merged[j].price; entryDate = merged[j].date; daysInSignal = 0;
    }
    if (currentSignal !== 'NEUTRAL') daysInSignal++;
  }

  var lastPrice = merged.length > 0 ? merged[merged.length - 1].price : 0;
  var unrealizedPnl = 0;
  if (entryPrice && currentSignal === 'LONG') unrealizedPnl = (lastPrice - entryPrice) / entryPrice * 100;
  if (entryPrice && currentSignal === 'SHORT') unrealizedPnl = (entryPrice - lastPrice) / entryPrice * 100;

  var wins = signals.filter(function (s) { return s.returnPct > 0; });
  var winRate = signals.length > 0 ? (wins.length / signals.length * 100) : 0;
  var avgWin = wins.length > 0 ? wins.reduce(function (s, w) { return s + w.returnPct; }, 0) / wins.length : 0;
  var losses = signals.filter(function (s) { return s.returnPct <= 0; });
  var avgLoss = losses.length > 0 ? losses.reduce(function (s, l) { return s + l.returnPct; }, 0) / losses.length : 0;

  return { currentSignal, entryPrice, entryDate, daysInSignal, unrealizedPnl, signalHistory: signals, winRate, avgWin, avgLoss, merged, warmingUp, historyDays };
}

// ─── ALLOCATION MODEL ─────────────────────────────────────────────────────────
function computeAllocation(data, mpSignal) {
  // 1. Max Pain Signal (30%)
  var mpDirection = mpSignal.currentSignal === 'LONG' ? 1 : mpSignal.currentSignal === 'SHORT' ? -1 : 0;
  var lastMerged = mpSignal.merged.length > 0 ? mpSignal.merged[mpSignal.merged.length - 1] : null;
  var distancePct = lastMerged && lastMerged.maxPain30dMA ? Math.abs(lastMerged.price - lastMerged.maxPain30dMA) / lastMerged.maxPain30dMA : 0;
  var mpScore = clamp(50 + mpDirection * (20 + Math.min(distancePct * 200, 30)), 0, 100);

  // 2. On-Chain Health (25%)
  var onChainScore = 50;
  if (data.glassnode) {
    var gn = data.glassnode;
    var flowScore = 50, soprScore = 50, nuplScore = 50, mvrvScore = 50, addrScore = 50;

    if (gn.exchange_net_flows && gn.exchange_net_flows.length > 0) {
      var recentFlows = gn.exchange_net_flows.slice(-7);
      var avgFlow = recentFlows.reduce(function (s, d) { return s + (d.v || d.value || 0); }, 0) / recentFlows.length;
      flowScore = clamp(50 - avgFlow * 0.00001, 10, 90); // negative = outflow = bullish
    }
    if (gn.sopr && gn.sopr.length > 0) {
      var latestSOPR = gn.sopr[gn.sopr.length - 1].v || gn.sopr[gn.sopr.length - 1].value || 1;
      soprScore = latestSOPR > 1.05 ? 30 : latestSOPR > 1.0 ? 40 : latestSOPR > 0.97 ? 60 : 70;
    }
    if (gn.nupl && gn.nupl.length > 0) {
      var latestNUPL = gn.nupl[gn.nupl.length - 1].v || gn.nupl[gn.nupl.length - 1].value || 0;
      nuplScore = latestNUPL > 0.6 ? 20 : latestNUPL > 0.4 ? 35 : latestNUPL > 0.2 ? 50 : latestNUPL > 0 ? 65 : 80;
    }
    if (gn.mvrv && gn.mvrv.length > 0) {
      var latestMVRV = gn.mvrv[gn.mvrv.length - 1].v || gn.mvrv[gn.mvrv.length - 1].value || 1;
      mvrvScore = latestMVRV > 3.5 ? 15 : latestMVRV > 2.5 ? 30 : latestMVRV > 1.5 ? 50 : latestMVRV > 1 ? 65 : 80;
    }
    if (gn.active_addresses && gn.active_addresses.length > 1) {
      var aa = gn.active_addresses;
      var recent = aa.slice(-7).reduce(function (s, d) { return s + (d.v || d.value || 0); }, 0) / 7;
      var older = aa.slice(-30, -7).reduce(function (s, d) { return s + (d.v || d.value || 0); }, 0) / Math.max(1, aa.slice(-30, -7).length);
      addrScore = older > 0 ? clamp(50 + (recent / older - 1) * 200, 20, 80) : 50;
    }
    onChainScore = flowScore * 0.30 + soprScore * 0.20 + nuplScore * 0.20 + mvrvScore * 0.20 + addrScore * 0.10;
  }

  // 3. Derivatives Sentiment (25%)
  var derivScore = 50;
  var fundingScore = 50, oiScore = 50, pcScore = 50;

  if (data.derivatives.perpFunding != null) {
    var fr = data.derivatives.perpFunding;
    var frAnn = fr * 365 * 100; // annualized %
    fundingScore = frAnn > 30 ? 20 : frAnn > 15 ? 35 : frAnn > 5 ? 45 : frAnn > -5 ? 55 : frAnn > -15 ? 65 : 75;
  }
  if (data.options && data.options.putCallRatio != null) {
    var pc = data.options.putCallRatio;
    pcScore = pc > 1.2 ? 70 : pc > 0.8 ? 55 : pc > 0.5 ? 45 : 30; // high put/call = contrarian bullish
  }
  if (data.derivatives.perpOI != null && data.marketData.mcap > 0) {
    var oiMcap = data.derivatives.perpOI / data.marketData.mcap;
    oiScore = oiMcap > 0.03 ? 30 : oiMcap > 0.02 ? 40 : oiMcap > 0.01 ? 55 : 60;
  }
  derivScore = fundingScore * 0.40 + pcScore * 0.35 + oiScore * 0.25;

  // 4. Price Momentum (20%)
  var momentumScore = 50;
  var md = data.marketData;
  if (md.change7d != null && md.change30d != null) {
    var mom7 = clamp(50 + md.change7d * 2, 10, 90);
    var mom30 = clamp(50 + md.change30d * 0.8, 10, 90);
    momentumScore = mom7 * 0.6 + mom30 * 0.4;
  }

  // Composite
  var composite = mpScore * 0.30 + onChainScore * 0.25 + derivScore * 0.25 + momentumScore * 0.20;

  // Allocation
  var directionalScore = composite - 50;
  var btcPct = clamp(Math.round(40 + directionalScore * 1.6), 0, 100);

  // Circuit breaker
  var cbActive = false, cbLevel = null, cbReasons = [];
  if (md.change24h <= -25) { btcPct = Math.min(btcPct, 0); cbActive = true; cbLevel = 'EXTREME'; cbReasons.push('24h drop > 25%'); }
  else if (md.change24h <= -15) { btcPct = Math.min(btcPct, 15); cbActive = true; cbLevel = 'SEVERE'; cbReasons.push('24h drop > 15%'); }

  var stablesPct = 100 - btcPct;

  // Regime detection (simple from price history)
  var regime = { label: 'NEUTRAL', color: COLORS.amber, bg: 'rgba(217,119,6,0.1)', desc: 'Mixed signals' };
  if (composite >= 65) regime = { label: 'RISK-ON', color: COLORS.green, bg: 'rgba(22,163,74,0.1)', desc: 'Favorable conditions for BTC exposure' };
  else if (composite >= 55) regime = { label: 'LEAN RISK-ON', color: COLORS.greenLight, bg: 'rgba(34,197,94,0.08)', desc: 'Mildly bullish, consider adding' };
  else if (composite <= 35) regime = { label: 'RISK-OFF', color: COLORS.red, bg: 'rgba(220,38,38,0.1)', desc: 'Defensive posture, reduce exposure' };
  else if (composite <= 45) regime = { label: 'LEAN RISK-OFF', color: COLORS.redLight, bg: 'rgba(239,68,68,0.08)', desc: 'Cautious, watch for deterioration' };

  return {
    scores: { maxPain: mpScore, onChain: onChainScore, derivatives: derivScore, momentum: momentumScore },
    composite,
    btcPct, stablesPct,
    regime,
    circuitBreaker: { active: cbActive, level: cbLevel, reasons: cbReasons },
    drivers: {
      mpScore, mpDirection, distancePct,
      flowScore: onChainScore, fundingScore, pcScore, oiScore, momentumScore,
    },
  };
}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
function generateMockData() {
  var price = 84000 + Math.random() * 4000;
  var days = [];
  for (var i = 90; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    days.push({ date: d.toISOString().slice(0, 10), price: price + (Math.random() - 0.5) * 6000, volume: 20e9 + Math.random() * 15e9 });
  }
  return {
    currentPrice: price,
    marketData: { price, mcap: price * 19.8e6, volume24h: 32e9, change24h: (Math.random() - 0.5) * 8, change7d: (Math.random() - 0.5) * 15, change30d: (Math.random() - 0.5) * 25, ath: 109000 },
    priceHistory: days,
    maxPainCurrent: price - 2000 + Math.random() * 4000,
    maxPainDistance: (Math.random() - 0.5) * 10,
    maxPainHistory: days.slice(-30).map(function (d) { return { date: d.date, maxPain: d.price - 1500 + Math.random() * 3000, price: d.price }; }),
    options: { maxPain: price - 1000, putCallRatio: 0.6 + Math.random() * 0.6, totalCallOI: 120000 + Math.random() * 40000, totalPutOI: 80000 + Math.random() * 30000, avgIV: 50 + Math.random() * 20, optionsCount: 3500, strikes: [], strikePain: {} },
    ivTermStructure: [
      { expiry: '28MAR26', avgIV: 48, totalOI: 45000 }, { expiry: '25APR26', avgIV: 52, totalOI: 32000 },
      { expiry: '30MAY26', avgIV: 55, totalOI: 28000 }, { expiry: '27JUN26', avgIV: 58, totalOI: 38000 },
      { expiry: '26SEP26', avgIV: 62, totalOI: 22000 }, { expiry: '26DEC26', avgIV: 65, totalOI: 18000 },
    ],
    glassnode: null,
    derivatives: { funding: null, oi: null, liquidations: null, longShort: null, perpFunding: 0.0001, perpMarkPrice: price, perpOI: 12e9 },
    _isMock: { coingecko: true, deribit: true, coinglass: true, glassnode: true },
    _sources: {},
  };
}

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
function SourceBadge({ label, isMock }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', background: isMock ? 'rgba(217,119,6,0.15)' : 'rgba(22,163,74,0.15)', color: isMock ? COLORS.amber : COLORS.green }}>
      {label}: {isMock ? 'MOCK' : 'LIVE'}
    </span>
  );
}

function MetricCard({ label, value, sub, color, wide }) {
  return (
    <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: '14px 16px', flex: wide ? '1 1 200px' : '1 1 140px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: color || COLORS.text }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SignalBadge({ signal, size }) {
  var bg = signal === 'LONG' ? 'rgba(22,163,74,0.15)' : signal === 'SHORT' ? 'rgba(220,38,38,0.15)' : 'rgba(217,119,6,0.15)';
  var color = signal === 'LONG' ? COLORS.green : signal === 'SHORT' ? COLORS.red : COLORS.amber;
  var sz = size === 'lg' ? { fontSize: 18, padding: '6px 16px' } : { fontSize: 12, padding: '3px 8px' };
  return <span style={{ ...sz, borderRadius: 6, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', background: bg, color }}>{signal}</span>;
}

function ScoreBar({ score, label, color }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
        <span style={{ color: COLORS.textSecondary }}>{label}</span>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', color }}>{score.toFixed(0)}/100</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: COLORS.bg, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: score + '%', borderRadius: 3, background: color || COLORS.accent, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 12, marginTop: 20 }}>{children}</h3>;
}

const chartMargin = { top: 5, right: 10, left: 10, bottom: 5 };

function ChartTooltipContent({ payload, label }) {
  if (!payload || payload.length === 0) return null;
  return (
    <div style={{ background: COLORS.surface, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: 8, fontSize: 11 }}>
      <div style={{ color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
      {payload.map(function (p, i) {
        return <div key={i} style={{ color: p.color || COLORS.text }}>{p.name}: {typeof p.value === 'number' ? p.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : p.value}</div>;
      })}
    </div>
  );
}

// ─── TAB: OVERVIEW (includes Allocation) ──────────────────────────────────────
function OverviewTab({ data, mpSignal, allocation }) {
  var chartData = mpSignal.merged.length > 0 ? mpSignal.merged.slice(-90) : data.priceHistory.slice(-90);

  var signalCards = [
    { label: 'Max Pain Signal', weight: '30%', score: allocation.scores.maxPain, color: COLORS.accent, desc: mpSignal.currentSignal + ' (' + mpSignal.daysInSignal + 'd)' },
    { label: 'On-Chain Health', weight: '25%', score: allocation.scores.onChain, color: COLORS.blue, desc: data.glassnode ? 'Live Glassnode data' : 'No data (mock)' },
    { label: 'Derivatives Sentiment', weight: '25%', score: allocation.scores.derivatives, color: COLORS.purple, desc: data.derivatives.perpFunding != null ? 'Funding: ' + (data.derivatives.perpFunding * 100).toFixed(4) + '%' : 'Limited data' },
    { label: 'Price Momentum', weight: '20%', score: allocation.scores.momentum, color: COLORS.greenLight, desc: '7d: ' + fmtPct(data.marketData.change7d) },
  ];

  return (
    <div>
      {/* Price Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20 }}>
        <span style={{ fontSize: 36, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: COLORS.text }}>{fmtUSD(data.currentPrice)}</span>
        <span style={{ fontSize: 18, fontWeight: 600, color: pctColor(data.marketData.change24h) }}>{fmtPct(data.marketData.change24h)}</span>
        <span style={{ fontSize: 13, color: COLORS.textMuted }}>24h</span>
        <span style={{ fontSize: 14, fontWeight: 500, color: pctColor(data.marketData.change7d) }}>{fmtPct(data.marketData.change7d)}</span>
        <span style={{ fontSize: 13, color: COLORS.textMuted }}>7d</span>
      </div>

      {/* Metric Cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <MetricCard label="Market Cap" value={'$' + fmt(data.marketData.mcap)} />
        <MetricCard label="24h Volume" value={'$' + fmt(data.marketData.volume24h)} />
        <MetricCard label="Max Pain" value={data.maxPainCurrent ? fmtUSD(data.maxPainCurrent) : '—'} sub={data.maxPainCurrent ? fmtPct(data.maxPainDistance) + ' from price' : 'Loading...'} />
        <MetricCard label="Signal" value={<SignalBadge signal={mpSignal.currentSignal} />} sub={mpSignal.daysInSignal > 0 ? mpSignal.daysInSignal + 'd held' : ''} />
        <MetricCard label="Fear & Greed" value={data.fng ? data.fng.current.value : '—'} color={data.fng ? (data.fng.current.value <= 24 ? COLORS.red : data.fng.current.value <= 44 ? COLORS.amber : data.fng.current.value <= 55 ? COLORS.textSecondary : data.fng.current.value <= 75 ? COLORS.green : COLORS.blue) : COLORS.textMuted} sub={data.fng ? data.fng.current.classification : 'Loading...'} />
      </div>

      {/* Price Chart */}
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>90-Day BTC Price vs Max Pain 30D MA</div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="date" tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (d) { return d.slice(5); }} interval={Math.floor(chartData.length / 8)} />
            <YAxis domain={['auto', 'auto']} tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (v) { return '$' + fmt(v); }} />
            <Tooltip content={<ChartTooltipContent />} />
            <Line type="monotone" dataKey="price" stroke={COLORS.text} strokeWidth={2} dot={false} name="BTC Price" />
            <Line type="monotone" dataKey="maxPain30dMA" stroke={COLORS.accent} strokeWidth={2} strokeDasharray="6 3" dot={false} name="Max Pain 30D MA" connectNulls />
            <Line type="monotone" dataKey="maxPain" stroke={COLORS.textMuted} strokeWidth={1} dot={false} name="Max Pain" connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
        {mpSignal.warmingUp && (
          <div style={{ textAlign: 'center', fontSize: 12, color: COLORS.amber, marginTop: 8 }}>
            Warming up: {mpSignal.historyDays}/30 days of Max Pain history collected
          </div>
        )}
      </div>

      {/* Regime Banner + Allocation */}
      <div style={{ background: allocation.regime.bg, border: '1px solid ' + allocation.regime.color + '33', borderRadius: 10, padding: '16px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: allocation.regime.color }}>{allocation.regime.label}</div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{allocation.regime.desc}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 32, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: allocation.regime.color }}>{allocation.composite.toFixed(0)}</div>
          <div style={{ fontSize: 11, color: COLORS.textMuted }}>/ 100</div>
        </div>
      </div>

      {/* Circuit Breaker */}
      {allocation.circuitBreaker.active && (
        <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.red }}>CIRCUIT BREAKER: {allocation.circuitBreaker.level}</div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary }}>{allocation.circuitBreaker.reasons.join(', ')} — BTC capped at {allocation.btcPct}%</div>
        </div>
      )}

      {/* Signal Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        {signalCards.map(function (s) {
          return (
            <div key={s.label} style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>{s.label}</span>
                <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>{s.weight}</span>
              </div>
              <ScoreBar score={s.score} label="" color={s.color} />
              <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 4 }}>{s.desc}</div>
            </div>
          );
        })}
      </div>

      {/* Allocation Bar */}
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 12 }}>Recommended Allocation</div>
        <div style={{ display: 'flex', height: 40, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ width: allocation.btcPct + '%', background: COLORS.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, fontFamily: 'JetBrains Mono, monospace', color: '#fff', transition: 'width 0.5s' }}>
            {allocation.btcPct > 10 ? 'BTC ' + allocation.btcPct + '%' : ''}
          </div>
          <div style={{ width: allocation.stablesPct + '%', background: COLORS.border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14, fontFamily: 'JetBrains Mono, monospace', color: COLORS.textSecondary, transition: 'width 0.5s' }}>
            {allocation.stablesPct > 10 ? 'Stables ' + allocation.stablesPct + '%' : ''}
          </div>
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted }}>
          Formula: BTC% = clamp(40 + (composite - 50) * 1.6, 0, 100). Center: 40% BTC at neutral composite.
        </div>
      </div>
    </div>
  );
}

// ─── TAB: MAX PAIN SIGNAL ─────────────────────────────────────────────────────
function MaxPainTab({ data, mpSignal }) {
  var chartData = mpSignal.merged.slice(-90);

  return (
    <div>
      {/* Signal Status */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <MetricCard label="Current Signal" value={<SignalBadge signal={mpSignal.currentSignal} size="lg" />} wide />
        <MetricCard label="Days Held" value={mpSignal.daysInSignal} color={COLORS.text} />
        <MetricCard label="Entry Price" value={mpSignal.entryPrice ? fmtUSD(mpSignal.entryPrice) : '—'} />
        <MetricCard label="Unrealized P&L" value={fmtPct(mpSignal.unrealizedPnl)} color={pctColor(mpSignal.unrealizedPnl)} />
      </div>

      {/* Main Chart */}
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>BTC Price vs Max Pain 30D MA — Crossover Signal</div>
        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={chartData} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="date" tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (d) { return d.slice(5); }} interval={Math.floor(chartData.length / 10)} />
            <YAxis domain={['auto', 'auto']} tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (v) { return '$' + fmt(v); }} />
            <Tooltip content={<ChartTooltipContent />} />
            <Legend wrapperStyle={{ fontSize: 11, color: COLORS.textSecondary }} />
            <Line type="monotone" dataKey="price" stroke={COLORS.text} strokeWidth={2} dot={false} name="BTC Price" />
            <Line type="monotone" dataKey="maxPain30dMA" stroke={COLORS.accent} strokeWidth={2.5} strokeDasharray="6 3" dot={false} name="Max Pain 30D MA" connectNulls />
            <Line type="monotone" dataKey="maxPain" stroke={COLORS.textMuted} strokeWidth={1} dot={false} name="Max Pain (raw)" connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <MetricCard label="Total Signals" value={mpSignal.signalHistory.length} />
        <MetricCard label="Win Rate" value={fmtPct(mpSignal.winRate).replace('+', '')} color={mpSignal.winRate >= 50 ? COLORS.green : COLORS.red} />
        <MetricCard label="Avg Win" value={fmtPct(mpSignal.avgWin || 0)} color={COLORS.green} />
        <MetricCard label="Avg Loss" value={fmtPct(mpSignal.avgLoss || 0)} color={COLORS.red} />
      </div>

      {/* Signal History Table */}
      {mpSignal.signalHistory.length > 0 && (
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Signal History</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid ' + COLORS.border }}>
                  {['Date', 'Direction', 'Entry', 'Exit', 'Return', 'Days'].map(function (h) {
                    return <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: COLORS.textMuted, fontWeight: 500 }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {mpSignal.signalHistory.slice().reverse().map(function (s, i) {
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid ' + COLORS.borderSubtle }}>
                      <td style={{ padding: '6px 12px', color: COLORS.textSecondary }}>{s.date}</td>
                      <td style={{ padding: '6px 12px' }}><SignalBadge signal={s.direction} /></td>
                      <td style={{ padding: '6px 12px', color: COLORS.text }}>{fmtUSD(s.entry)}</td>
                      <td style={{ padding: '6px 12px', color: COLORS.text }}>{fmtUSD(s.exit)}</td>
                      <td style={{ padding: '6px 12px', color: pctColor(s.returnPct), fontWeight: 600 }}>{fmtPct(s.returnPct)}</td>
                      <td style={{ padding: '6px 12px', color: COLORS.textSecondary }}>{s.days}d</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mpSignal.warmingUp && (
        <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: 16, marginTop: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.amber }}>Signal Warming Up</div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>Collecting Max Pain history: {mpSignal.historyDays}/30 days. Signal accuracy improves with more data.</div>
        </div>
      )}
    </div>
  );
}

// ─── TAB: OPTIONS STRUCTURE ───────────────────────────────────────────────────
function OptionsTab({ data }) {
  var opts = data.options;
  if (!opts) return <div style={{ color: COLORS.textMuted, padding: 40, textAlign: 'center' }}>No options data available. Deribit API may be loading...</div>;

  // Build strike OI chart data (aggregate to nearest $5K)
  var strikeData = [];
  if (opts.strikePain && Object.keys(opts.strikePain).length > 0) {
    var btcPrice = data.currentPrice || 84000;
    var nearStrikes = Object.keys(opts.strikePain).map(Number).filter(function (s) { return Math.abs(s - btcPrice) < 30000; }).sort(function (a, b) { return a - b; });
    strikeData = nearStrikes.map(function (s) {
      var sp = opts.strikePain[s];
      return { strike: '$' + fmt(s), callOI: sp.call_oi, putOI: -sp.put_oi, isMaxPain: s === opts.maxPain };
    });
  }

  var ivData = data.ivTermStructure || [];

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <MetricCard label="Max Pain" value={opts.maxPain ? fmtUSD(opts.maxPain) : '—'} color={COLORS.accent} />
        <MetricCard label="Put/Call Ratio" value={opts.putCallRatio.toFixed(3)} color={opts.putCallRatio > 1 ? COLORS.red : COLORS.green} />
        <MetricCard label="Total Call OI" value={fmt(opts.totalCallOI, 0) + ' BTC'} color={COLORS.green} />
        <MetricCard label="Total Put OI" value={fmt(opts.totalPutOI, 0) + ' BTC'} color={COLORS.red} />
        <MetricCard label="Avg IV" value={opts.avgIV.toFixed(1) + '%'} />
        <MetricCard label="Options Count" value={opts.optionsCount.toLocaleString()} />
      </div>

      {/* OI by Strike */}
      {strikeData.length > 0 && (
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Open Interest by Strike (near price)</div>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={strikeData} margin={chartMargin} stackOffset="sign">
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="strike" tick={{ fill: COLORS.textMuted, fontSize: 9 }} interval={Math.max(0, Math.floor(strikeData.length / 15))} angle={-45} textAnchor="end" height={60} />
              <YAxis tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (v) { return fmt(Math.abs(v)); }} />
              <Tooltip content={<ChartTooltipContent />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="callOI" fill={COLORS.green} name="Call OI" opacity={0.8} />
              <Bar dataKey="putOI" fill={COLORS.red} name="Put OI" opacity={0.8} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* IV Term Structure */}
      {ivData.length > 0 && (
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Implied Volatility Term Structure</div>
          <ResponsiveContainer width="100%" height={250}>
            <ComposedChart data={ivData} margin={chartMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="expiry" tick={{ fill: COLORS.textMuted, fontSize: 10 }} />
              <YAxis yAxisId="left" tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (v) { return v.toFixed(0) + '%'; }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (v) { return fmt(v); }} />
              <Tooltip content={<ChartTooltipContent />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="right" dataKey="totalOI" fill={COLORS.border} name="OI (BTC)" opacity={0.4} />
              <Line yAxisId="left" type="monotone" dataKey="avgIV" stroke={COLORS.accent} strokeWidth={2} dot={{ fill: COLORS.accent, r: 4 }} name="Avg IV %" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── TAB: ON-CHAIN ────────────────────────────────────────────────────────────
function OnChainTab({ data }) {
  var gn = data.glassnode;
  if (!gn) return (
    <div style={{ color: COLORS.textMuted, padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 16, marginBottom: 8 }}>No Glassnode data available</div>
      <div style={{ fontSize: 12 }}>Run btc_prefetch.py to generate btc_glassnode_data.json</div>
    </div>
  );

  function gnChart(title, dataKey, color, refLine) {
    var arr = gn[dataKey];
    if (!arr || arr.length === 0) return null;
    var chartArr = arr.map(function (d) {
      return { date: new Date((d.t || d.timestamp || 0) * 1000).toISOString().slice(0, 10), value: d.v || d.value || 0 };
    });
    return (
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>{title}</div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartArr} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="date" tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (d) { return d.slice(5); }} interval={Math.floor(chartArr.length / 6)} />
            <YAxis tick={{ fill: COLORS.textMuted, fontSize: 10 }} />
            <Tooltip content={<ChartTooltipContent />} />
            {refLine != null && <ReferenceLine y={refLine} stroke={COLORS.textMuted} strokeDasharray="3 3" />}
            <Area type="monotone" dataKey="value" stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} dot={false} name={title} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <SourceBadge label="Glassnode" isMock={data._isMock.glassnode} />
      </div>
      {gnChart('Exchange Net Flows (BTC)', 'exchange_net_flows', COLORS.blue, 0)}
      {gnChart('SOPR (Spent Output Profit Ratio)', 'sopr', COLORS.purple, 1)}
      {gnChart('NUPL (Net Unrealized Profit/Loss)', 'nupl', COLORS.green, 0)}
      {gnChart('MVRV Ratio', 'mvrv', COLORS.amber, 1)}
      {gnChart('Active Addresses', 'active_addresses', COLORS.accent, null)}
    </div>
  );
}

// ─── TAB: DERIVATIVES ─────────────────────────────────────────────────────────
function DerivativesTab({ data }) {
  var deriv = data.derivatives;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <SourceBadge label="Deribit" isMock={data._isMock.deribit} />
        <SourceBadge label="CoinGlass" isMock={data._isMock.coinglass} />
      </div>

      {/* Perp Stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <MetricCard label="Perp Funding (8h)" value={deriv.perpFunding != null ? (deriv.perpFunding * 100).toFixed(4) + '%' : '—'} color={deriv.perpFunding > 0 ? COLORS.green : COLORS.red} sub={deriv.perpFunding != null ? 'Ann: ' + (deriv.perpFunding * 365 * 3 * 100).toFixed(1) + '%' : ''} />
        <MetricCard label="Mark Price" value={deriv.perpMarkPrice ? fmtUSD(deriv.perpMarkPrice) : '—'} />
        <MetricCard label="Perp OI" value={deriv.perpOI ? '$' + fmt(deriv.perpOI) : '—'} />
        {data.options && <MetricCard label="Options P/C Ratio" value={data.options.putCallRatio.toFixed(3)} color={data.options.putCallRatio > 1 ? COLORS.red : COLORS.green} />}
      </div>

      {/* Funding Rate Interpretation */}
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Funding Rate Analysis</div>
        {deriv.perpFunding != null ? (
          <div>
            <div style={{ fontSize: 12, color: COLORS.textSecondary }}>
              {deriv.perpFunding > 0.0003
                ? 'Elevated positive funding — longs are paying shorts. Market may be overleveraged long, which can precede mean-reversion.'
                : deriv.perpFunding > 0
                ? 'Mildly positive funding — normal bullish positioning without excess leverage.'
                : deriv.perpFunding > -0.0003
                ? 'Mildly negative funding — shorts paying longs. Contrarian bullish signal.'
                : 'Deeply negative funding — extreme short crowding. Strong contrarian bullish setup if sustained.'}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: COLORS.textMuted }}>Funding data unavailable. Connect Deribit for live perpetual data.</div>
        )}
      </div>

      {/* CoinGlass data placeholder */}
      {data._isMock.coinglass && (
        <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: COLORS.amber, fontWeight: 600 }}>CoinGlass API Key Not Configured</div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>
            Add your CoinGlass API key in Settings to unlock historical funding rates, open interest charts, liquidation data, and long/short ratios.
          </div>
        </div>
      )}
    </div>
  );
}


// ─── TAB: V2 STRATEGY (Fear & Greed) ──────────────────────────────────────────
function computeV2Signal(data) {
  var fng = data.fng;
  var fngSMA14 = fng && fng.current ? fng.current.sma14 : 50;
  var fngScore = clamp(100 - fngSMA14, 0, 100); // invert: fear = bullish

  var price = data.currentPrice || 0;
  var maxPain = data.maxPainCurrent || price;
  var mpDistScore = 50;
  if (maxPain && price) {
    mpDistScore = price < maxPain
      ? clamp(50 + (maxPain - price) / maxPain * 200, 50, 100)
      : clamp(50 - (price - maxPain) / maxPain * 200, 0, 50);
  }

  var momScore = clamp(50 + (data.marketData.change30d || 0) * 0.8, 10, 90);

  var composite = fngScore * 0.50 + mpDistScore * 0.25 + momScore * 0.25;

  var direction = 'HOLD';
  var dirColor = COLORS.amber;
  if (fngSMA14 <= 24) { direction = 'STRONG BUY'; dirColor = COLORS.green; }
  else if (fngSMA14 <= 44) { direction = 'BUY'; dirColor = COLORS.greenLight; }
  else if (fngSMA14 >= 76) { direction = 'STRONG SELL'; dirColor = COLORS.red; }
  else if (fngSMA14 >= 56) { direction = 'SELL'; dirColor = COLORS.redLight; }

  return { fngScore, mpDistScore, momScore, composite, direction, dirColor, fngSMA14 };
}

function V2StrategyTab({ data, allocation }) {
  var fng = data.fng;
  var v2 = computeV2Signal(data);

  // Build chart data: merge FNG history with price history
  var chartData = [];
  if (fng && fng.history) {
    var priceMap = {};
    if (data.priceHistory) data.priceHistory.forEach(function (p) { priceMap[p.date] = p.price; });
    chartData = fng.history.map(function (d) {
      return { date: d.date, fng: d.value, sma14: d.sma14, price: priceMap[d.date] || null };
    });
  }

  // Find zone crossings (SMA14 crossing below 25 or above 75)
  var crossings = [];
  if (fng && fng.history.length > 1) {
    var priceMap2 = {};
    if (data.priceHistory) data.priceHistory.forEach(function (p) { priceMap2[p.date] = p.price; });
    for (var i = 1; i < fng.history.length; i++) {
      var prev = fng.history[i - 1].sma14;
      var curr = fng.history[i].sma14;
      if (prev >= 25 && curr < 25) crossings.push({ date: fng.history[i].date, type: 'EXTREME FEAR ENTRY', sma: curr, price: priceMap2[fng.history[i].date] || null });
      if (prev < 25 && curr >= 25) crossings.push({ date: fng.history[i].date, type: 'EXTREME FEAR EXIT', sma: curr, price: priceMap2[fng.history[i].date] || null });
      if (prev <= 75 && curr > 75) crossings.push({ date: fng.history[i].date, type: 'EXTREME GREED ENTRY', sma: curr, price: priceMap2[fng.history[i].date] || null });
      if (prev > 75 && curr <= 75) crossings.push({ date: fng.history[i].date, type: 'EXTREME GREED EXIT', sma: curr, price: priceMap2[fng.history[i].date] || null });
    }
  }

  // FNG zone color helper
  function fngZoneColor(v) {
    if (v <= 24) return COLORS.red;
    if (v <= 44) return COLORS.amber;
    if (v <= 55) return COLORS.textSecondary;
    if (v <= 75) return COLORS.green;
    return COLORS.blue;
  }

  if (!fng) return (
    <div style={{ color: COLORS.textMuted, padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 16, marginBottom: 8 }}>Loading Fear & Greed data...</div>
      <div style={{ fontSize: 12 }}>The Alternative.me API may be loading.</div>
    </div>
  );

  return (
    <div>
      {/* V2 Signal Banner */}
      <div style={{ background: v2.dirColor + '18', border: '1px solid ' + v2.dirColor + '44', borderRadius: 10, padding: '16px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>V2 Strategy Signal</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: v2.dirColor, fontFamily: 'JetBrains Mono, monospace' }}>{v2.direction}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: fngZoneColor(fng.current.value) }}>{fng.current.value}</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted }}>F&G Raw</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: fngZoneColor(fng.current.sma14) }}>{fng.current.sma14}</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted }}>14d SMA</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: v2.dirColor }}>{v2.composite.toFixed(0)}</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted }}>V2 Score</div>
          </div>
        </div>
        <div style={{ padding: '4px 12px', borderRadius: 8, background: fngZoneColor(fng.current.value) + '22', color: fngZoneColor(fng.current.value), fontSize: 13, fontWeight: 600 }}>
          {fng.current.classification}
        </div>
      </div>

      {/* Fear & Greed Chart */}
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Fear & Greed Index (90d) with 14d SMA & BTC Price</div>
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={chartData} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="date" tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (d) { return d.slice(5); }} interval={Math.floor(chartData.length / 8)} />
            <YAxis yAxisId="left" domain={[0, 100]} tick={{ fill: COLORS.textMuted, fontSize: 10 }} />
            <YAxis yAxisId="right" orientation="right" domain={['auto', 'auto']} tick={{ fill: COLORS.textMuted, fontSize: 10 }} tickFormatter={function (v) { return '$' + fmt(v); }} />
            <Tooltip content={<ChartTooltipContent />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine yAxisId="left" y={25} stroke={COLORS.red} strokeDasharray="4 4" label={{ value: 'Extreme Fear', fill: COLORS.red, fontSize: 10, position: 'insideTopLeft' }} />
            <ReferenceLine yAxisId="left" y={75} stroke={COLORS.blue} strokeDasharray="4 4" label={{ value: 'Extreme Greed', fill: COLORS.blue, fontSize: 10, position: 'insideBottomLeft' }} />
            <Area yAxisId="left" type="monotone" dataKey="fng" fill={COLORS.amber} fillOpacity={0.15} stroke={COLORS.amber} strokeWidth={1} dot={false} name="F&G Raw" />
            <Line yAxisId="left" type="monotone" dataKey="sma14" stroke={COLORS.accent} strokeWidth={2.5} dot={false} name="14d SMA" />
            <Line yAxisId="right" type="monotone" dataKey="price" stroke={COLORS.text} strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="BTC Price" connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* V2 Composite Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>Fear & Greed (inverted)</span>
            <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>50%</span>
          </div>
          <ScoreBar score={v2.fngScore} label="" color={COLORS.accent} />
          <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 4 }}>SMA14: {v2.fngSMA14} → Score: {v2.fngScore.toFixed(0)}</div>
        </div>
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>Max Pain Distance</span>
            <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>25%</span>
          </div>
          <ScoreBar score={v2.mpDistScore} label="" color={COLORS.blue} />
          <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 4 }}>Price {data.maxPainCurrent && data.currentPrice < data.maxPainCurrent ? 'below' : 'above'} max pain</div>
        </div>
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>Price Momentum (30d)</span>
            <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>25%</span>
          </div>
          <ScoreBar score={v2.momScore} label="" color={COLORS.purple} />
          <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 4 }}>30d: {fmtPct(data.marketData.change30d)}</div>
        </div>
      </div>

      {/* V1 vs V2 Comparison */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>V1 Composite (Multi-Signal)</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: allocation.regime.color }}>{allocation.composite.toFixed(0)}</div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary }}>{allocation.regime.label} — BTC {allocation.btcPct}%</div>
        </div>
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>V2 Fear & Greed Strategy</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: v2.dirColor }}>{v2.composite.toFixed(0)}</div>
          <div style={{ fontSize: 12, color: COLORS.textSecondary }}>{v2.direction}</div>
        </div>
      </div>

      {/* Zone Crossings */}
      {crossings.length > 0 && (
        <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Signal History (14d SMA Zone Crossings)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid ' + COLORS.border }}>
                  {['Date', 'Event', 'SMA', 'BTC Price'].map(function (h) {
                    return <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: COLORS.textMuted, fontWeight: 500 }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {crossings.slice().reverse().map(function (c, i) {
                  var isExtremeFear = c.type.indexOf('FEAR') >= 0;
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid ' + COLORS.borderSubtle }}>
                      <td style={{ padding: '6px 12px', color: COLORS.textSecondary }}>{c.date}</td>
                      <td style={{ padding: '6px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: isExtremeFear ? 'rgba(220,38,38,0.12)' : 'rgba(37,99,235,0.12)', color: isExtremeFear ? COLORS.red : COLORS.blue }}>
                          {c.type}
                        </span>
                      </td>
                      <td style={{ padding: '6px 12px', color: COLORS.text }}>{c.sma}</td>
                      <td style={{ padding: '6px 12px', color: COLORS.text }}>{c.price ? fmtUSD(c.price) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Methodology */}
      <div style={{ background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>V2 Methodology</div>
        <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
          <p style={{ marginBottom: 8 }}>V2 is a contrarian strategy built around the Fear & Greed Index 14-day SMA. When the market enters Extreme Fear (&lt;25), historically this has preceded significant BTC rallies — capitulation marks opportunity.</p>
          <p style={{ marginBottom: 8 }}><strong style={{ color: COLORS.accent }}>Fear & Greed 14d SMA (50%)</strong>: Inverted scoring — lower F&G = higher bullish score. The 14d SMA smooths daily noise while preserving trend direction. Extreme Fear (&lt;25) maps to scores 76-100.</p>
          <p style={{ marginBottom: 8 }}><strong style={{ color: COLORS.blue }}>Max Pain Distance (25%)</strong>: When price is significantly below Max Pain, options market makers have incentive to push price toward max pain — reinforcing the contrarian buy thesis.</p>
          <p><strong style={{ color: COLORS.purple }}>Price Momentum 30d (25%)</strong>: Confirms whether fear is justified by sustained decline (capitulation) or just a short-term dip. Deep 30d drawdowns with extreme fear create the strongest buy signals.</p>
        </div>
      </div>
    </div>
  );
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────
function SettingsModal({ onClose }) {
  var [cgKey, setCgKey] = useState('');
  var [cglKey, setCglKey] = useState('');

  useEffect(function () {
    try {
      var raw = localStorage.getItem('btc_engine_config');
      if (raw) { var c = JSON.parse(raw); setCgKey(c.coingeckoKey || ''); setCglKey(c.coinglassKey || ''); }
    } catch (e) {}
  }, []);

  function save() {
    if (window.BTCDataEngine) window.BTCDataEngine.saveConfig({ coingeckoKey: cgKey || null, coinglassKey: cglKey || null });
    onClose();
  }

  var inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid ' + COLORS.border, background: COLORS.bg, color: COLORS.text, fontSize: 13, fontFamily: 'JetBrains Mono, monospace', outline: 'none' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <div style={{ background: COLORS.surface, border: '1px solid ' + COLORS.border, borderRadius: 12, padding: 24, width: 420, maxWidth: '90vw' }} onClick={function (e) { e.stopPropagation(); }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 16 }}>API Configuration</div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: COLORS.textSecondary, display: 'block', marginBottom: 4 }}>CoinGecko Demo API Key (optional)</label>
          <input style={inputStyle} value={cgKey} onChange={function (e) { setCgKey(e.target.value); }} placeholder="CG-..." />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: COLORS.textSecondary, display: 'block', marginBottom: 4 }}>CoinGlass API Key (for derivatives data)</label>
          <input style={inputStyle} value={cglKey} onChange={function (e) { setCglKey(e.target.value); }} placeholder="Your CoinGlass key" />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid ' + COLORS.border, background: 'transparent', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={save} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: COLORS.accent, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Save & Refresh</button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN DASHBOARD COMPONENT ─────────────────────────────────────────────────
export default function BTCDashboard() {
  var [liveData, setLiveData] = useState(null);
  var [dataStatus, setDataStatus] = useState({ isLoading: true });
  var [activeTab, setActiveTab] = useState('overview');
  var [showSettings, setShowSettings] = useState(false);

  useEffect(function () {
    if (window.BTCDataEngine) {
      window.BTCDataEngine.subscribe(function (data, status) {
        setLiveData(data);
        setDataStatus(status);
      });
      window.BTCDataEngine.init();
    }
  }, []);

  var data = liveData || generateMockData();

  var mpSignal = useMemo(function () {
    return computeMaxPainSignal(data.priceHistory, data.maxPainHistory);
  }, [data.priceHistory, data.maxPainHistory]);

  var allocation = useMemo(function () {
    return computeAllocation(data, mpSignal);
  }, [data, mpSignal]);

  function renderTab() {
    switch (activeTab) {
      case 'overview': return <OverviewTab data={data} mpSignal={mpSignal} allocation={allocation} />;
      case 'maxpain': return <MaxPainTab data={data} mpSignal={mpSignal} />;
      case 'options': return <OptionsTab data={data} />;
      case 'onchain': return <OnChainTab data={data} />;
      case 'derivatives': return <DerivativesTab data={data} />;
      case 'v2strategy': return <V2StrategyTab data={data} allocation={allocation} />;
      default: return null;
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.text }}>
      {/* Header */}
      <div style={{ background: COLORS.surface, borderBottom: '1px solid ' + COLORS.border, padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: COLORS.accent }}>₿</span>
          <span style={{ fontSize: 16, fontWeight: 700 }}>BTC Max Pain Intelligence</span>
          <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace' }}>
            {data.currentPrice ? fmtUSD(data.currentPrice) : '...'}
          </span>
          {data.marketData.change24h != null && (
            <span style={{ fontSize: 12, fontWeight: 600, color: pctColor(data.marketData.change24h), fontFamily: 'JetBrains Mono, monospace' }}>
              {fmtPct(data.marketData.change24h)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {data._isMock && (
            <div style={{ display: 'flex', gap: 6 }}>
              <SourceBadge label="CoinGecko" isMock={data._isMock.coingecko} />
              <SourceBadge label="Deribit" isMock={data._isMock.deribit} />
              <SourceBadge label="Glassnode" isMock={data._isMock.glassnode} />
              <SourceBadge label="F&G" isMock={data._isMock.fng} />
            </div>
          )}
          <button onClick={function () { if (window.BTCDataEngine) window.BTCDataEngine.refresh(); }} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid ' + COLORS.border, background: 'transparent', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 11 }} title="Refresh all data">
            {dataStatus.isLoading ? '...' : 'Refresh'}
          </button>
          <button onClick={function () { setShowSettings(true); }} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid ' + COLORS.border, background: 'transparent', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 11 }}>
            Settings
          </button>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{ background: COLORS.surface, borderBottom: '1px solid ' + COLORS.border, padding: '0 24px', display: 'flex', gap: 0, overflowX: 'auto' }}>
        {TABS.map(function (tab) {
          var isActive = activeTab === tab.id;
          return (
            <button key={tab.id} onClick={function () { setActiveTab(tab.id); }}
              style={{ padding: '10px 16px', border: 'none', borderBottom: isActive ? '2px solid ' + COLORS.accent : '2px solid transparent', background: 'transparent', color: isActive ? COLORS.accent : COLORS.textSecondary, cursor: 'pointer', fontSize: 13, fontWeight: isActive ? 600 : 400, whiteSpace: 'nowrap', transition: 'all 0.2s' }}>
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>
        {renderTab()}
      </div>

      {/* Last Update */}
      <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 10, color: COLORS.textMuted }}>
        {dataStatus.lastUpdate ? 'Last update: ' + new Date(dataStatus.lastUpdate).toLocaleTimeString() + ' | Auto-refresh: 5 min' : 'Loading...'}
      </div>

      {showSettings && <SettingsModal onClose={function () { setShowSettings(false); }} />}
    </div>
  );
}
