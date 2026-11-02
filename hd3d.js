/* Head Rush HD renderer: real-time 3D with three.js (WebGL).
   The game logic stays in index.html; this module only draws what the game state says. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const HR3D = (window.HR3D = window.HR3D || {});
HR3D.ok = false;
const TAU = Math.PI * 2;

let G_API = null;
let renderer, scene, camera, composer, renderPass, bloomPass, gradePass, envTex, glCanvas, vigEl;
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
/* jellybean body profile (radius, height): wide hips, soft egg top */
const BEAN = [[0, 0], [0.2, 0.012], [0.33, 0.06], [0.405, 0.16], [0.43, 0.32], [0.42, 0.5], [0.39, 0.68], [0.34, 0.85], [0.26, 0.99], [0.15, 1.08], [0, 1.12]];
function beanR(y) {
  for (let i = 1; i < BEAN.length; i++) if (y <= BEAN[i][1]) { const a = BEAN[i - 1], b = BEAN[i], u = (y - a[1]) / (b[1] - a[1] || 1); return a[0] + (b[0] - a[0]) * u; }
  return 0;
}
function mergeGeos(list) {
  const pos = [], nor = [], uv = [], idx = []; let base = 0;
  list.forEach(g => {
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i)); else for (let i = 0; i < P.count; i++) idx.push(base + i);
    base += P.count; g.dispose();
  });
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  m.setIndex(idx); return m;
}
function rnd(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
function disposeTree(o) {
  o.traverse(n => {
    if (n.geometry && !n.geometry.userData.shared) n.geometry.dispose();
    if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => { if (m.userData.shared) return; ['map', 'emissiveMap'].forEach(k => m[k] && m[k].dispose()); m.dispose(); });
  });
}

/* ---------- shared geometry and materials ---------- */
const GEO = {}, MAT = {}, GEO_LO = {};
/* Low tier (levels 0-1) builds cheaper meshes and textures so it never costs more than the original renderer */
function lo() { return quality.level <= 1; }
function geoSet() { return lo() ? GEO_LO : GEO; }
function shared(g) { g.userData.shared = true; return g; }
function smat(m) { m.userData.shared = true; return m; }
function buildShared() {
  GEO.round = shared(new THREE.LatheGeometry(new THREE.SplineCurve(BEAN.map(p => new THREE.Vector2(p[0], p[1]))).getPoints(40), 40));
  GEO.square = shared(new RoundedBoxGeometry(0.74, 1.12, 0.74, 5, 0.2).translate(0, 0.56, 0));
  GEO.triangle = shared(new THREE.LatheGeometry([[0, 0], [0.44, 0], [0.51, 0.04], [0.52, 0.12], [0.5, 0.2], [0.14, 1.06], [0.08, 1.15], [0, 1.18]].map(p => new THREE.Vector2(p[0], p[1])), 40));
  const dia = new THREE.LatheGeometry([[0, 0], [0.06, 0.01], [0.5, 0.56], [0.5, 0.64], [0.06, 1.15], [0, 1.16]].map(p => new THREE.Vector2(p[0], p[1])), 4); dia.rotateY(Math.PI / 4);
  GEO.diamond = shared(dia);
  const st = new THREE.ExtrudeGeometry(starShape(0.58, 0.28), { depth: 0.26, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 4, curveSegments: 8 });
  st.translate(0, 0, -0.13); st.translate(0, 0.62, 0);
  GEO.star = shared(st);
  const beanPts = (n) => new THREE.SplineCurve(BEAN.map(p => new THREE.Vector2(p[0], p[1]))).getPoints(n);
  GEO_LO.round = shared(new THREE.LatheGeometry(beanPts(14), 16));
  GEO_LO.square = shared(new RoundedBoxGeometry(0.74, 1.12, 0.74, 2, 0.2).translate(0, 0.56, 0));
  GEO_LO.triangle = shared(new THREE.LatheGeometry([[0, 0], [0.44, 0], [0.51, 0.04], [0.52, 0.12], [0.5, 0.2], [0.14, 1.06], [0.08, 1.15], [0, 1.18]].map(p => new THREE.Vector2(p[0], p[1])), 16));
  GEO_LO.diamond = GEO.diamond;
  GEO_LO.star = shared(new THREE.ExtrudeGeometry(starShape(0.58, 0.28), { depth: 0.26, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 1, curveSegments: 4 }).translate(0, 0, -0.13).translate(0, 0.62, 0));
  GEO.eye = shared(new THREE.SphereGeometry(0.125, 20, 14));
  GEO.pupil = shared(new THREE.SphereGeometry(0.072, 16, 12));
  GEO.glint = shared(new THREE.SphereGeometry(0.022, 8, 6));
  GEO.cheek = shared(new THREE.SphereGeometry(0.07, 12, 8));
  /* arm = short stub + mitten with a thumb, hanging from the shoulder (origin) along -y */
  GEO.arm = shared(mergeGeos([
    new THREE.CapsuleGeometry(0.06, 0.16, 4, 10).translate(0, -0.1, 0),
    new THREE.SphereGeometry(0.13, 16, 12).scale(1, 0.92, 0.82).translate(0, -0.27, 0),
    new THREE.SphereGeometry(0.055, 10, 8).translate(0.0, -0.235, 0.095)
  ]));
  /* sneaker: white upper + chunky sole, toe along +z */
  GEO.shoeUp = shared(mergeGeos([
    new THREE.CapsuleGeometry(0.082, 0.1, 4, 12).rotateX(Math.PI / 2).scale(1, 0.82, 1).translate(0, 0.088, 0.015),
    new THREE.SphereGeometry(0.07, 12, 8).translate(0, 0.13, -0.035)
  ]));
  GEO.shoeSole = shared(new THREE.CapsuleGeometry(0.094, 0.12, 4, 12).rotateX(Math.PI / 2).scale(1, 0.34, 1).translate(0, 0.03, 0.015));
  GEO_LO.arm = shared(mergeGeos([new THREE.CapsuleGeometry(0.06, 0.16, 2, 6).translate(0, -0.1, 0), new THREE.SphereGeometry(0.13, 8, 6).scale(1, 0.92, 0.82).translate(0, -0.27, 0), new THREE.SphereGeometry(0.055, 6, 4).translate(0.0, -0.235, 0.095)]));
  GEO_LO.shoeUp = shared(mergeGeos([new THREE.CapsuleGeometry(0.082, 0.1, 2, 8).rotateX(Math.PI / 2).scale(1, 0.82, 1).translate(0, 0.088, 0.015), new THREE.SphereGeometry(0.07, 8, 5).translate(0, 0.13, -0.035)]));
  GEO_LO.shoeSole = shared(new THREE.CapsuleGeometry(0.094, 0.12, 2, 8).rotateX(Math.PI / 2).scale(1, 0.34, 1).translate(0, 0.03, 0.015));
  GEO.xbar = shared(new THREE.BoxGeometry(0.15, 0.035, 0.03));
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
  MAT.limb = smat(addRim(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, envMapIntensity: 0.8 })));
  MAT.shoeUp = smat(new THREE.MeshStandardMaterial({ color: 0xf2f4fb, roughness: 0.5, envMapIntensity: 0.6 }));
  MAT.shoeSole = smat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }));
  MAT.gunmetal = smat(new THREE.MeshStandardMaterial({ color: 0x2a2d3a, metalness: 0.85, roughness: 0.32 }));
  MAT.youHull = smat(new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.BackSide }));
  MAT.x = smat(new THREE.MeshBasicMaterial({ color: 0x1b1530 }));
  MAT.gold = smat(new THREE.MeshStandardMaterial({ color: 0xffc94a, metalness: 1, roughness: 0.22, emissive: 0x6a4a00, emissiveIntensity: 0.5 }));
  MAT.goldGlow = smat(new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd060, emissiveIntensity: 2.2 }));
  MAT.gemR = smat(new THREE.MeshStandardMaterial({ color: 0xff4d6d, roughness: 0.05, emissive: 0x551020 }));
  MAT.gemB = smat(new THREE.MeshStandardMaterial({ color: 0x3fa9ff, roughness: 0.05, emissive: 0x10305a }));
  MAT.gemG = smat(new THREE.MeshStandardMaterial({ color: 0x7be0ad, roughness: 0.05, emissive: 0x104a30 }));
  MAT.horn = smat(new THREE.MeshStandardMaterial({ color: 0x5a1a30, roughness: 0.3 }));
  MAT.stalk = smat(new THREE.MeshStandardMaterial({ color: 0x1d2140, roughness: 0.5 }));
  MAT.redGlow = smat(new THREE.MeshStandardMaterial({ color: 0xff4d6d, emissive: 0xff2050, emissiveIntensity: 2 }));
  MAT.visor = smat(new THREE.MeshStandardMaterial({ color: 0x14152c, roughness: 0.08, metalness: 0.4, envMapIntensity: 1.2 }));
  MAT.spot = smat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, transparent: true, opacity: 0.75 }));
  MAT.ring = smat(new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffc020, emissiveIntensity: 2.4 }));
  MAT.puddle = smat(new THREE.MeshStandardMaterial({ color: 0x4a4c70, roughness: 0.2, transparent: true, opacity: 0.75 }));
  MAT.bubble = smat(addRim(new THREE.MeshStandardMaterial({ color: 0x7fe3ff, emissive: 0x2ab8e0, emissiveIntensity: 0.3, roughness: 0.05, transparent: true, opacity: 0.2, depthWrite: false })));
  const blobTex = canvasTex(64, 64, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(0,0,0,1)'); gg.addColorStop(0.55, 'rgba(0,0,0,0.6)'); gg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); });
  GEO.blob = shared(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  MAT.blob = smat(new THREE.MeshBasicMaterial({ color: 0x000000, map: blobTex, transparent: true, depthWrite: false, opacity: 0.55 }));
  MAT.star = smat(new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd050, emissiveIntensity: 2.5 }));
}

/* ---------- grade: one tone curve shared by the High (post pass) and Low (in-material) paths ----------
   Per-channel filmic curve (Narkowicz fit) + a little saturation. It is invertible, so the bar cores can be
   pre-compensated to come out of the whole pipeline as exactly the game's bar colours. */
