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
const CHART_MS = 10000;
const STRONG_PCT = 1.0;   // 기준선에서 ±1% 떨어지면 색 농도 최대

const INTERVALS = [
  { key: '1m',  label: '1분' },
  { key: '5m',  label: '5분' },
  { key: '15m', label: '15분' },
  { key: '30m', label: '30분' },
  { key: '60m', label: '60분' },
  { key: '1d',  label: '1일' },
];

const state = {
  sel: 'ES=F',
  interval: '1m',
  quotes: {},
  chart: null,
  view: null,          // 보이는 구간 {from,to} (epoch 초)
  lastOk: 0,
  lastFetchAt: 0,
  hoverX: null,
  barScale: 0,
  areaStrength: { up: 0, dn: 0 },
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

/** sign(+1/-1/0) + 농도(0..1) -> {sign, t, rgb, css, rgba(a)} */
function shade(sign, t) {
  const k = clamp01(t);
  const from = sign > 0 ? UP_WEAK : sign < 0 ? DOWN_WEAK : FLAT_RGB;
  const to = sign > 0 ? UP_STRONG : sign < 0 ? DOWN_STRONG : FLAT_RGB;
  const rgb = [0, 1, 2].map((i) => Math.round(mix(from[i], to[i], k)));
  return {
    sign, t: k, rgb,
    css: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
    rgba: (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`,
  };
}

/** pct(변동률 %) -> {sign, t, rgb, css, rgba} — 카드·스파크라인용(고정 ±1% 스케일) */
function trend(pct) {
  const v = (pct == null || !isFinite(pct)) ? 0 : pct;
  const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
  return shade(sign, sign === 0 ? 0 : clamp01(Math.pow(Math.abs(v) / STRONG_PCT, 0.6)));
}

/** 봉별 변동률 목록 -> '강한 봉' 기준값. 상위 15% 지점을 최대 농도로 삼는다. */
function spikeScale(deltas) {
  const a = deltas.map(Math.abs).filter((v) => isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!a.length) return 0.01;
  return Math.max(a[Math.min(a.length - 1, Math.floor(a.length * 0.85))], 0.004);
}

/** |값| / 기준 -> 0..1 농도 (지각에 맞게 완만한 곡선) */
const strength = (v, scale) => clamp01(Math.pow(Math.abs(v) / (scale || 1), 0.7));
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
/* ── big chart ─────────────────────────────────────────────────
   기준선 = 직전 정산가(일봉은 전일 종가). 기준선 위는 빨강, 아래는 파랑,
   기준선에서 멀수록 진하다. 휠 확대·축소 / 드래그 이동 / 더블클릭 전체.
*/
const CH = { padL: 8, padR: 68, padT: 14, padB: 24 };
const MIN_BARS = 8;
const BASE_COLOR = '#e2e8f0';

function chartGeom() {
  const cv = $('#chart');
  const w = cv.clientWidth, h = cv.clientHeight;
  return { cv, w, h, iw: w - CH.padL - CH.padR, ih: h - CH.padT - CH.padB };
}

function barSecOf(d) {
  if (!d) return 60;
  if (d.interval === '1d') return 86400;
  return (d.coverage && d.coverage.barSec) || 60;
}

function lastTs(d) {
  return (d && d.points && d.points.length) ? d.points[d.points.length - 1][0] : null;
}

function fullView() {
  const d = state.chart;
  if (!d || !d.points || d.points.length < 2) return null;
  const p = d.points;
  if (d.interval === '1d') {                   // 일봉은 최근 1년부터 보여 준다
    const i = Math.max(0, p.length - 260);
    return { from: p[i][0], to: p[p.length - 1][0] };
  }
  return { from: p[0][0], to: p[p.length - 1][0] };
}

function setView(from, to, redraw) {
  const d = state.chart;
  if (!d || !d.points || d.points.length < 2) { state.view = null; return; }
  const p = d.points;
  const f0 = p[0][0], f1 = p[p.length - 1][0];
  const full = f1 - f0;
  const minSpan = Math.min(full, Math.max(barSecOf(d) * MIN_BARS, 60));
  const span = Math.min(Math.max(to - from, minSpan), full);
  const mid = (from + to) / 2;
  let nf, nt;
  if (span >= full) { nf = f0; nt = f1; }
  else {
    nf = mid - span / 2; nt = mid + span / 2;
    if (nf < f0) { nt += f0 - nf; nf = f0; }
    if (nt > f1) { nf -= nt - f1; nt = f1; }
    nf = Math.max(f0, nf); nt = Math.min(f1, nt);
  }
  state.view = { from: nf, to: nt };
  if (redraw !== false) { drawChart(); renderChartMeta(); }
}

function sliceVisible(p, view) {
  if (!view) return p.slice();
  let lo = 0, hi = p.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (p[m][0] < view.from) lo = m + 1; else hi = m; }
  const i0 = Math.max(0, lo - 1);
  lo = 0; hi = p.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (p[m][0] > view.to) hi = m - 1; else lo = m; }
  const i1 = Math.min(p.length - 1, lo + 1);
  return p.slice(i0, i1 + 1);
}

function placePills(c, items, xRight, top, bottom) {
  if (!items.length) return;
  items.sort((a, b) => a.y - b.y);
  const gap = 17;
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap;
  }
  const over = items[items.length - 1].y - (bottom - 9);
  if (over > 0) for (const it of items) it.y -= over;
  for (const it of items) if (it.y < top + 9) it.y = top + 9;
  c.font = '10px ui-monospace, monospace';
  c.textBaseline = 'middle';
  for (const it of items) {
    const tw = c.measureText(it.text).width + 10, bh = 15;
    const bx = xRight - tw, by = it.y - bh / 2;
    c.fillStyle = it.bg;
    c.beginPath();
    if (c.roundRect) c.roundRect(bx, by, tw, bh, 4); else c.rect(bx, by, tw, bh);
    c.fill();
    c.fillStyle = '#0a0d12';
    c.fillText(it.text, bx + 5, it.y + 0.5);
  }
  c.textBaseline = 'top';
}

function drawChart() {
  const { cv, w, h, iw, ih } = chartGeom();
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  const padL = CH.padL, padT = CH.padT;
  const d = state.chart;

  if (!d || !d.points || d.points.length < 2) {
    c.fillStyle = '#5c6878'; c.font = '12px ui-monospace, monospace';
    c.textBaseline = 'top';
    c.fillText('차트 데이터를 기다리는 중…', padL + 8, padT + 22);
    return;
  }
  if (!state.view) state.view = fullView();
  const view = state.view;
  const pts = sliceVisible(d.points, view);
  if (pts.length < 2) return;

  const base = (d.prev != null && isFinite(d.prev)) ? d.prev : null;
  const m = d.marks || {};
  const ys = pts.map((p) => p[1]);
  let min = Math.min(...ys), max = Math.max(...ys);
  const span0 = (max - min) || Math.max(0.01, Math.abs(max) * 0.0004);
  const near = (v) => v != null && isFinite(v) && v > min - 1.6 * span0 && v < max + 1.6 * span0;
  for (const k of ['open', 'high', 'low']) if (near(m[k])) { min = Math.min(min, m[k]); max = Math.max(max, m[k]); }
  if (base != null && near(base)) { min = Math.min(min, base); max = Math.max(max, base); }
  const pad = (max - min) * 0.10 || 0.01;
  min -= pad; max += pad;

  const t0 = view.from, t1 = view.to;
  const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v) => padT + (1 - (v - min) / (max - min || 1)) * ih;
  const x0 = padL, x1 = padL + iw, yTop = padT, yBot = padT + ih;

  // 격자 + y축 눈금
  c.font = '10px ui-monospace, monospace';
  c.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const y = Y(v);
    c.strokeStyle = '#161d27'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    c.fillStyle = '#5c6878';
    c.fillText(fmtPrice(v), x1 + 8, y);
  }

  const firstX = X(pts[0][0]), lastX = X(pts[pts.length - 1][0]);
  const yB = base != null ? Y(base) : null;

  // ── 기준선 위는 빨강, 아래는 파랑 (면적을 기준선에서 자른다) ──
  const areaPath = () => {
    c.beginPath();
    pts.forEach(([t, v], i) => { const x = X(t), y = Y(v); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.lineTo(lastX, yB); c.lineTo(firstX, yB); c.closePath();
  };
  // 면적 농도 = 기준선에서 가장 멀리 나간 폭 (보이는 구간 기준으로 눈금을 맞춘다)
  let upMax = 0, dnMax = 0;
  if (base != null) {
    for (const [, v] of pts) {
      const r = (v / base - 1) * 100;
      if (r > upMax) upMax = r;
      if (-r > dnMax) dnMax = -r;
    }
  }
  const areaRef = Math.max(((max - min) / (base || max)) * 100 * 0.9, 0.02);
  const aUp = 0.05 + 0.25 * strength(upMax, areaRef);
  const aDn = 0.05 + 0.25 * strength(dnMax, areaRef);
  state.areaStrength = { up: strength(upMax, areaRef), dn: strength(dnMax, areaRef) };
  if (base != null) {
    if (yB > yTop) {
      c.save();
      c.beginPath(); c.rect(x0, yTop, iw, yB - yTop); c.clip();
      areaPath();
      const g = c.createLinearGradient(0, yTop, 0, Math.max(yB, yTop + 1));
      g.addColorStop(0, `rgba(255,62,72,${aUp.toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,62,72,.015)');
      c.fillStyle = g; c.fill();
      c.restore();
    }
    if (yB < yBot) {
      c.save();
      c.beginPath(); c.rect(x0, yB, iw, yBot - yB); c.clip();
      areaPath();
      const g = c.createLinearGradient(0, Math.min(yB, yBot - 1), 0, yBot);
      g.addColorStop(0, `rgba(58,140,255,${aDn.toFixed(3)})`);
      g.addColorStop(1, 'rgba(58,140,255,.015)');
      c.fillStyle = g; c.fill();
      c.restore();
    }
  }

  // ── 선: 방향은 기준선 위/아래, 농도·굵기는 그 봉의 변동 폭 ──
  const deltas = [];
  for (let i = 1; i < pts.length; i++) deltas.push((pts[i][1] / pts[i - 1][1] - 1) * 100);
  const dScale = spikeScale(deltas);
  state.barScale = dScale;
  c.lineJoin = 'round'; c.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const va = pts[i - 1][1], vb = pts[i][1];
    const vm = (va + vb) / 2;
    const dp = (vb / va - 1) * 100;
    const side = base != null ? (vm >= base ? 1 : -1) : (dp >= 0 ? 1 : -1);
    const tr = shade(side, strength(dp, dScale));
    c.strokeStyle = tr.css;
    c.lineWidth = 1.0 + 2.3 * tr.t;
    c.beginPath(); c.moveTo(X(pts[i - 1][0]), Y(va)); c.lineTo(X(pts[i][0]), Y(vb)); c.stroke();
  }

  const pills = [];

  // ── 기준선(직전 정산가) ──
  if (base != null) {
    const yy = Math.max(yTop, Math.min(yBot, yB));
    c.save();
    c.setLineDash([5, 4]);
    c.strokeStyle = 'rgba(226,232,240,.5)';
    c.lineWidth = 1.3;
    c.beginPath(); c.moveTo(x0, yy); c.lineTo(x1, yy); c.stroke();
    c.restore();
    const inside = yB >= yTop - 1 && yB <= yBot + 1;
    pills.push({
      y: inside ? yB : (yB < yTop ? yTop + 9 : yBot - 9),
      text: (yB < yTop ? '↑ 기준 ' : yB > yBot ? '↓ 기준 ' : '기준 ') + fmtPrice(base),
      bg: BASE_COLOR,
    });
  }

  // ── 시가 / 최고 / 최저 ──
  const line = (v, color, width, dash) => {
    const y = Y(v);
    c.save();
    if (dash) c.setLineDash(dash);
    c.strokeStyle = color; c.lineWidth = width;
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    c.restore();
  };
  if (m.open != null && near(m.open)) {
    line(m.open, 'rgba(159,176,198,.62)', 1.4);
    pills.push({ y: Y(m.open), text: `시가 ${fmtPrice(m.open)}`, bg: MARK_OPEN });
  }
  if (m.high != null && near(m.high)) {
    line(m.high, MARK_HIGH, 2.8);
    pills.push({ y: Y(m.high), text: `최고 ${fmtPrice(m.high)}`, bg: MARK_HIGH });
  }
  if (m.low != null && near(m.low)) {
    line(m.low, MARK_LOW, 2.8);
    pills.push({ y: Y(m.low), text: `최저 ${fmtPrice(m.low)}`, bg: MARK_LOW });
  }
  placePills(c, pills, x1 - 2, yTop, yBot);

  // ── x축 눈금 ──
  c.textBaseline = 'top'; c.fillStyle = '#5c6878';
  c.font = '10px ui-monospace, monospace';
  const spanSec = t1 - t0;
  const nTicks = Math.min(6, Math.max(2, Math.floor(iw / 130)));
  for (let i = 0; i <= nTicks; i++) {
    const t = t0 + (spanSec * i) / nTicks;
    let label;
    if (d.interval === '1d') {
      label = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
        .format(new Date(t * 1000));
    } else {
      const o = { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' };
      if (spanSec > 86400) { o.month = '2-digit'; o.day = '2-digit'; }
      label = new Intl.DateTimeFormat('en-US', o).format(new Date(t * 1000));
    }
    c.fillText(label, Math.min(Math.max(X(t) - 16, x0), x1 - 40), yBot + 7);
  }

  // ── 마지막 점 ──
  const last = pts[pts.length - 1];
  const lastRel = base ? (last[1] / base - 1) * 100 : 0;
  const lastTr = trend(lastRel);
  c.beginPath(); c.arc(X(last[0]), Y(last[1]), 3.2, 0, Math.PI * 2);
  c.fillStyle = lastTr.css; c.fill();

  // ── 크로스헤어 ──
  if (state.hoverX != null && state.hoverX >= x0 && state.hoverX <= x1) {
    const ratio = (state.hoverX - x0) / iw;
    const t = t0 + ratio * spanSec;
    let best = pts[0], bd = Infinity;
    for (const p of pts) { const dd = Math.abs(p[0] - t); if (dd < bd) { bd = dd; best = p; } }
    const x = X(best[0]), y = Y(best[1]);
    c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(230,237,245,.35)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, yTop); c.lineTo(x, yBot); c.stroke();
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    c.restore();
    c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2);
    c.fillStyle = '#e6edf5'; c.fill();

    const tf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(best[0] * 1000));
    const rel = base ? (best[1] / base - 1) * 100 : null;
    const bi = pts.indexOf(best);
    let barTxt = '';
    if (bi > 0) {
      const dp = (best[1] / pts[bi - 1][1] - 1) * 100;
      barTxt = `  봉 ${fmtPct(dp)} · 강도 ${Math.round(strength(dp, dScale) * 100)}%`;
    }
    const txt = `${tf} ET  ${fmtPrice(best[1])}` + (rel != null ? `  ${fmtPct(rel)}` : '') + barTxt;
    c.font = '11px ui-monospace, monospace';
    const tw = c.measureText(txt).width + 16;
    const bx = Math.min(Math.max(x0 + 6, x + 10), x1 - tw);
    c.fillStyle = 'rgba(17,22,30,.96)'; c.strokeStyle = '#2a3543'; c.lineWidth = 1;
    c.beginPath();
    if (c.roundRect) c.roundRect(bx, yTop + 4, tw, 21, 5); else c.rect(bx, yTop + 4, tw, 21);
    c.fill(); c.stroke();
    c.fillStyle = '#e6edf5'; c.textBaseline = 'middle';
    c.fillText(txt, bx + 8, yTop + 15);
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
  const g = (d && d.granularity) || {};
  const band = '최소 ' + (g.chartMinLabel || '1분');

  if (!d || !d.points || !d.points.length) {
    meta.innerHTML = `<b style="color:#e6edf5;font-size:13px;letter-spacing:.08em">${item.tick}</b>
      <span style="color:#5c6878">${item.ko}</span>
      <span style="color:#5c6878">데이터 없음</span>
      <span class="mk">${band}</span>${dlyTag}`;
    return;
  }

  const last = d.points[d.points.length - 1][1];
  const base = d.prev;
  const delta = base != null ? last - base : null;
  const pct = base ? (delta / base) * 100 : null;
  const tr = trend(pct);
  const m = d.marks || {};
  const label = d.interval === '1d' ? '일봉' : `${d.intervalLabel}봉`;
  const vis = state.view ? sliceVisible(d.points, state.view).length : d.points.length;
  const fmt = (t) => (d.interval === '1d'
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(t * 1000))
    : new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(t * 1000)).replace(',', ''));
  const range = state.view ? `${fmt(state.view.from)} ~ ${fmt(state.view.to)} ET` : '';
  const sc = state.barScale || 0;
  const scTxt = sc > 0 ? (sc < 0.1 ? sc.toFixed(3) : sc.toFixed(2)) : null;
  const scaleTag = scTxt
    ? `<span class="mk" style="background:transparent;border:1px solid #2a3543;color:#8b98a8" title="이 봉에서 이만큼 움직이면 색 농도 최대">농도 기준 봉 ±${scTxt}%</span>`
    : '';

  meta.innerHTML = `
    <b style="color:#e6edf5;font-size:13px;letter-spacing:.08em">${item.tick}</b>
    <span style="color:#5c6878">${item.ko}</span>
    <span class="big" style="color:${tr.css}">${fmtPrice(last)}</span>
    <span style="color:${tr.css}">${fmtNum(delta)} ${fmtPct(pct)}</span>
    <span class="mk"><i style="background:${BASE_COLOR}"></i>기준 ${fmtPrice(base)}</span>
    <span class="mk"><i style="background:${MARK_OPEN}"></i>시가 ${fmtPrice(m.open)}</span>
    <span class="mk"><i style="background:${MARK_HIGH}"></i>최고 ${fmtPrice(m.high)}</span>
    <span class="mk"><i style="background:${MARK_LOW}"></i>최저 ${fmtPrice(m.low)}</span>
    <span style="color:#5c6878">${label} ${d.points.length}개 · 보기 ${vis}개</span>
    <span class="mk">${band}</span>
    ${scaleTag}
    ${range ? `<span style="color:#5c6878">${range}</span>` : ''}
    ${dlyTag}`;

  const mu = $('#minUnit');
  if (mu) {
    mu.textContent = band;
    mu.title = (g.note || '') + (g.tradeGap ? ` · 관측된 체결 갱신 간격 ${g.tradeGap}초` : '');
  }
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
    const r = await fetch(api(`/api/chart?symbol=${encodeURIComponent(state.sel)}&interval=${state.interval}`),
      { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'chart error');
    const prevLast = lastTs(state.chart);
    state.chart = j;
    err.hidden = true;
    const newLast = lastTs(j);
    if (!state.view) {
      state.view = fullView();
    } else if (prevLast != null && newLast != null && state.view.to >= prevLast - barSecOf(j)) {
      // 오른쪽 끝(실시간)을 보고 있었으면 새 봉까지 따라간다
      const span = state.view.to - state.view.from;
      setView(newLast - span, newLast, false);
    } else {
      setView(state.view.from, state.view.to, false);
    }
    renderChartMeta(); drawChart();
  } catch (e) {
    err.hidden = false;
    state.chart = null;
    state.view = null;
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
      state.chart = null; state.view = null; loadChart();
    };
    host.appendChild(b);
  });
}
function buildIntervals() {
  const host = $('#intervals');
  host.innerHTML = '';
  INTERVALS.forEach((it) => {
    const b = el('button', it.key === state.interval ? 'on' : '', it.label);
    b.dataset.interval = it.key;
    b.title = it.key === '1d'
      ? '일봉 · 최근 5년(휠로 확대)'
      : `${it.label}봉 · Sina 1분봉을 묶어 생성`;
    b.onclick = () => {
      if (state.interval === it.key) return;
      state.interval = it.key;
      host.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.chart = null; state.view = null;
      loadChart();
    };
    host.appendChild(b);
  });
}

