// Runs on GitHub Actions: fetches daily prices from Yahoo and writes data.json for the app.
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const core = html.split('/*CORE_START*/')[1].split('/*CORE_END*/')[0];
const { analyze, istParts } = new Function(core + ';return {analyze,istParts}')();

const syms = [...new Set(fs.readFileSync('symbols.txt', 'utf8').split(/[\s,;]+/)
  .map(s => s.trim().toUpperCase()).filter(Boolean))];
const HOSTS = process.env.YF_BASE ? [process.env.YF_BASE] : ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseChart(res) {
  const ts = res.timestamp || [], q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (c == null || h == null || l == null) continue;
    const b = { ts: ts[i], o: o == null ? c : o, h, l, c };
    const pb = bars[bars.length - 1];
    if (pb && istParts(pb.ts).ymd === istParts(b.ts).ymd) bars[bars.length - 1] = b; else bars.push(b);
  }
  const m = res.meta || {};
  if (bars.length && m.regularMarketPrice && m.regularMarketTime) {
    const lb = bars[bars.length - 1];
    if (istParts(m.regularMarketTime).ymd === istParts(lb.ts).ymd) {
      lb.c = m.regularMarketPrice; lb.h = Math.max(lb.h, lb.c); lb.l = Math.min(lb.l, lb.c);
    }
  }
  return bars;
}

async function getBars(sym) {
  const path = '/v8/finance/chart/' + encodeURIComponent(sym + '.NS') + '?range=3y&interval=1d&includePrePost=false';
  let err;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(HOSTS[a % HOSTS.length] + path, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.status === 404) throw Object.assign(new Error('404'), { stop: true });
      if (r.status === 429) { await sleep(2500 * (a + 1)); throw new Error('429'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error('no data');
      return parseChart(res);
    } catch (e) { err = e; if (e.stop) break; await sleep(400); }
  }
  throw err;
}

let old = {};
try { old = JSON.parse(fs.readFileSync('data.json', 'utf8')).d || {}; } catch (e) {}

const out = {}, failed = [];
let idx = 0, done = 0;
const gen = Date.now();
async function worker() {
  while (true) {
    const i = idx++; if (i >= syms.length) return;
    const s = syms[i];
    try {
      const bars = await getBars(s);
      const a = analyze(bars);
      if (!a) throw new Error('short history');
      out[s] = { px: a.px, prev: a.prev, lv: a.lv, ld: a.ld, th: a.th, tl: a.tl, to: a.to, t: gen };
    } catch (e) { failed.push(s + ':' + e.message); if (old[s]) out[s] = old[s]; }
    done++;
    if (done % 100 === 0) console.log(done + '/' + syms.length + ' failed ' + failed.length);
    await sleep(120);
  }
}
await Promise.all([worker(), worker(), worker()]);

const okCount = syms.length - failed.length;
console.log('fetched ' + okCount + ' of ' + syms.length + ', failed ' + failed.length);
if (failed.length) console.log('sample failures: ' + failed.slice(0, 15).join(', '));
if (okCount < syms.length * 0.3) { console.error('Too many failures (Yahoo may be blocking). data.json not changed.'); process.exit(1); }

const round = (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v;
fs.writeFileSync('data.json', JSON.stringify({ gen, n: Object.keys(out).length, d: out }, round));
console.log('data.json written');
