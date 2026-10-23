#!/usr/bin/env python3
"""US futures live dashboard - stdlib only, no API key.

Sources
  * Sina Finance  (hq.sinajs.cn)  - CME 미니선물 실시간 체결, S&P500 현물
  * Sina Finance  (stock2.finance.sina.com.cn) - 분봉/일봉 시계열
  * Naver Finance (polling/api)   - KOSPI / KOSPI200 / USD-KRW

The server keeps a warm cache and answers /api/quotes from memory, so the page
never waits on an upstream call. Nothing here needs an API key; every source is
a public quote endpoint meant for display.

    python3 server.py [port]        # default 8770
"""
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
REFERER = "https://finance.sina.com.cn"
CST = timezone(timedelta(hours=8))   # Sina timestamps are Beijing time

SINA = {                                  # page symbol -> Sina quote code
    "ES=F": "hf_ES", "NQ=F": "hf_NQ", "YM=F": "hf_YM",
    "CL=F": "hf_CL", "GC=F": "hf_GC", "SI=F": "hf_SI", "HG=F": "hf_HG",
    "NG=F": "hf_NG", "BTC=F": "hf_BTC", "VIX=F": "hf_VX",
    "^GSPC": "gb_$inx",
}
NAVER_INDEX = {"KOSPI": "KOSPI", "KPI200": "KPI200"}
NAVER_FX = {"USDKRW": "FX_USDKRW"}

SPARK_SYMBOLS = ["ES=F", "NQ=F", "YM=F", "VIX=F"]

QUOTE_TTL = 4.0
SPARK_TTL = 60.0
NAVER_TTL = 10.0
CHART_TTL = 20.0

# 봉 단위. 1d만 일봉이고 나머지는 1분봉을 묶어 만든다.
INTERVALS = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": 0}
INTERVAL_LABEL = {"1m": "1분", "5m": "5분", "15m": "15분",
                  "30m": "30분", "60m": "60분", "1d": "일봉"}
RANGE_ALIAS = {"1d": "1m", "1m": "1m", "1mo": "1d", "3mo": "1d"}

_lock = threading.Lock()
_quotes = {}        # page symbol -> (at, payload)
_sparks = {}        # page symbol -> (at, [prices])
_charts = {}        # (sym, interval) -> (at, payload)
_trade_gap = {}     # page symbol -> [최근 체결시각 간격(초)]  (실제 갱신 주기 관측)


# ── http helpers ────────────────────────────────────────────
def _get(url, referer=None, tries=3, timeout=10):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": referer or REFERER,
                "Accept": "*/*",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.4 * (attempt + 1))
    raise last


def sina_quote_raw(codes):
    url = "https://hq.sinajs.cn/list=" + ",".join(codes)
    raw = _get(url, referer=REFERER).decode("gbk", "replace")
    out = {}
    for m in re.finditer(r'var hq_str_([^=]+)="([^"]*)"', raw):
        out[m.group(1)] = m.group(2)
    return out


def _f(x, default=None):
    try:
        v = float(x)
        return v
    except (TypeError, ValueError):
        return default


