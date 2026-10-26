/* Head Rush HD renderer: real-time 3D with three.js (WebGL).
   The game logic stays in index.html; this module only draws what the game state says. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const HR3D = (window.HR3D = window.HR3D || {});
HR3D.ok = false;
const TAU = Math.PI * 2;

let G_API = null;
let renderer, scene, camera, composer, renderPass, bloomPass, outputPass, envTex, glCanvas;
let quality = { level: 3, pr: 2, bloom: true, shadows: true };
let curArena = null, arenaCache = {};
let keyLight, rimLight, hemi, fillLight;
let floorMesh, sideMesh, rimTop, rimLow, hubGroup, youRing, puddles = [];
let runnerPool = [], barPool = [], hammerPool = [], wallPool = [], beltPool = [], holePool = [];
let orb, particleMesh, bulbs, snowPts, emberPts;
const tmpV = new THREE.Vector3(), tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
let frameTimes = [], lastAdapt = 0, lastNow = 0;

/* ---------- helpers ---------- */
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function col(c) { return new THREE.Color(c); }
function sectorGeo(r0, r1, a0, a1, seg, y = 0, vcol) {
  const pos = [], uv = [], idx = [], colr = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg, a = a0 + (a1 - a0) * u, c = Math.cos(a), s = Math.sin(a);
    pos.push(r0 * c, y, r0 * s, r1 * c, y, r1 * s); uv.push(u, 0, u, 1);
    if (vcol) { const k = vcol(u); colr.push(k[0], k[1], k[2], k[0], k[1], k[2]); }
    if (i < seg) { const b = i * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (vcol) g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function starShape(R, r) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r : R; const x = Math.cos(a) * rad, y = Math.sin(a) * rad; i ? s.lineTo(x, y) : s.moveTo(x, y); }
  s.closePath(); return s;
}
function gearShape(R, teeth) {
  const s = new THREE.Shape();
  for (let i = 0; i < teeth * 4; i++) { const a = i / (teeth * 4) * TAU, rr = (i % 4 === 1 || i % 4 === 2) ? R : R * 0.84; const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? s.lineTo(x, y) : s.moveTo(x, y); }
  s.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, R * 0.22, 0, TAU, true); s.holes.push(hole);
  for (let k = 0; k < 5; k++) { const a = k / 5 * TAU + 0.6, h = new THREE.Path(); h.absarc(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, R * 0.15, 0, TAU, true); s.holes.push(h); }
  return s;
}
function rnd(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
function disposeTree(o) {
  o.traverse(n => {
    if (n.geometry && !n.geometry.userData.shared) n.geometry.dispose();
    if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => { if (m.userData.shared) return; ['map', 'emissiveMap'].forEach(k => m[k] && m[k].dispose()); m.dispose(); });
  });
}

/* ---------- shared geometry and materials ---------- */
const GEO = {}, MAT = {};
function shared(g) { g.userData.shared = true; return g; }
function smat(m) { m.userData.shared = true; return m; }
function buildShared() {
  GEO.round = shared(new THREE.CapsuleGeometry(0.36, 0.5, 10, 28).translate(0, 0.61, 0));
  GEO.square = shared(new RoundedBoxGeometry(0.74, 1.12, 0.74, 5, 0.2).translate(0, 0.56, 0));
  GEO.triangle = shared(new THREE.LatheGeometry([[0, 0], [0.44, 0], [0.51, 0.04], [0.52, 0.12], [0.5, 0.2], [0.14, 1.06], [0.08, 1.15], [0, 1.18]].map(p => new THREE.Vector2(p[0], p[1])), 40));
  const dia = new THREE.LatheGeometry([[0, 0], [0.06, 0.01], [0.5, 0.56], [0.5, 0.64], [0.06, 1.15], [0, 1.16]].map(p => new THREE.Vector2(p[0], p[1])), 4); dia.rotateY(Math.PI / 4);
  GEO.diamond = shared(dia);
  const st = new THREE.ExtrudeGeometry(starShape(0.58, 0.28), { depth: 0.26, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 4, curveSegments: 8 });
  st.translate(0, 0, -0.13); st.translate(0, 0.62, 0);
  GEO.star = shared(st);
  GEO.eye = shared(new THREE.SphereGeometry(0.125, 20, 14));
  GEO.pupil = shared(new THREE.SphereGeometry(0.072, 16, 12));
  GEO.glint = shared(new THREE.SphereGeometry(0.022, 8, 6));
  GEO.cheek = shared(new THREE.SphereGeometry(0.07, 12, 8));
  GEO.foot = shared(new THREE.SphereGeometry(0.12, 16, 10));
  GEO.xbar = shared(new THREE.BoxGeometry(0.15, 0.035, 0.03));
  GEO.ring = shared(new THREE.TorusGeometry(0.62, 0.035, 10, 64).rotateX(Math.PI / 2));
  GEO.disc = shared(new THREE.CircleGeometry(0.62, 48).rotateX(-Math.PI / 2));
  GEO.puddle = shared(new THREE.CircleGeometry(0.42, 32).rotateX(-Math.PI / 2));
  GEO.bubble = shared(new THREE.SphereGeometry(0.82, 32, 20));
  GEO.smallStar = shared(new THREE.ExtrudeGeometry(starShape(0.09, 0.04), { depth: 0.03, bevelEnabled: false }));
  GEO.crownBand = shared(new THREE.CylinderGeometry(0.21, 0.22, 0.12, 24, 1, true));
  GEO.spike = shared(new THREE.ConeGeometry(0.05, 0.13, 8));
  GEO.gem = shared(new THREE.SphereGeometry(0.035, 10, 8));
  GEO.halo = shared(new THREE.TorusGeometry(0.24, 0.03, 10, 40).rotateX(Math.PI / 2));
  GEO.horn = shared(new THREE.ConeGeometry(0.075, 0.3, 12));
  GEO.stalk = shared(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 6));
  GEO.ball = shared(new THREE.SphereGeometry(0.065, 14, 10));
  GEO.topStar = shared(new THREE.ExtrudeGeometry(starShape(0.17, 0.08), { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 }).translate(0, 0, -0.03));
  GEO.visor = shared(new THREE.TorusGeometry(0.37, 0.075, 10, 32, Math.PI * 0.8).rotateX(Math.PI / 2).rotateY(Math.PI * 0.1 + Math.PI / 2 * 0));
  GEO.spot = shared(new THREE.SphereGeometry(0.07, 12, 8));
  GEO.barCap = shared(new THREE.SphereGeometry(1, 20, 14));
  GEO.orb = shared(new THREE.SphereGeometry(0.26, 28, 18));
  MAT.hull = smat(new THREE.MeshBasicMaterial({ color: 0x0c0b1e, side: THREE.BackSide }));
  MAT.eye = smat(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, clearcoat: 1 }));
  MAT.pupil = smat(new THREE.MeshPhysicalMaterial({ color: 0x16122a, roughness: 0.1, clearcoat: 1 }));
  MAT.glint = smat(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  MAT.cheek = smat(new THREE.MeshBasicMaterial({ color: 0xff7aa0, transparent: true, opacity: 0.45, depthWrite: false }));
  MAT.foot = smat(new THREE.MeshPhysicalMaterial({ color: 0x17182c, roughness: 0.4, clearcoat: 0.6 }));
  MAT.x = smat(new THREE.MeshBasicMaterial({ color: 0x1b1530 }));
  MAT.gold = smat(new THREE.MeshPhysicalMaterial({ color: 0xffc94a, metalness: 1, roughness: 0.22, emissive: 0x6a4a00, emissiveIntensity: 0.4 }));
  MAT.goldGlow = smat(new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd060, emissiveIntensity: 2.2 }));
  MAT.gemR = smat(new THREE.MeshPhysicalMaterial({ color: 0xff4d6d, roughness: 0.05, clearcoat: 1, emissive: 0x551020 }));
  MAT.gemB = smat(new THREE.MeshPhysicalMaterial({ color: 0x3fa9ff, roughness: 0.05, clearcoat: 1, emissive: 0x10305a }));
  MAT.gemG = smat(new THREE.MeshPhysicalMaterial({ color: 0x7be0ad, roughness: 0.05, clearcoat: 1, emissive: 0x104a30 }));
  MAT.horn = smat(new THREE.MeshPhysicalMaterial({ color: 0x3a0f22, roughness: 0.3, clearcoat: 1, sheen: 1, sheenColor: new THREE.Color(0xffc2cc) }));
  MAT.stalk = smat(new THREE.MeshStandardMaterial({ color: 0x1d2140, roughness: 0.5 }));
  MAT.redGlow = smat(new THREE.MeshStandardMaterial({ color: 0xff4d6d, emissive: 0xff2050, emissiveIntensity: 2 }));
  MAT.visor = smat(new THREE.MeshPhysicalMaterial({ color: 0x14152c, roughness: 0.05, metalness: 0.3, clearcoat: 1 }));
  MAT.spot = smat(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, transparent: true, opacity: 0.75 }));
  MAT.ring = smat(new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffc020, emissiveIntensity: 2.4 }));
  MAT.ringFill = smat(new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.16, depthWrite: false }));
  MAT.puddle = smat(new THREE.MeshStandardMaterial({ color: 0x4a4c70, roughness: 0.2, transparent: true, opacity: 0.75 }));
  MAT.bubble = smat(new THREE.MeshPhysicalMaterial({ color: 0x7fe3ff, emissive: 0x2ab8e0, emissiveIntensity: 0.35, roughness: 0.05, transparent: true, opacity: 0.22, depthWrite: false, clearcoat: 1 }));
  MAT.star = smat(new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd050, emissiveIntensity: 2.5 }));
}

