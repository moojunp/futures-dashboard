/* US futures live dashboard — vanilla JS, no CDN. */
'use strict';

const INDEX = [
  { sym: 'ES=F',  tick: 'ES',  ko: 'S&P 500 선물',   digits: 2 },
  { sym: 'NQ=F',  tick: 'NQ',  ko: '나스닥 100 선물', digits: 0 },
  { sym: 'YM=F',  tick: 'YM',  ko: '다우 30 선물',    digits: 0 },
  { sym: 'VIX=F', tick: 'VX',  ko: 'VIX 선물',        digits: 2 },
];

const WATCH = [
  { sym: 'CL=F',  label: 'WTI 원유',    digits: 2 },
  { sym: 'GC=F',  label: '금',          digits: 1 },
  { sym: 'SI=F',  label: '은',          digits: 3 },
  { sym: 'HG=F',  label: '구리',        digits: 3 },
  { sym: 'NG=F',  label: '천연가스',     digits: 3 },
  { sym: 'BTC=F', label: '비트코인 선물', digits: 0 },
];

const KOREA = [
  { sym: 'KPI200', label: '코스피 200',  digits: 2 },
  { sym: 'KOSPI',  label: '코스피',      digits: 2 },
  { sym: 'USDKRW', label: '원/달러',     digits: 2 },
  { sym: '^GSPC',  label: 'S&P 500 현물', digits: 2 },
];

const QUOTE_MS = 5000;
const CHART_MS = 20000;
const STRONG_PCT = 1.0;   // |변동률| 1%에서 색 농도 최대

const state = {
  sel: 'ES=F',
  range: '1d',
  quotes: {},
  chart: null,
  lastOk: 0,
  lastFetchAt: 0,
  hoverX: null,
};

/* ── helpers ─────────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const idOf = (s) => 'r-' + s.replace(/[^A-Za-z0-9]/g, '_');

function fmtPrice(v, digits) {
  if (v == null || !isFinite(v)) return '—';
  if (digits == null) {
    const a = Math.abs(v);
    digits = a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  }
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtNum(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 100 ? 2 : a >= 10 ? 2 : 3;
  return (v > 0 ? '+' : '') + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtPct = (v) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const cls = (v) => (v == null || !isFinite(v)) ? 'flat-c' : v > 0 ? 'up-c' : v < 0 ? 'down-c' : 'flat-c';

/* ── trend colour: 상승=빨강, 하락=파랑, 농도=강도 ─────────── */
const UP_WEAK = [148, 86, 94], UP_STRONG = [255, 62, 72];
const DOWN_WEAK = [82, 106, 142], DOWN_STRONG = [58, 140, 255];
const FLAT_RGB = [139, 152, 168];
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const mix = (a, b, t) => a + (b - a) * t;