def _quote_ts(date_s, time_s):
    """Sina stamps quotes in Beijing time -> epoch seconds (None if unparseable)."""
    try:
        dt = datetime.strptime(f"{date_s.strip()} {time_s.strip()}",
                               "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST)
        return int(dt.timestamp())
    except Exception:  # noqa: BLE001
        return None


def parse_hf(code, raw):
    """hf_XXX: 0 last, 2 bid, 3 ask, 4 high, 5 low, 6 time, 7 prev settle,
    8 open, 12 date, 13 name"""
    f = raw.split(",")
    if len(f) < 9 or _f(f[0]) is None:
        return None
    price = _f(f[0])
    prev = _f(f[7])
    chg = price - prev if prev else None
    ts = _quote_ts(f[12], f[6]) if len(f) > 12 else None
    return {
        "symbol": code,
        "price": price,
        "prev": prev,
        "change": chg,
        "pct": (chg / prev * 100) if chg is not None and prev else None,
        "high": _f(f[4]),
        "low": _f(f[5]),
        "open": _f(f[8]),
        "ts": ts,
        "tsText": f[6].strip() if len(f) > 6 else None,
        "name": f[13] if len(f) > 13 else code,
        "ok": True,
    }


def parse_gb(code, raw):
    """gb_$inx: 0 name, 1 last, 2 pct, 3 datetime, 4 change, 5 prev, 6 high, 7 low"""
    f = raw.split(",")
    if len(f) < 8 or _f(f[1]) is None:
        return None
    ts = None
    try:
        ts = int(datetime.strptime(f[3].strip(), "%Y-%m-%d %H:%M:%S")
                 .replace(tzinfo=CST).timestamp())
    except Exception:  # noqa: BLE001
        pass
    return {
        "symbol": code,
        "price": _f(f[1]),
        "prev": None,
        "change": _f(f[4]),
        "pct": _f(f[2]),
        "high": _f(f[6]),
        "low": _f(f[7]),
        "open": _f(f[5]),
        "ts": ts,
        "name": f[0],
        "ok": True,
    }


def pull_sina():
    try:
        raw = sina_quote_raw(list(SINA.values()))
    except Exception as e:  # noqa: BLE001
        return f"sina: {e}"
    now = time.time()
    got = 0
    with _lock:
        for sym, code in SINA.items():
            body = raw.get(code)
            if not body:
                continue
            q = parse_hf(sym, body) if code.startswith("hf_") else parse_gb(sym, body)
            if not q:
                continue
            q["source"] = "Sina"
            # 체결 시각이 실제로 몇 초마다 새로 찍히는지 관측한다 (수집 주기와 별개).
            old = _quotes.get(sym)
            if old and q.get("ts") and old[1].get("ts") and q["ts"] > old[1]["ts"]:
                gap = q["ts"] - old[1]["ts"]
                if 0 < gap <= 3600:
                    _trade_gap.setdefault(sym, []).append(gap)
                    del _trade_gap[sym][:-40]
            _quotes[sym] = (now, q)
            got += 1
    return f"sina ok {got}/{len(SINA)}" if got else "sina: empty"


def pull_naver():
    now = time.time()
    for sym, code in NAVER_INDEX.items():
        try:
            raw = _get(f"https://polling.finance.naver.com/api/realtime/domestic/index/{code}",
                       referer="https://finance.naver.com", tries=2, timeout=8)
            d = json.loads(raw.decode("utf-8", "replace"))["datas"][0]
            price = _f(str(d.get("closePrice", "")).replace(",", ""))
            chg = _f(str(d.get("compareToPreviousClosePrice", "")).replace(",", ""))
            pct = _f(str(d.get("fluctuationsRatio", "")).replace(",", ""))
            q = {"symbol": sym, "name": d.get("stockName") or code, "price": price,
                 "change": chg, "pct": pct,
                 "prev": (price - chg) if price is not None and chg is not None else None,
                 "high": None, "low": None, "source": "Naver", "ok": price is not None}
            with _lock:
                _quotes[sym] = (now, q)
        except Exception:  # noqa: BLE001
            pass
    for sym, code in NAVER_FX.items():
        try:
            raw = _get("https://m.stock.naver.com/front-api/marketIndex/prices"
                       f"?category=exchange&reutersCode={code}",
                       referer="https://m.stock.naver.com", tries=2, timeout=8)
            d = json.loads(raw.decode("utf-8", "replace"))["result"][0]
            price = _f(str(d.get("closePrice", "")).replace(",", ""))
            chg = _f(str(d.get("fluctuations", "")).replace(",", ""))
            pct = _f(str(d.get("fluctuationsRatio", "")).replace(",", ""))
            q = {"symbol": sym, "name": "USD/KRW", "price": price, "change": chg,
                 "pct": pct, "prev": (price - chg) if price is not None and chg is not None else None,
                 "high": None, "low": None, "source": "Naver", "ok": price is not None}
            with _lock:
                _quotes[sym] = (now, q)
        except Exception:  # noqa: BLE001
            pass


# ── time series ─────────────────────────────────────────────
def _jsonp_payload(text):
    """strip the `/*<script>...*/\nvar t=( ... );` wrapper"""
    i = text.find("(")
    j = text.rfind(")")
    if i < 0 or j < i:
        raise ValueError("unexpected payload")
    return json.loads(text[i + 1:j])


# ── 1분봉 누적 저장 ──────────────────────────────────────────
# Sina는 글로벌선물에 "1분봉(당일 세션)"과 "일봉"만 준다. 5/15/30/60분봉은
# 1분봉을 묶어 만들고, 세션이 지날 때마다 1분봉을 파일에 쌓아 이어 붙인다.
MIN_FILE = os.path.join(ROOT, "data", "minutes.json")
MIN_KEEP_DAYS = 20
_min = {}                       # sym -> [[ts, price], ...] 오름차순
_min_dirty = False
_min_lock = threading.Lock()


def load_minutes():
    global _min
    try:
        with open(MIN_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        _min = {k: [[int(p[0]), float(p[1])] for p in v] for k, v in raw.items()}
    except Exception:  # noqa: BLE001
        _min = {}


def save_minutes():
    global _min_dirty
    with _min_lock:
        if not _min_dirty:
            return
        snap = dict(_min)
        _min_dirty = False
    try:
        os.makedirs(os.path.dirname(MIN_FILE), exist_ok=True)
        tmp = MIN_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, MIN_FILE)
    except Exception:  # noqa: BLE001
        pass


def store_minutes(sym, pts):
    """1분봉을 기존 저장분에 합친다 (ts 기준 멱등)."""
    global _min_dirty
    if not pts:
        return
    cutoff = time.time() - MIN_KEEP_DAYS * 86400
    with _min_lock:
        merged = {t: p for t, p in (_min.get(sym) or [])}
        for t, p in pts:
            merged[int(t)] = float(p)
        _min[sym] = [[t, merged[t]] for t in sorted(merged) if t >= cutoff]
        _min_dirty = True


def minute_series(sym):
    with _min_lock:
        return [[t, p] for t, p in (_min.get(sym) or [])]


def sina_minline(sym):
    """1-minute closes for the current Globex session (Beijing day)."""
    code = SINA[sym].replace("hf_", "")
    url = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_t=/"
           f"GlobalFuturesService.getGlobalFuturesMinLine?symbol={code}")
    txt = _get(url, referer=REFERER, timeout=12).decode("utf-8", "replace")
    data = _jsonp_payload(txt)
    rows = data.get("minLine_1d") or []
    pts = []
    for row in rows:
        # 첫 줄만 [날짜, 직전정산, "cme", "", "06:00", 현재가, 0, 0, 평균가, 시각]
        if len(row) >= 10:
            price, stamp = _f(row[5]), row[9]
        elif len(row) >= 6:
            price, stamp = _f(row[1]), row[5]
        else:
            continue
        try:
            dt = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST)
        except Exception:  # noqa: BLE001
            continue
        if price is not None:
            pts.append([int(dt.timestamp()), price])
    return pts