/* ---------- renderer ---------- */
function init() {
  glCanvas = document.createElement('canvas');
  glCanvas.id = 'gl';
  glCanvas.setAttribute('aria-hidden', 'true');
  glCanvas.style.cssText = 'position:fixed;inset:0;z-index:-2;pointer-events:none;display:none;';
  const stage = document.getElementById('stage');
  stage.insertBefore(glCanvas, stage.firstChild);
  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('webgl2');
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.22;
  pmrem.dispose();
  hemi = new THREE.HemisphereLight(0xbfc8ff, 0x20182a, 0.7); scene.add(hemi);
  keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(-5, 11, 7); keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  const sc = keyLight.shadow.camera; sc.left = -6.5; sc.right = 6.5; sc.top = 6.5; sc.bottom = -6.5; sc.near = 1; sc.far = 30;
  keyLight.shadow.bias = -0.0005; keyLight.shadow.normalBias = 0.02; keyLight.shadow.radius = 4;
  scene.add(keyLight); scene.add(keyLight.target);
  rimLight = new THREE.DirectionalLight(0x6fd6ff, 1.6); rimLight.position.set(6, 4, -8); scene.add(rimLight);
  fillLight = new THREE.PointLight(0xffffff, 0, 30, 2); fillLight.position.set(0, -1.5, 1); scene.add(fillLight);
  buildShared();
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
  renderPass = new RenderPass(scene, camera); composer.addPass(renderPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.82); composer.addPass(bloomPass);
  outputPass = new OutputPass(); composer.addPass(outputPass);
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  setQuality(mobile ? 2 : 3);
  try { const saved = +localStorage.getItem('headrush.hdq'); if (saved >= 0 && saved <= 3 && localStorage.getItem('headrush.hdq') !== null) setQuality(saved); } catch (e) {}
}
function setQuality(level) {
  level = Math.max(0, Math.min(3, level));
  quality.level = level;
  const dpr = window.devicePixelRatio || 1;
  quality.pr = Math.min(dpr, [1, 1.25, 1.6, 2][level]);
  quality.bloom = level >= 2;
  quality.shadows = level >= 1;
  if (renderer) {
    renderer.shadowMap.enabled = quality.shadows;
    keyLight.castShadow = quality.shadows;
    keyLight.shadow.mapSize.set(level >= 3 ? 2048 : 1024, level >= 3 ? 2048 : 1024);
    if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
    scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
    lastSize = '';
  }
}
let lastSize = '';
function resize(W, H) {
  const key = W + 'x' + H + '@' + quality.pr;
  if (key === lastSize) return;
  lastSize = key;
  renderer.setPixelRatio(quality.pr);
  renderer.setSize(W, H, false);
  glCanvas.style.width = W + 'px'; glCanvas.style.height = H + 'px';
  composer.setPixelRatio(quality.pr);
  composer.setSize(W, H);
  bloomPass.resolution.set(W * quality.pr / 2, H * quality.pr / 2);
}

/* ---------- arena: floor, hub, scenery ---------- */
function floorTextures(V, A, size) {
  const T = V.T, E = V.edge, s = size / (2 * E), c = size / 2;
  const P = (r, a) => [c + Math.cos(a) * r * s, c + Math.sin(a) * r * s];
  const mapT = canvasTex(size, size, (x) => {
    const g = x.createRadialGradient(c, c, 0, c, c, E * s);
    g.addColorStop(0, T.floorIn); g.addColorStop(1, T.floorOut); x.fillStyle = g; x.fillRect(0, 0, size, size);
    x.strokeStyle = rgbaHex(T.panel, 0.22); x.lineWidth = s * 0.02;
    for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; let p = P(0.85, a), q = P(1.55, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); p = P(1.65, a); q = P(V.e0 - 0.08, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); p = P(V.e1 + 0.08, a); q = P(E - 0.06, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); }
    x.beginPath(); x.arc(c, c, 1.6 * s, 0, TAU); x.stroke();
    x.beginPath(); x.arc(c, c, V.e1 * s, 0, TAU); x.arc(c, c, V.e0 * s, 0, TAU, true);
    const tg = x.createRadialGradient(c, c, V.e0 * s, c, c, V.e1 * s); tg.addColorStop(0, T.trackFar); tg.addColorStop(0.5, T.trackNear); tg.addColorStop(1, T.trackFar);
    x.fillStyle = tg; x.fill('evenodd');
    x.globalAlpha = 0.18; x.strokeStyle = T.tick; x.lineWidth = s * 0.035; x.lineJoin = 'round';
    const m = (V.e0 + V.e1) / 2, w = (V.e1 - V.e0) * 0.2;
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + 0.12; const p0 = P(m - w, a - 0.09), p1 = P(m, a), p2 = P(m + w, a - 0.09); x.beginPath(); x.moveTo(p0[0], p0[1]); x.lineTo(p1[0], p1[1]); x.lineTo(p2[0], p2[1]); x.stroke(); }
    x.globalAlpha = 1;
    for (let i = 0; i < 60; i++) { const a = Math.random() * TAU, r = 0.9 + Math.random() * (E - 1); const p = P(r, a); x.fillStyle = 'rgba(255,255,255,0.025)'; x.beginPath(); x.arc(p[0], p[1], s * (0.1 + Math.random() * 0.3), 0, TAU); x.fill(); }
  });
  const emT = canvasTex(size, size, (x) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, size, size);
    x.strokeStyle = rgbaHex(T.edge, 0.85); x.lineWidth = s * 0.03;
    x.beginPath(); x.arc(c, c, V.e1 * s, 0, TAU); x.stroke(); x.beginPath(); x.arc(c, c, V.e0 * s, 0, TAU); x.stroke();
    if (A.lanes.length > 1) { x.globalAlpha = 0.5; x.lineWidth = s * 0.02; x.setLineDash([s * 0.18, s * 0.14]); x.beginPath(); x.arc(c, c, (V.e0 + V.e1) / 2 * s, 0, TAU); x.stroke(); x.setLineDash([]); x.globalAlpha = 1; }
    x.strokeStyle = rgbaHex(T.tick, 0.9); x.lineWidth = s * 0.022;
    for (let i = 0; i < 72; i++) { const a = i / 72 * TAU; let p = P(V.e0 + 0.08, a), q = P(V.e0 + 0.2, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); p = P(V.e1 - 0.2, a); q = P(V.e1 - 0.08, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); }
    x.strokeStyle = T.rim; x.lineWidth = s * 0.05; x.beginPath(); x.arc(c, c, (E - 0.03) * s, 0, TAU); x.stroke();
  });
  return { mapT, emT };
}
function rgbaHex(h, a) { const c = new THREE.Color(h); return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; }

function buildArenaCore(V, A) {
  const T = V.T, E = V.edge, grp = new THREE.Group();
  const size = quality.level >= 3 ? 2048 : 1024;
  const ft = floorTextures(V, A, size);
  const floorMat = new THREE.MeshStandardMaterial({ map: ft.mapT, emissiveMap: ft.emT, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.6, metalness: 0.2 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(E, 128).rotateX(-Math.PI / 2), floorMat);
  floor.receiveShadow = true; grp.add(floor);
  const depth = A.id === 'orbit' ? 1.2 : 0.6;
  const sideTex = canvasTex(8, 128, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, T.sideTop); g.addColorStop(1, T.sideBot); x.fillStyle = g; x.fillRect(0, 0, w, h); });
  const side = new THREE.Mesh(new THREE.CylinderGeometry(E, E * 0.97, depth, 128, 1, true).translate(0, -depth / 2, 0), new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.5, metalness: 0.4 }));
  grp.add(side);
  const rT = new THREE.Mesh(new THREE.TorusGeometry(E, 0.04, 10, 160).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: T.rim, emissive: T.rim, emissiveIntensity: 1.3 }));
  rT.position.y = 0.01; grp.add(rT);
  const rL = new THREE.Mesh(new THREE.TorusGeometry(E * 0.975, 0.035, 10, 160).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: T.rimLow, emissive: T.rimLow, emissiveIntensity: 1.5 }));
  rL.position.y = -depth + 0.06; grp.add(rL);
  if (A.id === 'orbit') {
    const glow = new THREE.Mesh(new THREE.CircleGeometry(E * 0.8, 64).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8c6eff, transparent: true, opacity: 0.35 }));
    glow.position.y = -depth - 0.02; grp.add(glow);
  }
  const hub = new THREE.Group();
  const hubTex = canvasTex(8, 128, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, T.hubTop); g.addColorStop(1, T.hubBot); x.fillStyle = g; x.fillRect(0, 0, w, h); });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.76, 1.65, 48).translate(0, 0.825, 0), new THREE.MeshPhysicalMaterial({ map: hubTex, metalness: 0.55, roughness: 0.3, clearcoat: 0.6 }));
  body.castShadow = true; body.receiveShadow = true; hub.add(body);
  [[0.3, G_API.COL.low], [1.17, G_API.COL.high]].forEach(([y, c]) => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.035, 10, 64).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.6 }));
    r.position.y = y; hub.add(r);
  });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.72, 0.06, 48), new THREE.MeshPhysicalMaterial({ color: T.hubCap, metalness: 0.4, roughness: 0.35 }));
  cap.position.y = 1.67; hub.add(cap);
  const capRing = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.015, 6, 64).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: T.tick, emissive: T.tick, emissiveIntensity: 1.2 }));
  capRing.position.y = 1.7; hub.add(capRing);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.04, 40), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffc030, emissiveIntensity: 2.6 }));
  lamp.position.y = 1.71; hub.add(lamp);
  const lamp2 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 32), new THREE.MeshStandardMaterial({ color: 0xfff3b0, emissive: 0xfff0c0, emissiveIntensity: 3 }));
  lamp2.position.y = 1.72; hub.add(lamp2);
  grp.add(hub);
  return { grp, floor, hub };
}