/** pct(변동률 %) -> {sign, t(0..1 강도), rgb, rgba(a)} */
function trend(pct) {
  const v = (pct == null || !isFinite(pct)) ? 0 : pct;
  const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
  const t = sign === 0 ? 0 : clamp01(Math.pow(Math.abs(v) / STRONG_PCT, 0.6));
  const from = sign > 0 ? UP_WEAK : DOWN_WEAK;
  const to = sign > 0 ? UP_STRONG : DOWN_STRONG;
  const rgb = sign === 0 ? FLAT_RGB
    : [0, 1, 2].map((i) => Math.round(mix(from[i], to[i], t)));
  return {
    sign, t, rgb,
    css: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
    rgba: (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`,
  };
}
const MARK_HIGH = '#ff5a4d';
const MARK_LOW = '#3d8bff';
const MARK_OPEN = '#9fb0c6';

/* ── delay ───────────────────────────────────────────────── */
function delayOf(q) {
  if (!q || !q.ok || q.delay == null) return null;
  const since = state.lastFetchAt ? (Date.now() - state.lastFetchAt) / 1000 : 0;
  return Math.max(0, q.delay + since);
}
function fmtDelay(s) {
  if (s == null || !isFinite(s)) return '—';
  if (s < 0.95) return '<1s';
  if (s < 60) return s.toFixed(1) + 's';
  if (s < 3600) return Math.floor(s / 60) + '분 ' + Math.round(s % 60) + 's';
  return Math.floor(s / 3600) + '시간';
}
function delayColor(s) {
  if (s == null || !isFinite(s)) return '#5c6878';
  if (s < 5) return '#8b98a8';
  if (s < 20) return '#ffb545';
  return '#ff5c6c';
}

/* ── clocks & session ────────────────────────────────────── */
function etParts(d = new Date()) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) p[part.type] = part.value;
  return { dow: p.weekday, h: +p.hour % 24, m: +p.minute, s: +p.second };
}
function kstString(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
}
function sessionInfo() {
  const { dow, h, m } = etParts();
  const mins = h * 60 + m;
  const weekend = dow === 'Sat' || (dow === 'Sun' && mins < 1080) || (dow === 'Fri' && mins >= 1020);
  const brk = mins >= 1020 && mins < 1080;
  const rth = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(dow) && mins >= 570 && mins < 960;
  if (weekend) return { label: '주말 휴장', klass: 'closed', pos: mins / 1440 };
  if (brk) return { label: '데일리 브레이크', klass: 'closed', pos: mins / 1440 };
  if (rth) return { label: '정규장 (RTH)', klass: 'open', pos: mins / 1440 };
  return { label: '야간 (Globex)', klass: '', pos: mins / 1440 };
}

/* ── sparkline ───────────────────────────────────────────── */
function drawSpark(canvas, data, tr) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 46;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * (w - 2) + 1;
  const y = (v) => h - 4 - ((v - min) / span) * (h - 10);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, tr.rgba(0.10 + 0.24 * tr.t));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.beginPath();
  data.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = tr.css;
  c.lineWidth = 1 + 0.9 * tr.t; c.lineJoin = 'round'; c.stroke();
  c.lineTo(x(data.length - 1), h); c.lineTo(x(0), h); c.closePath();
  c.fillStyle = g; c.fill();
}

/* ── quote cards ─────────────────────────────────────────── */
function buildCards() {
  const host = $('#cards');
  host.innerHTML = '';
  INDEX.forEach((it) => {
    const card = el('div', 'card');
    card.id = 'card-' + it.sym.replace(/[^A-Za-z0-9]/g, '_');
    card.innerHTML = `
      <div class="row1">
        <div><div class="tick">${it.tick}</div><div class="ko">${it.ko}</div></div>
        <div class="dl" title="시세 지연 (마지막 체결 시각 기준)">—</div>
      </div>
      <div class="px">—</div>
      <div class="chg flat-c">—</div>
      <div class="hl"><span class="hi">H —</span><span class="lo">L —</span><span class="op">O —</span></div>
      <canvas></canvas>`;
    host.appendChild(card);
  });
}
function renderCards() {
  INDEX.forEach((it) => {
    const q = state.quotes[it.sym];
    const card = document.getElementById('card-' + it.sym.replace(/[^A-Za-z0-9]/g, '_'));
    if (!card) return;
    const px = card.querySelector('.px'), chg = card.querySelector('.chg');
    const dl = card.querySelector('.dl');
    if (!q || !q.ok || q.price == null) {
      px.textContent = '—'; chg.textContent = '수신 대기'; chg.className = 'chg flat-c';
      px.style.color = ''; chg.style.color = '';
      dl.textContent = '—'; dl.style.color = '#5c6878';
      return;
    }
    const tr = trend(q.pct);
    px.textContent = fmtPrice(q.price, it.digits);
    chg.textContent = `${fmtNum(q.change)}  ${fmtPct(q.pct)}`;
    px.style.color = tr.css;
    chg.style.color = tr.css;

    // 강도는 왼쪽 띠와 배경 농도로도 읽힌다
    card.style.borderLeft = tr.sign === 0
      ? '3px solid rgba(60,72,88,.9)'
      : `3px solid ${tr.rgba(0.30 + 0.65 * tr.t)}`;
    card.style.background = tr.sign === 0
      ? 'linear-gradient(160deg,#141b25,#0f141c)'
      : `linear-gradient(160deg, ${tr.rgba(0.05 + 0.15 * tr.t)}, #0f141c)`;

    const d = delayOf(q);
    dl.textContent = fmtDelay(d);
    dl.style.color = delayColor(d);
    dl.title = `시세 지연 ${fmtDelay(d)} · 서버 수신 ${q.age != null ? q.age.toFixed(1) + 's 전' : '—'}`;

    card.querySelector('.hi').textContent = 'H ' + fmtPrice(q.high, it.digits);
    card.querySelector('.lo').textContent = 'L ' + fmtPrice(q.low, it.digits);
    card.querySelector('.op').textContent = 'O ' + fmtPrice(q.open, it.digits);
    drawSpark(card.querySelector('canvas'), q.spark, tr);
  });
}

/* ── rows (watchlist / korea) ────────────────────────────── */
function buildRows(list, hostSel) {
  const host = $(hostSel);
  host.innerHTML = '';
  list.forEach((it) => {
    const row = el('div', 'wrow');
    row.id = idOf(it.sym);
    row.innerHTML = `<span class="nm">${it.label}</span><span class="px">—</span><span class="pc flat-c">—</span>`;
    host.appendChild(row);
  });
}
function renderRows(list) {
  list.forEach((it) => {
    const q = state.quotes[it.sym];
    const row = document.getElementById(idOf(it.sym));
    if (!row) return;
    const px = row.querySelector('.px'), pc = row.querySelector('.pc');
    if (!q || !q.ok || q.price == null) {
      px.textContent = '—'; pc.textContent = '—'; pc.className = 'pc flat-c';
      px.style.color = ''; pc.style.color = '';
      return;
    }
    const tr = trend(q.pct);
    px.textContent = fmtPrice(q.price, it.digits);
    pc.textContent = fmtPct(q.pct);
    px.style.color = tr.css;
    pc.style.color = tr.css;
  });
}

/* ── big chart ───────────────────────────────────────────── */
function pill(c, x, y, text, bg, above, hMax) {
  c.font = '10px ui-monospace, monospace';
  const tw = c.measureText(text).width + 10;
  const bh = 15;
  let by = above ? y - bh - 3 : y + 3;
  if (by < 2) by = y + 3;                                  // 위로 넘치면 아래로
  if (hMax && by + bh > hMax - 2) by = y - bh - 3;          // 아래로 넘치면 위로
  const bx = x - tw;
  c.fillStyle = bg;
  c.beginPath();
  if (c.roundRect) c.roundRect(bx, by, tw, bh, 4); else c.rect(bx, by, tw, bh);
  c.fill();
  c.fillStyle = '#0a0d12';
  c.textBaseline = 'middle';
  c.fillText(text, bx + 5, by + bh / 2 + 0.5);
  c.textBaseline = 'top';
}

function chartMarks(d) {
  const q = state.quotes[state.sel] || {};
  if (d.range !== '1d') {
    const ys = d.points.map((p) => p[1]);
    return {
      open: { v: d.points[0][1], label: '기간 시작' },
      high: { v: Math.max(...ys), label: '기간 최고' },
      low: { v: Math.min(...ys), label: '기간 최저' },
    };
  }
  const ys = d.points.map((p) => p[1]);
  const hi = (q.ok && q.high != null) ? q.high : Math.max(...ys);
  const lo = (q.ok && q.low != null) ? q.low : Math.min(...ys);
  const op = (q.ok && q.open != null) ? q.open : d.points[0][1];
  return {
    open: { v: op, label: '시가' },
    high: { v: hi, label: '당일 최고' },
    low: { v: lo, label: '당일 최저' },
  };
}

function drawChart() {
  const cv = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  const d = state.chart;
  const padL = 8, padR = 68, padT = 12, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;

  if (!d || !d.points || d.points.length < 2) {
    c.fillStyle = '#5c6878'; c.font = '12px ui-monospace, monospace';
    c.fillText('차트 데이터를 기다리는 중…', padL + 8, padT + 22);
    return;
  }

  const pts = d.points;
  const ys = pts.map((p) => p[1]);
  const marks = chartMarks(d);
  let min = Math.min(...ys), max = Math.max(...ys);
  for (const k of ['open', 'high', 'low']) {
    const v = marks[k].v;
    if (v != null && isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
  }
  if (d.prev) { min = Math.min(min, d.prev); max = Math.max(max, d.prev); }
  const pad = (max - min) * 0.12 || Math.max(0.01, max * 0.001);
  min -= pad; max += pad;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v) => padT + (1 - (v - min) / (max - min || 1)) * ih;

  c.font = '10px ui-monospace, monospace';
  c.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const y = Y(v);
    c.strokeStyle = '#161d27'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + iw, y); c.stroke();
    c.fillStyle = '#5c6878';
    c.fillText(fmtPrice(v), padL + iw + 8, y);
  }

  if (d.prev) {
    const y = Y(d.prev);
    c.save(); c.setLineDash([4, 4]); c.strokeStyle = 'rgba(140,152,168,.45)';
    c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + iw, y); c.stroke(); c.restore();
    c.fillStyle = '#8b98a8';
    c.fillText('전일', padL + iw + 8, y - 11);
  }

  // ── 시작가(시가) 선 ──
  const yH = (marks.high.v != null && isFinite(marks.high.v)) ? Y(marks.high.v) : padT;
  const yL = (marks.low.v != null && isFinite(marks.low.v)) ? Y(marks.low.v) : padT + ih;
  if (marks.open.v != null && isFinite(marks.open.v)) {
    const y = Y(marks.open.v);
    const above = Math.abs(y - yL) < 22 && Math.abs(y - yH) >= 22;
    c.strokeStyle = 'rgba(159,176,198,.72)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + iw, y); c.stroke();
    pill(c, padL + iw - 2, y, `${marks.open.label} ${fmtPrice(marks.open.v)}`, MARK_OPEN, above, padT + ih);
  }

  // ── 최고 / 최저 굵은 선 ──
  if (marks.high.v != null && isFinite(marks.high.v)) {
    const y = Y(marks.high.v);
    c.strokeStyle = MARK_HIGH; c.lineWidth = 2.8;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + iw, y); c.stroke();
    pill(c, padL + iw - 2, y, `${marks.high.label} ${fmtPrice(marks.high.v)}`, MARK_HIGH, true, padT + ih);
  }
  if (marks.low.v != null && isFinite(marks.low.v)) {
    const y = Y(marks.low.v);
    c.strokeStyle = MARK_LOW; c.lineWidth = 2.8;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + iw, y); c.stroke();
    pill(c, padL + iw - 2, y, `${marks.low.label} ${fmtPrice(marks.low.v)}`, MARK_LOW, false, padT + ih);
  }

  c.textBaseline = 'top'; c.fillStyle = '#5c6878';
  const nTicks = Math.min(6, Math.max(2, Math.floor(iw / 130)));
  const tz = { timeZone: 'America/New_York' };
  for (let i = 0; i <= nTicks; i++) {
    const t = t0 + ((t1 - t0) * i) / nTicks;
    const label = d.range === '1d'
      ? new Intl.DateTimeFormat('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' }).format(new Date(t * 1000))
      : new Intl.DateTimeFormat('en-US', { ...tz, month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));
    c.fillText(label, Math.min(Math.max(X(t) - 14, padL), padL + iw - 28), padT + ih + 7);
  }

  const last = pts[pts.length - 1];
  const base = d.prev || pts[0][1];
  const tr = trend(base ? (last[1] / base - 1) * 100 : 0);
  const g = c.createLinearGradient(0, padT, 0, padT + ih);
  g.addColorStop(0, tr.rgba(0.08 + 0.18 * tr.t));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.beginPath();
  pts.forEach(([t, v], i) => (i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v))));
  c.lineTo(X(t1), padT + ih); c.lineTo(X(t0), padT + ih); c.closePath();
  c.fillStyle = g; c.fill();

  c.beginPath();
  pts.forEach(([t, v], i) => (i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v))));
  c.strokeStyle = tr.css;
  c.lineWidth = 1.2 + 1.2 * tr.t; c.lineJoin = 'round'; c.stroke();

  c.beginPath(); c.arc(X(last[0]), Y(last[1]), 3, 0, Math.PI * 2);
  c.fillStyle = tr.css; c.fill();

  if (state.hoverX != null && state.hoverX >= padL && state.hoverX <= padL + iw) {
    const ratio = (state.hoverX - padL) / iw;
    const t = t0 + ratio * (t1 - t0);
    let best = pts[0], bd = Infinity;
    for (const p of pts) { const dd = Math.abs(p[0] - t); if (dd < bd) { bd = dd; best = p; } }
    const x = X(best[0]), y = Y(best[1]);
    c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(230,237,245,.35)';
    c.beginPath(); c.moveTo(x, padT); c.lineTo(x, padT + ih); c.stroke();
    c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + iw, y); c.stroke();
    c.restore();
    c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2);
    c.fillStyle = '#e6edf5'; c.fill();

    const tf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(best[0] * 1000));
    const txt = `${tf} ET  ${fmtPrice(best[1])}`;
    c.font = '11px ui-monospace, monospace';
    const tw = c.measureText(txt).width + 16;
    const bx = Math.min(Math.max(padL + 6, x + 10), padL + iw - tw);
    c.fillStyle = 'rgba(17,22,30,.96)'; c.strokeStyle = '#2a3543';
    c.beginPath();
    if (c.roundRect) c.roundRect(bx, padT + 4, tw, 21, 5); else c.rect(bx, padT + 4, tw, 21);
    c.fill(); c.stroke();
    c.fillStyle = '#e6edf5'; c.textBaseline = 'middle';
    c.fillText(txt, bx + 8, padT + 15);
    c.textBaseline = 'top';
  }
}