def sina_daily(sym, days=70):
    """일봉 OHLC; Sina는 계약 전 역사를 주므로 뒤에서 잘라 쓴다."""
    code = SINA[sym].replace("hf_", "")
    url = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_t=/"
           f"GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={code}")
    txt = _get(url, referer=REFERER, timeout=15).decode("utf-8", "replace")
    rows = _jsonp_payload(txt)
    pts = []
    for r in rows[-days:]:
        c = _f(r.get("close"))
        if c is None:
            continue
        dt = datetime.strptime(r["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        pts.append([int(dt.timestamp()), c, _f(r.get("open")),
                    _f(r.get("high")), _f(r.get("low"))])
    return pts


def aggregate(pts, minutes):
    """1분봉 -> N분봉. 각 구간의 마지막 가격을 쓴다."""
    if minutes <= 1:
        return [[p[0], p[1]] for p in pts]
    step = minutes * 60
    out = []
    for p in pts:
        ts, px = p[0], p[1]
        b = ts - (ts % step)
        if out and out[-1][0] == b:
            out[-1][1] = px
        else:
            out.append([b, px])
    return out


def granularity(sym=None):
    with _lock:
        gaps = sorted(_trade_gap.get(sym) or [])
    tick = gaps[len(gaps) // 2] if gaps else None
    return {
        "chartMin": "1m",
        "chartMinLabel": "1분",
        "native": ["1분봉", "일봉"],
        "derived": ["5분", "15분", "30분", "60분"],
        "quoteStamp": "1초",
        "quotePoll": QUOTE_TTL,
        "tradeGap": tick,
        "note": ("차트 데이터의 최소 단위는 1분봉(Sina). 시세 체결 시각은 초 단위까지 "
                 "오지만 서버가 %.0f초마다 받으므로 화면 갱신은 그보다 촘촘할 수 없다."
                 % QUOTE_TTL),
    }


def chart(sym, interval="1m"):
    if interval not in INTERVALS:
        interval = "1m"
    key = (sym, interval)
    ttl = 60.0 if interval == "1d" else 8.0
    now = time.time()
    with _lock:
        hit = _charts.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    if sym not in SINA or SINA[sym].startswith("gb_"):
        raise ValueError("no series for " + sym)

    with _lock:
        q = (_quotes.get(sym) or (0, {}))[1]

    if interval == "1d":
        rows = sina_daily(sym, 2600)
        pts = rows[-1500:]
        prev = rows[-2][1] if len(rows) > 1 else q.get("prev")
        last = rows[-1] if rows else None
        marks = {"open": last[2] if last else None,
                 "high": last[3] if last else None,
                 "low": last[4] if last else None}
    else:
        live = []
        try:
            live = sina_minline(sym)
        except Exception:  # noqa: BLE001
            pass
        if live:
            store_minutes(sym, live)
        series = minute_series(sym) or live
        pts = aggregate(series, INTERVALS[interval])
        pts = pts[-6000:] if interval == "1m" else pts[-4000:]
        prev = q.get("prev") or (pts[0][1] if pts else None)
        marks = {"open": q.get("open"), "high": q.get("high"), "low": q.get("low")}

    cover = {"from": pts[0][0] if pts else None,
             "to": pts[-1][0] if pts else None,
             "points": len(pts),
             "barSec": 86400 if interval == "1d" else INTERVALS[interval] * 60}
    out = {"ok": True, "symbol": sym, "interval": interval,
           "intervalLabel": INTERVAL_LABEL[interval],
           "points": pts, "prev": prev, "marks": marks,
           "price": pts[-1][1] if pts else None,
           "granularity": granularity(sym), "coverage": cover}
    with _lock:
        _charts[key] = (time.time(), out)
    return out


def refresh_sparks():
    for sym in SPARK_SYMBOLS:
        try:
            pts = sina_minline(sym)
            vals = [p[1] for p in pts]
            if len(vals) > 120:                      # downsample to ~120 points
                step = len(vals) / 120.0
                vals = [vals[int(i * step)] for i in range(120)]
            with _lock:
                _sparks[sym] = (time.time(), vals)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)