function skyTexture(stops, extra) {
  return canvasTex(512, 1024, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h);
    stops.forEach(s => g.addColorStop(s[0], s[1])); x.fillStyle = g; x.fillRect(0, 0, w, h);
    if (extra) extra(x, w, h);
  });
}
function starsOn(x, w, h, n, ymax, seed) { const r = rnd(seed); for (let i = 0; i < n; i++) { x.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.7})`; const s = 0.6 + r() * 1.6; x.fillRect(r() * w, r() * h * ymax, s, s); } }

function mergeBoxes(list, mat) {
  // list: [{x,y,z,w,h,d}] -> one mesh, UVs in world units so windows tile evenly
  const pos = [], nor = [], uv = [], idx = [];
  let base = 0;
  list.forEach(b => {
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, y0 = b.y, y1 = b.y + b.h, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const faces = [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], b.w, b.h],
      [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], b.w, b.h],
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], b.d, b.h],
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], b.d, b.h],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], 0, 0]
    ];
    faces.forEach(f => {
      for (let i = 0; i < 4; i++) { pos.push(...f[i]); nor.push(...f[4]); }
      const u1 = f[5] / (b.sx || 1.1), v1 = f[6] / (b.sy || 1.4), off = b.off || 0;
      if (f[5]) uv.push(off, 0, off + u1, 0, off + u1, v1, off, v1); else uv.push(0.99, 0.99, 0.995, 0.99, 0.995, 0.995, 0.99, 0.995);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3); base += 4;
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return new THREE.Mesh(g, mat);
}
function windowTextures(seed, colors, lit) {
  const r = rnd(seed), N = 64, cell = 16;
  const pick = [];
  for (let i = 0; i < N * N; i++) pick.push(r() < lit ? colors[Math.floor(r() * colors.length)] : null);
  const draw = (emissive) => (x, w, h) => {
    x.fillStyle = emissive ? '#000' : '#161735'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = pick[i * N + j];
      if (!emissive) { x.fillStyle = c ? c : '#0e0f26'; x.globalAlpha = c ? 0.9 : 1; x.fillRect(i * cell + 4, j * cell + 4, cell - 8, cell - 7); x.globalAlpha = 1; }
      else if (c) { x.fillStyle = c; x.globalAlpha = 0.55 + ((i * 7 + j * 13) % 5) * 0.09; x.fillRect(i * cell + 4, j * cell + 4, cell - 8, cell - 7); x.globalAlpha = 1; }
    }
    x.fillStyle = emissive ? '#000' : '#1d1e45'; x.fillRect(w - 6, h - 6, 6, 6);
  };
  const map = canvasTex(N * cell, N * cell, draw(false)), em = canvasTex(N * cell, N * cell, draw(true));
  [map, em].forEach(t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / N, 1 / N); });
  return { map, em };
}

function sceneryNeon(V) {
  const g = new THREE.Group(), r = rnd(11);
  const sky = skyTexture([[0, '#05061a'], [0.35, '#15123f'], [0.55, '#3a1f63'], [0.7, '#6a2a72'], [1, '#0d0e22']], (x, w, h) => { starsOn(x, w, h, 160, 0.4, 3); });
  const wt = windowTextures(5, ['#ffd27a', '#9fd8ff', '#ff9ad5', '#fff1c9'], 0.28);
  const bmat = new THREE.MeshStandardMaterial({ map: wt.map, emissiveMap: wt.em, emissive: 0xffffff, emissiveIntensity: 0.75, roughness: 0.7, metalness: 0.2 });
  const list = [];
  for (let i = 0; i < 140; i++) { const z = -36 - r() * 70, x = -90 + r() * 180; if (Math.abs(x) < 10 && z > -46) continue; list.push({ x, z, w: 4 + r() * 8, d: 4 + r() * 8, y: -40, h: 38 + r() * r() * 32, off: Math.floor(r() * 50) }); }
  list.push({ x: -3.5, z: -42, w: 12, d: 7, y: -40, h: 43, off: 3 });
  g.add(mergeBoxes(list, bmat));
  const signTex = canvasTex(1024, 360, (x, w, h) => {
    x.fillStyle = 'rgba(12,10,36,0.95)'; x.fillRect(0, 0, w, h);
    let fs = 200; x.textAlign = 'center'; x.textBaseline = 'middle';
    do { x.font = fs + 'px "Lilita One", "Arial Black", sans-serif'; fs -= 8; } while (fs > 60 && (x.measureText('HEAD').width > w * 0.42 || x.measureText('RUSH').width > w * 0.42));
    x.shadowBlur = 30; x.shadowColor = '#ff4fa3'; x.fillStyle = '#ffd6ec'; x.fillText('HEAD', w * 0.29, h * 0.54);
    x.shadowColor = '#ffd23f'; x.fillStyle = '#fff1b0'; x.fillText('RUSH', w * 0.72, h * 0.54);
    x.shadowBlur = 0; x.strokeStyle = '#ff7cc0'; x.lineWidth = 10; x.strokeRect(8, 8, w - 16, h - 16);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 3), new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 1.6 }));
  sign.position.set(-3.5, 5.4, -38.4); sign.scale.setScalar(1.15); g.add(sign);
  const roofTex = canvasTex(512, 512, (x, w, h) => { x.fillStyle = '#16173a'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(120,130,255,0.16)'; x.lineWidth = 3; for (let i = 0; i <= 8; i++) { x.beginPath(); x.moveTo(i * 64, 0); x.lineTo(i * 64, h); x.stroke(); x.beginPath(); x.moveTo(0, i * 64); x.lineTo(w, i * 64); x.stroke(); } });
  roofTex.wrapS = roofTex.wrapT = THREE.RepeatWrapping; roofTex.repeat.set(20, 10);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(80, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.35, metalness: 0.5 }));
  roof.position.set(0, -0.6, 4); roof.receiveShadow = true; g.add(roof);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(80, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: 0x7fe3ff, emissive: 0x3fd0ff, emissiveIntensity: 2.5 }));
  rail.position.set(0, 0.5, -10); g.add(rail);
  const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), postMat = new THREE.MeshStandardMaterial({ color: 0x505aa8, metalness: 0.6, roughness: 0.4 });
  const posts = new THREE.InstancedMesh(postGeo, postMat, 33);
  for (let i = 0; i < 33; i++) { tmpM.makeTranslation(-40 + i * 2.5, -0.05, -10); posts.setMatrixAt(i, tmpM); } g.add(posts);
  const boxMat = new THREE.MeshPhysicalMaterial({ color: 0x2a2c58, roughness: 0.4, metalness: 0.3, clearcoat: 0.5 });
  [[-8.2, 0, -9, 2.4, 1.2, 1.6], [8.4, 0.15, -8.5, 2.4, 1.5, 1.9], [-9.1, -0.1, -3.2, 1.8, 1, 1.5]].forEach(b => { const m = new THREE.Mesh(new RoundedBoxGeometry(b[3], b[4], b[5], 2, 0.08), boxMat); m.position.set(b[0], -0.6 + b[4] / 2, b[2]); m.castShadow = m.receiveShadow = true; g.add(m); });
  const moonTex = canvasTex(256, 256, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, w * 0.18, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(255,240,220,1)'); gg.addColorStop(0.36, 'rgba(242,207,160,1)'); gg.addColorStop(0.4, 'rgba(255,220,190,0.35)'); gg.addColorStop(1, 'rgba(255,220,190,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); });
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false })); moon.scale.set(18, 18, 1); moon.position.set(30, 38, -95); g.add(moon);
  [[-7.5, -8, 0xff4fa3], [7.8, -6, 0x3fd0ff], [-6.5, 5.5, 0x3fd0ff], [6.6, 5.5, 0xff4fa3]].forEach(l => { const pl = new THREE.PointLight(l[2], 6, 9, 2); pl.position.set(l[0], 0.6, l[1]); g.add(pl); });
  return { group: g, sky, fog: [0x2a1f5c, 40, 120], hemi: [0x9aa0ff, 0x1a1030, 0.55], key: [0xd8d4ff, 2.0], rim: [0x6fd6ff, 2.2], bloom: [0.6, 0.45, 0.8], exposure: 1.05 };
}

function sceneryLava(V) {
  const g = new THREE.Group(), r = rnd(99);
  const sky = skyTexture([[0, '#0b0405'], [0.3, '#2a0d09'], [0.5, '#6b1d0b'], [0.62, '#a8360f'], [1, '#3a0c05']]);
  const lavaTex = canvasTex(512, 512, (x, w, h) => {
    x.fillStyle = '#5a1206'; x.fillRect(0, 0, w, h);
    const rr = rnd(7);
    for (let i = 0; i < 160; i++) { const cx = rr() * w, cy = rr() * h, s = 10 + rr() * 50, c = rr() < 0.3 ? '255,210,63' : '255,106,26'; const gg = x.createRadialGradient(cx, cy, 0, cx, cy, s); gg.addColorStop(0, `rgba(${c},0.75)`); gg.addColorStop(1, `rgba(${c},0)`); x.fillStyle = gg; x.fillRect(cx - s, cy - s, s * 2, s * 2); }
    x.strokeStyle = 'rgba(30,6,3,0.55)'; x.lineWidth = 4; for (let i = 0; i < 40; i++) { x.beginPath(); let px = rr() * w, py = rr() * h; x.moveTo(px, py); for (let j = 0; j < 4; j++) { px += (rr() - 0.5) * 80; py += (rr() - 0.5) * 80; x.lineTo(px, py); } x.stroke(); }
  });
  lavaTex.wrapS = lavaTex.wrapT = THREE.RepeatWrapping; lavaTex.repeat.set(12, 12);
  const lava = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: lavaTex, emissiveMap: lavaTex, emissive: 0xffffff, emissiveIntensity: 1.5, roughness: 0.6 }));
  lava.position.y = -3; g.add(lava);
  const stone = new THREE.MeshStandardMaterial({ color: 0x5a4038, roughness: 0.85, metalness: 0.05 });
  for (let i = 0; i < 12; i++) {
    const a = (196 + i * 14 + r() * 6) * Math.PI / 180, rad = 9 + r() * 5, top = 1.5 + r() * 6;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, top + 3, 16), stone); c.position.set(rad * Math.cos(a), -3 + (top + 3) / 2, rad * Math.sin(a)); c.castShadow = true; g.add(c);
    if (r() > 0.35) { const cap = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 1.6), stone); cap.position.set(c.position.x, top + 0.22, c.position.z); g.add(cap); }
  }
  [[2.6, 2.6], [-2.6, 2.6], [2.6, -2.6], [-2.6, -2.6]].forEach(p => { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 2.4, 20), stone); s.position.set(p[0], -1.8, p[1]); g.add(s); });
  const volc = new THREE.Mesh(new THREE.ConeGeometry(40, 26, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a0d0a, roughness: 1 })); volc.position.set(-30, 8, -110); g.add(volc);
  const crater = new THREE.Mesh(new THREE.CircleGeometry(7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff8a3a })); crater.position.set(-30, 19.5, -110); g.add(crater);
  const pl = new THREE.PointLight(0xff6a20, 30, 18, 1.6); pl.position.set(0, -2.4, 2); g.add(pl);
  return { group: g, sky, fog: [0x5a1c0e, 20, 110], hemi: [0xffb080, 0x400a04, 0.5], key: [0xffd0b0, 1.8], rim: [0xff8a3a, 2.4], bloom: [0.7, 0.5, 0.78], exposure: 1.0, update(t) { lavaTex.offset.set(t * 0.004, t * 0.0025); }, embers: true };
}

function sceneryGear(V) {
  const g = new THREE.Group(), r = rnd(31);
  const sky = skyTexture([[0, '#0e0b09'], [1, '#1d1712']]);
  const wallTex = canvasTex(512, 512, (x, w, h) => { x.fillStyle = '#231b14'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(0,0,0,0.4)'; x.lineWidth = 4; for (let i = 0; i <= 4; i++) { x.beginPath(); x.moveTo(i * 128, 0); x.lineTo(i * 128, h); x.stroke(); x.beginPath(); x.moveTo(0, i * 128); x.lineTo(w, i * 128); x.stroke(); } x.fillStyle = 'rgba(233,174,98,0.3)'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.beginPath(); x.arc(i * 128 + 10, j * 128 + 10, 3, 0, TAU); x.fill(); } });
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping; wallTex.repeat.set(20, 8);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(120, 48), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8, metalness: 0.4 })); wall.position.set(0, 23, -20); g.add(wall);
  const floorTex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#2a231c'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(233,174,98,0.14)'; x.lineWidth = 3; x.strokeRect(2, 2, w - 4, h - 4); x.fillStyle = 'rgba(255,255,255,0.03)'; for (let i = 0; i < 40; i++) x.fillRect(Math.random() * w, Math.random() * h, 20, 2); });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(40, 15);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(120, 45).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.5, metalness: 0.6 })); fl.position.set(0, -0.6, 2); fl.receiveShadow = true; g.add(fl);
  const brass = new THREE.MeshPhysicalMaterial({ color: 0xb88a4e, metalness: 1, roughness: 0.32, clearcoat: 0.3 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x6a5236, metalness: 0.9, roughness: 0.5 });
  const gears = [];
  [[-11, 7.5, 6.5, 18, 1], [4, 12.5, 5, 14, -1], [13.5, 5, 4, 12, 1], [-2, 3.4, 2.6, 10, -1], [22, 13, 7, 20, -1], [-24, 15, 6, 16, 1], [-19, 3, 3, 10, -1], [30, 4, 4, 12, 1]].forEach((d, i) => {
    const geo = new THREE.ExtrudeGeometry(gearShape(d[2], d[3]), { depth: 0.6, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 2, curveSegments: 6 });
    const m = new THREE.Mesh(geo, i % 2 ? iron : brass); m.position.set(d[0], d[1], -19.4); g.add(m); gears.push({ m, sp: d[4] * 0.25 * (8 / d[3]) });
  });
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, metalness: 0.8, roughness: 0.4 });
  [[1.4, 0.45], [10, 0.38], [17, 0.55]].forEach(p => { const m = new THREE.Mesh(new THREE.CylinderGeometry(p[1], p[1], 120, 16).rotateZ(Math.PI / 2), pipeMat); m.position.set(0, p[0], -18.6); g.add(m); });
  [-30, -16, 9, 26].forEach(x => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 48, 16), pipeMat); m.position.set(x, 23, -18.5); g.add(m); });
  const crate = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.8 });
  [[-9.8, -11.8, 2.4, 2], [-11.6, -8.6, 1.9, 1.2], [9.8, -10.9, 2.8, 1.6]].forEach(b => { const m = new THREE.Mesh(new RoundedBoxGeometry(b[2], b[3], b[2] * 0.8, 2, 0.06), crate); m.position.set(b[0], -0.6 + b[3] / 2, b[1]); m.castShadow = m.receiveShadow = true; g.add(m); });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffd090, emissive: 0xffb050, emissiveIntensity: 3 });
  const coneTex = canvasTex(64, 256, (x, w, h) => { const gg = x.createLinearGradient(0, 0, 0, h); gg.addColorStop(0, 'rgba(255,190,110,0.28)'); gg.addColorStop(1, 'rgba(255,190,110,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, h); });
  [[-8, -12], [8, -11], [-15, -17], [15, -16], [0, -16]].forEach(l => {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 10), lampMat); bulb.position.set(l[0], 9, l[1]); g.add(bulb);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.8, 0.6, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0x3a2d22, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide })); shade.position.set(l[0], 9.35, l[1]); g.add(shade);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3.4, 9.6, 24, 1, true), new THREE.MeshBasicMaterial({ map: coneTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })); cone.position.set(l[0], 4.2, l[1]); g.add(cone);
    const pl = new THREE.PointLight(0xffb060, 8, 14, 2); pl.position.set(l[0], 8.4, l[1]); g.add(pl);
  });
  return { group: g, sky, fog: [0x1d1712, 24, 80], hemi: [0xffd8a8, 0x2a1d10, 0.55], key: [0xffe0b8, 2.0], rim: [0xffc477, 2.0], bloom: [0.55, 0.45, 0.82], exposure: 1.05, update(t) { gears.forEach(o => { o.m.rotation.z = t * o.sp; }); } };
}

function sceneryFrost(V) {
  const g = new THREE.Group(), r = rnd(57);
  const sky = skyTexture([[0, '#040a18'], [0.35, '#0d2140'], [0.55, '#1b4064'], [0.62, '#2d6185'], [1, '#cfe6f6']], (x, w, h) => { starsOn(x, w, h, 200, 0.45, 8); });
  const auroraTex = canvasTex(512, 128, (x, w, h) => { const gg = x.createLinearGradient(0, 0, 0, h); gg.addColorStop(0, 'rgba(120,255,200,0)'); gg.addColorStop(0.55, 'rgba(80,255,190,0.6)'); gg.addColorStop(0.8, 'rgba(90,200,255,0.25)'); gg.addColorStop(1, 'rgba(90,200,255,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, h); for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(0,0,0,0.15)'; x.fillRect(i * 13 + (i % 3) * 4, 0, 4, h); } });
  auroraTex.wrapS = THREE.RepeatWrapping;
  const auroras = [];
  [[-60, 34, -120, 0], [10, 40, -130, 1], [60, 30, -115, 2]].forEach(a => { const m = new THREE.Mesh(new THREE.PlaneGeometry(90, 26, 24, 1), new THREE.MeshBasicMaterial({ map: auroraTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false })); m.position.set(a[0], a[1], a[2]); m.rotation.y = (a[3] - 1) * 0.3; g.add(m); auroras.push(m); });
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xe6f3ff, roughness: 0.9 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 160).rotateX(-Math.PI / 2), snowMat); ground.position.set(0, -0.6, -40); ground.receiveShadow = true; g.add(ground);
  const rock = new THREE.MeshStandardMaterial({ color: 0x2a4664, roughness: 0.95, flatShading: true });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xf4fbff, roughness: 0.8, flatShading: true });
  for (let i = 0; i < 22; i++) {
    const z = -55 - r() * 70, x = -120 + r() * 240, h = 16 + r() * 30, rad = h * (0.7 + r() * 0.4);
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7, 1), rock); m.position.set(x, -0.6 + h / 2, z); m.rotation.y = r() * TAU; g.add(m);
    const c = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.36, h * 0.36, 7, 1), capMat); c.position.set(x, -0.6 + h - h * 0.18 + 0.05, z); c.rotation.y = m.rotation.y; g.add(c);
  }
  const treeCone = new THREE.ConeGeometry(1, 1.4, 9), treeMat = new THREE.MeshStandardMaterial({ color: 0x1d4a46, roughness: 0.8, flatShading: true });
  const tipMat = new THREE.MeshStandardMaterial({ color: 0xf4fbff, roughness: 0.7, flatShading: true });
  const trees = new THREE.InstancedMesh(treeCone, treeMat, 70 * 3), tips = new THREE.InstancedMesh(new THREE.ConeGeometry(0.42, 0.5, 9), tipMat, 70);
  let ti = 0;
  for (let i = 0; i < 70; i++) {
    const side = r() < 0.5 ? -1 : 1, z = -8 - r() * 34, x = side * (Math.abs(z) < 12 ? 8.5 + r() * 18 : 2 + r() * 34), h = 2.4 + r() * 3;
    for (let k = 0; k < 3; k++) { const s = h * (0.42 - k * 0.1); tmpM.compose(tmpV.set(x, -0.6 + h * (0.28 + k * 0.24), z), tmpQ.identity(), tmpS.set(s, h * 0.32, s)); trees.setMatrixAt(ti++, tmpM); }
    tmpM.compose(tmpV.set(x, -0.6 + h * 0.98, z), tmpQ.identity(), tmpS.set(h * 0.3, h * 0.3, h * 0.3)); tips.setMatrixAt(i, tmpM);
  }
  trees.castShadow = true; g.add(trees); g.add(tips);
  return { group: g, sky, fog: [0xa9cbe2, 30, 150], hemi: [0xd8ecff, 0x6f8fb0, 0.9], key: [0xeaf6ff, 2.1], rim: [0xbfe9ff, 1.8], bloom: [0.45, 0.4, 0.88], exposure: 0.95, snow: true, update(t) { auroraTex.offset.x = t * 0.01; auroras.forEach((m, i) => { m.material.opacity = 0.7 + 0.3 * Math.sin(t * 0.5 + i); }); } };
}

function sceneryOrbit(V) {
  const g = new THREE.Group(), r = rnd(73);
  const sky = canvasTex(1024, 1024, (x, w, h) => {
    const bg = x.createRadialGradient(w * 0.5, h * 0.35, 10, w * 0.5, h * 0.4, w); bg.addColorStop(0, '#141838'); bg.addColorStop(0.6, '#080a1e'); bg.addColorStop(1, '#030409'); x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'lighter';
    [[0.75, 0.22, '122,60,255', 0.3, 0.5], [0.2, 0.45, '31,182,201', 0.2, 0.45], [0.6, 0.7, '255,60,154', 0.14, 0.4]].forEach(n => { const gg = x.createRadialGradient(w * n[0], h * n[1], 0, w * n[0], h * n[1], w * n[4]); gg.addColorStop(0, `rgba(${n[2]},${n[3]})`); gg.addColorStop(1, `rgba(${n[2]},0)`); x.fillStyle = gg; x.fillRect(0, 0, w, h); });
    x.globalCompositeOperation = 'source-over'; starsOn(x, w, h, 700, 1, 4);
  });
  const planetTex = canvasTex(512, 256, (x, w, h) => { const gg = x.createLinearGradient(0, 0, 0, h); ['#ffd7a8', '#e8946a', '#d9775a', '#b05a50', '#e8a070', '#c06a5a', '#8a3a40'].forEach((c, i, a) => gg.addColorStop(i / (a.length - 1), c)); x.fillStyle = gg; x.fillRect(0, 0, w, h); x.globalAlpha = 0.25; for (let i = 0; i < 30; i++) { x.fillStyle = i % 2 ? '#5a1e28' : '#ffe0b0'; x.fillRect(0, Math.random() * h, w, 2 + Math.random() * 6); } });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(14, 48, 32), new THREE.MeshStandardMaterial({ map: planetTex, roughness: 0.9 })); planet.position.set(-15, 12.5, -58); planet.scale.setScalar(0.55); planet.rotation.z = 0.35; g.add(planet);
  const ringTex = canvasTex(256, 4, (x, w, h) => { for (let i = 0; i < w; i++) { const a = 0.15 + 0.5 * Math.abs(Math.sin(i * 0.15)) * (i > 30 && i < 230 ? 1 : 0); x.fillStyle = `rgba(255,220,170,${a})`; x.fillRect(i, 0, 1, h); } });
  const ringGeo = new THREE.RingGeometry(18, 30, 96, 1); const pos = ringGeo.attributes.position, uv = ringGeo.attributes.uv; for (let i = 0; i < pos.count; i++) { const d = Math.hypot(pos.getX(i), pos.getY(i)); uv.setXY(i, (d - 18) / 12, 0.5); }
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })); ring.position.copy(planet.position); ring.scale.setScalar(0.55); ring.rotation.x = -Math.PI / 2 + 0.35; ring.rotation.y = 0.35; g.add(ring);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(3, 32, 20), new THREE.MeshStandardMaterial({ color: 0xc8cdf0, roughness: 1 })); moon.position.set(38, 26, -90); g.add(moon);
  const station = new THREE.Group();
  const stMat = new THREE.MeshStandardMaterial({ color: 0x6a74b8, metalness: 0.8, roughness: 0.35 });
  station.add(new THREE.Mesh(new THREE.TorusGeometry(13, 0.5, 12, 96), stMat));
  for (let i = 0; i < 6; i++) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 13, 6), stMat); s.rotation.z = i / 6 * Math.PI; s.position.set(0, 0, 0); s.geometry.translate(0, 0, 0); station.add(s); }
  station.add(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.2, 24).rotateX(Math.PI / 2), stMat));
  const lightGeo = new THREE.SphereGeometry(0.22, 8, 6), lights = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), 24);
  for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; tmpM.makeTranslation(Math.cos(a) * 13, Math.sin(a) * 13, 0.55); lights.setMatrixAt(i, tmpM); lights.setColorAt(i, tmpC.set(i % 2 ? 0x8ee8ff : 0xffb478).multiplyScalar(3)); }
  station.add(lights);
  station.position.set(12, 10, -40); station.rotation.x = -1.2; station.rotation.y = -0.25; g.add(station);
  const astMat = new THREE.MeshStandardMaterial({ color: 0x6a6688, roughness: 0.95, flatShading: true });
  const asts = [];
  for (let i = 0; i < 18; i++) {
    const geo = new THREE.IcosahedronGeometry(0.5 + r() * 1.4, 1); const p = geo.attributes.position; for (let k = 0; k < p.count; k++) { tmpV.fromBufferAttribute(p, k).multiplyScalar(0.75 + r() * 0.45); p.setXYZ(k, tmpV.x, tmpV.y, tmpV.z); } geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, astMat); m.position.set((r() < 0.5 ? -1 : 1) * (6 + r() * 18), -4 + r() * 12, -8 - r() * 24); g.add(m); asts.push({ m, s: (r() - 0.5) * 0.4, b: r() * 6 });
  }
  return { group: g, sky, fog: null, hemi: [0xa8b0ff, 0x100c28, 0.6], key: [0xe8e8ff, 2.0], rim: [0xb18cff, 2.4], bloom: [0.7, 0.5, 0.8], exposure: 1.05, fillGlow: 0x8c6eff, update(t) { station.rotation.z = t * 0.05; asts.forEach(a => { a.m.rotation.x = t * a.s; a.m.rotation.y = t * a.s * 0.7; a.m.position.y += Math.sin(t * 0.5 + a.b) * 0.002; }); planet.rotation.y = t * 0.02; } };
}

function sceneryCarnival(V) {
  const g = new THREE.Group(), r = rnd(91);
  const sky = skyTexture([[0, '#0a0514'], [0.35, '#241034'], [0.6, '#4a1a4f'], [1, '#120a16']], (x, w, h) => { starsOn(x, w, h, 140, 0.45, 9); });
  const grassTex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#1e1024'; x.fillRect(0, 0, w, h); for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(${60 + Math.random() * 40},${20 + Math.random() * 30},${70 + Math.random() * 40},0.35)`; x.fillRect(Math.random() * w, Math.random() * h, 2, 5); } });
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping; grassTex.repeat.set(30, 20);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 120).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 })); ground.position.set(0, -0.6, -30); ground.receiveShadow = true; g.add(ground);
  const wheel = new THREE.Group(), wMat = new THREE.MeshStandardMaterial({ color: 0x8a4a9a, metalness: 0.7, roughness: 0.35 });
  const R = 6.6;
  [-0.6, 0.6].forEach(z => { const t = new THREE.Mesh(new THREE.TorusGeometry(R, 0.12, 8, 96), wMat); t.position.z = z; wheel.add(t); });
  for (let i = 0; i < 16; i++) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, R * 2, 6), wMat); s.rotation.z = i / 16 * Math.PI; wheel.add(s); }
  const bulbGeo = new THREE.SphereGeometry(0.13, 8, 6), wb = new THREE.InstancedMesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), 48);
  const palette = [0xffe08a, 0xff7ad9, 0x78dcff];
  for (let i = 0; i < 48; i++) { const a = i / 48 * TAU; tmpM.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, 0.7); wb.setMatrixAt(i, tmpM); wb.setColorAt(i, tmpC.set(palette[i % 3]).multiplyScalar(2.5)); }
  wheel.add(wb);
  const cabins = [], cabMats = [0xc8324e, 0x2f6fd0, 0xffcf5a, 0x8a3cc8].map(c => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.35, clearcoat: 0.8 }));
  for (let i = 0; i < 8; i++) { const c = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.9, 0.9, 2, 0.12), cabMats[i % 4]); g.add(c); cabins.push({ m: c, a: i / 8 * TAU }); }
  const hubM = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.6, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffc878, emissive: 0xffa040, emissiveIntensity: 1.5 })); wheel.add(hubM);
  wheel.position.set(-8, 7.4, -26); g.add(wheel);
  [-1, 1].forEach(s => { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 8.6, 8), wMat); leg.position.set(-8 + s * 1.9, 3.3, -26); leg.rotation.z = s * 0.24; g.add(leg); });
  const stripes = (a, b) => { const t = canvasTex(256, 64, (x, w, h) => { for (let i = 0; i < 16; i++) { x.fillStyle = i % 2 ? b : a; x.fillRect(i * 16, 0, 16, h); } }); t.wrapS = THREE.RepeatWrapping; return t; };
  [[9, -15, 2.4, '#c8324e', '#f3e3c3'], [17, -21, 2.8, '#2f6fd0', '#f3e3c3'], [-17, -16, 2.6, '#8a3cc8', '#ffe08a'], [3, -22, 2.0, '#e0602f', '#f3e3c3'], [-25, -24, 3, '#2f9a7a', '#f3e3c3']].forEach(tn => {
    const tex = stripes(tn[3], tn[4]); const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(tn[2], tn[2], tn[2] * 1.4, 32, 1, true), mat); body.position.set(tn[0], -0.6 + tn[2] * 0.7, tn[1]); body.castShadow = true; g.add(body);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(tn[2] * 1.12, tn[2] * 1.2, 32), mat); roof.position.set(tn[0], -0.6 + tn[2] * 1.4 + tn[2] * 0.6, tn[1]); g.add(roof);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(tn[2] * 0.6, tn[2] * 0.9), new THREE.MeshStandardMaterial({ color: 0xffc878, emissive: 0xff9a40, emissiveIntensity: 1.2 })); door.position.set(tn[0], -0.6 + tn[2] * 0.45, tn[1] + tn[2] + 0.02); g.add(door);
    const flag = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.5, 4).rotateZ(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: tn[3] })); flag.position.set(tn[0] + 0.25, -0.6 + tn[2] * 2.6 + 0.3, tn[1]); g.add(flag);
  });
  const sl = [];
  [[-14, -9, 0, -11], [0, -11, 14, -9], [-20, -12, -14, -9], [14, -9, 20, -12]].forEach(ln => {
    for (let j = 0; j <= 14; j++) { const u = j / 14; sl.push([ln[0] + (ln[2] - ln[0]) * u, 3.8 - Math.sin(u * Math.PI) * 0.9, ln[1] + (ln[3] - ln[1]) * u, j % 2]); }
    [[ln[0], ln[1]], [ln[2], ln[3]]].forEach(p => { const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.4, 6), new THREE.MeshStandardMaterial({ color: 0x5a3a6a })); pole.position.set(p[0], 1.6, p[1]); g.add(pole); });
  });
  const slm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), sl.length);
  sl.forEach((p, i) => { tmpM.makeTranslation(p[0], p[1], p[2]); slm.setMatrixAt(i, tmpM); slm.setColorAt(i, tmpC.set(p[3] ? 0xffe08a : 0xff7ad9).multiplyScalar(2.6)); });
  g.add(slm);
  [[-7, -8, 0xff7ad9], [7, -8, 0xffe08a], [-8, 5, 0xffe08a], [8, 5, 0xff7ad9]].forEach(l => { const pl = new THREE.PointLight(l[2], 6, 10, 2); pl.position.set(l[0], 1.5, l[1]); g.add(pl); });
  return { group: g, sky, fog: [0x241034, 30, 100], hemi: [0xd0a0ff, 0x1a0c20, 0.55], key: [0xffe8d0, 1.9], rim: [0xff9ad5, 2.2], bloom: [0.65, 0.45, 0.8], exposure: 1.05, bulbs: true, update(t) { const a = t * 0.12; wheel.rotation.z = a; cabins.forEach(c => { const ang = c.a + a; c.m.position.set(-8 + Math.cos(ang) * R, 7.4 + Math.sin(ang) * R - 0.6, -26 + 0.9); }); } };
}
const SCENERY = { neon: sceneryNeon, lava: sceneryLava, gear: sceneryGear, frost: sceneryFrost, orbit: sceneryOrbit, carnival: sceneryCarnival };