function renderChartMeta() {
  const d = state.chart;
  const meta = $('#chartMeta');
  const item = INDEX.find((x) => x.sym === state.sel) || { tick: state.sel, ko: '' };
  const q = state.quotes[state.sel] || {};
  const dly = delayOf(q);
  const dlyTag = `<span class="mk"><i class="dl-dot" style="background:${delayColor(dly)}"></i>지연 ${fmtDelay(dly)}</span>`;
  if (!d || !d.points || !d.points.length) {
    meta.innerHTML = `<b style="color:#e6edf5;font-size:13px;letter-spacing:.08em">${item.tick}</b>
      <span style="color:#5c6878">${item.ko}</span><span style="color:#5c6878">데이터 없음</span>${dlyTag}`;
    return;
  }
  const last = d.points[d.points.length - 1][1];
  const delta = d.prev ? last - d.prev : null;
  const pct = d.prev ? (delta / d.prev) * 100 : null;
  const tr = trend(pct);
  const mk = chartMarks(d);
  meta.innerHTML = `
    <b style="color:#e6edf5;font-size:13px;letter-spacing:.08em">${item.tick}</b>
    <span style="color:#5c6878">${item.ko}</span>
    <span class="big" style="color:${tr.css}">${fmtPrice(last)}</span>
    <span style="color:${tr.css}">${fmtNum(delta)} ${fmtPct(pct)}</span>
    <span style="color:#5c6878">${d.interval} · ${d.points.length}개</span>
    <span class="mk"><i style="background:${MARK_OPEN}"></i>${mk.open.label} ${fmtPrice(mk.open.v)}</span>
    <span class="mk"><i style="background:${MARK_HIGH}"></i>${mk.high.label} ${fmtPrice(mk.high.v)}</span>
    <span class="mk"><i style="background:${MARK_LOW}"></i>${mk.low.label} ${fmtPrice(mk.low.v)}</span>
    ${dlyTag}`;
}