def refresh_loop():
    last_naver = 0.0
    last_spark = 0.0
    while True:
        t0 = time.time()
        pull_sina()
        if t0 - last_naver > NAVER_TTL:
            last_naver = t0
            pull_naver()
        if t0 - last_spark > SPARK_TTL:
            last_spark = t0
            refresh_sparks()
        time.sleep(max(1.0, QUOTE_TTL - (time.time() - t0)))


def quotes_for(symbols):
    now = time.time()
    out = []
    with _lock:
        for s in symbols:
            hit = _quotes.get(s)
            if hit is None:
                out.append({"symbol": s, "ok": False, "error": "no data yet"})
                continue
            q = dict(hit[1])
            q["age"] = round(now - hit[0], 1)
            # 시세 지연: 마지막 체결 시각 -> 지금 (서버 기준 초)
            q["delay"] = round(max(0.0, now - q["ts"]), 1) if q.get("ts") else None
            sp = _sparks.get(s)
            q["spark"] = sp[1] if sp else []
            out.append(q)
    return out


# ── http ────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "USFuturesDash/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("DASH_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(json.dumps(obj, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8", code)

    def do_OPTIONS(self):
        # GitHub Pages에서 서빙되는 페이지가 다른 오리진에서 부르므로 preflight를 허용한다.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/quotes":
                syms = [s.strip() for s in qs.get("symbols", [""])[0].split(",") if s.strip()][:30]
                if not syms:
                    return self._json({"ok": False, "error": "symbols required"}, 400)
                return self._json({"ok": True, "serverTime": int(time.time()),
                                   "quotes": quotes_for(syms)})
            if u.path == "/api/chart":
                iv = qs.get("interval", [""])[0]
                if not iv:
                    iv = RANGE_ALIAS.get(qs.get("range", ["1m"])[0], "1m")
                return self._json(chart(qs.get("symbol", ["ES=F"])[0], iv))
            if u.path == "/api/granularity":
                return self._json({"ok": True,
                                   "granularity": granularity(qs.get("symbol", [""])[0] or None),
                                   "intervals": list(INTERVALS),
                                   "labels": INTERVAL_LABEL})
            if u.path == "/healthz":
                with _lock:
                    return self._json({"ok": True, "quotes": sorted(_quotes),
                                       "sparks": sorted(_sparks)})
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "error": str(e)}, 502)

        rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
        path = os.path.normpath(os.path.join(ROOT, rel))
        if not path.startswith(ROOT) or not os.path.isfile(path):
            return self._send(b"not found", "text/plain", 404)
        ctype = {".html": "text/html; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".json": "application/json", ".svg": "image/svg+xml"}.get(
                     os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            self._send(f.read(), ctype)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    load_minutes()
    threading.Thread(target=refresh_loop, name="refresher", daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"dashboard on http://0.0.0.0:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
