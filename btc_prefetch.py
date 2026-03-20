#!/usr/bin/env python3
"""BTC Glassnode Prefetch — fetches BTC on-chain metrics for BTC Max Pain Intelligence Dashboard.
Outputs btc_glassnode_data.json (consumed by btc-data-engine.js via fetch).
Metrics: exchange_net_flows, sopr, nupl, mvrv, active_addresses (30-day lookback).
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

SCRIPT_DIR = Path(__file__).parent
OUTPUT_FILE = SCRIPT_DIR / "btc_glassnode_data.json"
CONFIG_DIR = Path.home() / ".config" / "bd-briefing"
GLASSNODE_BASE = "https://api.glassnode.com/v1/metrics"

METRICS = {
    "exchange_net_flows": "/transactions/transfers_volume_exchanges_net",
    "sopr": "/indicators/sopr",
    "nupl": "/indicators/nupl",
    "mvrv": "/market/mvrv",
    "active_addresses": "/addresses/active_count",
}


def load_api_key():
    env_file = CONFIG_DIR / ".env"
    if not env_file.exists():
        print(f"[BTC Prefetch] .env not found at {env_file}")
        return None
    with open(env_file, "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("GLASSNODE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def fetch_metric(name, endpoint, api_key, since_ts):
    url = f"{GLASSNODE_BASE}{endpoint}?a=BTC&i=24h&s={since_ts}&f=json"
    req = Request(url)
    req.add_header("X-Api-Key", api_key)
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            print(f"  [OK] {name}: {len(data)} data points")
            return data
    except HTTPError as e:
        if e.code == 403:
            print(f"  [SKIP] {name}: tier-restricted (403)")
        else:
            print(f"  [ERR] {name}: HTTP {e.code}")
        return None
    except (URLError, TimeoutError) as e:
        print(f"  [ERR] {name}: {e}")
        return None


def main():
    api_key = load_api_key()
    if not api_key:
        print("[BTC Prefetch] No GLASSNODE_API_KEY found, skipping")
        sys.exit(0)

    since = int((datetime.utcnow() - timedelta(days=30)).timestamp())
    print(f"[BTC Prefetch] Fetching 30d BTC metrics from Glassnode...")

    result = {}
    for name, endpoint in METRICS.items():
        data = fetch_metric(name, endpoint, api_key, since)
        if data is not None:
            result[name] = data
        time.sleep(0.5)  # rate limit courtesy

    result["_meta"] = {
        "fetched_at": datetime.utcnow().isoformat() + "Z",
        "lookback_days": 30,
        "asset": "BTC",
        "metrics_available": list(result.keys()),
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print(f"[BTC Prefetch] Wrote {OUTPUT_FILE} ({OUTPUT_FILE.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