/* ── panels ──────────────────────────────────────────────── */
function renderTimeline() {
  const ul = $('#timeline');
  ul.innerHTML = '';
  const rows = [
    ['KO 09:00', '한국 정규장 개장'],
    ['KO 15:30', '한국 정규장 마감'],
    ['ET 09:30', '미국 RTH 개장'],
    ['ET 16:00', '미국 RTH 마감'],
    ['ET 17:00', '데일리 브레이크'],
    ['ET 18:00', 'Globex 재개'],
  ];
  rows.forEach(([t, label]) => ul.appendChild(el('li', '', `<span class="t">${t}</span><span>${label}</span>`)));
  const { dow, h, m } = etParts();
  const mins = h * 60 + m;
  const kst = kstString();
  const km = +kst.slice(0, 2) * 60 + +kst.slice(3, 5);
  if (km >= 540 && km < 930) ul.children[0].classList.add('now');
  if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(dow) && mins >= 570 && mins < 960) ul.children[2].classList.add('now');
}

function renderSession() {
  const s = sessionInfo();
  const b = $('#sessionBadge');
  b.textContent = s.label;
  b.className = 'badge ' + s.klass;
  const bar = $('#sessionBar');
  bar.innerHTML = '';
  const mk = (from, to, color) => {
    const i = document.createElement('i');
    i.style.left = (from / 1440 * 100) + '%';
    i.style.width = ((to - from) / 1440 * 100) + '%';
    i.style.background = color;
    bar.appendChild(i);
  };
  mk(0, 1020, 'rgba(76,141,255,.45)');
  mk(1020, 1080, 'rgba(255,92,106,.35)');
  mk(1080, 1440, 'rgba(76,141,255,.45)');
  const now = document.createElement('div');
  now.className = 'now';
  now.style.left = (s.pos * 100) + '%';
  bar.appendChild(now);
}