const TONE = { pre: 0.8, sat: 1.1 };
const TONE_GLSL = `vec3 CustomToneMapping( vec3 color ) {
  vec3 x = max( vec3( 0.0 ), color * toneMappingExposure * ${TONE.pre.toFixed(3)} );
  vec3 c = clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  return clamp( mix( vec3( l ), c, ${TONE.sat.toFixed(3)} ), 0.0, 1.0 );
}`;
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace('vec3 CustomToneMapping( vec3 color ) { return color; }', TONE_GLSL);
function toneCh(x) { x = Math.max(0, x); return Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)); }
/* linear-space input that the pipeline turns into this exact sRGB colour (unlit, untextured surfaces only) */
function exactColor(hex, exposure) {
  const c = new THREE.Color(hex), l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return new THREE.Color(...[c.r, c.g, c.b].map(v => {
    const y = Math.min(0.9995, Math.max(0, l + (v - l) / TONE.sat));
    let lo = 0, hi = 64;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (toneCh(m) < y) lo = m; else hi = m; }
    return (lo + hi) / 2 / (TONE.pre * exposure);
  }));
}
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, toneMappingExposure: { value: 1 }, uVig: { value: 0.45 }, uTint: { value: new THREE.Color(0, 0, 0) }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `precision highp float; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: `precision highp float;
    uniform sampler2D tDiffuse; uniform float uVig; uniform vec3 uTint; uniform vec2 uRes; varying vec2 vUv;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      c.rgb = CustomToneMapping( c.rgb );
      c = sRGBTransferOETF( c );
      float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      c.rgb += uTint * pow( 1.0 - l, 6.0 );
      vec2 d = ( vUv - 0.5 ) * vec2( uRes.x / uRes.y, 1.0 ) * 1.6;
      c.rgb *= 1.0 - uVig * smoothstep( 0.45, 1.25, dot( d, d ) );
      c.rgb += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;
      gl_FragColor = c;
    }`
};
class GradePass extends Pass {
  constructor() {
    super();
    this.uniforms = THREE.UniformsUtils.clone(GradeShader.uniforms);
    this.material = new THREE.RawShaderMaterial({ uniforms: this.uniforms, vertexShader: GradeShader.vertexShader, fragmentShader: GradeShader.fragmentShader, defines: { SRGB_TRANSFER: '' } });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
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
  renderer.toneMapping = THREE.CustomToneMapping;
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
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  setQuality(mobile ? 2 : 3);
  try { const saved = +localStorage.getItem('headrush.hdq'); if (saved >= 0 && saved <= 3 && localStorage.getItem('headrush.hdq') !== null) setQuality(saved); } catch (e) {}
  buildShared();
  faceTextures();
  initFx();
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
  renderPass = new RenderPass(scene, camera); composer.addPass(renderPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.82); composer.addPass(bloomPass);
  gradePass = new GradePass(); composer.addPass(gradePass);
  /* Low tier has no post pass: a CSS vignette on the compositor stands in for the graded one */
  vigEl = document.createElement('div'); vigEl.setAttribute('aria-hidden', 'true');
  vigEl.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;display:none;background:radial-gradient(ellipse 80% 70% at 50% 52%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.42) 100%);';
  stage.insertBefore(vigEl, glCanvas.nextSibling);
}
function setQuality(level) {
  level = Math.max(0, Math.min(3, level));
  quality.level = level;
  const dpr = window.devicePixelRatio || 1;
  quality.pr = Math.min(dpr, [1, 1.3, 1.75, 2][level]);
  quality.bloom = level >= 2;
  quality.shadows = level >= 1;
  quality.dyn = 1;
  if (renderer) {
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = level >= 3 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    keyLight.castShadow = quality.shadows;
    keyLight.shadow.mapSize.set(level >= 3 ? 2048 : 1024, level >= 3 ? 2048 : 1024);
    if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
    scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
    lastSize = '';
  }
}
let lastSize = '', lastSamples = -1;
function effPR() { return Math.max(0.75, quality.pr * quality.dyn); }
function resize(W, H) {
  const pr = effPR(), key = W + 'x' + H + '@' + pr.toFixed(2);
  if (key === lastSize) return;
  lastSize = key;
  renderer.setPixelRatio(pr);
  renderer.setSize(W, H, false);
  glCanvas.style.width = W + 'px'; glCanvas.style.height = H + 'px';
  /* Low tier draws straight to the screen: its post targets stay unallocated */
  if (!quality.bloom) return;
  const samples = pr <= 1.35 ? 4 : 0;
  if (samples !== lastSamples) { lastSamples = samples; composer.reset(new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples })); }
  composer.setPixelRatio(pr);
  composer.setSize(W, H);
}

/* ---------- camera rig (HD only) ----------
   Steeper than the Lite 3D camera so the board fills the portrait screen and the backdrop frames it.
   Fitted to the stage exactly like v3Camera() in index.html; the overlays use the positions render() returns. */
const RIG = { key: '', pitch: 43, dist: 14.2, cam: new THREE.Vector3(), tgt: new THREE.Vector3(), F: 1, cx: 0, cy: 0 };
function rig(V, W, H) {
  const sr = V.sr || { left: 0, top: 0, width: W, height: H }, pitch = HR3D.pitch || RIG.pitch;
  const key = [W, H, sr.left, sr.top, sr.width, sr.height, pitch].join('|');
  if (key === RIG.key) return RIG;
  RIG.key = key;
  const p = pitch * Math.PI / 180;
  RIG.tgt.set(0, 0.3, -0.4); RIG.cam.set(0, 0.3 + RIG.dist * Math.sin(p), -0.4 + RIG.dist * Math.cos(p));
  const c = new THREE.PerspectiveCamera(); c.position.copy(RIG.cam); c.lookAt(RIG.tgt); c.updateMatrixWorld();
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * TAU;
    [[3.75, 0], [3.6, 1.45]].forEach(([r, y]) => {
      tmpV.set(r * Math.cos(a), y, r * Math.sin(a)).applyMatrix4(c.matrixWorldInverse);
      const x = tmpV.x / -tmpV.z, yy = -tmpV.y / -tmpV.z;
      mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, yy); mxy = Math.max(mxy, yy);
    });
  }
  const sw = Math.max(60, sr.width), sh = Math.max(60, sr.height);
  RIG.F = Math.min(sw * 1.15 / (mxx - mnx), sh * 0.94 / (mxy - mny));
  RIG.cx = sr.left + sw / 2 - RIG.F * (mnx + mxx) / 2;
  RIG.cy = sr.top + sh * 0.95 - RIG.F * mxy;
  return RIG;
}

/* ---------- arena: floor, hub, scenery ---------- */
/* ---------- board styles: what each arena's floor is made of ----------
   base: drawn under the track markings. slabs: polar flagstones (ring radii, gap colour, tones).
   Gaps can glow through the emissive map (lava seams, ice cracks). */
const BOARD = {
  neon: { kind: 'hex', base: ['#16183c', '#0d0e26'], line: 'rgba(110,200,255,0.22)', glow: 'rgba(63,208,255,0.35)', rough: [0.18, 0.5], metal: 0.35, side: 'panel', sideCol: ['#1a1c42', '#07081a'], depth: 0.6, lip: 0x3fd0ff, lipLow: 0xff4fa3, emis: 1 },
  lava: { kind: 'slab', base: ['#2c2220', '#1b1413'], gap: '#120a08', gapGlow: 'rgba(255,64,10,0.55)', rings: [0.75, 1.3, 1.85, 2.4, 2.95, 3.5, 4.05, 4.6], slab: [0.55, 0.6], gapW: 0.028, tones: [[42, 33, 30], [52, 40, 35], [36, 28, 26], [58, 45, 38]], rough: [0.75, 0.95], metal: 0.05, side: 'stone', sideCol: ['#2a201d', '#0d0807'], hub: ['#4a3a34', '#140c0a'], depth: 9, lip: 0x3a2a24, lipGlow: 0xff5a14, emis: 0.32, cracks: 'rgba(255,110,30,0.75)' },
  gear: { kind: 'tread', base: ['#2b2a2e', '#17161a'], inlay: '#a87c46', seams: [0.85, 1.6, 2.45, 3.95], rough: [0.3, 0.75], metal: 0.7, side: 'steel', sideCol: ['#2a241e', '#0b0907'], hub: ['#7a5c3a', '#24190f'], depth: 1.1, lip: 0xa87c46, lipGlow: 0xffa040, emis: 0.7 },
  orbit: { kind: 'slab', base: ['#1a1f3c', '#0e1128'], gap: '#05060f', gapGlow: '#1a4a78', rings: [0.75, 1.6, 2.5, 3.9], slab: [0.95, 0], jit: 0, gapW: 0.03, tones: [[30, 35, 64], [35, 41, 74], [27, 31, 57], [39, 45, 82]], rough: [0.28, 0.5], metal: 0.55, side: 'panel', sideCol: ['#1c2246', '#05061a'], hub: ['#4a5296', '#141838'], depth: 0.9, lip: 0x8ee8ff, lipLow: 0x9b7bff, emis: 0.6, bolts: true },
  carnival: { kind: 'slab', base: ['#3a2430', '#22141c'], gap: '#12080e', gapGlow: '#000', rings: Array.from({ length: 13 }, (_, i) => 0.75 + i * 0.32), slab: [1.2, 0.8], jit: 0.35, gapW: 0.016, tones: [[80, 54, 52], [92, 62, 58], [72, 48, 52], [98, 68, 62], [66, 44, 50]], rough: [0.6, 0.88], metal: 0, side: 'plank', sideCol: ['#3a2232', '#0e060c'], hub: ['#74406a', '#24102a'], depth: 0.7, lip: 0x8a6a3a, lipGlow: 0xff7ad9, emis: 0.5, grain: true, paint: ['rgba(150,40,64,0.4)', 'rgba(220,190,140,0.22)', 'rgba(60,90,150,0.3)'] },
  frost: { kind: 'slab', base: ['#203f62', '#132a46'], gap: '#0b1a33', gapGlow: 'rgba(150,230,255,0.16)', rings: [0.75, 1.65, 2.5, 3.25, 4.1], slab: [1.1, 0.9], gapW: 0.03, tones: [[34, 66, 104], [40, 76, 118], [30, 58, 94], [46, 86, 128]], rough: [0.08, 0.3], metal: 0.15, side: 'ice', sideCol: ['#3d6a96', '#0c1a30'], hub: ['#6a90bc', '#14284a'], depth: 1.4, lip: 0xcfe9ff, lipGlow: 0x9fe3ff, emis: 0.8, cracks: 'rgba(230,248,255,0.55)' }
};
function boardBase(B, V, x, size, s, c, emissive, rough) {
  const E = V.edge, r = rnd(17);
  const P = (rr, a) => [c + Math.cos(a) * rr * s, c + Math.sin(a) * rr * s];
  const shade = (k, tone) => rough ? `rgb(${k},${k},${k})` : emissive ? '#000' : tone;
  if (B.kind === 'hex') {
    const g = x.createRadialGradient(c, c, 0, c, c, E * s); g.addColorStop(0, B.base[0]); g.addColorStop(1, B.base[1]);
    x.fillStyle = rough ? '#444' : emissive ? '#000' : g; x.fillRect(0, 0, size, size);
    const hr = 0.34 * s, hw = Math.sqrt(3) * hr;
    for (let row = -2; row * hr * 1.5 < size + hr * 2; row++) for (let col = -2; col * hw < size + hw; col++) {
      const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * hr * 1.5, v = r();
      x.beginPath(); for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * TAU / 6, px = cx + Math.cos(a) * hr * 0.94, py = cy + Math.sin(a) * hr * 0.94; k ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath();
      if (rough) { const k = Math.round(30 + v * 60); x.fillStyle = shade(k); x.fill(); }
      else if (emissive) { if (v < 0.06) { x.fillStyle = 'rgba(63,208,255,0.12)'; x.fill(); } x.strokeStyle = B.glow; x.lineWidth = s * 0.012; x.globalAlpha = 0.35; x.stroke(); x.globalAlpha = 1; }
      else { x.fillStyle = `rgba(${v < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + (v % 0.5) * 0.06})`; x.fill(); x.strokeStyle = B.line; x.lineWidth = s * 0.014; x.stroke(); }
    }
    return;
  }
  if (B.kind === 'tread') {
    /* riveted steel tread plate: sector plates, raised diamond tread, brass inlay rings with rivets */
    if (emissive) { x.fillStyle = '#000'; x.fillRect(0, 0, size, size); return; }
    const g = x.createRadialGradient(c, c, 0, c, c, E * s); g.addColorStop(0, B.base[0]); g.addColorStop(1, B.base[1]);
    x.fillStyle = rough ? shade(Math.round(255 * B.rough[1])) : g; x.fillRect(0, 0, size, size);
    const st = 0.16 * s;
    for (let yy = 0; yy < size + st; yy += st) for (let xx = 0, k = 0; xx < size + st; xx += st, k++) {
      const px = xx + ((yy / st) % 2 ? st / 2 : 0);
      x.save(); x.translate(px, yy); x.rotate(((k + Math.round(yy / st)) % 2 ? 1 : -1) * Math.PI / 4);
      x.fillStyle = rough ? shade(Math.round(255 * B.rough[0])) : 'rgba(255,255,255,0.07)'; x.beginPath(); x.ellipse(0, 0, st * 0.34, st * 0.08, 0, 0, TAU); x.fill();
      if (!rough) { x.fillStyle = 'rgba(0,0,0,0.25)'; x.beginPath(); x.ellipse(st * 0.02, st * 0.03, st * 0.34, st * 0.06, 0, 0, Math.PI); x.fill(); }
      x.restore();
    }
    /* plate seams: rings + radial cuts, each with a rivet row */
    const seam = (a0, rr0, rr1) => { const p = P(rr0, a0), q = P(rr1, a0); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); };
    x.strokeStyle = rough ? '#fff' : 'rgba(0,0,0,0.6)'; x.lineWidth = s * 0.02;
    B.seams.forEach(rr => { x.beginPath(); x.arc(c, c, rr * s, 0, TAU); x.stroke(); });
    for (let i = 0; i < 16; i++) { const a = i / 16 * TAU + 0.1; seam(a, 0.85, 1.6); seam(a + 0.2, 1.6, 2.45); seam(a, 3.95, E); }
    for (let i = 0; i < 24; i++) seam(i / 24 * TAU + 0.05, 2.45, 3.95);
    if (!rough) {
      /* brass inlay bands (hub surround and outer band) */
      [[0.8, 0.07], [E - 0.2, 0.09]].forEach(([rr, wd]) => { x.strokeStyle = B.inlay; x.lineWidth = wd * s; x.beginPath(); x.arc(c, c, rr * s, 0, TAU); x.stroke(); x.strokeStyle = 'rgba(255,230,180,0.35)'; x.lineWidth = s * 0.008; x.beginPath(); x.arc(c, c, (rr - wd * 0.3) * s, 0, TAU); x.stroke(); });
      /* rivets along the seams */
      const rivet = (p) => { x.fillStyle = 'rgba(0,0,0,0.55)'; x.beginPath(); x.arc(p[0] + s * 0.006, p[1] + s * 0.008, s * 0.022, 0, TAU); x.fill(); x.fillStyle = '#5a5248'; x.beginPath(); x.arc(p[0], p[1], s * 0.02, 0, TAU); x.fill(); x.fillStyle = 'rgba(255,240,210,0.35)'; x.beginPath(); x.arc(p[0] - s * 0.006, p[1] - s * 0.006, s * 0.007, 0, TAU); x.fill(); };
      B.seams.forEach(rr => { const n = Math.round(rr * 9); for (let i = 0; i < n; i++) { const a = (i + 0.5) / n * TAU; rivet(P(rr - 0.05, a)); rivet(P(rr + 0.05, a)); } });
      for (let i = 0; i < 24; i++) { const a = (i + 0.5) / 24 * TAU; rivet(P(E - 0.2, a)); }
      /* wear: a few scuffs and oil stains */
      for (let i = 0; i < 40; i++) { const p = P(0.9 + r() * (E - 1), r() * TAU), rr = s * (0.08 + r() * 0.3), gg = x.createRadialGradient(p[0], p[1], 0, p[0], p[1], rr); gg.addColorStop(0, `rgba(${r() < 0.6 ? '0,0,0,0.18' : '120,90,50,0.08'})`); gg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gg; x.fillRect(p[0] - rr, p[1] - rr, rr * 2, rr * 2); }
    }
    return;
  }
  /* polar flagstones */
  x.fillStyle = rough ? '#fff' : emissive ? B.gapGlow : B.gap; x.fillRect(0, 0, size, size);
  if (emissive) { x.globalCompositeOperation = 'source-over'; }
  const rings = B.rings.concat([E + 0.1]), gap = B.gapW;
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i] + gap, r1 = rings[i + 1] - gap, n = Math.max(5, Math.round(TAU * (r0 + r1) / 2 / (B.slab[0] + r() * B.slab[1]))), off = r() * TAU;
    const cut = []; const jit = B.jit !== undefined ? B.jit : 0.55; for (let j = 0; j <= n; j++) cut.push(off + (j + (j % n ? (r() - 0.5) * jit : 0)) / n * TAU);
    for (let j = 0; j < n; j++) {
      const a0 = cut[j] + gap / r0, a1 = cut[j + 1] - gap / r0;
      x.beginPath(); x.arc(c, c, r1 * s, a0, a1); x.arc(c, c, r0 * s, a1, a0, true); x.closePath();
      const t = B.tones[Math.floor(r() * B.tones.length)], j2 = 0.88 + r() * 0.24;
      if (rough) { const k = Math.round(255 * (B.rough[0] + (B.rough[1] - B.rough[0]) * r())); x.fillStyle = shade(k); }
      else if (emissive) x.fillStyle = '#000';
      else { const gg = x.createRadialGradient(c, c, r0 * s, c, c, r1 * s); gg.addColorStop(0, `rgb(${Math.round(t[0] * j2 * 1.12)},${Math.round(t[1] * j2 * 1.12)},${Math.round(t[2] * j2 * 1.12)})`); gg.addColorStop(1, `rgb(${Math.round(t[0] * j2 * 0.85)},${Math.round(t[1] * j2 * 0.85)},${Math.round(t[2] * j2 * 0.85)})`); x.fillStyle = gg; }
      x.fill();
      /* surface detail: speckle (map) and hairline cracks (map + faint glow) */
      if (B.grain && !rough && !emissive) {
        /* boardwalk plank: faded paint on a few, wood grain and nail heads on all */
        if (r() < 0.14) { x.fillStyle = B.paint[Math.floor(r() * B.paint.length)]; x.beginPath(); x.arc(c, c, r1 * s, a0, a1); x.arc(c, c, r0 * s, a1, a0, true); x.closePath(); x.fill(); }
        x.lineWidth = s * 0.006; for (let k = 0; k < 3; k++) { const rr = r0 + (r1 - r0) * (0.2 + r() * 0.6); x.strokeStyle = `rgba(20,8,12,${0.12 + r() * 0.12})`; x.beginPath(); x.arc(c, c, rr * s, a0 + r() * 0.05, a1 - r() * 0.05); x.stroke(); }
        if (r() < 0.2) { const p = P(r0 + (r1 - r0) * r(), a0 + (a1 - a0) * r()); x.strokeStyle = 'rgba(20,8,12,0.25)'; x.beginPath(); x.ellipse(p[0], p[1], s * 0.04, s * 0.015, a0, 0, TAU); x.stroke(); }
        [a0 + 0.04 / r0, a1 - 0.04 / r0].forEach(aa => { const p = P((r0 + r1) / 2, aa); x.fillStyle = 'rgba(200,190,200,0.3)'; x.beginPath(); x.arc(p[0], p[1], s * 0.012, 0, TAU); x.fill(); });
      }
      if (B.bolts && !rough && !emissive) {
        /* deck panel: inner bevel line and four corner bolts */
        const ri = r0 + 0.07, ro = r1 - 0.07, b0 = a0 + 0.07 / r0, b1 = a1 - 0.07 / r0;
        x.strokeStyle = 'rgba(150,170,255,0.09)'; x.lineWidth = s * 0.012; x.beginPath(); x.arc(c, c, ro * s, b0, b1); x.arc(c, c, ri * s, b1, b0, true); x.closePath(); x.stroke();
        [[ri + 0.03, b0 + 0.03 / ri], [ri + 0.03, b1 - 0.03 / ri], [ro - 0.03, b0 + 0.03 / ro], [ro - 0.03, b1 - 0.03 / ro]].forEach(q => { const p = P(q[0], q[1]); x.fillStyle = 'rgba(0,0,0,0.5)'; x.beginPath(); x.arc(p[0], p[1] + s * 0.006, s * 0.018, 0, TAU); x.fill(); x.fillStyle = 'rgba(170,185,240,0.35)'; x.beginPath(); x.arc(p[0], p[1], s * 0.014, 0, TAU); x.fill(); });
      }
      if (!rough && !emissive) { for (let k = 0; k < 10; k++) { const a = a0 + (a1 - a0) * r(), rr = r0 + (r1 - r0) * r(), p = P(rr, a); x.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`; x.beginPath(); x.arc(p[0], p[1], s * (0.02 + r() * 0.05), 0, TAU); x.fill(); } }
      if (B.cracks && r() < 0.28) {
        let a = a0 + (a1 - a0) * (0.2 + r() * 0.6), rr = r0 + (r1 - r0) * 0.1, p = P(rr, a);
        x.beginPath(); x.moveTo(p[0], p[1]);
        for (let k = 0; k < 4; k++) { rr += (r1 - r0) * 0.22; a += (r() - 0.5) * 0.12 / Math.max(1, rr * 0.5); p = P(rr, a); x.lineTo(p[0], p[1]); }
        x.strokeStyle = rough ? '#fff' : emissive ? B.cracks.replace(/[\d.]+\)$/, '0.35)') : B.cracks; x.lineWidth = s * 0.012; x.stroke();
      }
    }
  }
}
function floorTextures(V, A, size, B) {
  const T = V.T, E = V.edge, s = size / (2 * E), c = size / 2;
  const P = (r, a) => [c + Math.cos(a) * r * s, c + Math.sin(a) * r * s];
  const mapT = canvasTex(size, size, (x) => {
    if (B) boardBase(B, V, x, size, s, c, false, false);
    else { const g = x.createRadialGradient(c, c, 0, c, c, E * s); g.addColorStop(0, T.floorIn); g.addColorStop(1, T.floorOut); x.fillStyle = g; x.fillRect(0, 0, size, size); }
    x.strokeStyle = rgbaHex(T.panel, B ? 0.1 : 0.22); x.lineWidth = s * 0.02;
    if (!B) for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; let p = P(0.85, a), q = P(1.55, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); p = P(1.65, a); q = P(V.e0 - 0.08, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); p = P(V.e1 + 0.08, a); q = P(E - 0.06, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); }
    x.beginPath(); x.arc(c, c, 1.6 * s, 0, TAU); x.stroke();
    x.beginPath(); x.arc(c, c, V.e1 * s, 0, TAU); x.arc(c, c, V.e0 * s, 0, TAU, true);
    const tg = x.createRadialGradient(c, c, V.e0 * s, c, c, V.e1 * s); tg.addColorStop(0, T.trackFar); tg.addColorStop(0.5, T.trackNear); tg.addColorStop(1, T.trackFar);
    x.globalAlpha = B ? 0.32 : 1; x.fillStyle = tg; x.fill('evenodd'); x.globalAlpha = 1;
    x.globalAlpha = 0.18; x.strokeStyle = T.tick; x.lineWidth = s * 0.035; x.lineJoin = 'round';
    const m = (V.e0 + V.e1) / 2, w = (V.e1 - V.e0) * 0.2;
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + 0.12; const p0 = P(m - w, a - 0.09), p1 = P(m, a), p2 = P(m + w, a - 0.09); x.beginPath(); x.moveTo(p0[0], p0[1]); x.lineTo(p1[0], p1[1]); x.lineTo(p2[0], p2[1]); x.stroke(); }
    x.globalAlpha = 1;
    if (!B) for (let i = 0; i < 60; i++) { const a = Math.random() * TAU, r = 0.9 + Math.random() * (E - 1); const p = P(r, a); x.fillStyle = 'rgba(255,255,255,0.025)'; x.beginPath(); x.arc(p[0], p[1], s * (0.1 + Math.random() * 0.3), 0, TAU); x.fill(); }
  });
  const ek = lo() ? 0.5 : 1;
  const emT = canvasTex(size * ek, size * ek, (x) => {
    x.scale(ek, ek);
    if (B) boardBase(B, V, x, size, s, c, true, false); else { x.fillStyle = '#000'; x.fillRect(0, 0, size, size); }
    x.strokeStyle = rgbaHex(T.edge, 0.85); x.lineWidth = s * 0.03;
    x.beginPath(); x.arc(c, c, V.e1 * s, 0, TAU); x.stroke(); x.beginPath(); x.arc(c, c, V.e0 * s, 0, TAU); x.stroke();
    if (A.lanes.length > 1) { x.globalAlpha = 0.5; x.lineWidth = s * 0.02; x.setLineDash([s * 0.18, s * 0.14]); x.beginPath(); x.arc(c, c, (V.e0 + V.e1) / 2 * s, 0, TAU); x.stroke(); x.setLineDash([]); x.globalAlpha = 1; }
    x.strokeStyle = rgbaHex(T.tick, 0.9); x.lineWidth = s * 0.022;
    for (let i = 0; i < 72; i++) { const a = i / 72 * TAU; let p = P(V.e0 + 0.08, a), q = P(V.e0 + 0.2, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); p = P(V.e1 - 0.2, a); q = P(V.e1 - 0.08, a); x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); }
    x.strokeStyle = T.rim; x.lineWidth = s * 0.05; x.beginPath(); x.arc(c, c, (E - 0.03) * s, 0, TAU); x.stroke();
  });
  const roughT = B && !lo() ? canvasTex(size / 2, size / 2, (x, w) => boardBase(B, V, x, w, w / (2 * E), w / 2, false, true), false) : null;
  return { mapT, emT, roughT };
}
function rgbaHex(h, a) { const c = new THREE.Color(h); return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; }
function sideTexture(B) {
  const t = canvasTex(512, 256, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, B.sideCol[0]); g.addColorStop(1, B.sideCol[1]); x.fillStyle = g; x.fillRect(0, 0, w, h);
    const r = rnd(23);
    if (B.side === 'steel') {
      x.fillStyle = 'rgba(168,124,70,0.55)'; x.fillRect(0, 10, w, 10); x.fillRect(0, h - 26, w, 8);
      for (let i = 0; i < 8; i++) { x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(i * 64, 20, 3, h - 46); for (let k = 0; k < 4; k++) { x.fillStyle = 'rgba(0,0,0,0.5)'; x.beginPath(); x.arc(i * 64 + 8 + k * 16, 15, 3.4, 0, TAU); x.fill(); x.fillStyle = 'rgba(255,220,160,0.4)'; x.beginPath(); x.arc(i * 64 + 7 + k * 16, 14, 1.6, 0, TAU); x.fill(); } }
      const gg = x.createLinearGradient(0, 20, 0, h); gg.addColorStop(0, 'rgba(255,200,120,0.06)'); gg.addColorStop(1, 'rgba(0,0,0,0.3)'); x.fillStyle = gg; x.fillRect(0, 20, w, h - 20);
    }
    else if (B.side === 'plank') {
      for (let i = 0; i < 16; i++) { x.fillStyle = `rgba(${i % 2 ? '255,220,200' : '0,0,0'},${0.03 + r() * 0.04})`; x.fillRect(i * 32, 0, 32, h); x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillRect(i * 32, 0, 2, h); }
      /* bunting along the top of the skirt: muted, the bars stay the brightest colours */
      const pc = ['#7a2a40', '#b89a6a', '#3a4a80', '#6a3a7a'];
      x.fillStyle = 'rgba(30,14,22,0.9)'; x.fillRect(0, 6, w, 4);
      for (let i = 0; i < 16; i++) { x.fillStyle = pc[i % pc.length]; x.beginPath(); x.moveTo(i * 32 + 2, 9); x.lineTo(i * 32 + 30, 9); x.lineTo(i * 32 + 16, 46); x.closePath(); x.fill(); }
    }
    else if (B.side === 'panel') { x.fillStyle = 'rgba(63,208,255,0.5)'; x.fillRect(0, 18, w, 4); x.fillStyle = 'rgba(0,0,0,0.35)'; for (let i = 0; i < 8; i++) x.fillRect(i * 64, 0, 3, h); }
    else {
      const rows = B.side === 'stone' ? 6 : 3, rh = h / rows;
      for (let j = 0; j < rows; j++) { const o = r() * 60; for (let i = -1; i < 6; i++) { const bx = o + i * (w / 5) + (j % 2) * 40; x.fillStyle = `rgba(${B.side === 'ice' ? '200,235,255' : '255,240,230'},${0.03 + r() * 0.06})`; x.fillRect(bx + 3, j * rh + 3, w / 5 - 6, rh - 6); x.strokeStyle = 'rgba(0,0,0,0.45)'; x.lineWidth = 4; x.strokeRect(bx + 2, j * rh + 2, w / 5 - 4, rh - 4); } }
    }
  });
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(10, 1); return t;
}

function buildArenaCore(V, A) {
  const T = V.T, E = V.edge, grp = new THREE.Group(), B = BOARD[A.id];
  const size = quality.level >= 3 ? 2048 : 1024;
  const ft = floorTextures(V, A, size, B);
  const floorMat = new THREE.MeshStandardMaterial({ map: ft.mapT, emissiveMap: ft.emT, emissive: 0xffffff, emissiveIntensity: B ? B.emis : 1.0, roughness: B ? (ft.roughT ? 1 : (B.rough[0] + B.rough[1]) / 2) : 0.6, roughnessMap: ft.roughT, metalness: B ? B.metal : 0.2 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(E, lo() ? 64 : 128).rotateX(-Math.PI / 2), floorMat);
  floor.receiveShadow = true; grp.add(floor);
  if (B) {
    /* platform with mass: textured side wall, a lip ring on top, a glow line where it meets the world */
    const depth = B.depth;
    const side = new THREE.Mesh(new THREE.CylinderGeometry(E, E * (depth > 3 ? 0.86 : 0.98), depth, lo() ? 48 : 96, 1, true).translate(0, -depth / 2, 0), new THREE.MeshStandardMaterial({ map: sideTexture(B), roughness: B.side === 'steel' ? 0.5 : 0.8, metalness: B.side === 'panel' || B.side === 'steel' ? 0.5 : 0.05 }));
    side.receiveShadow = true; grp.add(side);
    const lipMat = B.side === 'panel' ? new THREE.MeshStandardMaterial({ color: B.lip, emissive: B.lip, emissiveIntensity: 1.6 }) : new THREE.MeshStandardMaterial({ color: B.lip, roughness: B.side === 'ice' ? 0.2 : B.side === 'steel' ? 0.32 : 0.85, metalness: B.side === 'steel' ? 1 : 0.05 });
    const lip = new THREE.Mesh(new THREE.TorusGeometry(E, B.side === 'panel' ? 0.045 : 0.11, lo() ? 5 : 10, lo() ? 80 : 160).rotateX(Math.PI / 2).scale(1, B.side === 'panel' ? 1 : 0.6, 1), lipMat);
    lip.position.y = 0.0; lip.castShadow = false; grp.add(lip);
    const lowC = B.lipLow || B.lipGlow;
    const low = new THREE.Mesh(new THREE.TorusGeometry(E * (depth > 3 ? 0.99 : 0.985), 0.03, lo() ? 4 : 8, lo() ? 80 : 160).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(lowC).multiplyScalar(B.side === 'panel' ? 2 : 1.2) }));
    low.position.y = depth > 3 ? -0.18 : -depth + 0.06; grp.add(low);
  } else {
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
  }
  const hub = new THREE.Group();
  const hc = B && B.hub ? B.hub : [T.hubTop, T.hubBot];
  const hubTex = canvasTex(8, 128, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, hc[0]); g.addColorStop(1, hc[1]); x.fillStyle = g; x.fillRect(0, 0, w, h); });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.76, 1.65, lo() ? 32 : 48).translate(0, 0.825, 0), new THREE.MeshStandardMaterial({ map: hubTex, metalness: B && B.side !== 'panel' ? 0.1 : 0.55, roughness: B && B.side === 'stone' ? 0.8 : 0.3 }));
  body.castShadow = true; body.receiveShadow = true; hub.add(body);
  [[0.3, G_API.COL.low], [1.17, G_API.COL.high]].forEach(([y, c]) => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.035, lo() ? 5 : 10, lo() ? 40 : 64).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.6 }));
    r.position.y = y; hub.add(r);
  });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.72, 0.06, 48), new THREE.MeshStandardMaterial({ color: T.hubCap, metalness: 0.4, roughness: 0.35 }));
  cap.position.y = 1.67; hub.add(cap);
  const capRing = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.015, 6, 64).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: T.tick, emissive: T.tick, emissiveIntensity: 1.2 }));
  capRing.position.y = 1.7; hub.add(capRing);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.04, 40), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffc030, emissiveIntensity: 1.5 }));
  lamp.position.y = 1.71; hub.add(lamp);
  const lamp2 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 32), new THREE.MeshStandardMaterial({ color: 0xfff3b0, emissive: 0xfff0c0, emissiveIntensity: 1.8 }));
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

/* Matte-painted backdrop: one cylinder card around the far side of the arena. The camera never moves,
   so a painting with its horizon at the camera's eye height reads as deep 3D for one draw call. */
/* The HD camera looks down ~43 deg, so the top of the screen is already below eye level: the painted
   horizon is dropped (BD.drop) into the band the camera actually sees. */
