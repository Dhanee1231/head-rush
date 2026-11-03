/* Neon Bounce rules: boost, squish, stun, room gate, and both flat and lite draws. */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/hrtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'));
const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
  const path = normalize(join(ROOT, decodeURIComponent(url)));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('no'); return; }
  const e = extname(path);
  res.writeHead(200, { 'content-type': e === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html?simtest=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__kit && window.__kit.bounceTest');
  const out = await page.evaluate(() => window.__kit.bounceTest());
  if (!out.ok) { console.error(out.fails.join('\n')); process.exit(1); }
  console.log('PASS neon bounce');
} finally {
  await browser.close();
  server.close();
}
