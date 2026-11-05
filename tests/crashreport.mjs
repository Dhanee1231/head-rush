/* Crash reporter, against a fake fetch (no network): normal play sends nothing, ?crashtest=1 sends one report, the limit of 5 holds,
   a failed send doesn't throw, and nothing private is sent. */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/hrtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'index.html'), 'utf8');
const fails = [];
const NAME = 'Zorblax';

/* The reporter keeps its own copies, because it runs before the game script. */
const pick = (re) => { const m = source.match(re); if (!m) fails.push('not found in index.html: ' + re); return m ? m[1] : null; };
const version = Number(pick(/GAME_VERSION = (\d+)/));
const sbUrl = pick(/var SB_URL = '([^']+)'/), sbKey = pick(/var SB_KEY = '([^']+)'/);
if (Number(pick(/var VERSION = (\d+)/)) !== version) fails.push('reporter VERSION differs from GAME_VERSION');
if (pick(/var CRASH_KEY = '([^']+)'/) !== sbKey) fails.push('reporter key differs from SB_KEY');
if (pick(/var CRASH_URL = '([^']+)'/) !== sbUrl + '/rest/v1/rpc/log_crash') fails.push('reporter URL differs from SB_URL');
if (source.indexOf("addEventListener('unhandledrejection'") > source.indexOf('<script type="importmap">')) fails.push('reporter is not the first script');

/* Test-only hooks in the served copy, so the live game gains nothing. Inline here, so errors count as coming from index.html. */
const MARK = "  renderProfile();\n  $('howto').open";
const EARLY = "(function () {\n  'use strict';\n  var TAU";
if (!source.includes(MARK) || !source.includes(EARLY)) { console.error('hook point not found'); process.exit(1); }
const HOOK = `
  window.__t = {
    setup: function (name) { voiceOn = false; musicVol = 0; if (!currentPlayer()) addPlayer(name); hideAllOverlays(); pickMode('party'); },
    finish: function () { hideAllOverlays(); newRound('neon', 'party', 0); running = false; G.t = 42; G.result = 'win'; G.place = 1; G.close = 3; G.bonus = 0; showEnd(); },
    state: function () { return { running: running, t: G.t }; },
    player: function () { return currentPlayer(); },
    boom: function (msg) { setTimeout(function () { throw new Error(msg); }, 0); },
    boomNamed: function (name) {
      var pl = currentPlayer();
      var m = name + ' ' + name.toUpperCase() + ' ' + encodeURIComponent(name) + ' ' + pl.id + ' ' + pl.cloudId + ' ' + pl.secret;
      setTimeout(function () { var e = new Error(m); e.stack = 'Error: ' + m + '\\n    at ' + name + ' (' + location.origin + '/index.html:1:2)'; throw e; }, 0);
    },
    boomJson: function () { setTimeout(function () { JSON.parse('nope typed secret words 987654'); }, 0); },
    boomRoom: function () { setTimeout(function () { var e = new Error('room url'); e.stack = 'Error: room url\\n    at f (' + location.origin + '/index.html?room=QQQQ:1:2)'; throw e; }, 0); },
    reject: function (msg) { Promise.reject(new Error(msg)); },
    rejectForeign: function () { var e = new Error('foreign rejection'); e.stack = 'Error: foreign rejection\\n    at f (https://cdn.example.com/lib.js:1:2)'; Promise.reject(e); },
    rejectBare: function () { Promise.reject('bare string'); }
  };
`;
const html = source.replace(MARK, HOOK + MARK);
const early = source.replace(EARLY, EARLY.replace('  var TAU', "  throw new Error('early boom');\n  var TAU"));

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  if (url === '/early.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(early); return; }
  const path = normalize(join(ROOT, decodeURIComponent(url)));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:' + server.address().port;

/* Own files still load for real; other sites get a fake answer. window.__sendMode picks how the fake log_crash behaves. */
const fakeFetch = () => {
  const real = window.fetch;
  /* The test box has no network, so Chrome says offline there. Pretend to be online; the offline case below overrides this. */
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  window.__sends = []; window.__sendMode = 'ok'; window.__rejections = 0;
  window.addEventListener('unhandledrejection', () => { window.__rejections++; });
  window.fetch = function (url, opts) {
    const u = String(url && url.url || url);
    if (u.startsWith(location.origin) || !/^https?:/.test(u)) return real.apply(this, arguments);
    if (u.includes('log_crash')) {
      window.__sends.push({ url: u, opts });
      if (window.__sendMode === 'throw') throw new Error('fake send threw');
      if (window.__sendMode === 'reject') return Promise.reject(new TypeError('fake send rejected'));
    }
    return Promise.resolve(new Response('null', { status: 200 }));
  };
};

async function open(path, name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(fakeFetch);
  await page.goto(base + path, { waitUntil: 'load' });
  if (name) await page.evaluate((n) => window.__t.setup(n), name);
  page.sends = () => page.evaluate(() => window.__sends.map((s) => ({ url: s.url, method: s.opts.method, headers: s.opts.headers, body: JSON.parse(s.opts.body) })));
  page.ctx = ctx;
  return page;
}
const check = (name, ok, detail) => { if (!ok) fails.push(name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
/* Starts a real round the way a player does and confirms the game clock runs. */
async function playRound(page, label, ms) {
  await page.evaluate(() => window.__t.finish());
  await sleep(600);
  await page.evaluate(() => document.getElementById('againBtn').scrollIntoView({ block: 'center' }));
  const p = await page.evaluate(() => { const r = document.getElementById('againBtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.touchscreen.tap(p.x, p.y);
  await sleep(100);
  const a = await page.evaluate(() => window.__t.state());
  await sleep(ms);
  const b = await page.evaluate(() => window.__t.state());
  check(label + ': round did not run', a.running && b.t > a.t, { a, b });
}

try {
  /* Normal play sends nothing, including past the moment the crash test would fire. */
  let page = await open('/index.html', NAME);
  await playRound(page, 'normal play', 2500);
  check('normal play sent a report', (await page.sends()).length === 0, await page.sends());
  check('normal play had page errors', page.errors.length === 0, page.errors);
  await page.ctx.close();

  /* ?crashtest=1 sends one complete report, and the game still plays. */
  page = await open('/index.html?crashtest=1&room=QQQQ', NAME);
  await sleep(2000);
  await playRound(page, 'crash test', 1000);
  let sends = await page.sends();
  check('crashtest did not send exactly one report', sends.length === 1, sends);
  check('crashtest threw more than once', page.errors.filter((e) => e.includes('Head Rush crash test')).length === 1, page.errors);
  if (sends[0]) {
    const s = sends[0], b = s.body;
    check('wrong URL', s.url === sbUrl + '/rest/v1/rpc/log_crash', s.url);
    check('wrong method', s.method === 'POST', s.method);
    check('wrong headers', s.headers.apikey === sbKey && s.headers.Authorization === 'Bearer ' + sbKey && s.headers['Content-Type'] === 'application/json', s.headers);
    check('wrong body fields', Object.keys(b).sort().join() === 'p_browser,p_message,p_source,p_stack,p_version', b);
    check('wrong message', b.p_message.includes('Head Rush crash test'), b.p_message);
    check('wrong source', /^\/index\.html:\d+$/.test(b.p_source), b.p_source);
    check('no stack', b.p_stack.includes('index.html'), b.p_stack);
    check('wrong version', b.p_version === version, b.p_version);
    check('browser label is not short', /^Chrome \d+ Linux$/.test(b.p_browser), b.p_browser);
    check('query string was sent', !JSON.stringify(b).includes('QQQQ') && !JSON.stringify(b).includes('crashtest='), b);
  }
  await page.ctx.close();

  /* At most 5 reports a page load, and each message once. */
  page = await open('/index.html', NAME);
  for (let i = 0; i < 8; i++) await page.evaluate((n) => window.__t.boom('limit ' + n), i);
  await sleep(200);
  sends = await page.sends();
  check('limit of 5 did not hold', sends.length === 5, sends.map((s) => s.body.p_message));
  await page.ctx.close();
  page = await open('/index.html', NAME);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__t.boom('same message'));
  await page.evaluate(() => window.__t.reject('same rejection'));
  await page.evaluate(() => window.__t.reject('same rejection'));
  await sleep(200);
  sends = await page.sends();
  check('repeat messages were sent again', sends.length === 2, sends.map((s) => s.body.p_message));
  check('rejection report is wrong', sends[1] && sends[1].body.p_message === 'Error: same rejection' && /^\/index\.html:\d+$/.test(sends[1].body.p_source), sends[1]);
  await page.ctx.close();

  /* A failed send doesn't throw, doesn't loop back into a report, and isn't retried. */
  for (const mode of ['reject', 'throw']) {
    page = await open('/index.html', NAME);
    await page.evaluate((m) => { window.__sendMode = m; }, mode);
    await page.evaluate(() => window.__t.boom('failed send'));
    await sleep(300);
    const r = await page.evaluate(() => ({ n: window.__sends.length, rej: window.__rejections }));
    check(mode + ': send was not tried exactly once', r.n === 1, r);
    check(mode + ': failure leaked as a rejection', r.rej === 0, r);
    check(mode + ': failure leaked as a page error', page.errors.every((e) => e.includes('failed send')), page.errors);
    await page.evaluate(() => { window.__sendMode = 'ok'; window.__t.boom('after failure'); });
    await sleep(100);
    check(mode + ': reporter stopped after a failure', (await page.sends()).length === 2);
    await playRound(page, mode + ' send', 500);
    await page.ctx.close();
  }

  /* No saved name or ID in what's sent, including from an unreadable .bad copy. */
  page = await open('/index.html', NAME);
  const pl = await page.evaluate(() => window.__t.player());
  await page.evaluate(() => { localStorage.setItem('headrush.players.v1.bad', '{"list":[{"id":"x","name":"Qwyndle B."'); });
  await page.evaluate((n) => window.__t.boomNamed(n), NAME);
  await page.evaluate(() => window.__t.boom('Qwyndle B. broke it'));
  await page.evaluate(() => window.__t.boomJson());
  await page.evaluate(() => window.__t.boomRoom());
  await sleep(200);
  sends = await page.sends();
  check('privacy cases did not all send', sends.length === 4, sends.map((s) => s.body.p_message));
  const text = JSON.stringify(sends.map((s) => s.body));
  for (const word of [NAME, NAME.toUpperCase(), pl.id, pl.cloudId, pl.secret, 'Qwyndle', 'secret words', '987654', 'QQQQ']) check('sent ' + word, !text.toLowerCase().includes(word.toLowerCase()), text);
  check('stack with the name was not kept', sends[0] && sends[0].body.p_stack.includes('***'), sends[0]);
  await page.ctx.close();

  /* Errors that aren't the game's are ignored. */
  page = await open('/index.html', NAME);
  await page.evaluate(() => {
    const fire = (o) => window.dispatchEvent(new ErrorEvent('error', o));
    fire({ message: 'Script error.' });
    fire({ message: 'Script error.', filename: location.href, lineno: 1 });
    fire({ message: 'extension broke', filename: 'chrome-extension://abc/content.js', lineno: 1 });
    fire({ message: 'other site broke', filename: 'https://cdn.example.com/lib.js', lineno: 1 });
    fire({ message: 'no file' });
    const e = new Error('injected by extension');
    e.stack = 'Error: injected by extension\n    at f (chrome-extension://abc/content.js:1:2)';
    fire({ message: 'injected by extension', filename: location.href, lineno: 1, error: e });
    window.__t.rejectForeign();
    window.__t.rejectBare();
  });
  await sleep(200);
  sends = await page.sends();
  check('foreign errors were reported', sends.length === 0, sends.map((s) => s.body.p_message));
  await page.ctx.close();

  /* Offline: nothing, and it doesn't use up a report. */
  page = await open('/index.html', NAME);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.__t.boom('offline'); });
  await sleep(100);
  check('sent while offline', (await page.sends()).length === 0);
  await page.ctx.close();

  /* An error in the very first line of the game script is still caught. */
  page = await open('/early.html');
  sends = await page.sends();
  check('error at the start of the game script was missed', sends.length === 1 && sends[0].body.p_message.includes('early boom') && sends[0].body.p_source.startsWith('/early.html:'), sends);
  await page.ctx.close();
} finally {
  await browser.close();
  server.close();
}
if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
console.log('PASS crash report');
