/* Byte-compare the gameplay functions and the six arenas to f292a66, plus the rule changes D approved since (tests/lib/approved.mjs). */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withApproved, APPROVED } from './lib/approved.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['update', 'hit', 'press', 'threats', 'addBar', 'speedAt', 'resolve', 'act', 'addSplit', 'makeSwitch', 'barUnits', 'crossed', 'snapNow', 'hud', 'arena', 'beltAt', 'barRelSpeed', 'minBarGap', 'widestGap', 'newRound', 'switchLane', 'spawnPickup', 'collect', 'holeOpenAt', 'hammerType', 'barVisible', 'runnerR', 'finish', 'resolveWall'];

function sliceFn(src, fnAt) {
  let i = src.indexOf('{', fnAt);
  if (i < 0) throw new Error('no brace');
  let depth = 0, quote = '', esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (c === '\\' && quote !== '`') { esc = true; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[j + 1] === '/') { const n = src.indexOf('\n', j); j = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[j + 1] === '*') { const n = src.indexOf('*/', j + 2); j = n < 0 ? src.length : n + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(fnAt, j + 1); }
  }
  throw new Error('unclosed at ' + fnAt);
}

function extract(src, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('missing function ' + name);
  const fnAt = src.indexOf('function ' + name, m.index);
  return sliceFn(src, fnAt);
}

function between(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error('missing slice ' + a);
  return src.slice(i, j);
}

const base = withApproved(execFileSync('git', ['show', 'f292a66:index.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20e6 }));
const now = readFileSync(join(ROOT, 'index.html'), 'utf8');
const bad = [];
for (const name of NAMES) {
  let a, b;
  try { a = extract(base, name); b = extract(now, name); }
  catch (e) { bad.push(name + ' ' + e.message); continue; }
  if (a !== b) bad.push(name + ' changed (' + a.length + ' vs ' + b.length + ')');
}
const arenaA = between(base, 'var ARENAS = {', 'var ORDER = ');
const arenaB = between(now, 'var ARENAS = {', 'var ORDER = ');
if (arenaA !== arenaB) bad.push('ARENAS block changed');
const lines = [
  'var ROUND = 90, RUN = 0.62, BAR0 = 0.9, STUN_T = 1.1, CLOSE_T = 0.12, CUE_T = 0.7, LANE_CUE_T = 1.0, LANE_T = 0.16, HAMMER_P = 6;',
  'var DUCK_T = 0.5;',
  'o.jumpT = o.jumpT || 0.5;',
  'jumpT: 0.8, reverse: true',
  '--low: #ff8a2a;',
  '--high: #3fa9ff;'
];
for (const line of lines) if (!now.includes(line) || !base.includes(line)) bad.push('missing ' + line);
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('PASS identity', NAMES.length, 'functions + 6 arenas + constants match f292a66 plus', APPROVED.length, 'approved rule change');