function wireChart() {
  const cv = $('#chart');

  document.querySelectorAll('#zoom button').forEach((b) => {
    b.onclick = () => {
      const v = state.view || fullView();
      if (!v) return;
      const mode = b.dataset.zoom;
      if (mode === 'reset') { state.view = fullView(); drawChart(); renderChartMeta(); return; }
      const mid = (v.from + v.to) / 2, span = v.to - v.from;
      const k = mode === 'in' ? 0.6 : 1.65;
      setView(mid - (span * k) / 2, mid + (span * k) / 2);
    };
  });

  cv.addEventListener('wheel', (e) => {
    if (!state.chart) return;
    e.preventDefault();
    const v = state.view || fullView();
    if (!v) return;
    const rect = cv.getBoundingClientRect();
    const { iw } = chartGeom();
    const ratio = clamp01((e.clientX - rect.left - CH.padL) / (iw || 1));
    const span = v.to - v.from;
    const k = e.deltaY < 0 ? 0.78 : 1.28;
    const anchor = v.from + span * ratio;
    setView(anchor - (anchor - v.from) * k, anchor + (v.to - anchor) * k);
  }, { passive: false });

  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (!state.chart) return;
    const v = state.view || fullView();
    if (!v) return;
    drag = { x: e.clientX, v };
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('pointermove', (e) => {
    const rect = cv.getBoundingClientRect();
    state.hoverX = e.clientX - rect.left;
    if (drag) {
      const { iw } = chartGeom();
      const dt = ((drag.x - e.clientX) * (drag.v.to - drag.v.from)) / (iw || 1);
      setView(drag.v.from + dt, drag.v.to + dt);
    } else {
      drawChart();
    }
  });
  cv.addEventListener('pointerup', () => {
    if (drag) { drag = null; cv.style.cursor = 'crosshair'; drawChart(); }
  });
  cv.addEventListener('pointerleave', () => {
    if (!drag) { state.hoverX = null; drawChart(); }
  });
  cv.addEventListener('dblclick', () => {
    state.view = fullView();
    drawChart(); renderChartMeta();
  });
  cv.style.cursor = 'crosshair';
  cv.title = '휠 확대·축소 · 드래그 이동 · 더블클릭 전체 구간';
}

async function start() {
  buildCards(); buildRows(WATCH, '#watch'); buildRows(KOREA, '#korea');
  buildTabs(); buildIntervals(); wireChart();
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