function setArena(g) {
  const A = g.arena, V = G_API.V3;
  if (curArena && curArena.id === A.id && curArena.edge === V.edge) return;
  if (curArena) { scene.remove(curArena.root); }
  let pack = arenaCache[A.id];
  if (!pack) {
    const core = buildArenaCore(V, A);
    const sc = (SCENERY[A.id] || sceneryNeon)(V);
    const root = new THREE.Group(); root.add(core.grp); root.add(sc.group);
    root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o !== core.floor) { if (o.castShadow === undefined) o.castShadow = false; } });
    pack = arenaCache[A.id] = { id: A.id, edge: V.edge, root, core, sc };
    if (sc.embers) pack.embers = makeEmbers();
    if (sc.snow) pack.snow = makeSnow();
    if (sc.bulbs) pack.bulbs = makeBulbs(V);
    if (pack.embers) root.add(pack.embers);
    if (pack.snow) root.add(pack.snow);
    if (pack.bulbs) root.add(pack.bulbs);
  }
  curArena = pack;
  scene.add(pack.root);
  const sc = pack.sc;
  scene.background = sc.sky;
  scene.fog = sc.fog ? new THREE.Fog(sc.fog[0], sc.fog[1], sc.fog[2]) : null;
  hemi.color.set(sc.hemi[0]); hemi.groundColor.set(sc.hemi[1]); hemi.intensity = sc.hemi[2] * 0.35;
  keyLight.color.set(sc.key[0]); keyLight.intensity = sc.key[1] * 0.7;
  rimLight.color.set(sc.rim[0]); rimLight.intensity = sc.rim[1] * 0.9;
  fillLight.intensity = sc.fillGlow ? 8 : 0; if (sc.fillGlow) fillLight.color.set(sc.fillGlow);
  bloomPass.strength = sc.bloom[0] * 0.75; bloomPass.radius = sc.bloom[1]; bloomPass.threshold = Math.max(0.9, sc.bloom[2]);
  renderer.toneMappingExposure = (sc.exposure || 1) * 0.9;
  runnerPool.forEach(rn => rn.root.parent && scene.remove(rn.root)); runnerPool = [];
  [barPool, hammerPool, wallPool, beltPool, holePool].forEach(pl => { pl.forEach(o => scene.remove(o.root || o)); pl.length = 0; });
}

