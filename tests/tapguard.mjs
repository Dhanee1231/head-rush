/* The results screen ignores taps for its first half second, then every button works. Real touches on a phone-size page.
   `node tests/tapguard.mjs shot` also saves tests/screenshots/results-360.png. */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/hrtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'index.html'), 'utf8');
const fails = [];

/* Every way onto the results screen has to start the guard. */
const direct = source.match(/\$\('endScreen'\)\.hidden = false/g) || [];
if (direct.length !== 1) fails.push('endScreen is opened directly ' + direct.length + ' times; only showEndScreen should');

/* Test-only hook in the served copy, so the live game gains nothing. */
const MARK = "  renderProfile();\n  $('howto').open";
if (!source.includes(MARK)) { console.error('hook point not found'); process.exit(1); }
const HOOK = `
  window.__end = {
    setup: function () { voiceOn = false; musicVol = 0; if (!currentPlayer()) addPlayer('Sam'); hideAllOverlays(); pickMode('party'); },
    finish: function () {
      hideAllOverlays(); newRound('neon', 'party', 0); running = false;
      G.t = 42; G.result = 'win'; G.place = 1; G.close = 3; G.bonus = 0;
      showEnd();
    },
    replayBack: function () { $('endScreen').hidden = true; REPLAY = { fin: snapNow(), byId: {} }; endReplay(); },
    state: function () {
      return { end: !$('endScreen').hidden, fb: !$('fbScreen').hidden, running: running, t: G.t,
        share: $('shareMsg').textContent + $('shareText').textContent };
    }
  };
`;
const html = source.replace(MARK, HOOK + MARK);

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  const path = normalize(join(ROOT, decodeURIComponent(url)));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => fails.push('page error: ' + e.message));
  await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html', { waitUntil: 'load' });
  await page.evaluate(() => window.__end.setup());

  const spot = (id) => page.evaluate((i) => {
    const el = document.getElementById(i);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
  const tap = async (id) => { const p = await spot(id); await page.touchscreen.tap(p.x, p.y); await sleep(30); };
  const state = () => page.evaluate(() => window.__end.state());
  /* Runs the steps inside the guard, and fails rather than passes if the machine was too slow to land them in time. */
  const inGuard = async (name, steps) => {
    const at = Date.now();
    await steps();
    if (Date.now() - at > 450) fails.push(name + ': too slow to test the guard (' + (Date.now() - at) + ' ms)');
  };

  for (const id of ['againBtn', 'shareBtn', 'fbOpenEnd', 'switchBtn']) {
    await page.evaluate(() => window.__end.finish());
    await inGuard('early ' + id, () => tap(id));
    const s = await state();
    if (!s.end || s.fb || s.running || s.share) fails.push('early tap on ' + id + ' did something: ' + JSON.stringify(s));
  }

  /* A finger that lands inside the half second and lifts after it is still a late tap. */
  await page.evaluate(() => window.__end.finish());
  const held = await spot('againBtn');
  await page.touchscreen.touchStart(held.x, held.y);
  await sleep(600);
  await page.touchscreen.touchEnd();
  await sleep(30);
  let s = await state();
  if (!s.end || s.running) fails.push('tap held across the end of the guard got through: ' + JSON.stringify(s));

  /* Skipping a replay brings the results back under the finger. */
  await sleep(600);
  await page.evaluate(() => window.__end.replayBack());
  await inGuard('after replay', () => tap('againBtn'));
  s = await state();
  if (!s.end || s.running) fails.push('tap right after a replay got through: ' + JSON.stringify(s));

  /* After the half second, buttons work on the first tap, on the same screen that ignored taps. */
  await sleep(600);
  await tap('fbOpenEnd');
  s = await state();
  if (!s.fb || s.end) fails.push('Give feedback did not open after the guard: ' + JSON.stringify(s));
  await tap('fbClose');
  s = await state();
  if (s.fb || !s.end) fails.push('feedback did not return to the results: ' + JSON.stringify(s));
  await tap('shareBtn');
  await sleep(100);
  s = await state();
  if (!s.share) fails.push('Share did nothing after the guard: ' + JSON.stringify(s));
  await tap('againBtn');
  s = await state();
  if (s.end || !s.running) fails.push('Run again did not start a round after the guard: ' + JSON.stringify(s));

  if (process.argv[2] === 'shot') {
    /* A fresh profile and settled confetti, so the picture shows one normal round with its buttons. */
    const ctx = await browser.createBrowserContext();
    const fresh = await ctx.newPage();
    await fresh.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await fresh.goto('http://127.0.0.1:' + server.address().port + '/index.html', { waitUntil: 'load' });
    await fresh.evaluate(() => { window.__end.setup(); window.__end.finish(); });
    await sleep(4000);
    await fresh.evaluate(() => document.getElementById('switchBtn').scrollIntoView({ block: 'end' }));
    await sleep(100);
    mkdirSync(join(ROOT, 'tests', 'screenshots'), { recursive: true });
    await fresh.screenshot({ path: join(ROOT, 'tests', 'screenshots', 'results-360.png') });
    await ctx.close();
    console.log('saved tests/screenshots/results-360.png');
  }
} finally {
  await browser.close();
  server.close();
}
if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
console.log('PASS tap guard');