const BD = { W: 2048, H: 1024, hz: 0.5, R: 62, HT: 30, arc: 2.1, drop: 23 };
function backdrop(paint) {
  const k = lo() ? 0.5 : 1;
  const tex = canvasTex(BD.W * k, BD.H * k, (x) => { x.scale(k, k); paint(x, BD.W, BD.H, Math.round(BD.H * BD.hz)); });
  tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = -1;
  const camY = RIG.cam.y || 10;
  const geo = new THREE.CylinderGeometry(BD.R, BD.R, BD.HT, 48, 1, true, Math.PI - BD.arc / 2, BD.arc).translate(0, camY - BD.drop + BD.HT * (0.5 - BD.hz), 0);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
  m.renderOrder = -10; return m;
}
function skylineLayer(x, w, hz, r, o) {
  /* o: { col, minH, maxH, wMin, wMax, win: [colors], lit, trim, beacons } */
  let bx = -20;
  while (bx < w + 20) {
    const bw = o.wMin + r() * (o.wMax - o.wMin), bh = o.minH + Math.pow(r(), 1.4) * (o.maxH - o.minH), top = hz - bh;
    x.fillStyle = o.col; x.fillRect(bx, top, bw, o.base - top);
    if (r() < 0.3) { x.fillRect(bx + bw * 0.3, top - bh * 0.08, bw * 0.4, bh * 0.08 + 2); }
    if (r() < (o.spire || 0)) { x.fillRect(bx + bw / 2 - 2, top - 40 - r() * 50, 4, 60); if (o.beacons) { x.fillStyle = 'rgba(255,60,90,0.9)'; x.fillRect(bx + bw / 2 - 3, top - 45 - 50 * 0.5, 6, 6); } }
    if (o.win) {
      const cw = 9, ch = 12;
      for (let yy = top + 8; yy < o.base - 6; yy += ch) for (let xx = bx + 5; xx < bx + bw - 8; xx += cw) {
        if (r() < o.lit) { x.fillStyle = o.win[Math.floor(r() * o.win.length)]; x.globalAlpha = 0.35 + r() * 0.5; x.fillRect(xx, yy, 5, 6); x.globalAlpha = 1; }
      }
    }
    if (o.trim && r() < 0.35) { x.fillStyle = o.trim[Math.floor(r() * o.trim.length)]; x.fillRect(bx, top, bw, 3); }
    bx += bw + (r() < 0.3 ? r() * 30 : 2);
  }
}
function glyphSign(x, cx, cy, sw, sh, col, kind) {
  x.save(); x.shadowColor = col; x.shadowBlur = 24;
  x.fillStyle = 'rgba(8,6,24,0.92)'; x.fillRect(cx - sw / 2, cy - sh / 2, sw, sh);
  x.strokeStyle = col; x.lineWidth = 4; x.strokeRect(cx - sw / 2 + 3, cy - sh / 2 + 3, sw - 6, sh - 6);
  x.lineWidth = 6; x.lineCap = 'round'; x.beginPath();
  const R = Math.min(sw, sh) * 0.28;
  if (kind === 0) x.arc(cx, cy, R, 0, TAU);
  else if (kind === 1) { x.moveTo(cx - R, cy + R * 0.8); x.lineTo(cx, cy - R); x.lineTo(cx + R, cy + R * 0.8); x.closePath(); }
  else if (kind === 2) { for (let i = 0; i <= 3; i++) { x.moveTo(cx - R, cy - R + i * R * 0.66); x.quadraticCurveTo(cx, cy - R * 1.3 + i * R * 0.66, cx + R, cy - R + i * R * 0.66); } }
  else { x.moveTo(cx - R, cy); x.lineTo(cx + R, cy); x.moveTo(cx, cy - R); x.lineTo(cx, cy + R); }
  x.stroke(); x.restore();
}
function streakTex() {
  return canvasTex(32, 128, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.25, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); const g2 = x.createLinearGradient(0, 0, w, 0); g2.addColorStop(0, 'rgba(0,0,0,1)'); g2.addColorStop(0.5, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)'); x.globalCompositeOperation = 'destination-out'; x.fillStyle = g2; x.fillRect(0, 0, w, h); }, false);
}