function renderDelay() {
  const q = state.quotes[state.sel];
  const d = delayOf(q);
  const item = INDEX.find((x) => x.sym === state.sel);
  const node = $('#delayVal');
  const kNode = $('#delayK');
  if (kNode) kNode.textContent = '지연 · ' + (item ? item.tick : '—');
  const closed = sessionInfo().klass === 'closed';
  if (closed && d != null && d > 120) {
    node.textContent = '휴장';
    node.style.color = '#5c6878';
    node.title = `휴장 중 · ${item ? item.tick : ''} 마지막 체결 기준 ${fmtDelay(d)}`;
  } else {
    node.textContent = fmtDelay(d);
    node.style.color = delayColor(d);
    node.title = `${item ? item.tick : ''} 시세 지연 — 마지막 체결 시각에서 지금까지 (카드 우측 상단은 종목별 지연)`;
  }
  node.classList.toggle('slow', d != null && d >= 20);
}

function tickClocks() {
  $('#clockKST').textContent = kstString();
  const p = etParts();
  $('#clockET').textContent = `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}:${String(p.s).padStart(2, '0')}`;
  if (state.lastOk) $('#syncAge').textContent = Math.round((Date.now() - state.lastOk) / 1000) + 's 전';
  renderDelay();
  if (state.chart) renderChartMeta();
}
function setDot(kind) { $('#liveDot').className = 'dot' + (kind ? ' ' + kind : ''); }

