/* Seeded replay of today's 6 arenas.
   Capture (from the f292a66 game plus the rule changes D approved since, see tests/lib/approved.mjs,
   with only a test hook added) writes tests/golden-hud.json.
   Check loads the working tree and requires the same HUD samples, twice. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withApproved } from './lib/approved.mjs';
import puppeteer from '/tmp/hrtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests', 'golden-hud.json');
const CHROME = '/usr/bin/google-chrome';
const ARENAS = ['neon', 'gear', 'frost', 'lava', 'orbit', 'carnival'];
const DIFFS = ['easy', 'medium', 'hard'];
const SEED = 20261102;

const HOOK = `
  window.__sim = {
    runAll: function () {
      voiceOn = false; musicVol = 0;
      var arenas = ${JSON.stringify(ARENAS)};
      var diffs = ${JSON.stringify(DIFFS)};
      var out = { runs: {}, daily: {} };
      function samp() {
        var you = G.players[0];
        var remain = G.dur == null ? G.t : G.dur - Math.min(Math.max(G.t, 0), G.dur);
        function r(x) { return Math.round(x * 1e6) / 1e6; }
        hud(); setAlive();
        return {
          t: r(G.t), timer: timerEl.textContent, alive: aliveEl.textContent,
          pre: $('hudPre').textContent, post: $('hudPost').textContent,
          hearts: G.players.map(function (p) { return p.hearts; }).join(''),
          nAlive: G.players.filter(function (p) { return !p.out; }).length,
          youA: r(you.angle), air: r(you.air), duck: r(you.duck), stun: r(you.stun),
          lane: you.lane, hits: G.hits || 0, close: G.close || 0,
          omega: r(G.omega), dir: G.dir, bf: r(G.bf),
          bars: G.bars.map(function (b) { return r(b.angle).toFixed(4) + b.type.charAt(0); }).join('|'),
          holes: G.holes.map(function (o) { return o.state + ':' + r(o.until).toFixed(3); }).join('|')
        };
      }
      function runOne(arena, diff, seed) {
        var saved = Math.random, rng = mulberry32(seed >>> 0);
        Math.random = rng;
        var samples = [], targets = [10, 30, 60], ti = 0, guard = 0, dt = 1 / 60;
        try {
          newRound(arena, 'party', 0, null, { diff: diff });
          while (ti < targets.length && guard < 20000) {
            guard++;
            var you = G.players[0], cues = [];
            if (G.t >= 0 && !you.out && G.t >= you.stun) {
              threats(you, cues);
              var best = null;
              for (var i = 0; i < cues.length; i++) {
                var th = cues[i];
                if (!th.vis && th.tti > 0.4) continue;
                var limit = th.need === 'lane' ? 0.42 : 0.34;
                if (th.tti > limit) continue;
                if (th.need === 'jump' && G.t < you.air) continue;
                if (th.need === 'duck' && G.t < you.duck) continue;
                if (!best || th.tti < best.tti) best = th;
              }
              if (best) press(best.need);
            }
            if (typeof kitBefore === 'function') kitBefore();
            update(dt);
            if (typeof kitAfter === 'function') kitAfter(dt);
            if (G.t + 1e-8 >= targets[ti]) { samples.push(samp()); ti++; }
          }
        } finally { Math.random = saved; }
        return samples;
      }
      arenas.forEach(function (a) {
        diffs.forEach(function (d) { out.runs[a + '/' + d] = runOne(a, d, ${SEED}); });
      });
      ['2026-11-02', '2026-01-01', '2026-07-04'].forEach(function (k) {
        var dc = dailyFor(k);
        out.daily[k] = { arena: dc.arena, twist: dc.twist.id, diff: dc.diff };
      });
      out.consts = { ROUND: ROUND, RUN: RUN, BAR0: BAR0, STUN_T: STUN_T, CLOSE_T: CLOSE_T, DUCK_T: DUCK_T, jumpT: ARENAS.neon.jumpT, orbitJump: ARENAS.orbit.jumpT };
      return out;
    }
  };
`;

function inject(html) {
  /* The two-space call also sits inside indented frame() lines, including Sky Tower's
     early return. Only the call that closes the IIFE runs at load, which is where __sim must exist. */
  const needle = '\n  requestAnimationFrame(frame);\n})();';
  const hits = html.split(needle).length - 1;
  if (hits !== 1) throw new Error('hook point count ' + hits);
  return html.replace(needle, '\n' + HOOK + needle);
}