function makeEmbers() {
  const n = 220, geo = new THREE.BufferGeometry(), p = new Float32Array(n * 3), r = rnd(5);
  for (let i = 0; i < n; i++) { p[i * 3] = -16 + r() * 32; p[i * 3 + 1] = -3 + r() * 12; p[i * 3 + 2] = -18 + r() * 26; }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const tex = canvasTex(32, 32, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(255,220,120,1)'); gg.addColorStop(1, 'rgba(255,100,30,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); });
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.18, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffb060 }));
  pts.userData.kind = 'embers'; return pts;
}
function makeSnow() {
  const n = 700, geo = new THREE.BufferGeometry(), p = new Float32Array(n * 3), r = rnd(6);
  for (let i = 0; i < n; i++) { p[i * 3] = -14 + r() * 28; p[i * 3 + 1] = r() * 14; p[i * 3 + 2] = -16 + r() * 28; }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const tex = canvasTex(32, 32, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(255,255,255,1)'); gg.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); });
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.12, map: tex, transparent: true, depthWrite: false, opacity: 0.9 }));
  pts.userData.kind = 'snow'; return pts;
}
function makeBulbs(V) {
  const m = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 40);
  m.userData.R = V.edge - 0.14; return m;
}

/* ---------- runners ---------- */
function shapeInfo(shape) {
  return {
    round: { top: 1.22, ey: 0.84, ez: 0.315, ex: 0.135 },
    square: { top: 1.12, ey: 0.78, ez: 0.355, ex: 0.15 },
    triangle: { top: 1.18, ey: 0.5, ez: 0.34, ex: 0.12 },
    diamond: { top: 1.16, ey: 0.66, ez: 0.34, ex: 0.12 },
    star: { top: 1.24, ey: 0.64, ez: 0.22, ex: 0.12 }
  }[shape] || { top: 1.22, ey: 0.8, ez: 0.335, ex: 0.14 };
}
function makeRunner(p) {
  const shape = p.shape || 'round', acc = p.skin ? p.skin.acc : 'none', info = shapeInfo(shape);
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const bc = new THREE.Color(p.color), hsl = {}; bc.getHSL(hsl); bc.setHSL(hsl.h, Math.min(1, hsl.s * 1.25), hsl.l * 0.86);
  const mat = new THREE.MeshPhysicalMaterial({ color: bc, envMap: envTex, envMapIntensity: 0.55, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, flatShading: shape === 'diamond' });
  const mesh = new THREE.Mesh(GEO[shape] || GEO.round, mat); mesh.castShadow = true; body.add(mesh);
  const hull = new THREE.Mesh(GEO[shape] || GEO.round, MAT.hull); hull.scale.setScalar(1.045); hull.position.y = -0.02; body.add(hull);
  const eyes = [], pupils = [], xs = [];
  [-1, 1].forEach(s => {
    const e = new THREE.Mesh(GEO.eye, MAT.eye); e.position.set(s * info.ex, info.ey, info.ez); e.scale.set(1, 1.15, 0.55); body.add(e); eyes.push(e);
    const pu = new THREE.Mesh(GEO.pupil, MAT.pupil); pu.position.set(s * info.ex, info.ey - 0.01, info.ez + 0.05); pu.scale.set(1, 1.1, 0.5); body.add(pu); pupils.push(pu);
    const gl = new THREE.Mesh(GEO.glint, MAT.glint); gl.position.set(s * info.ex - 0.025, info.ey + 0.035, info.ez + 0.085); body.add(gl); pupils.push(gl);
    const ck = new THREE.Mesh(GEO.cheek, MAT.cheek); ck.position.set(s * (info.ex + 0.07), info.ey - 0.14, info.ez - 0.02); ck.scale.set(1.3, 0.6, 0.35); body.add(ck);
    const xg = new THREE.Group(); [0.8, -0.8].forEach(rz => { const b = new THREE.Mesh(GEO.xbar, MAT.x); b.rotation.z = rz; xg.add(b); }); xg.position.set(s * info.ex, info.ey, info.ez + 0.05); xg.visible = false; body.add(xg); xs.push(xg);
  });
  const top = info.top;
  if (acc === 'visor') {
    eyes.concat(pupils).forEach(m => { m.visible = false; });
    const v = new THREE.Mesh(GEO.visor, MAT.visor); v.position.set(0, info.ey, 0); v.scale.set(info.ez / 0.37 * 1.02, 1, info.ez / 0.37 * 1.02); v.rotation.y = -Math.PI * 0.4 + Math.PI; body.add(v);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 0.02), MAT.ring); strip.position.set(-0.06, info.ey + 0.03, info.ez + 0.07); body.add(strip);
  } else if (acc === 'spots') {
    [[0.2, 0.45, 0.28], [-0.24, 0.32, 0.24], [0.1, 0.25, 0.32], [-0.3, 0.7, 0.12]].forEach(sp => { const m = new THREE.Mesh(GEO.spot, MAT.spot); m.position.set(sp[0], sp[1], sp[2]); m.scale.set(1, 1, 0.45); m.lookAt(sp[0] * 3, sp[1], sp[2] * 3); body.add(m); });
  } else if (acc === 'crown') {
    const c = new THREE.Group(); const band = new THREE.Mesh(GEO.crownBand, MAT.gold); c.add(band);
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, sp = new THREE.Mesh(GEO.spike, MAT.gold); sp.position.set(Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2); c.add(sp); }
    [[MAT.gemR, -0.5], [MAT.gemB, 0], [MAT.gemG, 0.5]].forEach(gm => { const m = new THREE.Mesh(GEO.gem, gm[0]); m.position.set(Math.sin(gm[1]) * 0.215, 0, Math.cos(gm[1]) * 0.215); c.add(m); });
    c.position.y = top + 0.0; body.add(c);
  } else if (acc === 'halo') {
    const h = new THREE.Mesh(GEO.halo, MAT.goldGlow); h.position.y = top + 0.22; body.add(h);
  } else if (acc === 'horns') {
    [-1, 1].forEach(s => { const h = new THREE.Mesh(GEO.horn, MAT.horn); h.position.set(s * 0.18, top - 0.02, 0.02); h.rotation.z = -s * 0.5; body.add(h); });
  } else if (acc === 'antenna') {
    const st = new THREE.Mesh(GEO.stalk, MAT.stalk); st.position.set(0.08, top + 0.1, 0); st.rotation.z = -0.35; body.add(st);
    const b = new THREE.Mesh(GEO.ball, MAT.redGlow); b.position.set(0.14, top + 0.25, 0); body.add(b);
  } else if (acc === 'star') {
    const s = new THREE.Mesh(GEO.topStar, MAT.goldGlow); s.position.y = top + 0.2; body.add(s);
  }
  const feet = [-1, 1].map(s => { const f = new THREE.Mesh(GEO.foot, MAT.foot); f.scale.set(1, 0.65, 1.35); f.castShadow = true; root.add(f); return f; });
  const bubble = new THREE.Mesh(GEO.bubble, MAT.bubble); bubble.position.y = 0.62; bubble.visible = false; body.add(bubble);
  const stars = [0, 1, 2].map(() => { const s = new THREE.Mesh(GEO.smallStar, MAT.star); s.visible = false; body.add(s); return s; });
  const puddle = new THREE.Mesh(GEO.puddle, MAT.puddle); puddle.visible = false; puddle.position.y = 0.012;
  const pX = new THREE.Group(); [0.8, -0.8].forEach(rz => { const b = new THREE.Mesh(GEO.xbar, new THREE.MeshBasicMaterial({ color: 0xd6d4f0 })); b.scale.set(1.4, 1.4, 1); b.rotation.x = -Math.PI / 2; b.rotation.y = rz; pX.add(b); }); pX.position.y = 0.03; puddle.add(pX);
  scene.add(root); scene.add(puddle);
  return { root, body, mesh, mat, eyes, pupils, xs, feet, bubble, stars, puddle, top, sig: sigOf(p) };
}
function sigOf(p) { return (p.shape || 'round') + '|' + (p.skin ? p.skin.acc : 'none') + '|' + p.color; }

