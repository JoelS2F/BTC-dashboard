// ═══════════════════════════════════════════════════════════════════════════════
// BTC Max Pain Intelligence — Data Engine
// Sources: CoinGecko (BTC price/history), Deribit (options/max pain/perp),
//          CoinGlass (funding/OI/liquidations), Glassnode (pre-fetched JSON)
// Pattern: IIFE singleton, 3-min cache, 5-min refresh, stale fallback, pub/sub
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  var CONFIG = {
    CACHE_TTL: 3 * 60 * 1000,
    REFRESH_INTERVAL: 5 * 60 * 1000,
    DERIBIT_BASE: "https://www.deribit.com/api/v2/public",
    COINGLASS_BASE: "https://open-api-v3.coinglass.com",
  };

  var CACHE_KEYS = {
    CG_BTC: "btc_cache_coingecko",
    CG_CHART_90: "btc_cache_chart_90d",
    DERIBIT_OPTIONS: "btc_cache_deribit_options",
    DERIBIT_PERP: "btc_cache_deribit_perp",
    COINGLASS_FR: "btc_cache_coinglass_fr",
    COINGLASS_OI: "btc_cache_coinglass_oi",
    COINGLASS_LIQ: "btc_cache_coinglass_liq",
    COINGLASS_LS: "btc_cache_coinglass_ls",
    GN_DATA: "btc_cache_glassnode",
    FNG: "btc_cache_fng",
    MAX_PAIN_HISTORY: "btc_maxpain_history",
  };

  var CONFIG_KEY = "btc_engine_config";

  // ─── STATE ──────────────────────────────────────────────────────────────────
  var state = {
    isLoading: true,
    lastUpdate: null,
    coinData: null,
    priceHistory: null,
    deribitOptions: null,
    deribitPerp: null,
    coinglassData: { funding: null, oi: null, liquidations: null, longShort: null },
    glassnodeData: null,
    fngData: null,
    maxPainHistory: [],
    sources: {
      coingecko: { status: "pending", stale: false },
      deribit: { status: "pending", stale: false },
      coinglass: { status: "pending", stale: false },
      glassnode: { status: "pending", stale: false },
      fng: { status: "pending", stale: false },
    },
    config: { coinglassKey: null, coingeckoKey: null },
    freshness: { coingecko: null, deribit: null, coinglass: null, glassnode: null, fng: null },
    refreshTimer: null,
    listeners: [],
  };

  // ─── CACHE HELPERS ──────────────────────────────────────────────────────────
  function getCached(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - obj.ts < CONFIG.CACHE_TTL) return obj.data;
    } catch (e) {}
    return null;
  }

  function setCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
  }

  function getStaleFallback(key) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw).data;
    } catch (e) {}
    return null;
  }

  // ─── CONFIG ─────────────────────────────────────────────────────────────────
  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        var cfg = JSON.parse(raw);
        state.config.coinglassKey = cfg.coinglassKey || null;
        state.config.coingeckoKey = cfg.coingeckoKey || null;
      }
    } catch (e) {}
  }

  function cgHeaders() {
    var h = { Accept: "application/json" };
    if (state.config.coingeckoKey) h["x-cg-demo-api-key"] = state.config.coingeckoKey;
    return h;
  }

  // ─── COINGECKO FETCHERS ─────────────────────────────────────────────────────
  async function fetchBTCCoinData() {
    var cached = getCached(CACHE_KEYS.CG_BTC);
    if (cached) { state.coinData = cached; state.sources.coingecko.status = "live"; return; }
    try {
      var url = "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false";
      var res = await fetch(url, { headers: cgHeaders() });
      if (!res.ok) throw new Error("CG " + res.status);
      var data = await res.json();
      state.coinData = data;
      setCache(CACHE_KEYS.CG_BTC, data);
      state.sources.coingecko.status = "live";
      state.freshness.coingecko = Date.now();
    } catch (e) {
      console.warn("[BTC Engine] CoinGecko coin error:", e.message);
      var stale = getStaleFallback(CACHE_KEYS.CG_BTC);
      if (stale) { state.coinData = stale; state.sources.coingecko.stale = true; state.sources.coingecko.status = "stale"; }
      else state.sources.coingecko.status = "error";
    }
  }

  async function fetchBTCPriceHistory() {
    var cached = getCached(CACHE_KEYS.CG_CHART_90);
    if (cached) { state.priceHistory = cached; return; }
    try {
      var url = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90";
      var res = await fetch(url, { headers: cgHeaders() });
      if (!res.ok) throw new Error("CG chart " + res.status);
      var data = await res.json();
      state.priceHistory = data;
      setCache(CACHE_KEYS.CG_CHART_90, data);
    } catch (e) {
      console.warn("[BTC Engine] CoinGecko chart error:", e.message);
      var stale = getStaleFallback(CACHE_KEYS.CG_CHART_90);
      if (stale) state.priceHistory = stale;
    }
  }

  // ─── DERIBIT FETCHERS ───────────────────────────────────────────────────────
  async function fetchDeribitOptions() {
    var cached = getCached(CACHE_KEYS.DERIBIT_OPTIONS);
    if (cached) { state.deribitOptions = cached; state.sources.deribit.status = "live"; return; }
    try {
      var url = CONFIG.DERIBIT_BASE + "/get_book_summary_by_currency?currency=BTC&kind=option";
      var res = await fetch(url);
      if (!res.ok) throw new Error("Deribit options " + res.status);
      var json = await res.json();
      var data = json.result || [];
      state.deribitOptions = data;
      setCache(CACHE_KEYS.DERIBIT_OPTIONS, data);
      state.sources.deribit.status = "live";
      state.freshness.deribit = Date.now();
    } catch (e) {
      console.warn("[BTC Engine] Deribit options error:", e.message);
      var stale = getStaleFallback(CACHE_KEYS.DERIBIT_OPTIONS);
      if (stale) { state.deribitOptions = stale; state.sources.deribit.stale = true; state.sources.deribit.status = "stale"; }
      else state.sources.deribit.status = "error";
    }
  }

  async function fetchDeribitPerp() {
    var cached = getCached(CACHE_KEYS.DERIBIT_PERP);
    if (cached) { state.deribitPerp = cached; return; }
    try {
      var url = CONFIG.DERIBIT_BASE + "/ticker?instrument_name=BTC-PERPETUAL";
      var res = await fetch(url);
      if (!res.ok) throw new Error("Deribit perp " + res.status);
      var json = await res.json();
      state.deribitPerp = json.result || null;
      setCache(CACHE_KEYS.DERIBIT_PERP, json.result);
    } catch (e) {
      console.warn("[BTC Engine] Deribit perp error:", e.message);
      var stale = getStaleFallback(CACHE_KEYS.DERIBIT_PERP);
      if (stale) state.deribitPerp = stale;
    }
  }

  // ─── COINGLASS FETCHERS ─────────────────────────────────────────────────────
  async function fetchCoinGlass(endpoint, cacheKey, stateField) {
    if (!state.config.coinglassKey) return;
    var cached = getCached(cacheKey);
    if (cached) { state.coinglassData[stateField] = cached; return; }
    try {
      var url = CONFIG.COINGLASS_BASE + endpoint;
      var res = await fetch(url, { headers: { "CoinGlass-Api-Key": state.config.coinglassKey } });
      if (!res.ok) throw new Error("CoinGlass " + res.status);
      var json = await res.json();
      var data = json.data || json;
      state.coinglassData[stateField] = data;
      setCache(cacheKey, data);
      state.sources.coinglass.status = "live";
      state.freshness.coinglass = Date.now();
    } catch (e) {
      console.warn("[BTC Engine] CoinGlass " + stateField + " error:", e.message);
      var stale = getStaleFallback(cacheKey);
      if (stale) { state.coinglassData[stateField] = stale; state.sources.coinglass.stale = true; }
    }
  }

  async function fetchAllCoinGlass() {
    if (!state.config.coinglassKey) { state.sources.coinglass.status = "no-key"; return; }
    await Promise.all([
      fetchCoinGlass("/api/futures/funding-rate-chart?symbol=BTC&interval=h8", CACHE_KEYS.COINGLASS_FR, "funding"),
      fetchCoinGlass("/api/futures/open-interest-chart?symbol=BTC&interval=h4", CACHE_KEYS.COINGLASS_OI, "oi"),
      fetchCoinGlass("/api/futures/liquidation-chart?symbol=BTC&interval=h4", CACHE_KEYS.COINGLASS_LIQ, "liquidations"),
      fetchCoinGlass("/api/futures/global-long-short-account-ratio?symbol=BTC&interval=h4", CACHE_KEYS.COINGLASS_LS, "longShort"),
    ]);
  }

  // ─── GLASSNODE (PRE-FETCHED JSON) ───────────────────────────────────────────
  async function fetchGlassnodeData() {
    var cached = getCached(CACHE_KEYS.GN_DATA);
    if (cached) { state.glassnodeData = cached; state.sources.glassnode.status = "live"; state.freshness.glassnode = Date.now(); return; }
    try {
      var url = "btc_glassnode_data.json?t=" + Date.now();
      var res = await fetch(url);
      if (!res.ok) throw new Error("Glassnode JSON " + res.status);
      var data = await res.json();
      state.glassnodeData = data;
      setCache(CACHE_KEYS.GN_DATA, data);
      state.sources.glassnode.status = "live";
      state.freshness.glassnode = Date.now();
    } catch (e) {
      console.warn("[BTC Engine] Glassnode pre-fetch not found:", e.message);
      var stale = getStaleFallback(CACHE_KEYS.GN_DATA);
      if (stale) { state.glassnodeData = stale; state.sources.glassnode.stale = true; state.sources.glassnode.status = "stale"; }
      else state.sources.glassnode.status = "unavailable";
    }
  }

  // ─── MAX PAIN CALCULATION ───────────────────────────────────────────────────
  function computeMaxPain(options) {
    if (!options || options.length === 0) return null;
    var strikePain = {};
    for (var i = 0; i < options.length; i++) {
      var name = options[i].instrument_name || "";
      var oi = parseFloat(options[i].open_interest || 0);
      if (oi <= 0) continue;
      var parts = name.split("-");
      if (parts.length < 4) continue;
      var strike = parseFloat(parts[2]);
      if (isNaN(strike)) continue;
      if (!strikePain[strike]) strikePain[strike] = { call_oi: 0, put_oi: 0 };
      if (name.endsWith("-C")) strikePain[strike].call_oi += oi;
      else if (name.endsWith("-P")) strikePain[strike].put_oi += oi;
    }
    var strikes = Object.keys(strikePain).map(Number).sort(function (a, b) { return a - b; });
    if (strikes.length === 0) return null;
    var minPain = Infinity;
    var maxPainStrike = null;
    for (var si = 0; si < strikes.length; si++) {
      var s = strikes[si];
      var totalPain = 0;
      for (var key in strikePain) {
        var k = parseFloat(key);
        totalPain += Math.max(0, s - k) * strikePain[key].put_oi;
        totalPain += Math.max(0, k - s) * strikePain[key].call_oi;
      }
      if (totalPain < minPain) { minPain = totalPain; maxPainStrike = s; }
    }
    // Aggregate options stats
    var totalCallOI = 0, totalPutOI = 0, totalCallVol = 0, totalPutVol = 0, ivSum = 0, ivCount = 0;
    for (var j = 0; j < options.length; j++) {
      var o = options[j];
      var oName = o.instrument_name || "";
      if (oName.endsWith("-C")) {
        totalCallOI += parseFloat(o.open_interest || 0);
        totalCallVol += parseFloat(o.volume || 0);
      } else if (oName.endsWith("-P")) {
        totalPutOI += parseFloat(o.open_interest || 0);
        totalPutVol += parseFloat(o.volume || 0);
      }
      if (o.mark_iv && o.mark_iv > 0) { ivSum += o.mark_iv; ivCount++; }
    }
    return {
      maxPain: maxPainStrike,
      strikes: strikes,
      strikePain: strikePain,
      totalCallOI: totalCallOI,
      totalPutOI: totalPutOI,
      putCallRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
      totalCallVol: totalCallVol,
      totalPutVol: totalPutVol,
      avgIV: ivCount > 0 ? ivSum / ivCount : 0,
      optionsCount: options.length,
    };
  }

  // ─── MAX PAIN HISTORY (localStorage persistence) ────────────────────────────
  function loadMaxPainHistory() {
    try {
      var raw = localStorage.getItem(CACHE_KEYS.MAX_PAIN_HISTORY);
      if (raw) state.maxPainHistory = JSON.parse(raw);
    } catch (e) { state.maxPainHistory = []; }
  }

  function updateMaxPainHistory(currentMaxPain, currentPrice) {
    if (!currentMaxPain) return state.maxPainHistory;
    var history = state.maxPainHistory.slice();
    var today = new Date().toISOString().slice(0, 10);
    var last = history.length > 0 ? history[history.length - 1] : null;
    if (!last || last.date !== today) {
      history.push({ date: today, maxPain: currentMaxPain, price: currentPrice, ts: Date.now() });
    } else {
      last.maxPain = currentMaxPain;
      last.price = currentPrice;
      last.ts = Date.now();
    }
    if (history.length > 90) history = history.slice(-90);
    state.maxPainHistory = history;
    try { localStorage.setItem(CACHE_KEYS.MAX_PAIN_HISTORY, JSON.stringify(history)); } catch (e) {}
    return history;
  }

  // ─── TRANSFORM PRICE HISTORY ────────────────────────────────────────────────
  function transformPriceHistory(raw) {
    if (!raw || !raw.prices) return [];
    return raw.prices.map(function (p, i) {
      return {
        date: new Date(p[0]).toISOString().slice(0, 10),
        price: p[1],
        volume: raw.total_volumes && raw.total_volumes[i] ? raw.total_volumes[i][1] : 0,
        mcap: raw.market_caps && raw.market_caps[i] ? raw.market_caps[i][1] : 0,
      };
    });
  }

  // ─── TRANSFORM OPTIONS BY EXPIRY (for IV term structure) ────────────────────
  function transformOptionsByExpiry(options) {
    if (!options) return [];
    var byExpiry = {};
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      var parts = (o.instrument_name || "").split("-");
      if (parts.length < 4) continue;
      var expiry = parts[1];
      if (!byExpiry[expiry]) byExpiry[expiry] = { ivSum: 0, count: 0, totalOI: 0, totalVol: 0 };
      if (o.mark_iv > 0) { byExpiry[expiry].ivSum += o.mark_iv; byExpiry[expiry].count++; }
      byExpiry[expiry].totalOI += parseFloat(o.open_interest || 0);
      byExpiry[expiry].totalVol += parseFloat(o.volume || 0);
    }
    return Object.keys(byExpiry).map(function (exp) {
      var d = byExpiry[exp];
      return { expiry: exp, avgIV: d.count > 0 ? d.ivSum / d.count : 0, totalOI: d.totalOI, totalVol: d.totalVol };
    }).sort(function (a, b) { return a.expiry.localeCompare(b.expiry); });
  }

  // ─── TRANSFORM COINGLASS DATA ───────────────────────────────────────────────
  function transformCoinglassTimeSeries(data) {
    if (!data) return [];
    if (Array.isArray(data)) {
      return data.map(function (d) {
        return { date: new Date(d.t || d.time || d[0]).toISOString().slice(0, 10), value: d.v || d.value || d[1] || 0 };
      });
    }
    if (data.dateList && data.dataMap) {
      var dates = data.dateList;
      var values = Object.values(data.dataMap)[0] || [];
      return dates.map(function (d, i) {
        return { date: new Date(d).toISOString().slice(0, 10), value: values[i] || 0 };
      });
    }
    return [];
  }

  // ─── FEAR & GREED INDEX ──────────────────────────────────────────────────────
  async function fetchFearGreed() {
    var cached = getCached(CACHE_KEYS.FNG);
    if (cached) { state.fngData = cached; state.sources.fng.status = "live"; state.freshness.fng = Date.now(); return; }
    try {
      var url = "https://api.alternative.me/fng/?limit=90&format=json";
      var res = await fetch(url);
      if (!res.ok) throw new Error("FNG " + res.status);
      var data = await res.json();
      state.fngData = data;
      setCache(CACHE_KEYS.FNG, data);
      state.sources.fng.status = "live";
      state.freshness.fng = Date.now();
    } catch (e) {
      console.warn("[BTC Engine] Fear & Greed error:", e.message);
      var stale = getStaleFallback(CACHE_KEYS.FNG);
      if (stale) { state.fngData = stale; state.sources.fng.stale = true; state.sources.fng.status = "stale"; }
      else state.sources.fng.status = "error";
    }
  }

  function transformFNG(raw) {
    if (!raw || !raw.data || raw.data.length === 0) return null;
    // Sort oldest → newest
    var sorted = raw.data.slice().sort(function (a, b) { return parseInt(a.timestamp) - parseInt(b.timestamp); });
    var history = sorted.map(function (d) {
      return { date: new Date(parseInt(d.timestamp) * 1000).toISOString().slice(0, 10), value: parseInt(d.value), classification: d.value_classification };
    });
    // Compute 14d SMA
    for (var i = 0; i < history.length; i++) {
      var windowSlice = history.slice(Math.max(0, i - 13), i + 1);
      history[i].sma14 = Math.round(windowSlice.reduce(function (s, d) { return s + d.value; }, 0) / windowSlice.length);
    }
    var latest = history[history.length - 1];
    return { history: history, current: latest };
  }

  // ─── AGGREGATE getData() ────────────────────────────────────────────────────
  function getData() {
    var price = 0;
    var change24h = 0, change7d = 0, change30d = 0;
    var mcap = 0, volume24h = 0, ath = 0;
    if (state.coinData && state.coinData.market_data) {
      var md = state.coinData.market_data;
      price = md.current_price ? md.current_price.usd : 0;
      change24h = md.price_change_percentage_24h || 0;
      change7d = md.price_change_percentage_7d || 0;
      change30d = md.price_change_percentage_30d || 0;
      mcap = md.market_cap ? md.market_cap.usd : 0;
      volume24h = md.total_volume ? md.total_volume.usd : 0;
      ath = md.ath ? md.ath.usd : 0;
    }

    var optionsData = computeMaxPain(state.deribitOptions);
    var maxPainCurrent = optionsData ? optionsData.maxPain : null;
    var maxPainDistance = maxPainCurrent && price ? ((price - maxPainCurrent) / maxPainCurrent * 100) : 0;

    updateMaxPainHistory(maxPainCurrent, price);

    var priceHistoryArr = transformPriceHistory(state.priceHistory);
    var ivTermStructure = transformOptionsByExpiry(state.deribitOptions);

    // Perp data
    var perpFunding = null, perpMarkPrice = null, perpOI = null;
    if (state.deribitPerp) {
      perpFunding = state.deribitPerp.current_funding || 0;
      perpMarkPrice = state.deribitPerp.mark_price || 0;
      perpOI = state.deribitPerp.open_interest || 0;
    }

    return {
      currentPrice: price,
      marketData: { price: price, mcap: mcap, volume24h: volume24h, change24h: change24h, change7d: change7d, change30d: change30d, ath: ath },
      priceHistory: priceHistoryArr,
      maxPainCurrent: maxPainCurrent,
      maxPainDistance: maxPainDistance,
      maxPainHistory: state.maxPainHistory,
      options: optionsData,
      ivTermStructure: ivTermStructure,
      glassnode: state.glassnodeData,
      fng: transformFNG(state.fngData),
      derivatives: {
        funding: state.coinglassData.funding,
        oi: state.coinglassData.oi,
        liquidations: state.coinglassData.liquidations,
        longShort: state.coinglassData.longShort,
        perpFunding: perpFunding,
        perpMarkPrice: perpMarkPrice,
        perpOI: perpOI,
      },
      _freshness: state.freshness,
      _isMock: {
        coingecko: state.sources.coingecko.status !== "live",
        deribit: state.sources.deribit.status !== "live",
        coinglass: state.sources.coinglass.status !== "live",
        glassnode: state.sources.glassnode.status !== "live",
        fng: state.sources.fng.status !== "live",
      },
      _sources: state.sources,
    };
  }

  function getStatus() {
    return { isLoading: state.isLoading, lastUpdate: state.lastUpdate, sources: state.sources };
  }

  // ─── PUB/SUB ────────────────────────────────────────────────────────────────
  function notifyListeners() {
    var data = getData();
    var status = getStatus();
    for (var i = 0; i < state.listeners.length; i++) {
      try { state.listeners[i](data, status); } catch (e) { console.error("[BTC Engine] Listener error:", e); }
    }
  }

  // ─── FETCH ALL ──────────────────────────────────────────────────────────────
  async function fetchAll() {
    state.isLoading = true;
    notifyListeners();
    await Promise.all([
      fetchBTCCoinData(),
      fetchBTCPriceHistory(),
      fetchDeribitOptions(),
      fetchDeribitPerp(),
      fetchAllCoinGlass(),
      fetchGlassnodeData(),
      fetchFearGreed(),
    ]);
    state.isLoading = false;
    state.lastUpdate = Date.now();
    notifyListeners();
  }

  async function refresh() {
    // Clear caches to force re-fetch
    Object.values(CACHE_KEYS).forEach(function (k) {
      if (k !== CACHE_KEYS.MAX_PAIN_HISTORY) {
        try { localStorage.removeItem(k); } catch (e) {}
      }
    });
    await fetchAll();
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────
  window.BTCDataEngine = {
    init: function (cfg) {
      loadConfig();
      if (cfg) {
        if (cfg.coinglassKey) state.config.coinglassKey = cfg.coinglassKey;
        if (cfg.coingeckoKey) state.config.coingeckoKey = cfg.coingeckoKey;
      }
      loadMaxPainHistory();
      fetchAll();
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.refreshTimer = setInterval(refresh, CONFIG.REFRESH_INTERVAL);
    },
    getData: getData,
    getStatus: getStatus,
    refresh: refresh,
    subscribe: function (fn) {
      if (typeof fn === "function") state.listeners.push(fn);
    },
    saveConfig: function (cfg) {
      if (cfg.coinglassKey !== undefined) state.config.coinglassKey = cfg.coinglassKey;
      if (cfg.coingeckoKey !== undefined) state.config.coingeckoKey = cfg.coingeckoKey;
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch (e) {}
      refresh();
    },
    destroy: function () {
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.listeners = [];
    },
    _state: state,
  };
})();