function mime(p) {
  const e = extname(p);
  return { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.css': 'text/css' }[e] || 'application/octet-stream';
}

function serve(indexHtml) {
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(indexHtml);
      return;
    }
    const path = normalize(join(ROOT, decodeURIComponent(url)));
    if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': mime(path) });
    res.end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runPage(indexHtml) {
  const server = await serve(indexHtml);
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio']
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('headrush.voice', '0');
      localStorage.setItem('headrush.musicVol', '0');
      localStorage.setItem('headrush.sfxVol', '0');
    });
    await page.goto('http://127.0.0.1:' + port + '/index.html?simtest=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__sim && window.__sim.runAll');
    const out = await page.evaluate(() => window.__sim.runAll());
    return out;
  } finally {
    await browser.close();
    server.close();
  }
}

function diffRuns(a, b) {
  const bad = [];
  for (const k of Object.keys(a.runs)) {
    const A = a.runs[k], B = b.runs[k];
    if (!B) { bad.push(k + ' missing'); continue; }
    if (JSON.stringify(A) !== JSON.stringify(B)) {
      for (let i = 0; i < A.length; i++) {
        if (JSON.stringify(A[i]) !== JSON.stringify(B[i])) bad.push(k + ' @' + (A[i] && A[i].t) + '\n  base ' + JSON.stringify(A[i]) + '\n  now  ' + JSON.stringify(B[i]));
      }
    }
  }
  if (JSON.stringify(a.daily) !== JSON.stringify(b.daily)) bad.push('daily ' + JSON.stringify(a.daily) + ' vs ' + JSON.stringify(b.daily));
  if (JSON.stringify(a.consts) !== JSON.stringify(b.consts)) bad.push('consts ' + JSON.stringify(b.consts));
  return bad;
}

const mode = process.argv[2] || 'check';
if (mode === 'capture') {
  const base = withApproved(execFileSync('git', ['show', 'f292a66:index.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20e6 }));
  console.log('capturing f292a66 plus approved rule changes…');
  const out = await runPage(inject(base));
  for (const k of Object.keys(out.runs)) {
    if (!out.runs[k] || out.runs[k].length !== 3) throw new Error('short run ' + k);
  }
  console.log('capturing twice to confirm the hook is stable…');
  const again = await runPage(inject(base));
  const drift = diffRuns(out, again);
  if (drift.length) { console.error(drift.slice(0, 8).join('\n')); process.exit(1); }
  writeFileSync(GOLDEN, JSON.stringify(out, null, 2));
  console.log('wrote', GOLDEN, 'runs', Object.keys(out.runs).length);
} else {
  if (!existsSync(GOLDEN)) { console.error('missing golden'); process.exit(1); }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  console.log('replay 1…');
  const a = await runPage(inject(html));
  console.log('replay 2…');
  const b = await runPage(inject(html));
  const drift = diffRuns(a, b);
  const vs = diffRuns(golden, a);
  if (drift.length || vs.length) {
    console.error('DRIFT\n' + drift.slice(0, 6).join('\n'));
    console.error('VS GOLDEN\n' + vs.slice(0, 12).join('\n'));
    process.exit(1);
  }
  const n = Object.values(a.runs).reduce((s, r) => s + r.length, 0);
  const expect = Object.values(golden.runs).reduce((s, r) => s + r.length, 0);
  if (n !== expect) { console.error('sample count ' + n + ' vs ' + expect); process.exit(1); }
  console.log('PASS replay ' + n + '/' + n + ' HUD samples match f292a66 plus approved rule changes, twice');
  console.log('consts', JSON.stringify(a.consts));
}