function updateRunner(rn, p, i, g, V, now) {
  const t = g.t, JT = g.arena.jumpT;
  const R = V.TR + (G_API.runnerR(p) - V.mid) * V.SC, f = p.angle + g.rot, x = R * Math.cos(f), z = R * Math.sin(f);
  if (p.out) {
    rn.root.visible = false; rn.puddle.visible = true; rn.puddle.position.x = x; rn.puddle.position.z = z;
    const age = t - p.outAt; rn.puddle.scale.setScalar(Math.min(1, 0.3 + age * 2));
    return { x, z, top: 0.2, out: true };
  }
  rn.root.visible = true; rn.puddle.visible = false;
  let state = 'run', jump = 0;
  if (t < p.stun) state = 'stun';
  else if (t < p.air) { state = 'jump'; jump = Math.sin(Math.PI * Math.min(1, Math.max(0, 1 - (p.air - t) / JT))) * (JT > 0.6 ? 1.15 : 0.95); }
  else if (t < p.duck) state = 'duck';
  else if (t >= p.air && t - p.air < 0.12) state = 'land';
  const sqY = state === 'duck' ? 0.58 : state === 'land' ? 0.84 : state === 'jump' ? 1.07 : 1;
  const sqX = state === 'duck' ? 1.22 : state === 'land' ? 1.12 : state === 'jump' ? 0.95 : 1;
  const ph = t * 11 + i * 1.7, running = state === 'run' && t >= 0 && !g.over;
  const bob = running ? Math.abs(Math.cos(ph)) * 0.04 : 0;
  rn.root.position.set(x, 0, z);
  const hd = Math.atan2(-Math.sin(f), Math.cos(f));
  const cyaw = Math.atan2(V.CAM[0] - x, V.CAM[2] - z);
  let d = hd - cyaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  rn.root.rotation.y = cyaw + d * (HR3D.faceBlend !== undefined ? HR3D.faceBlend : 0.2);
  const S = 0.85;
  rn.body.position.y = jump + bob;
  rn.body.scale.set(S * sqX, S * sqY, S * sqX);
  rn.body.rotation.z = running ? Math.sin(ph) * 0.05 : 0;
  rn.body.rotation.x = state === 'jump' ? -0.15 : running ? 0.06 : 0;
  const stride = running ? Math.sin(ph) : state === 'jump' ? 0.6 : 0;
  rn.feet.forEach((ft, k) => { const s = k ? 1 : -1; ft.position.set(s * 0.17 * S * sqX, 0.06 + (running ? Math.max(0, s * Math.sin(ph)) * 0.06 : 0) + jump * 0.9, s * stride * 0.13 * S * -1 + 0.02); });
  const stun = state === 'stun';
  rn.eyes.forEach(e => { e.visible = !stun && !(p.skin && p.skin.acc === 'visor'); });
  rn.pupils.forEach(e => { e.visible = !stun && !(p.skin && p.skin.acc === 'visor'); });
  rn.xs.forEach(e => { e.visible = stun && !(p.skin && p.skin.acc === 'visor'); });
  rn.mat.emissive.set(stun && Math.floor(t * 14) % 2 ? 0x553344 : 0x000000);
  rn.bubble.visible = p.shield > 0 && p.shield > t && !(p.shield - t < 2 && Math.floor(t * 10) % 2);
  rn.stars.forEach((s, k) => { s.visible = stun; if (stun) { const a = t * 6 + k * TAU / 3; s.position.set(Math.cos(a) * 0.38, rn.top + 0.18 + Math.sin(a * 2) * 0.03, Math.sin(a) * 0.38); s.rotation.y = a; } });
  return { x, z, top: rn.top * S * sqY + jump + bob + 0.1, out: false };
}