/* ── backend base ─────────────────────────────────────────────
   이 페이지는 GitHub Pages에서 정적으로 서빙될 수 있고, 데이터는 터널로
   노출된 로컬 서버에서 받는다. 아래 순서로 살아 있는 서버를 찾는다.
     1) ?api=<base>            URL 파라미터
     2) endpoint.json          run.sh 가 터널 주소를 써 두는 파일
     3) window.DASH_API_BASE   호스트 페이지가 심어 준 값
     4) same-origin            서버가 직접 이 페이지를 서빙하는 경우
*/
const API_TIMEOUT_MS = 2500;
let API = '';

function api(u) { return API + u; }

async function probeBase(base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(base + '/healthz', { cache: 'no-store', signal: ctl.signal });
    return r.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function resolveApi() {
  const cands = [];
  const q = new URLSearchParams(location.search).get('api');
  if (q) cands.push(q.replace(/\/+$/, ''));
  try {
    const r = await fetch('endpoint.json?_=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.apiBase) cands.push(String(j.apiBase).replace(/\/+$/, ''));
    }
  } catch (e) { /* 아직 배포되지 않음 */ }
  if (typeof window.DASH_API_BASE === 'string' && window.DASH_API_BASE) {
    cands.push(window.DASH_API_BASE.replace(/\/+$/, ''));
  }
  if (!/\.github\.io$/.test(location.hostname)) cands.push('');

  for (const base of cands) {
    if (await probeBase(base)) { API = base; return base; }
  }
  API = '';
  return '';
}

/* ── data ────────────────────────────────────────────────── */
const ALL = [...INDEX.map((x) => x.sym), ...WATCH.map((x) => x.sym), ...KOREA.map((x) => x.sym)];

async function loadQuotes() {
  try {
    const r = await fetch(api('/api/quotes?symbols=' + encodeURIComponent(ALL.join(','))), { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'api error');
    let ok = 0;
    for (const q of j.quotes) { state.quotes[q.symbol] = q; if (q.ok) ok++; }
    state.lastFetchAt = Date.now();
    if (ok) { state.lastOk = Date.now(); setDot('live'); } else setDot('stale');
    $('#footerState').textContent = `${new Date().toLocaleTimeString('ko-KR')} 수신 · ${ok}/${j.quotes.length} 종목`;
    renderCards(); renderRows(WATCH); renderRows(KOREA); renderKoreaNote();
    if (state.chart) { renderChartMeta(); drawChart(); }
    renderDelay();
  } catch (e) {
    setDot('err');
    $('#footerState').textContent = '서버 연결 실패: ' + e.message;
  }
}

function renderKoreaNote() {
  const es = state.quotes['ES=F'];
  const note = $('#koreaNote');
  if (!es || !es.ok || es.pct == null) { note.textContent = '—'; return; }
  const beta = 0.9;
  const implied = es.pct * beta;
  const tr = trend(implied);
  note.innerHTML = `ES ${fmtPct(es.pct)} × β ${beta} = <b style="color:${tr.css}">코스피200 야간 환산 ${fmtPct(implied)}</b><br>
    실제 야간선물 호가가 아니라 방향성 참고치입니다.`;
}

async function loadChart() {
  const err = $('#chartErr');
  try {
    const r = await fetch(api(`/api/chart?symbol=${encodeURIComponent(state.sel)}&range=${state.range}`), { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'chart error');
    state.chart = j;
    err.hidden = true;
    renderChartMeta(); drawChart();
  } catch (e) {
    err.hidden = false;
    state.chart = null;
    renderChartMeta();
  }
}

/* ── wiring ──────────────────────────────────────────────── */
function buildTabs() {
  const host = $('#tabs');
  host.innerHTML = '';
  INDEX.forEach((it) => {
    const b = el('button', it.sym === state.sel ? 'on' : '', it.tick);
    b.onclick = () => {
      state.sel = it.sym;
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.chart = null; loadChart();
    };
    host.appendChild(b);
  });
}
function wireRanges() {
  document.querySelectorAll('#ranges button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#ranges button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.range = b.dataset.range;
      state.chart = null; loadChart();
    };
  });
}
function wireHover() {
  const cv = $('#chart');
  cv.addEventListener('mousemove', (e) => {
    state.hoverX = e.clientX - cv.getBoundingClientRect().left;
    drawChart();
  });
  cv.addEventListener('mouseleave', () => { state.hoverX = null; drawChart(); });
}

async function start() {
  buildCards(); buildRows(WATCH, '#watch'); buildRows(KOREA, '#korea');
  buildTabs(); wireRanges(); wireHover();
  renderSession(); renderTimeline(); tickClocks();
  await resolveApi();
  loadQuotes(); loadChart();

  setInterval(tickClocks, 1000);
  setInterval(renderSession, 30000);
  setInterval(loadQuotes, QUOTE_MS);
  setInterval(loadChart, CHART_MS);
  setInterval(renderTimeline, 60000);
  window.addEventListener('resize', () => { renderCards(); drawChart(); });
}

document.addEventListener('DOMContentLoaded', start);