function sceneryNeon(V) {
  const g = new THREE.Group(), r = rnd(11);
  const sky = new THREE.Color(0x05060f);
  g.add(backdrop((x, w, h, hz) => {
    const pr = rnd(12);
    const sg = x.createLinearGradient(0, 0, 0, hz); sg.addColorStop(0, '#04050e'); sg.addColorStop(0.55, '#0e0b26'); sg.addColorStop(0.88, '#2a1246'); sg.addColorStop(1, '#3a1450');
    x.fillStyle = sg; x.fillRect(0, 0, w, hz);
    for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(220,225,255,${0.15 + pr() * 0.5})`; const z = 0.8 + pr() * 1.4; x.fillRect(pr() * w, pr() * hz * 0.6, z, z); }
    const hb = x.createLinearGradient(0, hz - 160, 0, hz + 10); hb.addColorStop(0, 'rgba(255,60,170,0)'); hb.addColorStop(0.7, 'rgba(255,60,170,0.22)'); hb.addColorStop(1, 'rgba(120,60,255,0.12)'); x.fillStyle = hb; x.fillRect(0, hz - 160, w, 170);
    x.fillStyle = '#07061a'; x.fillRect(0, hz, w, h - hz);
    skylineLayer(x, w, hz + 10, pr, { col: '#241c52', base: hz + 30, minH: 50, maxH: 170, wMin: 30, wMax: 80, win: ['#7f7cff', '#ff8ad0'], lit: 0.06 });
    const hz2 = x.createLinearGradient(0, hz - 120, 0, hz + 20); hz2.addColorStop(0, 'rgba(60,30,120,0)'); hz2.addColorStop(1, 'rgba(70,30,130,0.55)'); x.fillStyle = hz2; x.fillRect(0, hz - 120, w, 140);
    skylineLayer(x, w, hz + 40, pr, { col: '#120f33', base: h, minH: 90, maxH: 300, wMin: 50, wMax: 130, win: ['#ffcf7a', '#8fd8ff', '#ff8fd0', '#fff1c9'], lit: 0.16, trim: ['#3fd0ff', '#ff4fa3', '#b48cff'], spire: 0.3, beacons: true });
    [[0.2, 0.27, '#3fd0ff', 0], [0.36, 0.22, '#ff4fa3', 2], [0.55, 0.3, '#ffd23f', 1], [0.7, 0.24, '#b48cff', 3], [0.86, 0.29, '#ff4fa3', 0]].forEach(sn => glyphSign(x, sn[0] * w, hz - sn[1] * h * 0.5, 70 + pr() * 40, 52 + pr() * 30, sn[2], sn[3]));
    skylineLayer(x, w, hz + 120, pr, { col: '#08071a', base: h, minH: 40, maxH: 140, wMin: 60, wMax: 160, win: ['#ffcf7a', '#8fd8ff'], lit: 0.05, trim: ['#3fd0ff', '#ff4fa3'] });
    for (let i = 0; i < 900; i++) { const yy = hz + 130 + pr() * (h - hz - 130), c = pr() < 0.5 ? '255,207,122' : pr() < 0.5 ? '255,79,163' : '143,216,255'; x.fillStyle = `rgba(${c},${0.2 + pr() * 0.5})`; x.fillRect(pr() * w, yy, 2, 2); }
  }));
  /* wet rooftop deck: dark tiles, low roughness so the neon smears across it */
  const roofTex = canvasTex(512, 512, (x, w, h) => { x.fillStyle = '#0d0e22'; x.fillRect(0, 0, w, h); const rr = rnd(4); for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.fillStyle = `rgba(${rr() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + rr() * 0.04})`; x.fillRect(i * 64 + 2, j * 64 + 2, 60, 60); } x.strokeStyle = 'rgba(110,120,255,0.12)'; x.lineWidth = 3; for (let i = 0; i <= 8; i++) { x.beginPath(); x.moveTo(i * 64, 0); x.lineTo(i * 64, h); x.stroke(); x.beginPath(); x.moveTo(0, i * 64); x.lineTo(w, i * 64); x.stroke(); } });
  roofTex.wrapS = roofTex.wrapT = THREE.RepeatWrapping; roofTex.repeat.set(16, 8);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(64, 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.22, metalness: 0.4, envMapIntensity: 0.6 }));
  roof.position.set(0, -0.6, -2); roof.receiveShadow = true; g.add(roof);
  /* parapet with a neon top rail, merged */
  const propTex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#15173a'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(0,0,0,0.45)'; for (let i = 0; i < 9; i++) x.fillRect(20, 40 + i * 18, w - 40, 7); x.strokeStyle = 'rgba(140,150,255,0.18)'; x.lineWidth = 4; x.strokeRect(4, 4, w - 8, h - 8); x.fillStyle = '#1d2050'; x.fillRect(w - 8, h - 8, 8, 8); });
  propTex.wrapS = propTex.wrapT = THREE.RepeatWrapping;
  const dark = new THREE.MeshStandardMaterial({ map: propTex, roughness: 0.5, metalness: 0.35 });
  const walls = []; [[0, -14, 64, 1.4, 0.6]].forEach(b => walls.push({ x: b[0], z: b[1], w: b[2], h: b[3], d: b[4], y: -0.6 }));
  /* props: AC units, vent boxes, a stair hut, water tank base */
  [[-6.8, -9.5, 2.2, 1.3, 1.6], [6.6, -10.5, 2.6, 1.6, 1.8], [-4.2, -12.6, 1.4, 0.9, 1.2], [9.5, -7, 1.8, 1.2, 1.6], [-10, -6.5, 2.2, 1.4, 1.8], [3.2, -12.8, 3.4, 2.6, 2.2]].forEach(b => walls.push({ x: b[0], z: b[1], w: b[2], h: b[3], d: b[4], y: -0.6 }));
  const props = mergeBoxes(walls, dark); props.castShadow = props.receiveShadow = true; g.add(props);
  const neonMat = (c, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(64, 0.07, 0.07), neonMat(0x3fd0ff, 2.6)); rail.position.set(0, 0.85, -13.7); g.add(rail);
  const trims = [[-6.8, -9.5, 2.2, 1.3, 1.6, 0xff4fa3], [6.6, -10.5, 2.6, 1.6, 1.8, 0x3fd0ff], [3.2, -12.8, 3.4, 2.6, 2.2, 0xff4fa3]];
  trims.forEach(t => { const m = new THREE.Mesh(new THREE.BoxGeometry(t[2] + 0.04, 0.05, 0.05), neonMat(t[5], 2.2)); m.position.set(t[0], -0.6 + t[3], t[1] + t[4] / 2); g.add(m); });
  /* blade sign on the stair hut: original glyph, glowing */
  const bladeTex = canvasTex(128, 384, (x, w, h) => { x.fillStyle = '#0a0820'; x.fillRect(0, 0, w, h); x.shadowBlur = 18; x.shadowColor = '#ff4fa3'; x.strokeStyle = '#ffc2e4'; x.lineWidth = 8; x.strokeRect(10, 10, w - 20, h - 20); x.lineCap = 'round'; for (let i = 0; i < 3; i++) { x.beginPath(); x.arc(w / 2, 80 + i * 110, 30, 0, TAU); x.stroke(); } });
  const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2.7), new THREE.MeshBasicMaterial({ map: bladeTex, color: 0xffffff }));
  blade.position.set(1.4, 2.4, -11.6); g.add(blade);
  /* wet reflections: soft vertical streaks under the neon sources */
  const st = streakTex(); const refl = [];
  [[-6.8, -8.3, 0xff4fa3, 2.4, 2.2], [6.6, -9.2, 0x3fd0ff, 2.8, 2.4], [1.4, -10.9, 0xff4fa3, 0.7, 2.0], [-2, -12.4, 0x3fd0ff, 6, 2.2], [8, -12.4, 0x3fd0ff, 5, 2]].forEach(q => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(q[3], q[4]).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: st, color: new THREE.Color(q[2]).multiplyScalar(0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.position.set(q[0], -0.585, q[1] + q[4] / 2 - 0.2); g.add(m); refl.push(m);
  });
  [[-6, -5, 0xff4fa3], [6.5, -5.5, 0x3fd0ff]].forEach(l => { const pl = new THREE.PointLight(l[2], 5, 10, 2); pl.position.set(l[0], 1.2, l[1]); g.add(pl); });
  const neonMotes = motes(70, [-9, 9], [0, 6], [-14, -2], 0xd08aff, 0.06, 13); g.add(neonMotes);
  return { update(t) { stepMotes(neonMotes, t); }, group: g, sky, fog: [0x0c0a24, 22, 70], hemi: [0x6a70d8, 0x0a0614, 0.9], key: [0xd8d4ff, 2.3], rim: [0x9a7bff, 2.4], bloom: [0.85, 0.35, 1], exposure: 1.12, tint: 0x06041a, vig: 0.5 };
}

function crag(r, x, y, z, w, h, mat) {
  /* jagged basalt spire: a tapered prism with jittered vertices, flat shaded */
  const geo = new THREE.CylinderGeometry(w * (0.3 + r() * 0.25), w, h, 7, 5);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = 1 + (r() - 0.5) * 0.35; p.setXYZ(i, p.getX(i) * k, p.getY(i) + (r() - 0.5) * h * 0.04, p.getZ(i) * k); }
  geo.translate(x, y + h / 2, z); geo.rotateY(0); return geo.toNonIndexed();
}
function sceneryLava(V) {
  const g = new THREE.Group(), r = rnd(99);
  const sky = new THREE.Color(0x070203);
  g.add(backdrop((x, w, h, hz) => {
    const pr = rnd(100);
    const sg = x.createLinearGradient(0, 0, 0, hz); sg.addColorStop(0, '#060203'); sg.addColorStop(0.6, '#1c0706'); sg.addColorStop(1, '#4a1208');
    x.fillStyle = sg; x.fillRect(0, 0, w, hz);
    /* smoke bands */
    for (let i = 0; i < 40; i++) { const cx = pr() * w, cy = hz * (0.2 + pr() * 0.7), rr = 60 + pr() * 160; const gg = x.createRadialGradient(cx, cy, 0, cx, cy, rr); gg.addColorStop(0, `rgba(${pr() < 0.5 ? '70,20,14' : '20,8,8'},0.35)`); gg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gg; x.fillRect(cx - rr, cy - rr, rr * 2, rr * 2); }
    const glow = x.createLinearGradient(0, hz - 140, 0, hz + 40); glow.addColorStop(0, 'rgba(255,80,20,0)'); glow.addColorStop(1, 'rgba(255,80,20,0.35)'); x.fillStyle = glow; x.fillRect(0, hz - 140, w, 180);
    /* far ridge with temple towers, then nearer cliffs with orange rim light and lava falls */
    const ridge = (base, minH, maxH, step, col, rim, falls, towers) => {
      x.beginPath(); x.moveTo(0, h); let px = 0; const pts = [];
      while (px <= w + step) { const yy = base - minH - pr() * (maxH - minH); pts.push([px, yy]); px += step * (0.5 + pr()); }
      pts.forEach(q => x.lineTo(q[0], q[1])); x.lineTo(w, h); x.closePath(); x.fillStyle = col; x.fill();
      if (towers) for (let i = 0; i < towers; i++) { const tx = pr() * w, tw = 18 + pr() * 30, th = 60 + pr() * 110, ty = base - maxH * 0.7; x.fillStyle = col; x.fillRect(tx, ty - th, tw, th + 60); for (let k = 0; k < 3; k++) x.fillRect(tx - 6 + k * 2, ty - th + k * th * 0.3, tw + 12 - k * 4, 6); x.beginPath(); x.moveTo(tx - 4, ty - th); x.lineTo(tx + tw / 2, ty - th - 30); x.lineTo(tx + tw + 4, ty - th); x.fill(); }
      if (rim) { x.save(); x.strokeStyle = rim; x.lineWidth = 2.5; x.shadowColor = rim; x.shadowBlur = 10; x.beginPath(); pts.forEach((q, i) => i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])); x.stroke(); x.restore(); }
      for (let i = 0; i < falls; i++) { const q = pts[Math.floor(pr() * pts.length)], fw = 3 + pr() * 5; const fg = x.createLinearGradient(0, q[1], 0, h); fg.addColorStop(0, 'rgba(255,170,60,0.95)'); fg.addColorStop(0.5, 'rgba(255,90,20,0.7)'); fg.addColorStop(1, 'rgba(120,20,5,0)'); x.fillStyle = fg; x.fillRect(q[0] - fw / 2, q[1] + 4, fw, h - q[1]); x.save(); x.shadowColor = '#ff5a14'; x.shadowBlur = 16; x.fillRect(q[0] - 1, q[1] + 4, 2, (h - q[1]) * 0.5); x.restore(); }
    };
    ridge(hz + 10, 40, 150, 70, '#2a0f0b', 'rgba(255,90,30,0.45)', 3, 6);
    const mid = x.createLinearGradient(0, hz - 60, 0, hz + 60); mid.addColorStop(0, 'rgba(90,20,10,0)'); mid.addColorStop(1, 'rgba(90,20,10,0.4)'); x.fillStyle = mid; x.fillRect(0, hz - 60, w, 120);
    ridge(hz + 90, 20, 170, 55, '#0e0605', 'rgba(255,110,40,0.6)', 6, 0);
    const deep = x.createLinearGradient(0, hz + 120, 0, h); deep.addColorStop(0, 'rgba(6,2,2,0)'); deep.addColorStop(1, 'rgba(80,16,6,0.8)'); x.fillStyle = deep; x.fillRect(0, hz + 120, w, h - hz - 120);
  }));
  /* magma far below the column: dim, slow, fogged */
  const lavaTex = canvasTex(512, 512, (x, w, h) => {
    x.fillStyle = '#2a0703'; x.fillRect(0, 0, w, h);
    const rr = rnd(7);
    for (let i = 0; i < 140; i++) { const cx = rr() * w, cy = rr() * h, s = 10 + rr() * 50, c = rr() < 0.25 ? '255,170,50' : '230,70,15'; const gg = x.createRadialGradient(cx, cy, 0, cx, cy, s); gg.addColorStop(0, `rgba(${c},0.6)`); gg.addColorStop(1, `rgba(${c},0)`); x.fillStyle = gg; x.fillRect(cx - s, cy - s, s * 2, s * 2); }
    x.strokeStyle = 'rgba(15,3,2,0.7)'; x.lineWidth = 6; for (let i = 0; i < 50; i++) { x.beginPath(); let px = rr() * w, py = rr() * h; x.moveTo(px, py); for (let j = 0; j < 4; j++) { px += (rr() - 0.5) * 90; py += (rr() - 0.5) * 90; x.lineTo(px, py); } x.stroke(); }
  });
  lavaTex.wrapS = lavaTex.wrapT = THREE.RepeatWrapping; lavaTex.repeat.set(3, 3);
  const fadeT = canvasTex(128, 128, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, '#fff'); gg.addColorStop(0.55, '#aaa'); gg.addColorStop(1, '#000'); x.fillStyle = gg; x.fillRect(0, 0, w, w); }, false);
  const lava = new THREE.Mesh(new THREE.CircleGeometry(34, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: lavaTex, alphaMap: fadeT, transparent: true, depthWrite: false, color: 0x8a8a8a, fog: false }));
  lava.position.set(0, -16, -8); lava.renderOrder = -9; g.add(lava);
  /* basalt spires rising from the chasm, merged into one mesh */
  const spires = [];
  [[-4.4, -10.5, 1.3, 14.4], [-8.5, -4, 1.3, 13], [5, -11.5, 1.5, 15.2], [9, -4, 1.2, 12.5], [-2.2, -15, 1.6, 11.5], [3.4, -17, 2.0, 12.8], [-9.5, -16, 2.2, 14], [10.5, -16.5, 2.4, 15]].forEach(c => spires.push(crag(r, c[0], -16, c[1], c[2], c[3])));
  const sg = new THREE.BufferGeometry(); const all = spires.map(q => q.attributes.position.array); const n = all.reduce((a, b) => a + b.length, 0), arr = new Float32Array(n); let o = 0; all.forEach(a => { arr.set(a, o); o += a.length; });
  sg.setAttribute('position', new THREE.BufferAttribute(arr, 3)); sg.computeVertexNormals();
  const basalt = new THREE.MeshStandardMaterial({ color: 0x2a1d1a, roughness: 0.9, flatShading: true, emissive: 0x3a0a02, emissiveIntensity: 0.25 });
  const sp = new THREE.Mesh(sg, basalt); sp.castShadow = false; sp.receiveShadow = true; g.add(sp);
  /* braziers on the two nearest spires: stone bowl + flame card + warm light */
  const flameTex = canvasTex(64, 128, (x, w, h) => { const gg = x.createRadialGradient(w / 2, h * 0.75, 2, w / 2, h * 0.6, h * 0.55); gg.addColorStop(0, 'rgba(255,240,180,1)'); gg.addColorStop(0.3, 'rgba(255,150,40,0.9)'); gg.addColorStop(0.7, 'rgba(220,50,10,0.35)'); gg.addColorStop(1, 'rgba(120,20,5,0)'); x.fillStyle = gg; x.beginPath(); x.moveTo(w / 2, 0); x.quadraticCurveTo(w, h * 0.6, w / 2, h); x.quadraticCurveTo(0, h * 0.6, w / 2, 0); x.fill(); }, false);
  const flames = [];
  [[-4.4, -10.5, 14.4 - 16], [5, -11.5, 15.2 - 16]].forEach(b => {
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.45, 0.5, 10), basalt); bowl.position.set(b[0], b[2] + 0.25, b[1]); g.add(bowl);
    const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false })); f.scale.set(0.9, 1.5, 1); f.position.set(b[0], b[2] + 1.0, b[1]); g.add(f); flames.push(f);
  });
  const pl = new THREE.PointLight(0xff5a1a, 18, 14, 1.6); pl.position.set(0, -4, 4); g.add(pl);
  const fl = new THREE.PointLight(0xff8a3a, 6, 12, 2); fl.position.set(0, 1.5, -7.5); g.add(fl);
  return { group: g, sky, fog: [0x120403, 14, 52], hemi: [0xffb080, 0x400a04, 0.75], key: [0xffd6b8, 2.4], rim: [0xff6a2a, 2.6], bloom: [0.9, 0.35, 1], exposure: 1.1, tint: 0x0a0202, vig: 0.55, embers: true,
    update(t) { lavaTex.offset.set(t * 0.003, t * 0.002); flames.forEach((f, i) => { const k = 1 + 0.12 * Math.sin(t * 13 + i * 2) + 0.06 * Math.sin(t * 29 + i); f.scale.set(0.9 * (2 - k), 1.5 * k, 1); }); fl.intensity = 6 + Math.sin(t * 11) * 0.8; } };
}

function sceneryGear(V) {
  const g = new THREE.Group(), r = rnd(31);
  const sky = new THREE.Color(0x060403);
  /* the tower's back wall: a huge backlit clock window with gear silhouettes in front of it.
     The card is seen ~2.3x squashed vertically, so round things are painted as tall ellipses (SQ). */
  const SQ = 2.3;
  g.add(backdrop((x, w, h, hz) => {
    const pr = rnd(32);
    const wg = x.createLinearGradient(0, 0, 0, h); wg.addColorStop(0, '#040302'); wg.addColorStop(0.4, '#120c07'); wg.addColorStop(0.62, '#1a1209'); wg.addColorStop(1, '#080604'); x.fillStyle = wg; x.fillRect(0, 0, w, h);
    for (let j = 0; j < 10; j++) for (let i = 0; i < 26; i++) { const pw = w / 26, ph = h / 10, px = i * pw + (j % 2) * pw / 2, py = j * ph; x.fillStyle = `rgba(255,200,140,${0.008 + pr() * 0.02})`; x.fillRect(px + 3, py + 3, pw - 6, ph - 6); x.strokeStyle = 'rgba(0,0,0,0.55)'; x.lineWidth = 3; x.strokeRect(px, py, pw, ph); }
    const cx = w * 0.5, cy = h * 0.5, R = 88;
    const ell = (fx, fy, rr) => { x.beginPath(); x.ellipse(fx, fy, rr, rr * SQ, 0, 0, TAU); };
    /* warm spill on the wall around the window */
    x.save(); x.translate(cx, cy); x.scale(1, SQ); const sp = x.createRadialGradient(0, 0, R * 0.8, 0, 0, R * 2.6); sp.addColorStop(0, 'rgba(255,150,60,0.22)'); sp.addColorStop(1, 'rgba(255,150,60,0)'); x.fillStyle = sp; x.fillRect(-R * 3, -R * 3, R * 6, R * 6); x.restore();
    /* glass: dim amber, brighter at the centre (kept well below the bars) */
    x.save(); x.translate(cx, cy); x.scale(1, SQ); const gl = x.createRadialGradient(0, -R * 0.15, 0, 0, 0, R); gl.addColorStop(0, '#8a5a22'); gl.addColorStop(0.55, '#5a3612'); gl.addColorStop(1, '#2a1607'); x.fillStyle = gl; x.beginPath(); x.arc(0, 0, R, 0, TAU); x.fill();
    /* iron tracery: rim, inner ring, spokes, hour bars, hands */
    x.strokeStyle = '#0c0805'; x.lineCap = 'round';
    x.lineWidth = 12; x.beginPath(); x.arc(0, 0, R, 0, TAU); x.stroke();
    x.lineWidth = 5; x.beginPath(); x.arc(0, 0, R * 0.62, 0, TAU); x.stroke(); x.beginPath(); x.arc(0, 0, R * 0.16, 0, TAU); x.stroke();
    x.lineWidth = 3; for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; x.beginPath(); x.moveTo(Math.cos(a) * R * 0.16, Math.sin(a) * R * 0.16); x.lineTo(Math.cos(a) * R, Math.sin(a) * R); x.stroke(); }
    x.lineWidth = 7; for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; x.beginPath(); x.moveTo(Math.cos(a) * R * 0.74, Math.sin(a) * R * 0.74); x.lineTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9); x.stroke(); }
    x.lineWidth = 8; x.beginPath(); x.moveTo(0, 0); x.lineTo(Math.cos(-2.2) * R * 0.5, Math.sin(-2.2) * R * 0.5); x.stroke(); x.lineWidth = 5; x.beginPath(); x.moveTo(0, 0); x.lineTo(Math.cos(-0.55) * R * 0.8, Math.sin(-0.55) * R * 0.8); x.stroke();
    x.restore();
    /* soft light shafts falling from the window */
    x.save(); x.globalCompositeOperation = 'lighter';
    [[-0.5, 0.05], [0.15, 0.04], [0.6, 0.035]].forEach(([dx, al]) => { const bx = cx + dx * R; const lg = x.createLinearGradient(0, cy, 0, h * 0.95); lg.addColorStop(0, `rgba(255,170,80,${al})`); lg.addColorStop(1, 'rgba(255,170,80,0)'); x.fillStyle = lg; x.beginPath(); x.moveTo(bx - 30, cy); x.lineTo(bx + 30, cy); x.lineTo(bx + 150 + dx * 120, h * 0.95); x.lineTo(bx + 20 + dx * 120, h * 0.95); x.closePath(); x.fill(); });
    x.restore();
    /* gear silhouettes in front of the glass and along the wall */
    const gearSil = (gx, gy, gr, teeth, col, rot) => { x.save(); x.translate(gx, gy); x.scale(1, SQ); x.rotate(rot); x.fillStyle = col; x.beginPath(); for (let i = 0; i < teeth * 4; i++) { const a = i / (teeth * 4) * TAU, rr = (i % 4 === 1 || i % 4 === 2) ? gr : gr * 0.84; i ? x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : x.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); } x.closePath(); x.fill(); x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(0, 0, gr * 0.2, 0, TAU); x.fill(); x.globalCompositeOperation = 'source-over'; x.restore(); };
    gearSil(cx - R * 0.95, cy + R * 1.6, 62, 14, '#0a0705', 0.1); gearSil(cx + R * 0.9, cy + R * 1.9, 46, 10, '#0b0806', 0.3); gearSil(cx + R * 1.75, cy + R * 0.2, 54, 12, '#0d0907', 0); gearSil(cx - R * 1.9, cy - R * 0.6, 70, 16, '#0d0907', 0.2);
    /* iron columns and a catwalk */
    x.fillStyle = '#0a0705'; [cx - R * 2.6, cx + R * 2.5].forEach(px => { x.fillRect(px - 18, 0, 36, h); x.fillStyle = 'rgba(255,170,90,0.09)'; x.fillRect(px - 18, 0, 3, h); x.fillStyle = '#0a0705'; });
    x.fillRect(0, cy + R * SQ * 1.15, w, 10); for (let i = 0; i < 80; i++) x.fillRect(i * w / 80, cy + R * SQ * 1.15 - 34, 3, 34); x.fillRect(0, cy + R * SQ * 1.15 - 36, w, 4);
    const fl = x.createLinearGradient(0, h * 0.7, 0, h); fl.addColorStop(0, 'rgba(0,0,0,0)'); fl.addColorStop(1, 'rgba(0,0,0,0.7)'); x.fillStyle = fl; x.fillRect(0, h * 0.7, w, h * 0.3);
  }));
  /* machine-room floor: dark tread plate, fading into darkness */
  const floorTex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#17140f'; x.fillRect(0, 0, w, h); for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { x.save(); x.translate(i * 32 + (j % 2) * 16, j * 32 + 8); x.rotate((i + j) % 2 ? 0.78 : -0.78); x.fillStyle = 'rgba(255,230,190,0.06)'; x.beginPath(); x.ellipse(0, 0, 10, 2.5, 0, 0, TAU); x.fill(); x.restore(); } x.strokeStyle = 'rgba(0,0,0,0.6)'; x.lineWidth = 3; x.strokeRect(1, 1, w - 2, h - 2); });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(20, 9);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(64, 28).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55, metalness: 0.6, envMapIntensity: 0.5 }));
  fl.position.set(0, -1.1, -6); fl.receiveShadow = true; g.add(fl);
  /* big slow gears half sunk into the floor around the board: one instanced draw */
  const gearGeo = new THREE.ExtrudeGeometry(gearShape(1, 14), { depth: 0.22, bevelEnabled: !lo(), bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 2, curveSegments: lo() ? 2 : 4 }).translate(0, 0, -0.11);
  const gearMat = new THREE.MeshStandardMaterial({ color: 0x4a3622, metalness: 0.9, roughness: 0.38, envMapIntensity: 0.8 });
  const GD = [[-6.4, 0.2, -9, 2.6, 1], [-3.2, 3.0, -15, 1.8, -1], [6.7, 0.8, -10.5, 3.1, -1], [3.5, 3.6, -16, 1.5, 1], [0.9, 5.3, -18, 1.1, -1], [-9.6, 3.2, -13, 1.9, -1]];
  const gearIM = new THREE.InstancedMesh(gearGeo, gearMat, GD.length); gearIM.frustumCulled = false; g.add(gearIM);
  /* brass pipes along the back wall and up the sides, with flanges: merged */
  const brass = new THREE.MeshStandardMaterial({ color: 0x9a7040, metalness: 1, roughness: 0.34, envMapIntensity: 0.9 });
  const pg = [];
  [[0.0, -18.5, 0.34], [1.1, -18.6, 0.24]].forEach(q => pg.push(new THREE.CylinderGeometry(q[2], q[2], 50, 14).rotateZ(Math.PI / 2).translate(0, q[0], q[1])));
  [[-8.6, -12.5], [8.8, -13]].forEach(q => { pg.push(new THREE.CylinderGeometry(0.28, 0.28, 14, 14).translate(q[0], 5.9, q[1])); [0.6, 2.6, 4.6].forEach(y => pg.push(new THREE.CylinderGeometry(0.4, 0.4, 0.18, 14).translate(q[0], y, q[1]))); });
  for (let i = -4; i <= 4; i++) pg.push(new THREE.CylinderGeometry(0.46, 0.46, 0.16, 14).rotateZ(Math.PI / 2).translate(i * 5, 0, -18.5));
  const pipes = new THREE.Mesh(mergeGeos(pg), brass); g.add(pipes);
  /* hanging work lamps: bulbs, shades and light cones, each merged */
  const LP = [[-4.6, 5.4, -8.6], [5.0, 5.8, -9.6]];
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc070).multiplyScalar(2.2) });
  const coneTex = canvasTex(64, 256, (x, w, h) => { const gg = x.createLinearGradient(0, 0, 0, h); gg.addColorStop(0, 'rgba(255,180,100,0.16)'); gg.addColorStop(1, 'rgba(255,180,100,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, h); const g2 = x.createLinearGradient(0, 0, w, 0); g2.addColorStop(0, 'rgba(0,0,0,1)'); g2.addColorStop(0.5, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)'); x.globalCompositeOperation = 'destination-out'; x.fillStyle = g2; x.fillRect(0, 0, w, h); });
  g.add(new THREE.Mesh(mergeGeos(LP.map(l => new THREE.SphereGeometry(0.2, 12, 8).translate(l[0], l[1] - 0.1, l[2]))), lampMat));
  g.add(new THREE.Mesh(mergeGeos(LP.map(l => [new THREE.ConeGeometry(0.62, 0.46, 18, 1, true).translate(l[0], l[1] + 0.12, l[2]), new THREE.CylinderGeometry(0.02, 0.02, 6, 4).translate(l[0], l[1] + 3.3, l[2])]).flat()), new THREE.MeshStandardMaterial({ color: 0x2a2018, metalness: 0.8, roughness: 0.45, side: THREE.DoubleSide })));
  const cones = new THREE.Mesh(mergeGeos(LP.map(l => new THREE.ConeGeometry(1.7, l[1] + 1.1, 24, 1, true).translate(l[0], (l[1] - 1.1) / 2, l[2]))), new THREE.MeshBasicMaterial({ map: coneTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  g.add(cones);
  LP.forEach(l => { const pl = new THREE.PointLight(0xffb060, 9, 13, 2); pl.position.set(l[0], l[1] - 0.4, l[2]); g.add(pl); });
  const back = new THREE.PointLight(0xff9a40, 14, 22, 1.6); back.position.set(0, 4, -16); g.add(back);
  /* steam vents on the pipes: soft puffs, a hiss every few seconds */
  const steam = makePuffs(48, softTex()); g.add(steam);
  const vents = [[-8.6, 2.75, -12.2, 0.35], [8.8, 0.75, -12.7, -0.3], [3.6, 0.35, -18.1, 0.1]];
  let lastT = null, acc = 0;
  /* dust motes in the light */
  const dust = motes(140, [-9, 9], [-1, 7], [-17, -3], 0xffc890, 0.07, 41); g.add(dust);
  const steamCol = new THREE.Color(0.32, 0.27, 0.22);
  return { group: g, sky, fog: [0x0c0805, 16, 58], hemi: [0xffd8a8, 0x1a120a, 0.6], key: [0xffe2c0, 2.2], rim: [0xffa850, 2.8], bloom: [0.85, 0.35, 1], exposure: 1.1, tint: 0x080402, vig: 0.5,
    update(t) {
      const dt = lastT === null ? 0 : Math.min(0.05, t - lastT); lastT = t;
      GD.forEach((d, i) => { tmpQ.setFromAxisAngle(Z_AXIS, t * d[4] * 0.32 / d[3] + i); tmpM.compose(tmpV.set(d[0], d[1], d[2]), tmpQ, tmpS.setScalar(d[3])); gearIM.setMatrixAt(i, tmpM); });
      gearIM.instanceMatrix.needsUpdate = true;
      acc += dt;
      while (acc > 0.07) { acc -= 0.07; vents.forEach((v, i) => { if ((t * 0.33 + i * 0.37) % 1 < 0.3) puff(steam, { x: v[0], y: v[1], z: v[2], vx: v[3] + (Math.random() - 0.5) * 0.3, vy: 1.1 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.3, life: 1.4 + Math.random() * 0.6, size: 0.5, grow: 2.2, col: steamCol }); }); }
      stepPuffs(steam, dt); stepMotes(dust, t);
    } };
}

function crystalGeo(r, x, z, n, size) {
  /* a cluster of elongated octahedral crystals leaning outwards, merged */
  const parts = [];
  for (let i = 0; i < n; i++) {
    const h = size * (0.6 + r() * 0.9), w = h * (0.16 + r() * 0.08);
    const c = new THREE.OctahedronGeometry(1, 0); c.scale(w, h, w);
    c.rotateZ((r() - 0.5) * 0.9); c.rotateX((r() - 0.5) * 0.7); c.rotateY(r() * TAU);
    c.translate(x + (r() - 0.5) * size * 0.7, -0.6 + h * 0.35, z + (r() - 0.5) * size * 0.7);
    parts.push(c.toNonIndexed());
  }
  return parts;
}
function mergeNonIndexed(list) {
  const n = list.reduce((a, g) => a + g.attributes.position.count * 3, 0), arr = new Float32Array(n); let o = 0;
  list.forEach(g => { arr.set(g.attributes.position.array, o); o += g.attributes.position.count * 3; g.dispose(); });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(arr, 3)); geo.computeVertexNormals(); return geo;
}
function sceneryFrost(V) {
  const g = new THREE.Group(), r = rnd(57);
  const sky = new THREE.Color(0x030614);
  g.add(backdrop((x, w, h, hz) => {
    const pr = rnd(58);
    const sg = x.createLinearGradient(0, 0, 0, hz); sg.addColorStop(0, '#02040e'); sg.addColorStop(0.5, '#0a1430'); sg.addColorStop(1, '#1d2a5a');
    x.fillStyle = sg; x.fillRect(0, 0, w, hz);
    for (let i = 0; i < 500; i++) { x.fillStyle = `rgba(230,240,255,${0.15 + pr() * 0.6})`; const z = 0.8 + pr() * 1.5; x.fillRect(pr() * w, pr() * hz * 0.9, z, z); }
    /* aurora curtains: vertical streaks along a wavy band, green fading to violet */
    x.globalCompositeOperation = 'lighter';
    [[0.2, 0.78, 0.4], [0.52, 0.7, 0.38], [0.85, 0.8, 0.34]].forEach(cu => {
      const cx = cu[0] * w, cw = cu[2] * w, cy = cu[1] * hz;
      for (let k = 0; k < 220; k++) {
        const u = k / 220, px = cx - cw / 2 + u * cw, py = cy + Math.sin(u * 7 + cu[0] * 9) * 30 + Math.sin(u * 19) * 8, ln = 110 + pr() * 90;
        const ag = x.createLinearGradient(0, py - ln, 0, py + 30); ag.addColorStop(0, 'rgba(150,90,255,0)'); ag.addColorStop(0.5, `rgba(130,100,255,${0.07 + pr() * 0.06})`); ag.addColorStop(0.88, `rgba(80,255,180,${0.16 + pr() * 0.14})`); ag.addColorStop(1, 'rgba(80,255,180,0)');
        x.fillStyle = ag; x.fillRect(px, py - ln, cw / 220 + 2, ln + 30);
      }
    });
    x.globalCompositeOperation = 'source-over';
    const peaks = (base, minH, maxH, step, col, snow) => {
      const pts = []; let px = -step;
      while (px <= w + step) { pts.push([px, base - minH - pr() * (maxH - minH)]); px += step * (0.6 + pr() * 0.8); pts.push([px, base - minH * 0.3 - pr() * minH]); px += step * (0.4 + pr() * 0.5); }
      x.beginPath(); x.moveTo(-step, h); pts.forEach(q => x.lineTo(q[0], q[1])); x.lineTo(w + step, h); x.closePath(); x.fillStyle = col; x.fill();
      /* snow caps: light the left faces of each summit */
      x.fillStyle = snow;
      for (let i = 0; i < pts.length - 1; i += 2) { const a = pts[i], b = pts[i - 1] || [a[0] - step, a[1] + 60]; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0] + (a[0] - b[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.45); x.lineTo(a[0] + 6, a[1] + (b[1] - a[1]) * 0.35); x.closePath(); x.fill(); }
    };
    peaks(hz + 20, 70, 230, 110, '#121c3a', 'rgba(150,175,230,0.45)');
    const haze = x.createLinearGradient(0, hz - 80, 0, hz + 40); haze.addColorStop(0, 'rgba(40,60,120,0)'); haze.addColorStop(1, 'rgba(40,60,120,0.5)'); x.fillStyle = haze; x.fillRect(0, hz - 80, w, 120);
    peaks(hz + 70, 30, 140, 80, '#0a1128', 'rgba(170,190,240,0.5)');
    const ice = x.createLinearGradient(0, hz + 60, 0, h); ice.addColorStop(0, '#0b1530'); ice.addColorStop(1, '#101e40'); x.fillStyle = ice; x.fillRect(0, hz + 75, w, h - hz - 75);
  }));
  /* ice shelf around the board: dark blue, glossy, with frost cracks */
  const shelfTex = canvasTex(512, 512, (x, w, h) => {
    x.fillStyle = '#16294a'; x.fillRect(0, 0, w, h); const rr = rnd(9);
    for (let i = 0; i < 60; i++) { const cx = rr() * w, cy = rr() * h, s = 30 + rr() * 90, gg = x.createRadialGradient(cx, cy, 0, cx, cy, s); gg.addColorStop(0, `rgba(${rr() < 0.5 ? '60,100,150' : '10,20,40'},0.35)`); gg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gg; x.fillRect(cx - s, cy - s, s * 2, s * 2); }
    x.strokeStyle = 'rgba(200,230,255,0.22)'; x.lineWidth = 1.5; for (let i = 0; i < 40; i++) { x.beginPath(); let px = rr() * w, py = rr() * h; x.moveTo(px, py); for (let j = 0; j < 5; j++) { px += (rr() - 0.5) * 70; py += (rr() - 0.5) * 70; x.lineTo(px, py); } x.stroke(); }
  });
  shelfTex.wrapS = shelfTex.wrapT = THREE.RepeatWrapping; shelfTex.repeat.set(4, 4);
  const fadeT = canvasTex(128, 128, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, '#fff'); gg.addColorStop(0.6, '#fff'); gg.addColorStop(1, '#000'); x.fillStyle = gg; x.fillRect(0, 0, w, w); }, false);
  /* the shelf fades out before the painted horizon so the peaks and aurora stay in view */
  const shelf = new THREE.Mesh(new THREE.CircleGeometry(19, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: shelfTex, alphaMap: fadeT, transparent: true, depthWrite: false, roughness: 0.15, metalness: 0.2, envMapIntensity: 0.7 }));
  shelf.renderOrder = -5; shelf.position.set(0, -1.4, -3); shelf.receiveShadow = true; g.add(shelf);
  /* violet crystal clusters framing the board and the far shelf */
  let cr = [];
  [[-5.4, -8, 7, 1.8], [5.6, -8.5, 8, 2.1], [-2.6, -12.5, 4, 1.2], [3.4, -14, 5, 1.6], [-8, -13, 6, 2.4], [8.6, -14, 6, 2.6], [-7.5, -3, 5, 1.6], [7.8, -3.5, 5, 1.7]].forEach(c => { cr = cr.concat(crystalGeo(r, c[0], c[1], c[2], c[3])); });
  const crys = new THREE.Mesh(mergeNonIndexed(cr), new THREE.MeshPhysicalMaterial({ color: 0x5e5aa8, emissive: 0x2a1a70, emissiveIntensity: 0.35, roughness: 0.12, metalness: 0.1, clearcoat: 1, flatShading: true, envMapIntensity: 1.3 }));
  crys.position.y = -0.8; crys.castShadow = false; g.add(crys);
  const glints = [];
  [[-5.6, -8.5], [5.8, -9], [-8.5, -14], [9.5, -15]].forEach(p2 => { const pl = new THREE.PointLight(0x9a7bff, 3.5, 6, 2); pl.position.set(p2[0], 0.6, p2[1] + 1); if (glints.length < 2) g.add(pl); glints.push(pl); });
  return { group: g, sky, fog: [0x0a1530, 20, 75], hemi: [0x8fb0ff, 0x0b1430, 1.0], key: [0xdcebff, 2.4], rim: [0x7fffd0, 1.8], bloom: [0.8, 0.35, 1], exposure: 1.12, tint: 0x02061a, vig: 0.5, snow: true,
    update(t) { glints.forEach((l, i) => { l.intensity = 3.5 + Math.sin(t * 1.3 + i * 2) * 0.8; }); } };
}

function sceneryOrbit(V) {
  const g = new THREE.Group(), r = rnd(73);
  /* deep space: dark nebula and stars on a portrait card (scene background) */
  const sk = lo() ? 0.5 : 1;
  const sky = canvasTex(512 * sk, 1024 * sk, (x) => {
    const w = 512, h = 1024; x.scale(sk, sk);
    const bg = x.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#020309'); bg.addColorStop(0.3, '#070a1c'); bg.addColorStop(0.55, '#0a0c24'); bg.addColorStop(1, '#03040b'); x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'lighter';
    [[0.78, 0.18, '110,60,220', 0.22, 0.45], [0.15, 0.3, '30,120,170', 0.14, 0.4], [0.6, 0.08, '200,60,150', 0.08, 0.3]].forEach(n => { const gg = x.createRadialGradient(w * n[0], h * n[1], 0, w * n[0], h * n[1], w * n[4]); gg.addColorStop(0, `rgba(${n[2]},${n[3]})`); gg.addColorStop(1, `rgba(${n[2]},0)`); x.fillStyle = gg; x.fillRect(0, 0, w, h); });
    x.globalCompositeOperation = 'source-over';
    const pr = rnd(4); for (let i = 0; i < 520; i++) { x.fillStyle = `rgba(${pr() < 0.2 ? '200,210,255' : '255,255,255'},${0.15 + pr() * 0.6})`; const z = 0.6 + pr() * 1.3; x.fillRect(pr() * w, pr() * h, z, z * 0.5); }
  });
  /* the ringed planet sits low in the camera's sky band (25 deg down, 8 deg left, 10 deg across) */
  const D = 64, dep = 25 * Math.PI / 180, az = -9 * Math.PI / 180, PR = D * Math.sin(10.5 * Math.PI / 180);
  const pc = new THREE.Vector3(RIG.cam.x + D * Math.cos(dep) * Math.sin(az), RIG.cam.y - D * Math.sin(dep), RIG.cam.z - D * Math.cos(dep) * Math.cos(az));
  const planetTex = canvasTex(512, 256, (x, w, h) => {
    const gg = x.createLinearGradient(0, 0, 0, h); ['#2a2f5a', '#4a4f86', '#3a3a6e', '#6a5e96', '#4c4a80', '#2e3466', '#5a5890', '#383a70', '#22264a'].forEach((c, i, a) => gg.addColorStop(i / (a.length - 1), c)); x.fillStyle = gg; x.fillRect(0, 0, w, h);
    const pr = rnd(8); for (let i = 0; i < 46; i++) { x.fillStyle = `rgba(${pr() < 0.5 ? '20,18,50' : '170,160,220'},${0.05 + pr() * 0.1})`; const y = pr() * h; x.fillRect(0, y, w, 1 + pr() * 5); }
    x.fillStyle = 'rgba(190,150,200,0.25)'; x.beginPath(); x.ellipse(w * 0.62, h * 0.6, 26, 10, 0, 0, TAU); x.fill();
  });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(PR, lo() ? 28 : 48, lo() ? 18 : 32), new THREE.MeshStandardMaterial({ map: planetTex, color: 0xb8b8c8, roughness: 0.95, envMapIntensity: 0.2 }));
  planet.position.copy(pc); planet.rotation.z = 0.32; g.add(planet);
  /* thin atmosphere halo behind the planet */
  const atmT = canvasTex(128, 128, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, w * 0.36, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(255,255,255,0)'); gg.addColorStop(0.08, 'rgba(255,255,255,0.8)'); gg.addColorStop(0.35, 'rgba(255,255,255,0.18)'); gg.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); }, false);
  const atm = new THREE.Sprite(new THREE.SpriteMaterial({ map: atmT, color: new THREE.Color(0x7a8cff).multiplyScalar(0.55), blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  atm.scale.setScalar(PR * 2.78); atm.position.copy(pc).addScaledVector(tmpV.copy(pc).sub(RIG.cam).normalize(), PR * 1.2); atm.renderOrder = -8; g.add(atm);
  const ringTex = canvasTex(256, 4, (x, w, h) => { const pr = rnd(3); for (let i = 0; i < w; i++) { const u = i / w, a = (u > 0.06 && u < 0.94 ? 0.16 + 0.34 * Math.abs(Math.sin(i * 0.11)) * (0.6 + pr() * 0.4) : 0) * (u > 0.55 && u < 0.6 ? 0.15 : 1); x.fillStyle = `rgba(200,190,230,${a})`; x.fillRect(i, 0, 1, h); } });
  const ringGeo = new THREE.RingGeometry(PR * 1.3, PR * 2.2, 128, 1); const rp = ringGeo.attributes.position, ruv = ringGeo.attributes.uv; for (let i = 0; i < rp.count; i++) { const d = Math.hypot(rp.getX(i), rp.getY(i)); ruv.setXY(i, (d - PR * 1.3) / (PR * 0.9), 0.5); }
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: ringTex, color: 0x8a86b0, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }));
  ring.position.copy(pc); ring.rotation.set(-Math.PI / 2 + 0.42, 0.28, 0); g.add(ring);
  /* the station: a far ring with spokes and lights, merged, turning slowly */
  const station = new THREE.Group(), stMat = new THREE.MeshStandardMaterial({ color: 0x4a5288, metalness: 0.8, roughness: 0.4 });
  const sp = [new THREE.TorusGeometry(6, 0.32, 10, 72), new THREE.CylinderGeometry(0.9, 0.9, 1.4, 20).rotateX(Math.PI / 2)];
  for (let i = 0; i < 4; i++) sp.push(new THREE.CylinderGeometry(0.1, 0.1, 12, 6).rotateZ(i / 4 * Math.PI));
  station.add(new THREE.Mesh(mergeGeos(sp), stMat));
  const stl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 16);
  for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; tmpM.makeTranslation(Math.cos(a) * 6, Math.sin(a) * 6, 0.35); stl.setMatrixAt(i, tmpM); stl.setColorAt(i, tmpC.set(i % 2 ? 0x8ee8ff : 0xffc890).multiplyScalar(1.4)); }
  station.add(stl); station.scale.setScalar(0.75);
  const sd = 95, sdep = 12 * Math.PI / 180, saz = 7 * Math.PI / 180;
  station.position.set(RIG.cam.x + sd * Math.cos(sdep) * Math.sin(saz), RIG.cam.y - sd * Math.sin(sdep), RIG.cam.z - sd * Math.cos(sdep) * Math.cos(saz));
  station.rotation.set(-0.9, -0.35, 0); g.add(station);
  /* docking pylons flanking the deck: trusses rising out of the void, nav lights on top (merged + instanced) */
  const py = [];
  [[-6.6, -7.2], [6.8, -7.8], [-3.8, -12.5], [4.2, -13]].forEach((q, k) => {
    const H = k < 2 ? 12 : 10, top = k < 2 ? 1.6 : 2.6;
    [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]].forEach(o => py.push(new THREE.BoxGeometry(0.1, H, 0.1).translate(q[0] + o[0], top - H / 2, q[1] + o[1])));
    for (let y = top - H; y < top; y += 1.1) { py.push(new THREE.BoxGeometry(0.74, 0.06, 0.06).translate(q[0], y, q[1] - 0.32)); py.push(new THREE.BoxGeometry(0.06, 0.06, 0.74).translate(q[0] - 0.32, y, q[1])); py.push(new THREE.BoxGeometry(0.06, 0.06, 0.74).translate(q[0] + 0.32, y, q[1])); }
    py.push(new THREE.CylinderGeometry(0.5, 0.42, 0.24, 12).translate(q[0], top + 0.12, q[1]));
  });
  const pyl = new THREE.Mesh(mergeGeos(py), new THREE.MeshStandardMaterial({ color: 0x2c3260, metalness: 0.75, roughness: 0.4 })); g.add(pyl);
  const nav = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 4);
  [[-6.6, 1.88, -7.2], [6.8, 1.88, -7.8], [-3.8, 2.88, -12.5], [4.2, 2.88, -13]].forEach((q, i) => { tmpM.makeTranslation(q[0], q[1], q[2]); nav.setMatrixAt(i, tmpM); nav.setColorAt(i, tmpC.set(0)); });
  g.add(nav);
  const navCol = [0xff3a5a, 0x3aff9a, 0xff3a5a, 0x3aff9a];
  /* a soft engine glow under the floating deck */
  const glow = new THREE.Mesh(new THREE.CircleGeometry(V.edge * 0.9, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5a46c8, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.y = -1.05; g.add(glow);
  const dust = motes(120, [-10, 10], [-2, 6], [-16, 2], 0x9ab8ff, 0.06, 77); g.add(dust);
  return { group: g, sky, fog: null, hemi: [0xa8b0ff, 0x0c0a24, 0.6], key: [0xe8e8ff, 2.2], rim: [0x9a8cff, 2.6], bloom: [0.8, 0.35, 1], exposure: 1.1, tint: 0x03041a, vig: 0.5, fillGlow: 0x6a50ff,
    update(t) {
      station.rotation.z = t * 0.06; planet.rotation.y = t * 0.01;
      for (let i = 0; i < 4; i++) nav.setColorAt(i, tmpC.set(navCol[i]).multiplyScalar(((t * 0.8 + i * 0.27) % 1) < 0.18 ? 3 : 0.25));
      nav.instanceColor.needsUpdate = true; stepMotes(dust, t);
    } };
}

function sceneryCarnival(V) {
  const g = new THREE.Group(), r = rnd(91), SQ = 2.3;
  const sky = new THREE.Color(0x05030a);
  /* the far fairground: purple night, warm horizon glow, roller coaster, tents and trees as silhouettes */
  g.add(backdrop((x, w, h, hz) => {
    const pr = rnd(92);
    const sg = x.createLinearGradient(0, 0, 0, h); sg.addColorStop(0, '#05030b'); sg.addColorStop(0.3, '#120822'); sg.addColorStop(0.5, '#2a1238'); sg.addColorStop(0.6, '#3a1a3c'); sg.addColorStop(1, '#0c0610'); x.fillStyle = sg; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 420; i++) { x.fillStyle = `rgba(240,225,255,${0.12 + pr() * 0.5})`; const z = 0.8 + pr() * 1.2; x.fillRect(pr() * w, pr() * h * 0.45, z, z * 0.6); }
    /* moon */
    x.save(); x.translate(w * 0.44, h * 0.24); x.scale(1, SQ); const mg = x.createRadialGradient(0, 0, 10, 0, 0, 70); mg.addColorStop(0, 'rgba(255,230,220,0.18)'); mg.addColorStop(1, 'rgba(255,230,220,0)'); x.fillStyle = mg; x.fillRect(-70, -70, 140, 140); x.fillStyle = '#c9bcc8'; x.beginPath(); x.arc(0, 0, 13, 0, TAU); x.fill(); x.fillStyle = '#120822'; x.beginPath(); x.arc(5, -3, 12, 0, TAU); x.fill(); x.restore();
    const hzY = h * 0.6, glow = x.createLinearGradient(0, hzY - 160, 0, hzY); glow.addColorStop(0, 'rgba(255,120,120,0)'); glow.addColorStop(1, 'rgba(255,130,110,0.2)'); x.fillStyle = glow; x.fillRect(0, hzY - 160, w, 160);
    /* roller coaster: a lattice hill line with posts */
    x.strokeStyle = '#1a0c20'; x.fillStyle = '#1a0c20'; x.lineWidth = 5; x.beginPath();
    const cy = u => hzY - 60 - 90 * Math.max(0, Math.sin(u * 9)) - 40 * Math.max(0, Math.sin(u * 23 + 1));
    for (let px = 0; px <= w; px += 6) { const yy = cy(px / w); px ? x.lineTo(px, yy) : x.moveTo(px, yy); } x.stroke();
    x.lineWidth = 2; for (let px = 0; px <= w; px += 22) { const yy = cy(px / w); x.beginPath(); x.moveTo(px, yy); x.lineTo(px, hzY); x.stroke(); x.beginPath(); x.moveTo(px, yy); x.lineTo(px + 22, hzY); x.stroke(); }
    /* tents, booths and trees along the horizon, a few warm windows */
    for (let i = 0; i < 30; i++) { const tx = pr() * w, tw = 30 + pr() * 60, th = 30 + pr() * 50; x.fillStyle = '#140a1a'; x.beginPath(); x.moveTo(tx - tw / 2, hzY); x.lineTo(tx - tw / 2, hzY - th * 0.5); x.lineTo(tx, hzY - th); x.lineTo(tx + tw / 2, hzY - th * 0.5); x.lineTo(tx + tw / 2, hzY); x.fill(); if (pr() < 0.6) { x.fillStyle = `rgba(255,${170 + pr() * 60},110,${0.35 + pr() * 0.3})`; x.fillRect(tx - 4, hzY - th * 0.32, 8, th * 0.32); } }
    for (let i = 0; i < 40; i++) { const tx = pr() * w, tr = 14 + pr() * 22; x.fillStyle = '#0c0610'; x.beginPath(); x.ellipse(tx, hzY - tr * SQ * 0.5, tr, tr * SQ * 0.55, 0, 0, TAU); x.fill(); }
    for (let i = 0; i < 200; i++) { x.fillStyle = pr() < 0.5 ? 'rgba(255,220,140,0.6)' : 'rgba(255,130,210,0.5)'; x.fillRect(pr() * w, hzY - 8 - pr() * 60, 2, 2); }
    x.fillStyle = '#0c0610'; x.fillRect(0, hzY, w, h - hzY);
  }));
  /* the fair ground: dark boardwalk planks */
  const groundTex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#1a0f16'; x.fillRect(0, 0, w, h); const rr = rnd(3); for (let j = 0; j < 8; j++) { x.fillStyle = `rgba(${rr() < 0.5 ? '255,220,220' : '0,0,0'},${0.02 + rr() * 0.04})`; x.fillRect(0, j * 32 + 2, w, 28); x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(0, j * 32, w, 2); x.fillRect(rr() * w, j * 32, 2, 32); } });
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping; groundTex.repeat.set(16, 7);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 28).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.75, envMapIntensity: 0.4 }));
  ground.position.set(0, -0.7, -6); ground.receiveShadow = true; g.add(ground);
  /* Ferris wheel (frame merged, turning), lit rim bulbs and swinging cabins, sized to sit inside the camera's band */
  const WX = -4.2, WY = 2.7, WZ = -15, R = 2.9, wMat = new THREE.MeshStandardMaterial({ color: 0x3a2048, metalness: 0.7, roughness: 0.4 });
  const wg = [new THREE.TorusGeometry(R, 0.07, 6, 64).translate(0, 0, -0.32), new THREE.TorusGeometry(R, 0.07, 6, 64).translate(0, 0, 0.32), new THREE.TorusGeometry(R * 0.45, 0.04, 6, 40), new THREE.CylinderGeometry(0.3, 0.3, 0.8, 16).rotateX(Math.PI / 2)];
  for (let i = 0; i < 12; i++) wg.push(new THREE.CylinderGeometry(0.03, 0.03, R * 2, 4).rotateZ(i / 12 * Math.PI));
  const wheel = new THREE.Mesh(mergeGeos(wg), wMat); wheel.position.set(WX, WY, WZ); g.add(wheel);
  const wb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, lo() ? 5 : 8, lo() ? 3 : 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), 36);
  for (let i = 0; i < 36; i++) { const a = i / 36 * TAU; tmpM.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, 0.36); wb.setMatrixAt(i, tmpM); wb.setColorAt(i, tmpC.set(0)); }
  wheel.add(wb);
  const cabGeo = new RoundedBoxGeometry(0.55, 0.48, 0.5, 2, 0.08).translate(0, -0.3, 0), cab = new THREE.InstancedMesh(cabGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }), 8);
  const cabCol = [0x7a2a40, 0x3a4a80, 0xa08050, 0x6a3a7a]; for (let i = 0; i < 8; i++) cab.setColorAt(i, tmpC.set(cabCol[i % 4])); cab.frustumCulled = false; g.add(cab);
  /* static dark structure, merged: wheel legs, light poles, string wires, tent poles */
  const st = [], str = [];
  [-1, 1].forEach(sd => st.push(new THREE.CylinderGeometry(0.09, 0.13, WY + 0.9, 6).rotateZ(sd * 0.3).translate(WX + sd * (WY + 0.7) * Math.sin(0.3) / 2, (WY - 0.7) / 2, WZ - 0.5), new THREE.CylinderGeometry(0.09, 0.13, WY + 0.9, 6).rotateZ(sd * 0.3).translate(WX + sd * (WY + 0.7) * Math.sin(0.3) / 2, (WY - 0.7) / 2, WZ + 0.5)));
  const poles = [[-7.6, -6.8], [-1.2, -10.5], [7.8, -7.4], [2.4, -16]];
  poles.forEach(q => st.push(new THREE.CylinderGeometry(0.06, 0.08, 5, 6).translate(q[0], 1.8, q[1])));
  [[0, 1], [1, 2], [1, 3]].forEach(([i, j]) => { const A = poles[i], Bq = poles[j]; let prev = null; for (let k = 0; k <= 16; k++) { const u = k / 16, p = new THREE.Vector3(A[0] + (Bq[0] - A[0]) * u, 4.25 - Math.sin(u * Math.PI) * 1.0, A[1] + (Bq[1] - A[1]) * u); if (k > 0 && k < 16) str.push([p.x, p.y - 0.1, p.z, k % 3]); if (prev) { const d = p.clone().sub(prev), L = d.length(), c = new THREE.CylinderGeometry(0.012, 0.012, L, 3); c.applyQuaternion(tmpQ.setFromUnitVectors(Y_AXIS, d.normalize())); c.translate((p.x + prev.x) / 2, (p.y + prev.y) / 2, (p.z + prev.z) / 2); st.push(c); } prev = p; } });
  g.add(new THREE.Mesh(mergeGeos(st), new THREE.MeshStandardMaterial({ color: 0x24142c, metalness: 0.5, roughness: 0.6 })));
  const sb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, lo() ? 5 : 8, lo() ? 3 : 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), str.length);
  str.forEach((q, i) => { tmpM.makeTranslation(q[0], q[1], q[2]); sb.setMatrixAt(i, tmpM); sb.setColorAt(i, tmpC.set(0)); }); g.add(sb);
  /* the big top and a small booth: striped canvas (muted), merged, with glowing doorways */
  const stripe = canvasTex(256, 64, (x, w, h) => { for (let i = 0; i < 16; i++) { x.fillStyle = i % 2 ? '#8a7866' : '#6a2238'; x.fillRect(i * 16, 0, 16, h); } x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, h - 8, w, 8); });
  stripe.wrapS = THREE.RepeatWrapping;
  const tents = [[4.7, -14.8, 1.75], [-8.4, -9.4, 1.2]], tg = [], dg = [];
  tents.forEach(([tx, tz, tr]) => {
    tg.push(new THREE.CylinderGeometry(tr, tr, tr * 1.1, 24, 1, true).translate(tx, -0.7 + tr * 0.55, tz));
    tg.push(new THREE.ConeGeometry(tr * 1.12, tr * 1.25, 24, 1, true).translate(tx, -0.7 + tr * 1.1 + tr * 0.62, tz));
    dg.push(new THREE.PlaneGeometry(tr * 0.55, tr * 0.8).translate(tx, -0.7 + tr * 0.4, tz + tr + 0.02));
  });
  g.add(new THREE.Mesh(mergeGeos(tg), new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.85, side: THREE.DoubleSide })));
  g.add(new THREE.Mesh(mergeGeos(dg), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd08850).multiplyScalar(0.8) })));
  const pl1 = new THREE.PointLight(0xffa860, 10, 9, 2); pl1.position.set(4.7, 0.6, -12.4); g.add(pl1);
  const pl2 = new THREE.PointLight(0xff6ad0, 8, 12, 2); pl2.position.set(WX, WY, WZ + 2); g.add(pl2);
  const pl3 = new THREE.PointLight(0xffd090, 6, 10, 2); pl3.position.set(-1.2, 3.4, -8.5); g.add(pl3);
  const flies = motes(40, [-9, 9], [0, 4], [-15, -4], 0xffd890, 0.08, 93); g.add(flies);
  return { group: g, sky, fog: [0x12081a, 20, 64], hemi: [0xd0a0ff, 0x1a0c20, 0.6], key: [0xffe8d0, 2.1], rim: [0xff8ad0, 2.4], bloom: [0.8, 0.35, 1], exposure: 1.1, tint: 0x07020c, vig: 0.5, bulbs: true,
    update(t) {
      const a = t * 0.15; wheel.rotation.z = a;
      for (let i = 0; i < 8; i++) { const ang = i / 8 * TAU + a; tmpQ.setFromAxisAngle(Z_AXIS, Math.sin(t * 1.3 + i) * 0.06); tmpM.compose(tmpV.set(WX + Math.cos(ang) * R, WY + Math.sin(ang) * R, WZ + 0.45), tmpQ, tmpS.setScalar(1)); cab.setMatrixAt(i, tmpM); }
      cab.instanceMatrix.needsUpdate = true;
      const step = Math.floor(t * 4);
      for (let i = 0; i < 36; i++) wb.setColorAt(i, tmpC.set(i % 2 ? 0xffd890 : 0xff7ad0).multiplyScalar((i + step) % 3 ? 1.6 : 0.3));
      wb.instanceColor.needsUpdate = true;
      for (let i = 0; i < str.length; i++) sb.setColorAt(i, tmpC.set(str[i][3] ? 0xffd890 : 0xff8ad0).multiplyScalar((i + step) % 4 === 0 ? 0.35 : 1.5));
      sb.instanceColor.needsUpdate = true; stepMotes(flies, t);
    } };
}
const SCENERY = { neon: sceneryNeon, lava: sceneryLava, gear: sceneryGear, frost: sceneryFrost, orbit: sceneryOrbit, carnival: sceneryCarnival };

function setArena(g) {
  const A = g.arena, V = G_API.V3;
  const key = A.id + (lo() ? ':lo' : '');
  if (curArena && curArena.key === key && curArena.edge === V.edge) return;
  if (curArena) { scene.remove(curArena.root); }
  let pack = arenaCache[key];
  if (!pack) {
    const core = buildArenaCore(V, A);
    const sc = (SCENERY[A.id] || sceneryNeon)(V);
    const root = new THREE.Group(); root.add(core.grp); root.add(sc.group);
    root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o !== core.floor) { if (o.castShadow === undefined) o.castShadow = false; } });
    pack = arenaCache[key] = { id: A.id, key, edge: V.edge, root, core, sc };
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
  bloomPass.strength = sc.bloom[0] * 0.75; bloomPass.radius = Math.min(0.4, sc.bloom[1]); bloomPass.threshold = 1.35; /* above the bar cores' own luminance: cores stay exact, halos and tips bloom */
  gradePass.uniforms.uTint.value.set(sc.tint || 0x000000); gradePass.uniforms.uVig.value = sc.vig !== undefined ? sc.vig : 0.45;
  renderer.toneMappingExposure = (sc.exposure || 1) * 0.9;
  runnerPool.forEach(rn => { scene.remove(rn.root); }); runnerPool = [];
  RIM.color.value.set(V.T.rimLight); FX.dust.set(DUST[A.id] || 0xdfe4ff);
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
  const m = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, lo() ? 5 : 10, lo() ? 3 : 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 40);
  m.userData.R = V.edge - 0.14; return m;
}

/* ---------- runners ---------- */
const RIM = { color: { value: new THREE.Color(0x6fd6ff) }, strength: { value: 0.55 } };
function addRim(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = RIM.color; sh.uniforms.uRimStrength = RIM.strength;
    sh.fragmentShader = 'uniform vec3 uRimColor;\nuniform float uRimStrength;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n{ float rimF = 1.0 - saturate( abs( dot( normal, normalize( vViewPosition ) ) ) ); totalEmissiveRadiance += uRimColor * pow( rimF, 2.6 ) * uRimStrength;\n' +
      '  float upF = dot( normal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ); diffuseColor.rgb *= mix( 0.42, 1.0, smoothstep( -0.75, 0.3, upF ) ); }');
  };
  mat.customProgramCacheKey = () => 'rim';
  return mat;
}
const FACE = {};
function faceTextures() {
  /* big glossy toy eyes set close together, small mouth, blush; drawn once per expression */
  const k = lo() ? 0.5 : 1;
  const mk = (kind) => canvasTex(512 * k, 360 * k, (x) => {
    const w = 512, h = 360; x.scale(k, k);
    x.clearRect(0, 0, w, h);
    const ex = [w / 2 - 92, w / 2 + 92], ey = h * 0.36, RX = 70, RY = 88, ink = '#15112a';
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.fillStyle = 'rgba(255,92,140,0.38)';
    ex.forEach((cx, i) => { x.beginPath(); x.ellipse(cx + (i ? 50 : -50), ey + 116, 38, 16, 0, 0, TAU); x.fill(); });
    ex.forEach((cx, i) => {
      if (kind === 'open' || kind === 'up') {
        x.fillStyle = ink; x.beginPath(); x.ellipse(cx, ey, RX + 7, RY + 7, 0, 0, TAU); x.fill();
        const g = x.createLinearGradient(0, ey - RY, 0, ey + RY); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#dfe3f2');
        x.fillStyle = g; x.beginPath(); x.ellipse(cx, ey, RX, RY, 0, 0, TAU); x.fill();
        const py = kind === 'up' ? ey - 20 : ey + 8, px = cx + (i ? -6 : 6);
        x.fillStyle = ink; x.beginPath(); x.ellipse(px, py, RX * 0.68, RY * 0.7, 0, 0, TAU); x.fill();
        x.fillStyle = 'rgba(80,90,160,0.55)'; x.beginPath(); x.ellipse(px, py + RY * 0.34, RX * 0.42, RY * 0.22, 0, 0, TAU); x.fill();
        x.fillStyle = '#ffffff'; x.beginPath(); x.ellipse(px - 17, py - 27, 18, 22, -0.4, 0, TAU); x.fill();
        x.beginPath(); x.arc(px + 19, py + 22, 8, 0, TAU); x.fill();
      } else if (kind === 'blink') {
        x.strokeStyle = ink; x.lineWidth = 14; x.beginPath(); x.moveTo(cx - 40, ey + 6); x.quadraticCurveTo(cx, ey + 26, cx + 40, ey + 6); x.stroke();
      } else if (kind === 'happy') {
        x.strokeStyle = ink; x.lineWidth = 16; x.beginPath(); x.moveTo(cx - 40, ey + 16); x.quadraticCurveTo(cx, ey - 36, cx + 40, ey + 16); x.stroke();
      } else if (kind === 'stun') {
        x.strokeStyle = ink; x.lineWidth = 15; x.beginPath(); x.moveTo(cx - 30, ey - 30); x.lineTo(cx + 30, ey + 30); x.moveTo(cx + 30, ey - 30); x.lineTo(cx - 30, ey + 30); x.stroke();
      }
    });
    const my = ey + 128;
    x.fillStyle = ink; x.strokeStyle = ink;
    if (kind === 'happy') {
      x.beginPath(); x.moveTo(w / 2 - 34, my - 10); x.quadraticCurveTo(w / 2, my + 52, w / 2 + 34, my - 10); x.closePath(); x.fill();
      x.fillStyle = '#ff6f8e'; x.beginPath(); x.ellipse(w / 2, my + 14, 15, 9, 0, 0, TAU); x.fill();
    } else if (kind === 'stun') {
      x.lineWidth = 9; x.beginPath(); x.moveTo(w / 2 - 34, my); for (let k = 0; k < 4; k++) x.quadraticCurveTo(w / 2 - 26 + k * 17, my + (k % 2 ? 12 : -12), w / 2 - 17 + k * 17, my); x.stroke();
    } else if (kind === 'up') {
      x.beginPath(); x.ellipse(w / 2, my + 4, 14, 17, 0, 0, TAU); x.fill();
    } else {
      x.lineWidth = 10; x.beginPath(); x.moveTo(w / 2 - 22, my - 2); x.quadraticCurveTo(w / 2, my + 18, w / 2 + 22, my - 2); x.stroke();
    }
  });
  ['open', 'blink', 'happy', 'stun', 'up'].forEach(k => { FACE[k] = mk(k); });
}
function surfaceZ(shape, x, y) {
  const ax = Math.abs(x);
  if (shape === 'square') return ax <= 0.17 ? 0.37 : 0.17 + Math.sqrt(Math.max(0, 0.04 - (ax - 0.17) * (ax - 0.17)));
  if (shape === 'star') return 0.215;
  if (shape === 'diamond') { const r = y < 0.56 ? 0.06 + 0.44 * Math.max(0, y - 0.01) / 0.55 : y > 0.64 ? 0.5 - 0.44 * Math.min(1, (y - 0.64) / 0.51) : 0.5; return r * 0.7071; }
  if (shape === 'triangle') { const r = 0.5 + (0.14 - 0.5) * Math.min(1, Math.max(0, (y - 0.2) / 0.86)); return Math.sqrt(Math.max(0.0004, r * r - x * x)); }
  const r = beanR(y);
  return Math.sqrt(Math.max(0.0004, r * r - x * x));
}
const FACEGEO = {};
function faceGeo(shape, ey) {
  const fk = shape + (lo() ? ':lo' : '');
  if (FACEGEO[fk]) return FACEGEO[fk];
  const g = new THREE.PlaneGeometry(0.74, 0.52, lo() ? 10 : 24, lo() ? 7 : 16), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i) + ey; p.setXYZ(i, x, y, surfaceZ(shape, x, y) + 0.012); }
  g.computeVertexNormals(); g.userData.shared = true;
  return (FACEGEO[fk] = g);
}
function shapeInfo(shape) {
  return {
    round: { top: 1.14, ey: 0.68, sh: 0.42, shy: 0.46 },
    square: { top: 1.12, ey: 0.76, sh: 0.38, shy: 0.5 },
    triangle: { top: 1.18, ey: 0.5, sh: 0.4, shy: 0.36 },
    diamond: { top: 1.16, ey: 0.64, sh: 0.45, shy: 0.52 },
    star: { top: 1.24, ey: 0.64, sh: 0.36, shy: 0.5 }
  }[shape] || { top: 1.14, ey: 0.68, sh: 0.42, shy: 0.46 };
}
function makeRunner(p) {
  const shape = p.shape || 'round', acc = p.skin ? p.skin.acc : 'none', info = shapeInfo(shape);
  const root = new THREE.Group(), lean = new THREE.Group(), body = new THREE.Group(); root.add(lean); lean.add(body);
  /* candy vinyl: pastel game colours pushed to saturated toy colours, clear coat on High */
  const bc = new THREE.Color(p.color), hsl = {}; bc.getHSL(hsl); bc.setHSL(hsl.h, Math.min(1, hsl.s * 1.5 + 0.08), Math.min(0.62, hsl.l * 0.82));
  const flat = shape === 'diamond';
  const mat = addRim(quality.level >= 2
    ? new THREE.MeshPhysicalMaterial({ color: bc, roughness: 0.45, clearcoat: 0.85, clearcoatRoughness: 0.14, envMapIntensity: 0.9, flatShading: flat })
    : new THREE.MeshStandardMaterial({ color: bc, roughness: 0.3, envMapIntensity: 0.8, flatShading: flat }));
  const GS = geoSet(), mesh = new THREE.Mesh(GS[shape] || GS.round, mat); mesh.castShadow = true; body.add(mesh);
  /* only the player's runner gets an outline: a gold one */
  if (p.you) { const hull = new THREE.Mesh(GS[shape] || GS.round, MAT.youHull); hull.scale.set(1.075, 1.04, 1.075); hull.position.y = -0.025; body.add(hull); }
  const faceMat = new THREE.MeshBasicMaterial({ map: FACE.open, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const face = new THREE.Mesh(faceGeo(shape, info.ey), faceMat); face.renderOrder = 2; body.add(face);
  const top = info.top;
  if (acc === 'visor') {
    face.visible = false;
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.17, 16, 2), MAT.visor); const vp = v.geometry.attributes.position;
    for (let i = 0; i < vp.count; i++) { const x = vp.getX(i), y = vp.getY(i) + info.ey; vp.setXYZ(i, x, y, surfaceZ(shape, x, y) + 0.025); }
    v.geometry.computeVertexNormals(); body.add(v);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.02), MAT.ring); strip.position.set(-0.07, info.ey + 0.03, surfaceZ(shape, -0.07, info.ey) + 0.04); body.add(strip);
  } else if (acc === 'spots') {
    [[0.22, 0.42], [-0.24, 0.3], [0.08, 0.24], [-0.3, 0.62]].forEach(sp => { const z = surfaceZ(shape, sp[0], sp[1]); const m = new THREE.Mesh(GEO.spot, MAT.spot); m.position.set(sp[0], sp[1], z - 0.02); m.scale.set(1, 1, 0.4); m.lookAt(sp[0] * 4, sp[1], z * 4); body.add(m); });
  } else if (acc === 'crown') {
    const c = new THREE.Group(); c.add(new THREE.Mesh(GEO.crownBand, MAT.gold));
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, sp = new THREE.Mesh(GEO.spike, MAT.gold); sp.position.set(Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2); c.add(sp); }
    [[MAT.gemR, -0.5], [MAT.gemB, 0], [MAT.gemG, 0.5]].forEach(gm => { const m = new THREE.Mesh(GEO.gem, gm[0]); m.position.set(Math.sin(gm[1]) * 0.215, 0, Math.cos(gm[1]) * 0.215); c.add(m); });
    c.position.y = top; body.add(c);
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
  const bubble = new THREE.Mesh(GEO.bubble, MAT.bubble); bubble.position.y = 0.62; bubble.visible = false; body.add(bubble);
  const stars = [0, 1, 2].map(() => { const s = new THREE.Mesh(GEO.smallStar, MAT.star); s.visible = false; body.add(s); return s; });
  scene.add(root);
  return {
    root, lean, body, mesh, mat, face, faceMat, bubble, stars, top, shape, info, sig: sigOf(p),
    limbCol: bc.clone().multiplyScalar(0.92), soleCol: bc.clone().multiplyScalar(0.8), armZ: 0.55, armX: [0, 0],
    sq: 1, sqv: 0, tilt: 0, tiltv: 0, spin: 0, hop: 0, hopv: 0, st: { stun: -9, air: -9, out: false, duck: -9 },
    blinkAt: 1 + Math.random() * 3, faceKind: 'open', happyUntil: -9, fly: null, lastStep: 0, lastT: null
  };
}
function sigOf(p) { return (p.shape || 'round') + '|' + (p.skin ? p.skin.acc : 'none') + '|' + p.color + '|' + (p.you ? 1 : 0) + (lo() ? '|lo' : ''); }
function jumpH(u) { u = Math.min(1, Math.max(0, u)); return 1 - Math.pow(Math.abs(2 * u - 1), 2.4); }
function setFace(rn, k) { if (rn.faceKind !== k) { rn.faceKind = k; rn.faceMat.map = FACE[k]; } }

function updateRunner(rn, p, i, g, V, now, dt) {
  const t = g.t, JT = g.arena.jumpT;
  const R = V.TR + (G_API.runnerR(p) - V.mid) * V.SC, f = p.angle + g.rot;
  let x = R * Math.cos(f), z = R * Math.sin(f);
  const fresh = rn.lastT === null || t < rn.lastT - 0.5; rn.lastT = t;
  if (fresh) { rn.st = { stun: p.stun, air: p.air, out: p.out, duck: p.duck }; rn.fly = null; }
  // events
  if (p.out && !rn.st.out) {
    const out = new THREE.Vector3(x, 0, z).normalize();
    rn.fly = { t0: now, x, z, vx: out.x * 3.2, vz: out.z * 3.2, vy: 6.5, spin: (Math.random() < 0.5 ? -1 : 1) * 9 };
    emitDust(x, 0.5, z, 10, p.color, 0.35, 2.4); ringAt(x, z, p.color, 1.6); knockoutFx(x, z, p.color);
  }
  if (!p.out && p.stun > rn.st.stun && t < p.stun) {
    rn.sqv -= 7; rn.tiltv += 10; rn.hopv += 3.2; ringAt(x, z, p.you ? 0xffffff : p.color); hitFx(x, 0.75, z, p.you);
    if (p.you) punch(0.045);
  }
  if (!p.out && p.air > rn.st.air && t < p.air) { rn.sqv += 7; if (p.you || i < 3) emitDust(x, 0.05, z, 4, FX.dust, 0.22, 0.8); }
  if (!p.out && rn.st.air > 0 && t >= rn.st.air && t - rn.st.air < 0.1 && rn.st.airLanded !== rn.st.air) { rn.st.airLanded = rn.st.air; rn.sqv -= 8; emitDust(x, 0.05, z, 6, FX.dust, 0.26, 1.1); }
  if (!p.out && p.duck > rn.st.duck && t < p.duck) { rn.sqv -= 4; }
  rn.st.stun = p.stun; rn.st.air = p.air; rn.st.out = p.out; rn.st.duck = p.duck;

  if (p.out) {
    if (!rn.fly) { rn.root.visible = false; return { x, z, top: 0.2, out: true }; }
    const ft = now - rn.fly.t0;
    if (ft > 1.6) { rn.root.visible = false; return { x, z, top: 0.2, out: true }; }
    rn.root.visible = true;
    rn.root.position.set(rn.fly.x + rn.fly.vx * ft, Math.max(-8, rn.fly.vy * ft - 9 * ft * ft), rn.fly.z + rn.fly.vz * ft);
    rn.body.rotation.z = rn.fly.spin * ft; rn.body.rotation.x = rn.fly.spin * 0.6 * ft;
    rn.body.scale.setScalar(0.85 * Math.max(0.2, 1 - ft * 0.35));
    setFace(rn, 'stun');
    return { x: rn.root.position.x, z: rn.root.position.z, top: rn.root.position.y + 1, out: true };
  }
  rn.root.visible = true;
  rn.body.rotation.set(0, 0, 0);
  let state = 'run', jump = 0;
  if (t < p.stun) state = 'stun';
  else if (t < p.air) { state = 'jump'; jump = jumpH(1 - (p.air - t) / JT) * (JT > 0.6 ? 1.2 : 1.0); }
  else if (t < p.duck) state = 'duck';
  const running = state === 'run' && t >= 0 && !g.over;
  const winning = g.over && g.result === 'win' && p.you;
  if (winning) jump = Math.abs(Math.sin(now * 6)) * 0.6;
  /* a duck pressed in mid-air drops the runner quickly instead of snapping to the floor */
  if (jump >= (rn.jy || 0)) rn.jy = jump; else rn.jy = Math.max(jump, rn.jy - dt * 9);
  jump = rn.jy;
  // springs (squash/stretch, tilt, hop)
  const ph = t * 11 + i * 1.7;
  let sqT = state === 'duck' ? 0.56 : state === 'jump' ? 1.06 : 1;
  if (running) sqT += Math.cos(ph * 2) * 0.035;
  rn.sqv += ((sqT - rn.sq) * 340 - rn.sqv * 16) * dt; rn.sq += rn.sqv * dt; rn.sq = Math.max(0.45, Math.min(1.35, rn.sq));
  rn.tiltv += (-rn.tilt * 220 - rn.tiltv * 9) * dt; rn.tilt += rn.tiltv * dt;
  rn.hopv -= 18 * dt; rn.hop = Math.max(0, rn.hop + rn.hopv * dt); if (rn.hop === 0 && rn.hopv < 0) rn.hopv = 0;
  const S = 0.85, sx = 1 / Math.sqrt(rn.sq);
  const bob = running ? Math.abs(Math.cos(ph)) * 0.05 : 0;
  rn.root.position.set(x, 0, z);
  const hd = Math.atan2(-Math.sin(f), Math.cos(f));
  const cyaw = Math.atan2(RIG.cam.x - x, RIG.cam.z - z);
  let d = hd - cyaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  const yaw = cyaw + d * (HR3D.faceBlend !== undefined ? HR3D.faceBlend : 0.22);
  rn.root.rotation.y = yaw;
  // lean toward running direction (and wobble back after a hit)
  const rel = hd - yaw, leanAmt = (running ? 0.16 : state === 'jump' ? 0.1 : 0) + rn.tilt * -0.35;
  tmpV.set(Math.cos(rel), 0, -Math.sin(rel));
  rn.lean.quaternion.setFromAxisAngle(tmpV, leanAmt);
  rn.body.position.y = LEG + jump + bob + rn.hop;
  rn.body.scale.set(S * sx, S * rn.sq, S * sx);
  if (state === 'stun') rn.body.rotation.y = Math.sin(t * 18) * 0.25;
  const stride = running ? Math.sin(ph) : state === 'jump' ? 0.7 : 0;
  rn.root.updateMatrixWorld(true);
  /* sneakers (instanced across all runners), toes along the running direction */
  for (let k = 0; k < 2; k++) {
    const s = k ? 1 : -1, lift = running ? Math.max(0, s * Math.sin(ph)) * 0.09 : 0;
    const fx = s * 0.19 * S * sx, fz = s * stride * 0.17 * S, cr = Math.cos(rel), srr = Math.sin(rel);
    tmpV.set(fx * cr + fz * srr, lift + jump * 0.85 + rn.hop, -fx * srr + fz * cr).applyMatrix4(rn.root.matrixWorld);
    tmpQ.setFromAxisAngle(Y_AXIS, yaw + rel + (running ? s * Math.cos(ph) * 0.0 : 0));
    tmpQ2.setFromAxisAngle(X_AXIS, running ? -Math.max(0, s * Math.cos(ph)) * 0.35 : state === 'jump' ? 0.3 : 0); tmpQ.multiply(tmpQ2);
    tmpM.compose(tmpV, tmpQ, tmpS.setScalar(S * 1.3));
    partPush('up', tmpM); partPush('sole', tmpM, rn.soleCol);
  }
  /* mitten arms: pump while running, up on a jump, out on a duck, flail when stunned */
  let az = 0.55, axA = 0;
  if (state === 'jump' || winning) { az = 2.45; axA = -0.25; }
  else if (state === 'duck') { az = 1.3; axA = 0.35; }
  else if (state === 'stun') az = 1.8;
  rn.armZ += (az - rn.armZ) * Math.min(1, dt * 16);
  tmpQ3.copy(rn.root.quaternion).multiply(rn.lean.quaternion);
  if (state === 'stun') { tmpQ2.setFromAxisAngle(Y_AXIS, rn.body.rotation.y); tmpQ3.multiply(tmpQ2); }
  for (let k = 0; k < 2; k++) {
    const s = k ? 1 : -1;
    let a = rn.armZ, b = running ? s * stride * 0.95 : axA;
    if (state === 'stun') { a += Math.sin(now * 24 + s * 1.3) * 0.7; b = Math.sin(now * 19 + s) * 0.6; }
    rn.armX[k] += (b - rn.armX[k]) * Math.min(1, dt * 20);
    tmpV.set(s * rn.info.sh, rn.info.shy, 0.02); rn.body.localToWorld(tmpV);
    tmpQ.copy(tmpQ3); tmpQ2.setFromAxisAngle(X_AXIS, rn.armX[k]); tmpQ.multiply(tmpQ2); tmpQ2.setFromAxisAngle(Z_AXIS, s * a); tmpQ.multiply(tmpQ2);
    tmpM.compose(tmpV, tmpQ, tmpS.setScalar(S * (0.94 + 0.06 * rn.sq)));
    partPush('arms', tmpM, rn.limbCol);
  }
  // face
  if (state === 'stun') setFace(rn, 'stun');
  else if (winning || now < rn.happyUntil) setFace(rn, 'happy');
  else if (now > rn.blinkAt) { setFace(rn, 'blink'); if (now > rn.blinkAt + 0.12) rn.blinkAt = now + 1.8 + Math.random() * 3.2; }
  else setFace(rn, state === 'jump' ? 'up' : 'open');
  rn.bubble.visible = p.shield > 0 && p.shield > t && !(p.shield - t < 2 && Math.floor(t * 10) % 2);
  if (rn.bubble.visible) rn.bubble.rotation.y = now;
  rn.stars.forEach((s, k) => { s.visible = state === 'stun'; if (s.visible) { const a = now * 6 + k * TAU / 3; s.position.set(Math.cos(a) * 0.4, rn.top + 0.2 + Math.sin(a * 2) * 0.04, Math.sin(a) * 0.4); s.rotation.y = a; } });
  // contact shadow
  const bs = 1.05 * S * sx * (1 - Math.min(0.55, (jump + rn.hop) * 0.4));
  tmpM.compose(tmpV.set(x, 0.008, z), tmpQ.identity(), tmpS.set(bs, 1, bs)); partPush('blob', tmpM);
  // running dust for your runner
  if (p.you && running && now - rn.lastStep > 0.22) { rn.lastStep = now; emitDust(x, 0.04, z, 1, FX.dust, 0.16, 0.5); }
  return { x, z, top: LEG + rn.top * S * rn.sq + jump + bob + rn.hop + 0.1, out: false };
}

/* ---------- instanced runner parts: every runner's arms, shoes and contact shadow in 4 draw calls ---------- */
const LEG = 0.15;
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpQ2 = new THREE.Quaternion(), tmpQ3 = new THREE.Quaternion();
let PARTS = null;
function makeParts() {
  const cap = 64, white = new THREE.Color(1, 1, 1);
  const mk = (geo, mat, shadow, colored) => {
    const m = new THREE.InstancedMesh(geo, mat, cap); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; m.castShadow = shadow;
    if (colored) for (let i = 0; i < cap; i++) m.setColorAt(i, white);
    scene.add(m); return m;
  };
  const L = lo(), GS = geoSet();
  /* Low: cheaper limbs, and only the bodies cast shadows */
  PARTS = { arms: mk(GS.arm, MAT.limb, !L, true), up: mk(GS.shoeUp, MAT.shoeUp, !L, false), sole: mk(GS.shoeSole, MAT.shoeSole, false, true), blob: mk(GEO.blob, MAT.blob, false, false), n: {}, lo: L };
  PARTS.blob.renderOrder = 1;
}
function partsBegin() { if (PARTS && PARTS.lo !== lo()) { ['arms', 'up', 'sole', 'blob'].forEach(k => { scene.remove(PARTS[k]); PARTS[k].dispose(); }); PARTS = null; } if (!PARTS) makeParts(); PARTS.n = { arms: 0, up: 0, sole: 0, blob: 0 }; }
function partPush(k, m, c) { const im = PARTS[k], i = PARTS.n[k]; if (i >= im.instanceMatrix.count) return; im.setMatrixAt(i, m); if (c) im.setColorAt(i, c); PARTS.n[k] = i + 1; }
function partsEnd() { ['arms', 'up', 'sole', 'blob'].forEach(k => { const im = PARTS[k]; im.count = PARTS.n[k]; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }); }

/* ---------- little effects: dust, hit sparks, knockout confetti, impact rings, camera punch ----------
   Dust, sparks and flashes share one additive instanced puff system; confetti is one instanced mesh. */
let ringPool = [], zoomPunch = 0, fxPuffs, confetti;
const FX = { dust: new THREE.Color(0xdfe4ff) };
/* landing dust per arena: ash in the temple, snow powder on the peak, brass dust in the works... */
const DUST = { neon: 0x9aa0ff, lava: 0x9a6a58, frost: 0xe6f6ff, gear: 0xc8a478, orbit: 0xa8b8ff, carnival: 0xd8b0c0 };
function initFx() {
  for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); m.visible = false; scene.add(m); ringPool.push({ m, life: 0, k: 1 }); }
  fxPuffs = makePuffs(160, softTex()); fxPuffs.renderOrder = 5; scene.add(fxPuffs);
  confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.1, 0.06), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 120);
  confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage); confetti.frustumCulled = false; confetti.count = 0; confetti.setColorAt(0, tmpC.set(0xffffff)); confetti.userData.ps = []; scene.add(confetti);
}
function emitDust(x, y, z, n, color, size, speed) {
  const c = new THREE.Color(color).multiplyScalar(0.32);
  for (let k = 0; k < n; k++) {
    const a = Math.random() * TAU, sp = speed * (0.4 + Math.random() * 0.6);
    puff(fxPuffs, { x, y, z, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 0.4 + Math.random() * 0.8, drag: 4, life: 0.4 + Math.random() * 0.35, size: size * (0.8 + Math.random() * 0.6), grow: 0.8, col: c });
  }
}
/* a hit: a white flash and a spray of hot sparks that fall back */
const SPARK = [new THREE.Color(1, 0.85, 0.5), new THREE.Color(1, 1, 1)];
function hitFx(x, y, z, you) {
  puff(fxPuffs, { x, y, z, life: 0.16, size: you ? 1.1 : 0.8, grow: 0.6, col: new THREE.Color(0.7, 0.7, 0.75) });
  for (let k = 0; k < (you ? 12 : 8); k++) { const a = Math.random() * TAU, sp = 2 + Math.random() * 2.5; puff(fxPuffs, { x, y, z, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 1.5 + Math.random() * 2.5, g: 9, drag: 1.5, life: 0.35 + Math.random() * 0.25, size: 0.07, grow: -0.5, col: SPARK[k % 2] }); }
}
/* a knockout: flash, then confetti in the runner's colour with white and gold */
function knockoutFx(x, z, color) {
  puff(fxPuffs, { x, y: 0.6, z, life: 0.22, size: 1.6, grow: 0.8, col: new THREE.Color(color).multiplyScalar(0.8) });
  const cols = [new THREE.Color(color), new THREE.Color(0xffffff), new THREE.Color(0xffd23f)], ps = confetti.userData.ps;
  for (let k = 0; k < 26 && ps.length < 120; k++) { const a = Math.random() * TAU, sp = 1 + Math.random() * 2.2; ps.push({ x, y: 0.7, z, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 3 + Math.random() * 3, age: 0, life: 1.4 + Math.random() * 0.6, rx: Math.random() * TAU, ry: Math.random() * TAU, sx: (Math.random() - 0.5) * 16, sy: (Math.random() - 0.5) * 12, c: cols[k % 3] }); }
}
function stepConfetti(dt) {
  const ps = confetti.userData.ps; let n = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]; p.age += dt; if (p.age >= p.life) { ps.splice(i--, 1); continue; }
    p.vy -= 7 * dt; const dr = Math.max(0, 1 - 2.2 * dt); p.vx *= dr; p.vz *= dr; if (p.vy < -1.2) p.vy = -1.2;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rx += p.sx * dt; p.ry += p.sy * dt;
    const sc = Math.min(1, (p.life - p.age) * 3);
    tmpQ.setFromEuler(new THREE.Euler(p.rx, p.ry, 0)); tmpM.compose(tmpV.set(p.x, Math.max(0.03, p.y), p.z), tmpQ, tmpS.setScalar(sc));
    confetti.setMatrixAt(n, tmpM); confetti.setColorAt(n, p.c); n++;
  }
  confetti.count = n; confetti.instanceMatrix.needsUpdate = true; if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
}
function ringAt(x, z, color, k = 1) { const r = ringPool.find(o => o.life <= 0); if (!r) return; r.life = 0.4; r.k = k; r.m.position.set(x, 0.03, z); r.m.material.color.set(color); r.m.visible = true; }
function punch(a) { zoomPunch = Math.max(zoomPunch, a); }
function stepFx(dt) {
  stepPuffs(fxPuffs, dt); stepConfetti(dt);
  ringPool.forEach(r => {
    if (r.life <= 0) return;
    r.life -= dt; if (r.life <= 0) { r.m.visible = false; return; }
    const k = 1 - r.life / 0.4; r.m.scale.setScalar((0.4 + k * 1.3) * r.k); r.m.material.opacity = (1 - k) * 0.7;
  });
  zoomPunch *= Math.pow(0.0005, dt);
}

/* ---------- soft billboard puffs (steam, smoke, sparks): one additive InstancedMesh per system, faded by instance colour ---------- */
let softT;
function softTex() { return softT || (softT = canvasTex(64, 64, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(255,255,255,1)'); gg.addColorStop(0.4, 'rgba(255,255,255,0.45)'); gg.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); })); }
function makePuffs(cap, tex) {
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }), cap);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; m.renderOrder = 4;
  for (let i = 0; i < cap; i++) m.setColorAt(i, tmpC.setRGB(0, 0, 0));
  m.userData.ps = []; return m;
}
function puff(m, o) { const ps = m.userData.ps; if (ps.length < m.instanceMatrix.count) ps.push(Object.assign({ age: 0, life: 1, size: 0.4, grow: 1, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, spin: 0 }, o)); }
function stepPuffs(m, dt) {
  const ps = m.userData.ps; let n = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]; p.age += dt;
    if (p.age >= p.life) { ps.splice(i--, 1); continue; }
    const k = p.age / p.life, dr = Math.max(0, 1 - p.drag * dt);
    p.vy -= p.g * dt; p.vx *= dr; p.vy *= dr; p.vz *= dr; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const sz = p.size * (1 + p.grow * k), a = Math.min(1, k * 8) * Math.pow(1 - k, 1.4);
    tmpQ.copy(camera.quaternion); if (p.spin) { tmpQ2.setFromAxisAngle(Z_AXIS, p.spin * p.age); tmpQ.multiply(tmpQ2); }
    tmpM.compose(tmpV.set(p.x, p.y, p.z), tmpQ, tmpS.set(sz * (p.sx || 1), sz, 1)); m.setMatrixAt(n, tmpM); m.setColorAt(n, tmpC.copy(p.col).multiplyScalar(a)); n++;
  }
  m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
}
/* drifting ambient motes (dust, plankton-like space dust): Points that wander on slow sine paths */
function motes(n, X, Y, Z, colr, size, seed) {
  const geo = new THREE.BufferGeometry(), p = new Float32Array(n * 3), r = rnd(seed);
  for (let i = 0; i < n; i++) { p[i * 3] = X[0] + r() * (X[1] - X[0]); p[i * 3 + 1] = Y[0] + r() * (Y[1] - Y[0]); p[i * 3 + 2] = Z[0] + r() * (Z[1] - Z[0]); }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size, map: softTex(), color: colr, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pts.userData.base = p.slice(); pts.frustumCulled = false; return pts;
}
function stepMotes(pts, t) {
  const p = pts.geometry.attributes.position, b = pts.userData.base;
  for (let i = 0; i < p.count; i++) { const k = i * 3; p.array[k] = b[k] + Math.sin(t * 0.21 + i * 1.7) * 0.6; p.array[k + 1] = b[k + 1] + Math.sin(t * 0.17 + i * 2.3) * 0.4; p.array[k + 2] = b[k + 2] + Math.cos(t * 0.13 + i) * 0.5; }
  p.needsUpdate = true;
}

/* ---------- bars, hammers, walls, belts, holes ---------- */
/* Bars are the scene's hero lights: an unlit core that comes out of the grade as exactly the game's colour,
   a halo shell that only glows outside the core, a light pool on the floor, a gunmetal collar and a hot tip. */
let poolTex;
const haloMat = (colr, k) => new THREE.ShaderMaterial({
  uniforms: { uCol: { value: new THREE.Color(colr) }, uK: { value: k }, uA: { value: 1 }, uIn: { value: 0.42 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main() { vec4 mv = modelViewMatrix * vec4( position, 1.0 ); vN = normalize( normalMatrix * normal ); vV = normalize( -mv.xyz ); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 uCol; uniform float uK; uniform float uA; uniform float uIn; varying vec3 vN; varying vec3 vV;
    void main() { float f = abs( dot( normalize( vN ), normalize( vV ) ) ); float d = sqrt( max( 0.0, 1.0 - f * f ) );
      float g = smoothstep( uIn - 0.04, uIn + 0.06, d ) * pow( 1.0 - d, 1.6 ); gl_FragColor = vec4( uCol * g * uK * uA, 1.0 ); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});
function makeBar(type, V) {
  const high = type === 'high', colr = high ? G_API.COL.high : G_API.COL.low, r = high ? 0.14 : 0.13, r0 = 0.75, r1 = V.barOut, L = r1 - r0;
  const root = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: exactColor(colr, renderer.toneMappingExposure), transparent: true, fog: false });
  const cyl = new THREE.Mesh(new THREE.CapsuleGeometry(r, L, lo() ? 3 : 6, lo() ? 10 : 20).rotateZ(Math.PI / 2).translate(r0 + L / 2, 0, 0), mat);
  cyl.renderOrder = 6; /* drawn after every additive layer so nothing adds onto the exact core colour */
  const HS = 2.5;
  const halo = new THREE.Mesh(new THREE.CapsuleGeometry(r * HS, L, lo() ? 3 : 6, lo() ? 10 : 20).rotateZ(Math.PI / 2).translate(r0 + L / 2, 0, 0), haloMat(colr, quality.bloom ? 1.6 : 2.4));
  halo.material.uniforms.uIn.value = 1 / HS; halo.renderOrder = 3;
  const capMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colr).multiplyScalar(4), transparent: true });
  const cap = new THREE.Mesh(GEO.barCap, capMat); cap.scale.setScalar(r * 1.15); cap.position.x = r1 + r * 0.5;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.7, r * 1.7, 0.16, 20).rotateZ(Math.PI / 2), MAT.gunmetal); collar.position.x = r0 + 0.1;
  const holder = new THREE.Group(); holder.position.y = high ? 1.17 : 0.3; holder.add(cyl); holder.add(halo); holder.add(cap); holder.add(collar); root.add(holder);
  if (!poolTex) poolTex = canvasTex(64, 64, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); }, false);
  /* light pool: wider and softer for the high bar (further from the floor) */
  const pw = high ? 1.5 : 0.95, poolMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colr).multiplyScalar(high ? 0.5 : 0.8), map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(L + 0.4, pw).rotateX(-Math.PI / 2).translate(r0 + L / 2 + 0.1, 0.018, 0), poolMat); pool.renderOrder = 1;
  root.add(pool);
  const trail = new THREE.Mesh(sectorGeo(0.75, r1, 0, 0.6, 16, 0.02, u => { const k = 0.4 * Math.pow(1 - u, 1.8); const c = new THREE.Color(colr); return [c.r * k, c.g * k, c.b * k]; }), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  root.add(trail);
  scene.add(root);
  return { root, holder, mat, capMat, halo, pool, trail, type };
}
/* Hammers: the handle is lit like a bar (exact low/high colour core, halo, floor pool) so its height reads the same way;
   a chunky toy mallet head with gunmetal caps, on a striped carnival post. */
let postTex;
function makeHammer(V) {
  const root = new THREE.Group(), r0 = V.e0 - 0.2, r1 = V.e1 + 0.55, L = r1 - r0, postR = V.e1 + 0.62, ex = renderer.toneMappingExposure;
  if (!postTex) { postTex = canvasTex(64, 128, (x, w, h) => { x.fillStyle = '#d8c8b0'; x.fillRect(0, 0, w, h); x.fillStyle = '#7a2438'; for (let i = -2; i < 6; i++) { x.beginPath(); x.moveTo(0, i * 32); x.lineTo(w, i * 32 + 32); x.lineTo(w, i * 32 + 48); x.lineTo(0, i * 32 + 16); x.closePath(); x.fill(); } }); postTex.wrapT = THREE.RepeatWrapping; postTex.repeat.set(1, 4); }
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.9, 16).translate(0, 0.95, 0), new THREE.MeshStandardMaterial({ map: postTex, roughness: 0.45, color: 0xb0a0a0 })); post.position.x = postR; post.castShadow = true; root.add(post);
  const knob = new THREE.Mesh(GEO.barCap, MAT.gold); knob.scale.setScalar(0.19); knob.position.set(postR, 1.98, 0); root.add(knob);
  const cols = { low: exactColor(G_API.COL.low, ex), high: exactColor(G_API.COL.high, ex) };
  const core = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, L, lo() ? 3 : 6, lo() ? 10 : 18).rotateZ(Math.PI / 2).translate(r0 + L / 2, 0, 0), new THREE.MeshBasicMaterial({ color: cols.low, fog: false }));
  core.castShadow = true; core.renderOrder = 6;
  const HS = 2.4, halo = new THREE.Mesh(new THREE.CapsuleGeometry(0.15 * HS, L, lo() ? 3 : 6, lo() ? 10 : 18).rotateZ(Math.PI / 2).translate(r0 + L / 2, 0, 0), haloMat(G_API.COL.low, quality.bloom ? 1.5 : 2.2));
  halo.material.uniforms.uIn.value = 1 / HS; halo.renderOrder = 3;
  const headMat = new THREE.MeshStandardMaterial({ color: G_API.COL.low, emissive: G_API.COL.low, emissiveIntensity: 1, roughness: 0.3, envMapIntensity: 1 });
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.66, 24).rotateX(Math.PI / 2), headMat); head.position.x = r0 - 0.05; head.castShadow = true;
  const caps = new THREE.Mesh(mergeGeos([new THREE.CylinderGeometry(0.37, 0.37, 0.09, 24).rotateX(Math.PI / 2).translate(0, 0, 0.36), new THREE.CylinderGeometry(0.37, 0.37, 0.09, 24).rotateX(Math.PI / 2).translate(0, 0, -0.36), new THREE.CylinderGeometry(0.2, 0.2, 0.2, 16).rotateZ(Math.PI / 2).translate(0.38, 0, 0)]), MAT.gunmetal);
  caps.position.x = r0 - 0.05;
  const holder = new THREE.Group(); holder.add(core); holder.add(halo); holder.add(head); holder.add(caps); root.add(holder);
  if (!poolTex) poolTex = canvasTex(64, 64, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); }, false);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(L + 0.6, 1.2).rotateX(-Math.PI / 2).translate(r0 + L / 2, 0.018, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pool.renderOrder = 1; root.add(pool);
  scene.add(root);
  const o = { root, holder, core, halo, headMat, pool, cols, y: 0.3, cur: '' };
  o.setCol = (type) => {
    if (o.cur === type) return; o.cur = type;
    const c = type === 'high' ? G_API.COL.high : G_API.COL.low;
    core.material.color.copy(cols[type]); halo.material.uniforms.uCol.value.set(c); headMat.color.set(c).multiplyScalar(0.35); headMat.emissive.copy(cols[type]).multiplyScalar(0.72);
    pool.material.color.set(c).multiplyScalar(type === 'high' ? 0.45 : 0.75);
  };
  o.setCol('low');
  return o;
}
/* Ice walls: a faceted, flat-shaded block with a snow cap, a cold inner glow and a frost pool on the floor (all shared) */
function wallParts() {
  if (GEO.wall) return;
  const r = rnd(5), g = new THREE.BoxGeometry(0.92, 1.05, 0.42, 3, 3, 2).translate(0, 0.525, 0), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = (Math.abs(x) > 0.45 || Math.abs(z) > 0.2 || y > 1.04) ? 1 : 0; const h = Math.sin(x * 31.7 + y * 17.3 + z * 41.1) * 43758.5; const n = h - Math.floor(h); p.setXYZ(i, x * (1 + (n - 0.5) * 0.1 * k), y > 0.01 ? y + (n - 0.5) * 0.08 * k : y, z * (1 + (n - 0.5) * 0.25 * k)); }
  const ng = g.toNonIndexed(); ng.computeVertexNormals();
  const np = ng.attributes.position, nn = ng.attributes.normal, colr = [];
  for (let i = 0; i < np.count; i++) { const y = np.getY(i), up = nn.getY(i); const snow = up > 0.6 ? 1 : 0, k = 0.55 + 0.45 * Math.min(1, y / 1.05); /* linear albedo, kept dark: the arena lights are strong and pale ice would tone-map to white */
    if (snow) colr.push(0.1, 0.22, 0.38); else { const f = 0.7 + 0.6 * Math.abs(nn.getX(i)); colr.push(0.03 * k * f, 0.12 * k * f, 0.3 * k * f); } }
  ng.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); g.dispose();
  GEO.wall = shared(ng);
  MAT.wall = smat(addRim(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.94, emissive: 0x2a74c0, emissiveIntensity: 0.6, envMapIntensity: 0.9 })));
  GEO.wallCore = shared(new THREE.BoxGeometry(0.6, 0.7, 0.16).translate(0, 0.45, 0));
  MAT.wallCore = smat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6fd0ff).multiplyScalar(0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  const ft = canvasTex(128, 64, (x, w, h) => { const gg = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gg.addColorStop(0, 'rgba(255,255,255,0.9)'); gg.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gg.addColorStop(1, 'rgba(255,255,255,0)'); x.save(); x.scale(1, 0.5); x.translate(0, h / 2); x.restore(); x.fillStyle = gg; x.fillRect(0, 0, w, h); }, false);
  GEO.wallPool = shared(new THREE.PlaneGeometry(1.7, 1.0).rotateX(-Math.PI / 2).translate(0, 0.016, 0));
  MAT.wallPool = smat(new THREE.MeshBasicMaterial({ map: ft, color: new THREE.Color(0x8fdcff).multiplyScalar(0.55), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
}
function makeWall(V) {
  wallParts();
  const root = new THREE.Group();
  const m = new THREE.Mesh(GEO.wall, MAT.wall); m.castShadow = true; m.renderOrder = 2; root.add(m);
  const core = new THREE.Mesh(GEO.wallCore, MAT.wallCore); core.renderOrder = 3; root.add(core);
  const pool = new THREE.Mesh(GEO.wallPool, MAT.wallPool); pool.renderOrder = 1; root.add(pool);
  scene.add(root); return { root };
}
/* Belts: a conveyor. Dark ribbed rubber with soft glowing chevrons in the speed colour (both scroll),
   gunmetal rollers at each end and brass side rails, merged per belt. */
let chevTex, ribTex;
function makeBelt(bt, V) {
  if (!chevTex) {
    chevTex = canvasTex(64, 64, (x, w, h) => { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = 15; x.beginPath(); x.moveTo(20, 14); x.lineTo(40, 32); x.lineTo(20, 50); x.stroke(); x.strokeStyle = '#fff'; x.lineWidth = 7; x.stroke(); });
    ribTex = canvasTex(64, 64, (x, w, h) => { x.fillStyle = '#26252c'; x.fillRect(0, 0, w, h); for (let i = 0; i < 4; i++) { x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(i * 16, 0, 5, h); x.fillStyle = 'rgba(255,255,255,0.06)'; x.fillRect(i * 16 + 5, 0, 2, h); } });
    chevTex.wrapS = ribTex.wrapS = THREE.RepeatWrapping;
  }
  const fast = bt.mult > 1, colr = fast ? G_API.COL.fast : G_API.COL.slow, r0 = V.e0 + 0.05, r1 = V.e1 - 0.05;
  const t = chevTex.clone(), t2 = ribTex.clone(); t.needsUpdate = t2.needsUpdate = true; t.repeat.set(Math.round(bt.w / 0.11), 1); t2.repeat.copy(t.repeat);
  const m = new THREE.Mesh(sectorGeo(r0, r1, -bt.w / 2, bt.w / 2, 20, 0.014), new THREE.MeshStandardMaterial({ map: t2, color: new THREE.Color(colr).lerp(new THREE.Color(0xffffff), 0.5), emissive: colr, emissiveMap: t, emissiveIntensity: 1.25, roughness: 0.75, metalness: 0.1 }));
  m.receiveShadow = true;
  const fg = [];
  [r0 - 0.02, r1 + 0.02].forEach(rr => fg.push(new THREE.TorusGeometry(rr, 0.035, 6, 24, bt.w).rotateX(Math.PI / 2).rotateY(bt.w / 2).translate(0, 0.04, 0)));
  [-bt.w / 2, bt.w / 2].forEach(a => fg.push(new THREE.CylinderGeometry(0.075, 0.075, r1 - r0 + 0.1, 12).rotateZ(Math.PI / 2).translate((r0 + r1) / 2, 0.05, 0).rotateY(-a)));
  m.add(new THREE.Mesh(mergeGeos(fg), new THREE.MeshStandardMaterial({ color: 0x8a6438, metalness: 1, roughness: 0.35 })));
  scene.add(m);
  return { root: m, tex: t, tex2: t2, dir: fast ? 1 : -1 };
}
/* Lava holes: the crack stage keeps the board visible and lights branching fractures that pulse faster as the tile goes;
   the open pit is molten lava with dark crust plates, a ragged broken rim and an inner shadow for depth, with embers rising.
   Textures are drawn at the sector's real proportions (u = across the track, v = along the radius). */
let crackTex, crackMap, lavaPitTex, holeFx;
function holeTextures() {
  const r = rnd(61), W = 128, H = 256;
  const cracks = [];
  const branch = (x, y, a, len, d) => { const pts = [[x, y]]; for (let k = 0; k < 6; k++) { a += (r() - 0.5) * 0.9; x += Math.cos(a) * len / 6; y += Math.sin(a) * len / 6; pts.push([x, y]); if (d < 2 && r() < 0.3) branch(x, y, a + (r() < 0.5 ? 1 : -1) * (0.6 + r() * 0.5), len * 0.5, d + 1); } cracks.push([pts, d]); };
  branch(W * 0.5, H * 0.05, Math.PI / 2, H * 0.95, 0); branch(W * 0.1, H * 0.35, 0.3, W * 1.1, 1); branch(W * 0.95, H * 0.7, Math.PI - 0.2, W * 1.0, 1);
  const stroke = (x, wdt, col) => cracks.forEach(([pts, d]) => { x.strokeStyle = col; x.lineWidth = wdt / (1 + d * 0.6); x.beginPath(); pts.forEach((q, i) => i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])); x.stroke(); });
  crackTex = canvasTex(W, H, (x) => { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.lineJoin = 'round'; x.lineCap = 'round'; x.shadowColor = '#ff5a10'; x.shadowBlur = 10; stroke(x, 7, '#ff6a14'); x.shadowBlur = 0; stroke(x, 2.5, '#ffe0a0'); });
  crackMap = canvasTex(W, H, (x) => { x.clearRect(0, 0, W, H); x.fillStyle = 'rgba(10,4,2,0.25)'; x.fillRect(0, 0, W, H); x.lineJoin = 'round'; stroke(x, 9, 'rgba(8,3,2,0.85)'); });
  lavaPitTex = canvasTex(W, H, (x) => {
    const gg = x.createLinearGradient(0, 0, W, 0); gg.addColorStop(0, '#c83a08'); gg.addColorStop(0.5, '#ffb030'); gg.addColorStop(1, '#c83a08'); x.fillStyle = gg; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) { const cx = r() * W, cy = r() * H, s = 6 + r() * 16; x.fillStyle = `rgba(${r() < 0.5 ? '255,240,170' : '255,120,30'},0.5)`; x.beginPath(); x.arc(cx, cy, s, 0, TAU); x.fill(); }
    /* crust plates */
    for (let i = 0; i < 14; i++) { const cx = r() * W, cy = r() * H, s = 8 + r() * 14; x.fillStyle = 'rgba(40,10,4,0.85)'; x.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + r() * 0.5, rr = s * (0.6 + r() * 0.5); k ? x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : x.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } x.closePath(); x.fill(); }
    /* inner shadow (depth) and a ragged broken rim */
    const sh = x.createLinearGradient(0, 0, W * 0.3, 0); sh.addColorStop(0, 'rgba(0,0,0,0.85)'); sh.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = sh; x.fillRect(0, 0, W * 0.3, H);
    const sh2 = x.createLinearGradient(W, 0, W * 0.75, 0); sh2.addColorStop(0, 'rgba(0,0,0,0.75)'); sh2.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = sh2; x.fillRect(W * 0.7, 0, W * 0.3, H);
    [0, H].forEach(y0 => { const g2 = x.createLinearGradient(0, y0, 0, y0 ? H - 26 : 26); g2.addColorStop(0, 'rgba(0,0,0,0.8)'); g2.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g2; x.fillRect(0, y0 ? H - 26 : 0, W, 26); });
    x.fillStyle = '#0c0403'; [[0, 1], [W, -1]].forEach(([x0, sg]) => { x.beginPath(); x.moveTo(x0, 0); for (let y = 0; y <= H; y += 12) x.lineTo(x0 + sg * (3 + r() * 9), y); x.lineTo(x0, H); x.closePath(); x.fill(); });
  });
}
function makeHole(o, V) {
  if (!crackTex) holeTextures();
  const geo = sectorGeo(V.e0 + 0.06, V.e1 - 0.06, -o.w / 2, o.w / 2, 10, 0.014);
  const crack = new THREE.MeshStandardMaterial({ map: crackMap, emissive: 0xffffff, emissiveMap: crackTex, emissiveIntensity: 1, roughness: 0.8, transparent: true, depthWrite: false });
  const pit = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: lavaPitTex, emissiveIntensity: 1, roughness: 1 });
  const m = new THREE.Mesh(geo, crack); m.renderOrder = 1; scene.add(m);
  if (!holeFx) { holeFx = makePuffs(60, softTex()); scene.add(holeFx); }
  return { root: m, crack, pit, acc: 0 };
}
/* Pickup: a toy power-up. Glossy core in the power-up colour inside a fresnel glass shell, a white icon with a dark
   outline, a turning gold ring, a light pool on the floor and a soft beacon beam. */
function makeOrb() {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.15, transparent: true });
  const ball = new THREE.Mesh(GEO.orb, mat); ball.scale.setScalar(0.95); root.add(ball);
  const shell = new THREE.Mesh(GEO.orb, haloMat(0xffffff, 1.6)); shell.scale.setScalar(1.25); shell.material.uniforms.uIn.value = 0.0; shell.renderOrder = 3; root.add(shell);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.022, 8, 48).rotateX(Math.PI / 2), MAT.gold); ring.rotation.z = 0.4; root.add(ring);
  const icons = {};
  ['shield', 'slow', 'heart'].forEach(k => {
    const tex = canvasTex(128, 128, (x, w) => {
      const c = w / 2, R = w * 0.27; x.lineCap = 'round'; x.lineJoin = 'round';
      const path = () => {
        x.beginPath();
        if (k === 'shield') { x.moveTo(c, c - R); x.lineTo(c + R * 0.85, c - R * 0.65); x.lineTo(c + R * 0.7, c + R * 0.3); x.lineTo(c, c + R); x.lineTo(c - R * 0.7, c + R * 0.3); x.lineTo(c - R * 0.85, c - R * 0.65); x.closePath(); }
        else if (k === 'slow') { x.arc(c, c, R, 0, TAU); x.moveTo(c, c); x.lineTo(c, c - R * 0.7); x.moveTo(c, c); x.lineTo(c + R * 0.5, c); }
        else { x.moveTo(c, c + R * 0.95); x.bezierCurveTo(c - R * 1.6, c - R * 0.1, c - R * 0.6, c - R * 1.2, c, c - R * 0.45); x.bezierCurveTo(c + R * 0.6, c - R * 1.2, c + R * 1.6, c - R * 0.1, c, c + R * 0.95); x.closePath(); }
      };
      path(); x.strokeStyle = 'rgba(16,10,36,0.9)'; x.lineWidth = w * 0.07; x.stroke();
      path(); if (k === 'slow') { x.strokeStyle = '#fff'; x.lineWidth = w * 0.06; x.stroke(); } else { x.fillStyle = '#fff'; x.fill(); }
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); sp.scale.set(0.3, 0.3, 1); sp.renderOrder = 7; sp.visible = false; root.add(sp); icons[k] = sp;
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, map: softTex(), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  const beamT = canvasTex(32, 128, (x, w, h) => { const gg = x.createLinearGradient(0, 0, 0, h); gg.addColorStop(0, 'rgba(255,255,255,0)'); gg.addColorStop(1, 'rgba(255,255,255,0.5)'); x.fillStyle = gg; x.fillRect(0, 0, w, h); }, false);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.6, 20, 1, true).translate(0, 0.8, 0), new THREE.MeshBasicMaterial({ map: beamT, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  glow.add(beam);
  scene.add(root); scene.add(glow);
  return { root, ball, mat, icons, glow, shell, ring, beam, cur: -1 };
}
function makeParticles() {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), 220);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; scene.add(m); return m;
}

/* the player's marker: bright gold ring, soft gold light pool, slow dashed outer ring (plus the gold outline on the runner) */
function makeYouRing() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23f).multiplyScalar(2.2), transparent: true, depthWrite: false }));
  ring.position.y = 0.012; ring.renderOrder = 2; g.add(ring);
  const glowT = canvasTex(128, 128, (x, w) => { const gg = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gg.addColorStop(0, 'rgba(255,255,255,0.55)'); gg.addColorStop(0.5, 'rgba(255,255,255,0.4)'); gg.addColorStop(0.62, 'rgba(255,255,255,0.7)'); gg.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, w); }, false);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa010).multiplyScalar(0.45), map: glowT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pool.position.y = 0.01; pool.renderOrder = 1; g.add(pool);
  const dashT = canvasTex(256, 16, (x, w, h) => { x.fillStyle = '#fff'; for (let i = 0; i < 16; i++) x.fillRect(i * 16 + 2, 0, 9, h); }, false); dashT.wrapS = THREE.RepeatWrapping;
  const dash = new THREE.Mesh(sectorGeo(0.78, 0.84, 0, TAU, 96, 0.012), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23f).multiplyScalar(1.4), map: dashT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  dashT.repeat.set(3, 1); dash.renderOrder = 2; g.add(dash);
  g.userData = { dash, pool };
  scene.add(g); return g;
}

/* ---------- per-frame ---------- */
function syncPool(pool, list, make, keyFn) {
  while (pool.length > list.length) { const o = pool.pop(); scene.remove(o.root || o); if (o.blob) scene.remove(o.blob); disposeTree(o.root || o); }
  for (let i = 0; i < list.length; i++) {
    if (!pool[i] || (keyFn && pool[i].key !== keyFn(list[i]))) { if (pool[i]) { scene.remove(pool[i].root || pool[i]); if (pool[i].blob) scene.remove(pool[i].blob); disposeTree(pool[i].root || pool[i]); } pool[i] = make(list[i]); if (keyFn) pool[i].key = keyFn(list[i]); }
  }
}

HR3D.attach = function (api) { G_API = api; };
HR3D.setQuality = function (lv) { setQuality(lv); try { localStorage.setItem('headrush.hdq', String(lv)); } catch (e) {} };
HR3D.quality = () => quality.level;
HR3D.show = function (on) { if (glCanvas) glCanvas.style.display = on ? 'block' : 'none'; if (document.body.classList.contains('hd3d') !== !!on) document.body.classList.toggle('hd3d', !!on); if (vigEl) vigEl.style.display = on && !quality.bloom ? 'block' : 'none'; };

HR3D.render = function (g, view) {
  const V = G_API.V3, W = view.W, H = view.H, now = view.now;
  HR3D.show(true);
  resize(W, H);
  const RG = rig(V, W, H);
  setArena(g);
  camera.position.copy(RG.cam);
  camera.up.set(0, 1, 0);
  camera.lookAt(RG.tgt);
  camera.fov = 2 * Math.atan(H / (2 * RG.F)) * 180 / Math.PI;
  camera.aspect = W / H;
  if (g.close > (HR3D._close || 0) && runnerPool[0]) { runnerPool[0].happyUntil = now + 0.7; punch(0.02); }
  HR3D._close = g.close;
  stepFx(Math.min(0.05, view.dt || 0.016));
  camera.zoom = 1 + zoomPunch;
  camera.setViewOffset(W, H, W / 2 - RG.cx - (view.sx || 0), H / 2 - RG.cy - (view.sy || 0), W, H);
  camera.updateProjectionMatrix();
  const t = g.t, A = g.arena;
  curArena.core.floor.rotation.y = -g.rot;
  if (curArena.sc.update) curArena.sc.update(now);
  // runners
  syncPool(runnerPool, g.players, p => makeRunner(p), p => sigOf(p));
  partsBegin();
  const out = [];
  g.players.forEach((p, i) => {
    const rn = runnerPool[i];
    const r = updateRunner(rn, p, i, g, V, now, Math.min(0.05, view.dt || 0.016));
    tmpV.set(r.x, 0, r.z).project(camera); const fx = (tmpV.x + 1) / 2 * W, fy = (1 - tmpV.y) / 2 * H;
    tmpV.set(r.x, r.top, r.z).project(camera); const ty = (1 - tmpV.y) / 2 * H;
    out.push({ cx: fx, foot: fy, top: ty });
  });
  partsEnd();
  if (!youRing) youRing = makeYouRing();
  youRing.userData.dash.rotation.y = now * 0.6;
  youRing.userData.pool.material.opacity = 0.8 + 0.2 * Math.sin(now * 4);
  const you = g.players[0];
  youRing.visible = !you.out;
  if (!you.out) { const R = V.TR + (G_API.runnerR(you) - V.mid) * V.SC, f = you.angle + g.rot; youRing.position.set(R * Math.cos(f), 0.02, R * Math.sin(f)); }
  // bars
  syncPool(barPool, g.bars, b => makeBar(b.type, V), b => b.type + '|' + V.barOut + (lo() ? '|lo' : ''));
  g.bars.forEach((b, i) => {
    const o = barPool[i], vis = G_API.barVisible(b, t);
    o.root.rotation.y = -(b.angle + g.rot);
    const al = vis ? 1 : 0.18; o.mat.opacity = al; o.capMat.opacity = al; o.halo.material.uniforms.uA.value = vis ? 1 : 0.15;
    o.pool.visible = o.trail.visible = vis; o.trail.scale.z = (g.dir || 1) < 0 ? -1 : 1;
    /* High tier: the bar tip sheds a few sparks behind its sweep */
    if (quality.bloom && vis && Math.random() < (view.dt || 0.016) * 9) {
      const f = b.angle + g.rot, d = (g.dir || 1) < 0 ? -1 : 1, R = V.barOut + 0.1, y = b.type === 'high' ? 1.17 : 0.3;
      puff(fxPuffs, { x: R * Math.cos(f), y, z: R * Math.sin(f), vx: Math.sin(f) * d * 1.2 + Math.cos(f) * 0.8, vz: -Math.cos(f) * d * 1.2 + Math.sin(f) * 0.8, vy: 0.6 + Math.random(), g: 5, life: 0.35 + Math.random() * 0.2, size: 0.06, grow: -0.4, col: o.sparkCol || (o.sparkCol = new THREE.Color(b.type === 'high' ? G_API.COL.high : G_API.COL.low).lerp(new THREE.Color(1, 1, 1), 0.4)) });
    }
  });
  // hammers
  syncPool(hammerPool, A.hammers, () => makeHammer(V));
  A.hammers.forEach((h, i) => {
    const o = hammerPool[i], type = G_API.hammerType(h, t), P = G_API.HAMMER_P, ph = ((t + h.ph) % P + P) % P, k = (ph % (P / 2)) / (P / 2);
    const high = type === 'high', target = high ? 1.17 : 0.3, colr = high ? G_API.COL.high : G_API.COL.low;
    o.y += (target - o.y) * Math.min(1, view.dt * 18);
    o.holder.position.y = o.y;
    o.root.rotation.y = -(h.a + g.rot);
    /* warning before the swap: flash the other colour and shake, as before */
    const flash = k > 0.7 && Math.floor(t * 8) % 2;
    o.setCol(flash ? (high ? 'low' : 'high') : type);
    o.holder.position.x = k > 0.7 ? Math.sin(t * 60) * 0.02 : 0;
    o.pool.scale.z = 0.8 + o.y * 0.5;
  });
  // walls
  syncPool(wallPool, A.walls, () => makeWall(V));
  A.walls.forEach((w, i) => { const m = wallPool[i].root, R = V.TR + (A.lanes[w.lane] - V.mid) * V.SC, f = w.a + g.rot; m.position.set(R * Math.cos(f), 0, R * Math.sin(f)); m.rotation.y = -f; });
  // belts
  syncPool(beltPool, A.belts, bt => makeBelt(bt, V));
  A.belts.forEach((bt, i) => { const o = beltPool[i]; o.root.rotation.y = -(bt.a + g.rot); o.tex.offset.x = o.tex2.offset.x = -(t * 0.45 * o.dir) / 0.11 % 1; });
  // holes
  syncPool(holePool, g.holes, o => makeHole(o, V));
  g.holes.forEach((o, i) => {
    const h = holePool[i];
    h.root.rotation.y = -(o.a + g.rot);
    if (o.state === 'idle') { h.root.visible = false; return; }
    h.root.visible = true;
    if (o.state === 'crack') { const left = Math.max(0, o.until - t), pulse = 0.5 + 0.5 * Math.sin(t * (10 + (1.3 - left) * 16)); h.root.material = h.crack; h.crack.emissiveIntensity = 0.5 + 1.5 * pulse; }
    else {
      h.root.material = h.pit; h.pit.emissiveIntensity = 1.15 + 0.25 * Math.sin(t * 6 + i);
      /* embers and heat rising from the open pit */
      h.acc += view.dt || 0;
      while (h.acc > 0.09) {
        h.acc -= 0.09;
        const A2 = o.a + g.rot + (Math.random() - 0.5) * o.w * 0.8, R2 = V.e0 + 0.2 + Math.random() * (V.e1 - V.e0 - 0.4), ex = R2 * Math.cos(A2), ez = R2 * Math.sin(A2);
        puff(holeFx, { x: ex, y: 0.05, z: ez, vx: (Math.random() - 0.5) * 0.3, vy: 1.2 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.3, life: 0.7 + Math.random() * 0.6, size: 0.09, grow: -0.4, col: tmpC.setRGB(1, 0.5, 0.12).clone() });
        if (Math.random() < 0.35) puff(holeFx, { x: ex, y: 0.2, z: ez, vy: 0.6, life: 1.0, size: 0.5, grow: 1.4, col: tmpC.setRGB(0.22, 0.06, 0.01).clone() });
      }
    }
  });
  if (holeFx) stepPuffs(holeFx, Math.min(0.05, view.dt || 0.016));
  // pickup orb
  if (!orb) orb = makeOrb();
  const pu = g.pickup;
  orb.root.visible = orb.glow.visible = !!pu;
  if (pu) {
    const L = A.lanes, R = V.TR + ((L.length > 1 ? L[pu.lane] : L[0]) - V.mid) * V.SC, f = pu.a + g.rot, colr = pu.type === 'shield' ? G_API.COL.puShield : pu.type === 'slow' ? G_API.COL.puSlow : G_API.COL.heart;
    const life = 12 - (t - pu.born), blink = life < 2 && Math.floor(t * 10) % 2;
    orb.root.position.set(R * Math.cos(f), 0.62 + 0.08 * Math.sin(t * 4), R * Math.sin(f));
    orb.ring.rotation.y = t * 2.2; orb.ball.rotation.y = t * 1.5;
    if (orb.cur !== colr) { orb.cur = colr; orb.mat.color.set(colr).multiplyScalar(0.55); orb.mat.emissive.set(colr); orb.shell.material.uniforms.uCol.value.set(colr); orb.glow.material.color.set(colr).multiplyScalar(0.7); orb.beam.material.color.set(colr).multiplyScalar(0.35); }
    orb.mat.opacity = blink ? 0.4 : 1; orb.shell.material.uniforms.uA.value = blink ? 0.3 : 1;
    Object.keys(orb.icons).forEach(k => { orb.icons[k].visible = k === pu.type && !blink; });
    orb.glow.position.set(orb.root.position.x, 0.025, orb.root.position.z);
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

/* Dynamic resolution: keep frames near the target by trading pixels first, effects second. */
let slowChecks = 0, fastChecks = 0, adaptAcc = 0;
function adapt(dt) {
  if (!dt || dt > 0.25) return;
  frameTimes.push(dt); adaptAcc += dt;
  if (adaptAcc < 1) return;
  adaptAcc = 0;
  frameTimes.sort((a, b) => a - b);
  const med = frameTimes[Math.floor(frameTimes.length * 0.5)], p90 = frameTimes[Math.floor(frameTimes.length * 0.9)];
  frameTimes = [];
  const target = HR3D.targetDt || 1 / 60;
  if (med > target * 1.18 || p90 > target * 1.6) {
    fastChecks = 0;
    if (quality.dyn > 0.62) { quality.dyn = Math.max(0.6, quality.dyn - 0.12); lastSize = ''; }
    else if (++slowChecks >= 2 && quality.level > 0) { slowChecks = 0; setQuality(quality.level - 1); quality.dyn = 0.85; }
  } else if (med < target * 1.04 && p90 < target * 1.25) {
    slowChecks = 0;
    if (++fastChecks >= 3 && quality.dyn < 1) { fastChecks = 0; quality.dyn = Math.min(1, quality.dyn + 0.06); lastSize = ''; }
  }
}
HR3D.stats = () => ({ level: quality.level, pr: effPR(), dyn: quality.dyn });

try { init(); HR3D.ok = true; } catch (e) { HR3D.ok = false; HR3D.error = String(e && e.message || e); if (glCanvas) glCanvas.remove(); }
window.dispatchEvent(new Event('hr3d-ready'));
