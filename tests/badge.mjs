/* The home-menu badge shows GAME_VERSION, reads "Alpha · v<n>", and fits on a small phone. */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/hrtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/usr/bin/google-chrome';

function mime(p) {
  const e = extname(p);
  return { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[e] || 'application/octet-stream';
}

/* Serve a different version than the real one, so a hardcoded number can't pass. */
const source = readFileSync(join(ROOT, 'index.html'), 'utf8');
const html = source.replace(/GAME_VERSION = \d+/, 'GAME_VERSION = 98');
if (html === source) { console.error('GAME_VERSION definition not found'); process.exit(1); }

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  const path = normalize(join(ROOT, decodeURIComponent(url)));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': mime(path) });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
const fails = [];
let shown = '';
try {
  for (const width of [320, 360, 390]) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => fails.push('page error: ' + e.message));
    await page.setViewport({ width, height: 700 });
    await page.goto('http://127.0.0.1:' + server.address().port + '/index.html', { waitUntil: 'load' });
    const got = await page.evaluate(() => {
      /* A fresh profile opens on the name screen, so bring up the menu to measure it. */
      document.getElementById('nameScreen').hidden = true;
      document.getElementById('startScreen').hidden = false;
      const el = document.getElementById('alphaBadge'), r = el.getBoundingClientRect();
      return { text: el.innerText, left: r.left, right: r.right, height: r.height, eyebrow: el.parentElement.getBoundingClientRect().height };
    });
    shown = got.text;
    console.log(width + 'px', JSON.stringify(got));
    if (got.text !== 'Alpha · v98') fails.push(width + 'px: badge reads "' + got.text + '"');
    if (got.height <= 0 || got.left < 0 || got.right > width) fails.push(width + 'px: badge off screen');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
console.log('PASS badge', shown);