/* ---------- bars, hammers, walls, belts, holes ---------- */
let stripeTex;
function barMaterial(colr) {
  if (!stripeTex) { stripeTex = canvasTex(4, 64, (x, w, h) => { x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); x.fillStyle = '#6a6a6a'; x.fillRect(0, 0, w, h * 0.35); }); stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping; }
  const t = stripeTex.clone(); t.needsUpdate = true; t.repeat.set(1, 9);
  return new THREE.MeshPhysicalMaterial({ color: colr, map: t, emissive: colr, emissiveMap: t, emissiveIntensity: 0.7, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1, transparent: true });
}
function makeBar(type, V) {
  const high = type === 'high', colr = high ? G_API.COL.high : G_API.COL.low, r = high ? 0.14 : 0.13, r0 = 0.75, r1 = V.barOut, L = r1 - r0;
  const root = new THREE.Group();
  const mat = barMaterial(colr);
  const cyl = new THREE.Mesh(new THREE.CapsuleGeometry(r, L, 6, 20).rotateZ(Math.PI / 2).translate(r0 + L / 2, 0, 0), mat); cyl.castShadow = true;
  const capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: colr, emissiveIntensity: 3, transparent: true });
  const cap = new THREE.Mesh(GEO.barCap, capMat); cap.scale.setScalar(r * 1.25); cap.position.x = r1 + r * 0.6;
  const holder = new THREE.Group(); holder.position.y = high ? 1.17 : 0.3; holder.add(cyl); holder.add(cap); root.add(holder);
  const trail = new THREE.Mesh(sectorGeo(0.75, r1, 0, 0.55, 16, 0.02, u => { const k = 0.32 * Math.pow(1 - u, 1.6); const c = new THREE.Color(colr); return [c.r * k, c.g * k, c.b * k]; }), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  root.add(trail);
  scene.add(root);
  return { root, holder, mat, capMat, trail, type };
}
function makeHammer(V) {
  const root = new THREE.Group(), r0 = V.e0 - 0.2, r1 = V.e1 + 0.55, L = r1 - r0, postR = V.e1 + 0.62;
  const metal = new THREE.MeshPhysicalMaterial({ color: G_API.V3.T.hubTop, metalness: 0.7, roughness: 0.3 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.9, 16).translate(0, 0.95, 0), metal); post.position.x = postR; post.castShadow = true; root.add(post);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffc040, emissiveIntensity: 2 })); knob.position.set(postR, 1.95, 0); root.add(knob);
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.25, clearcoat: 1 });
  const beam = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, L, 6, 18).rotateZ(Math.PI / 2).translate(r0 + L / 2, 0, 0), mat); beam.castShadow = true;
  const head = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.55, 0.62, 3, 0.1), mat); head.position.x = r0; head.castShadow = true;
  const holder = new THREE.Group(); holder.add(beam); holder.add(head); root.add(holder);
  scene.add(root);
  return { root, holder, mat, y: 0.3 };
}
function makeWall(V) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(0.92, 1.05, 0.42, 3, 0.08).translate(0, 0.525, 0), new THREE.MeshPhysicalMaterial({ color: 0xbfe9ff, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.8, emissive: 0x4aa8d8, emissiveIntensity: 0.25, ior: 1.3, specularIntensity: 1 }));
  m.castShadow = true; scene.add(m); return m;
}
let chevTex;
function makeBelt(bt, V) {
  if (!chevTex) { chevTex = canvasTex(64, 64, (x, w, h) => { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.strokeStyle = '#fff'; x.lineWidth = 9; x.lineCap = 'round'; x.lineJoin = 'round'; x.beginPath(); x.moveTo(18, 12); x.lineTo(42, 32); x.lineTo(18, 52); x.stroke(); }); chevTex.wrapS = THREE.RepeatWrapping; }
  const fast = bt.mult > 1, colr = fast ? G_API.COL.fast : G_API.COL.slow;
  const t = chevTex.clone(); t.needsUpdate = true; t.repeat.set(Math.round(bt.w / 0.11), 1);
  const geo = sectorGeo(V.e0 + 0.05, V.e1 - 0.05, -bt.w / 2, bt.w / 2, 20, 0.012);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(colr).multiplyScalar(0.35), emissive: colr, emissiveMap: t, emissiveIntensity: 1.6, transparent: true, opacity: 0.9, roughness: 0.5 }));
  m.receiveShadow = true; scene.add(m);
  return { root: m, tex: t, dir: fast ? 1 : -1 };
}
let crackTex, lavaPitTex;
function makeHole(o, V) {
  if (!crackTex) {
    crackTex = canvasTex(256, 128, (x, w, h) => { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.strokeStyle = '#ffb04a'; x.lineWidth = 6; x.lineJoin = 'round'; x.beginPath(); x.moveTo(30, 0); x.lineTo(90, 40); x.lineTo(130, 70); x.lineTo(180, 60); x.lineTo(230, 128); x.moveTo(130, 70); x.lineTo(110, 128); x.moveTo(90, 40); x.lineTo(150, 10); x.stroke(); });
    lavaPitTex = canvasTex(256, 128, (x, w, h) => { const gg = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gg.addColorStop(0, '#fff2a0'); gg.addColorStop(0.35, '#ffb02a'); gg.addColorStop(0.75, '#ff4a10'); gg.addColorStop(1, '#3a0804'); x.fillStyle = gg; x.fillRect(0, 0, w, h); });
  }
  const geo = sectorGeo(V.e0 + 0.06, V.e1 - 0.06, -o.w / 2, o.w / 2, 10, 0.014);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a0604, emissive: 0xffffff, emissiveMap: crackTex, emissiveIntensity: 1, roughness: 0.6, transparent: true });
  const m = new THREE.Mesh(geo, mat); scene.add(m);
  return { root: m, mat };
}

function makeOrb() {
  const root = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.1, clearcoat: 1, transparent: true });
  const ball = new THREE.Mesh(GEO.orb, mat); root.add(ball);
  const icons = {};
  ['shield', 'slow', 'heart'].forEach(k => {
    const tex = canvasTex(128, 128, (x, w) => {
      x.fillStyle = 'rgba(20,14,40,0.85)'; x.strokeStyle = 'rgba(20,14,40,0.85)'; x.lineCap = 'round'; const c = w / 2, R = w * 0.3;
      if (k === 'shield') { x.beginPath(); x.moveTo(c, c - R); x.lineTo(c + R * 0.85, c - R * 0.65); x.lineTo(c + R * 0.7, c + R * 0.3); x.lineTo(c, c + R); x.lineTo(c - R * 0.7, c + R * 0.3); x.lineTo(c - R * 0.85, c - R * 0.65); x.closePath(); x.fill(); }
      else if (k === 'slow') { x.lineWidth = w * 0.07; x.beginPath(); x.arc(c, c, R, 0, TAU); x.stroke(); x.beginPath(); x.moveTo(c, c); x.lineTo(c, c - R * 0.7); x.moveTo(c, c); x.lineTo(c + R * 0.5, c); x.stroke(); }
      else { x.beginPath(); x.arc(c - R * 0.42, c - R * 0.2, R * 0.48, 0, TAU); x.arc(c + R * 0.42, c - R * 0.2, R * 0.48, 0, TAU); x.fill(); x.beginPath(); x.moveTo(c - R * 0.88, c - R * 0.05); x.lineTo(c + R * 0.88, c - R * 0.05); x.lineTo(c, c + R * 0.95); x.closePath(); x.fill(); }
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); sp.scale.set(0.42, 0.42, 1); sp.renderOrder = 5; sp.visible = false; root.add(sp); icons[k] = sp;
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(root); scene.add(glow);
  return { root, ball, mat, icons, glow };
}
function makeParticles() {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), 220);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; scene.add(m); return m;
}

/* ---------- per-frame ---------- */
function syncPool(pool, list, make, keyFn) {
  while (pool.length > list.length) { const o = pool.pop(); scene.remove(o.root || o); disposeTree(o.root || o); }
  for (let i = 0; i < list.length; i++) {
    if (!pool[i] || (keyFn && pool[i].key !== keyFn(list[i]))) { if (pool[i]) { scene.remove(pool[i].root || pool[i]); disposeTree(pool[i].root || pool[i]); } pool[i] = make(list[i]); if (keyFn) pool[i].key = keyFn(list[i]); }
  }
}

HR3D.attach = function (api) { G_API = api; };
HR3D.setQuality = function (lv) { setQuality(lv); try { localStorage.setItem('headrush.hdq', String(lv)); } catch (e) {} };
HR3D.quality = () => quality.level;
HR3D.show = function (on) { if (glCanvas) glCanvas.style.display = on ? 'block' : 'none'; };

HR3D.render = function (g, view) {
  const V = G_API.V3, W = view.W, H = view.H, now = view.now;
  HR3D.show(true);
  resize(W, H);
  setArena(g);
  camera.position.set(V.CAM[0], V.CAM[1], V.CAM[2]);
  camera.up.set(0, 1, 0);
  camera.lookAt(V.tgt[0], V.tgt[1], V.tgt[2]);
  camera.fov = 2 * Math.atan(H / (2 * V.F)) * 180 / Math.PI;
  camera.aspect = W / H;
  camera.setViewOffset(W, H, W / 2 - V.cx - (view.sx || 0), H / 2 - V.cy - (view.sy || 0), W, H);
  camera.updateProjectionMatrix();
  const t = g.t, A = g.arena;
  curArena.core.floor.rotation.y = -g.rot;
  if (curArena.sc.update) curArena.sc.update(now);
  // runners
  syncPool(runnerPool, g.players, p => makeRunner(p), p => sigOf(p));
  const out = [];
  g.players.forEach((p, i) => {
    const rn = runnerPool[i];
    const r = updateRunner(rn, p, i, g, V, now);
    tmpV.set(r.x, 0, r.z).project(camera); const fx = (tmpV.x + 1) / 2 * W, fy = (1 - tmpV.y) / 2 * H;
    tmpV.set(r.x, r.top, r.z).project(camera); const ty = (1 - tmpV.y) / 2 * H;
    out.push({ cx: fx, foot: fy, top: ty });
  });
  if (!youRing) { youRing = new THREE.Group(); youRing.add(new THREE.Mesh(GEO.ring, MAT.ring)); youRing.add(new THREE.Mesh(GEO.disc, MAT.ringFill)); scene.add(youRing); }
  const you = g.players[0];
  youRing.visible = !you.out;
  if (!you.out) { const R = V.TR + (G_API.runnerR(you) - V.mid) * V.SC, f = you.angle + g.rot; youRing.position.set(R * Math.cos(f), 0.02, R * Math.sin(f)); }
  // bars
  syncPool(barPool, g.bars, b => makeBar(b.type, V), b => b.type + '|' + V.barOut);
  g.bars.forEach((b, i) => {
    const o = barPool[i], vis = G_API.barVisible(b, t);
    o.root.rotation.y = -(b.angle + g.rot);
    const al = vis ? 1 : 0.18; o.mat.opacity = al; o.capMat.opacity = al;
    o.trail.visible = vis; o.trail.scale.z = (g.dir || 1) < 0 ? -1 : 1;
    o.mat.map.offset.y = 0;
  });
  // hammers
  syncPool(hammerPool, A.hammers, () => makeHammer(V));
  A.hammers.forEach((h, i) => {
    const o = hammerPool[i], type = G_API.hammerType(h, t), P = G_API.HAMMER_P, ph = ((t + h.ph) % P + P) % P, k = (ph % (P / 2)) / (P / 2);
    const high = type === 'high', target = high ? 1.17 : 0.3, colr = high ? G_API.COL.high : G_API.COL.low;
    o.y += (target - o.y) * Math.min(1, view.dt * 18);
    o.holder.position.y = o.y;
    o.root.rotation.y = -(h.a + g.rot);
    o.mat.color.set(colr);
    if (k > 0.7) { o.mat.emissive.set(Math.floor(t * 8) % 2 ? (high ? G_API.COL.low : G_API.COL.high) : colr); o.holder.position.x = Math.sin(t * 60) * 0.02; } else { o.mat.emissive.set(colr); o.holder.position.x = 0; }
  });
  // walls
  syncPool(wallPool, A.walls, () => makeWall(V));
  A.walls.forEach((w, i) => { const m = wallPool[i], R = V.TR + (A.lanes[w.lane] - V.mid) * V.SC, f = w.a + g.rot; m.position.set(R * Math.cos(f), 0, R * Math.sin(f)); m.rotation.y = -f; });
  // belts
  syncPool(beltPool, A.belts, bt => makeBelt(bt, V));
  A.belts.forEach((bt, i) => { const o = beltPool[i]; o.root.rotation.y = -(bt.a + g.rot); o.tex.offset.x = -(t * 0.45 * o.dir) / 0.11 % 1; });
  // holes
  syncPool(holePool, g.holes, o => makeHole(o, V));
  g.holes.forEach((o, i) => {
    const h = holePool[i];
    h.root.rotation.y = -(o.a + g.rot);
    if (o.state === 'idle') { h.root.visible = false; return; }
    h.root.visible = true;
    if (o.state === 'crack') { const left = Math.max(0, o.until - t), pulse = 0.5 + 0.5 * Math.sin(t * (10 + (1.3 - left) * 16)); h.mat.emissiveMap = crackTex; h.mat.color.set(0x3a1208); h.mat.emissiveIntensity = 0.6 + 1.6 * pulse; }
    else { h.mat.emissiveMap = lavaPitTex; h.mat.color.set(0x1a0604); h.mat.emissiveIntensity = 2.2 + 0.4 * Math.sin(t * 6 + i); }
  });
  // pickup orb
  if (!orb) orb = makeOrb();
  const pu = g.pickup;
  orb.root.visible = orb.glow.visible = !!pu;
  if (pu) {
    const L = A.lanes, R = V.TR + ((L.length > 1 ? L[pu.lane] : L[0]) - V.mid) * V.SC, f = pu.a + g.rot, colr = pu.type === 'shield' ? G_API.COL.puShield : pu.type === 'slow' ? G_API.COL.puSlow : G_API.COL.heart;
    const life = 12 - (t - pu.born), blink = life < 2 && Math.floor(t * 10) % 2;
    orb.root.position.set(R * Math.cos(f), 0.62 + 0.08 * Math.sin(t * 4), R * Math.sin(f));
    orb.root.rotation.y = t * 1.5;
    orb.mat.color.set(colr); orb.mat.emissive.set(colr); orb.mat.opacity = blink ? 0.4 : 1;
    Object.keys(orb.icons).forEach(k => { orb.icons[k].visible = k === pu.type; });
    orb.glow.position.set(orb.root.position.x, 0.025, orb.root.position.z); orb.glow.material.color.set(colr);
  }
  // particles
  if (!particleMesh) particleMesh = makeParticles();
  const e0w = V.mid - A.band / 2; let n = 0;
  for (let i = 0; i < g.parts.length && n < 220; i++) {
    const q = g.parts[i], rr = Math.hypot(q.x, q.y), ang = Math.atan2(q.y, q.x) + g.rot;
    const R = rr < e0w ? rr * (V.e0 / e0w) : V.e0 + (rr - e0w) * V.SC, age = q.max - q.life, y = 0.45 + age * 1.1 - age * age * 0.8;
    const sz = q.s * 6 * Math.max(0.2, q.life / q.max);
    tmpQ.setFromAxisAngle(tmpV.set(0.3, 1, 0.2).normalize(), q.rot);
    tmpM.compose(tmpV.set(R * Math.cos(ang), y, R * Math.sin(ang)), tmpQ, tmpS.set(sz, sz, sz));
    particleMesh.setMatrixAt(n, tmpM); particleMesh.setColorAt(n, tmpC.set(q.color).multiplyScalar(1.6)); n++;
  }
  particleMesh.count = n; particleMesh.instanceMatrix.needsUpdate = true; if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;
  // ambience
  if (curArena.embers) { const p = curArena.embers.geometry.attributes.position; for (let i = 0; i < p.count; i++) { let y = p.getY(i) + view.dt * (0.6 + (i % 7) * 0.12); if (y > 9) y = -3; p.setY(i, y); } p.needsUpdate = true; }
  if (curArena.snow) { const p = curArena.snow.geometry.attributes.position; for (let i = 0; i < p.count; i++) { let y = p.getY(i) - view.dt * (0.5 + (i % 5) * 0.12); if (y < -0.5) y = 14; p.setY(i, y); p.setX(i, p.getX(i) + Math.sin(now * 0.8 + i) * 0.003); } p.needsUpdate = true; }
  if (curArena.bulbs) {
    const m = curArena.bulbs, R = m.userData.R, step = Math.floor(now * 2.5);
    for (let i = 0; i < 40; i++) { const a = i / 40 * TAU + g.rot; tmpM.makeTranslation(R * Math.cos(a), 0.06, R * Math.sin(a)); m.setMatrixAt(i, tmpM); m.setColorAt(i, tmpC.set(i % 2 ? 0xffe08a : 0xff7ad9).multiplyScalar((i + step) % 2 ? 0.35 : 3)); }
    m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
  }
  // slow-mo tint via exposure
  renderer.toneMappingExposure = (curArena.sc.exposure || 1) * 0.9 * (g.t < g.slowUntil ? 0.85 : 1);
  if (quality.bloom) composer.render(); else renderer.render(scene, camera);
  adapt(view.dt);
  return out;
};

function adapt(dt) {
  if (!dt) return;
  frameTimes.push(dt);
  if (frameTimes.length < 90) return;
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length; frameTimes = [];
  if (avg > 1 / 40 && quality.level > 0) { setQuality(quality.level - 1); }
}

try { init(); HR3D.ok = true; } catch (e) { HR3D.ok = false; HR3D.error = String(e && e.message || e); if (glCanvas) glCanvas.remove(); }
window.dispatchEvent(new Event('hr3d-ready'));
