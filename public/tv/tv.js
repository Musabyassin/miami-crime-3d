'use strict';
/* ميامي 3D — شاشة التلفاز: محاكاة اللعبة كاملة (Three.js) + استقبال
   مدخلات الهواتف عبر الخادم. لعبة أصلية مبنية من صناديق وأسطوانات
   فقط — لا أصول ولا كود ولا علامات من أي لعبة أخرى.
   النسخة 2: كاميرا ثالث-شخص، أسلحة وتصويب مساعد، صحة ودرع، مستشفى
   ومتجر سلاح، شرطة بمروحية، تدمير سيارات، ومهمة «مطلوبون». */
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
const COLORS = ['#e52521', '#22a447', '#2f6df6', '#f5b800', '#9b30ff', '#ff7f00'];
const PAINTS = ['#e52521', '#ff5e8a', '#22a447', '#2f6df6', '#f5b800', '#9b30ff', '#ff7f00', '#00c8c8', '#ffffff', '#111111'];
const DISTRICTS = [
  ['الشاطئ', 88, -88], ['وسط المدينة', 0, -88], ['الحي القديم', -88, -88],
  ['المرسى', 88, 0], ['السوق', 0, 0], ['الحي اللاتيني', -88, 0],
  ['الميناء', 88, 88], ['الحديقة', 0, 88], ['المطار', -88, 88],
];
const WORLD = 115; // نصف حجم المدينة
const ROADS = [-80, -40, 0, 40, 80];
const BLOCKS = [-60, -20, 20, 60]; // مراكز البلوكات «بين» الطرق (المباني هنا لا على التقاطعات)
const ZONES = {
  garage: { x: -62, z: 62, w: 18, h: 14, color: 0xffd166, css: '#ffd166', label: '🎨 الكراج' },
  shop: { x: 60, z: -54, w: 18, h: 12, color: 0xff5555, css: '#ff5555', label: '🔫 متجر السلاح' },
  hospital: { x: -60, z: -54, w: 18, h: 12, color: 0x8be0a4, css: '#8be0a4', label: '🏥 المستشفى' },
};
const GARAGE = ZONES.garage, SHOP = ZONES.shop, HOSPITAL = ZONES.hospital;
const WEAPONS = {
  fists: { name: 'قبضة', icon: '👊', melee: true },
  pistol: { name: 'مسدس', icon: '🔫', dmg: 25, rate: 0.32, mag: 12, reload: 1.1, range: 45, spread: 0.025, pellets: 1, auto: false, cost: 0, pack: 24 },
  smg: { name: 'رشاش', icon: '🔫', dmg: 12, rate: 0.085, mag: 30, reload: 1.5, range: 40, spread: 0.07, pellets: 1, auto: true, cost: 800, pack: 60 },
  shotgun: { name: 'بندقية', icon: '💥', dmg: 11, rate: 0.85, mag: 6, reload: 1.9, range: 20, spread: 0.17, pellets: 6, auto: false, cost: 1200, pack: 18 },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
const lerpAngle = (a, b, k) => a + angDiff(b, a) * k;
const inZone = (Z, x, z) => Math.abs(x - Z.x) < Z.w / 2 && Math.abs(z - Z.z) < Z.h / 2;
function escapeHtml(s) { return String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- حالة الغرفة واللعبة ---------- */
let ws = null, code = '', phase = 'lobby'; // lobby | playing | paused | over
let missionType = 'courier';
let players = new Map(); // slot -> player state
let roomPlayers = []; // من الخادم {slot,name,color}
const inputs = {}; // slot -> {x,y,jump,action,punch,run,fire,swap,cam}
const prevInput = {};
let mission = null; // {type, idx, x, z, timeLeft, checkpoints, targets}
let paused = false;
let dayT = 0.25; // 0..1 دورة نهار/ليل (تبدأ صباحاً)
let toastTimer = 0;

function showToast(text, ms = 2500) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function moneyFmt(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

/* ---------- الصوت: WebAudio مولّد فقط، بلا ملفات ---------- */
let AC = null, engineOsc = null, engineGain = null, sirenOsc = null, sirenGain = null, sirenLfo = null, noiseBuf = null;
function ensureAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    engineOsc = AC.createOscillator(); engineOsc.type = 'sawtooth'; engineOsc.frequency.value = 60;
    engineGain = AC.createGain(); engineGain.gain.value = 0;
    engineOsc.connect(engineGain); engineGain.connect(AC.destination); engineOsc.start();
    sirenOsc = AC.createOscillator(); sirenOsc.type = 'triangle'; sirenOsc.frequency.value = 700;
    sirenGain = AC.createGain(); sirenGain.gain.value = 0;
    sirenLfo = AC.createOscillator(); sirenLfo.type = 'sine'; sirenLfo.frequency.value = 0.6;
    const lfoGain = AC.createGain(); lfoGain.gain.value = 250;
    sirenLfo.connect(lfoGain); lfoGain.connect(sirenOsc.frequency);
    sirenOsc.connect(sirenGain); sirenGain.connect(AC.destination);
    sirenOsc.start(); sirenLfo.start();
  } catch (e) { AC = null; }
}
function beep(freq, dur, type = 'sine', vol = 0.15, when = 0) {
  if (!AC) return;
  const t = AC.currentTime + when;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, lp) {
  if (!AC) return;
  if (!noiseBuf) {
    noiseBuf = AC.createBuffer(1, Math.floor(AC.sampleRate * 0.8), AC.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = AC.createBufferSource(); s.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp || 2500;
  const g = AC.createGain(); const t = AC.currentTime;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(AC.destination); s.start(t); s.stop(t + dur + 0.02);
}
const sfxPickup = () => { beep(880, 0.12); beep(1318, 0.18, 'sine', 0.15, 0.09); };
const sfxPunch = () => beep(120, 0.15, 'square', 0.2);
const sfxBust = () => { beep(220, 0.3, 'sawtooth', 0.2); beep(165, 0.4, 'sawtooth', 0.2, 0.2); };
const sfxMission = () => { beep(523, 0.15); beep(659, 0.15, 'sine', 0.15, 0.12); beep(784, 0.3, 'sine', 0.15, 0.24); };
const sfxShot = (w) => (w === 'shotgun' ? noise(0.25, 0.35, 1800) : w === 'smg' ? noise(0.07, 0.16, 3500) : noise(0.12, 0.24, 2800));
const sfxBoom = () => noise(0.8, 0.5, 600);
const sfxHurt = () => beep(180, 0.12, 'square', 0.14);
const sfxReload = () => { beep(300, 0.05, 'square', 0.1); beep(450, 0.06, 'square', 0.1, 0.12); };
let lastCrashSfx = 0;
const sfxCrash = () => { const t = performance.now(); if (t - lastCrashSfx > 250) { lastCrashSfx = t; noise(0.18, 0.3, 900); } };

/* ---------- WebSocket ---------- */
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    $('lobbyStatus').textContent = '✅ متصل — أنشئ غرفة…';
    const resume = sessionStorage.getItem('miami_code') || undefined;
    ws.send(JSON.stringify({ t: 'create', resume }));
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'created') {
      code = m.code; sessionStorage.setItem('miami_code', code);
      $('codeRow').innerHTML = String(code).split('').map((d) => '<b>' + d + '</b>').join('');
      $('barCode').innerHTML = 'كود الغرفة: <b>' + code + '</b>';
      $('lobbyStatus').textContent = '✅ الغرفة جاهزة — أدخلوا الكود من هواتفكم';
      $('startBtn').disabled = false;
    } else if (m.t === 'room') {
      roomPlayers = m.players || [];
      renderSlots(); updateBarCtrl();
    } else if (m.t === 'input') {
      inputs[m.player] = m.input || {};
    } else if (m.t === 'control') {
      handleControl(m.action, m.mission);
    } else if (m.t === 'err') {
      $('lobbyStatus').textContent = '⚠ ' + (m.m || 'خطأ في الاتصال');
    }
  };
  ws.onclose = () => { $('lobbyStatus').textContent = '⚠ انقطع الاتصال — أعد تحميل الصفحة'; setTimeout(connect, 3000); };
}
function renderSlots() {
  const el = $('slots');
  let html = '';
  for (let s = 1; s <= 6; s++) {
    const p = roomPlayers.find((q) => q.slot === s);
    if (p) html += '<div class="slot taken" style="--c:' + p.color + '"><span class="dot"></span>' + escapeHtml(p.name) + '</div>';
    else html += '<div class="slot">لاعب ' + s + ' — فارغ</div>';
  }
  el.innerHTML = html;
}
function updateBarCtrl() {
  $('barCtrl').textContent = roomPlayers.length ? '📱 ' + roomPlayers.length + ' هاتف متصل' : '📵 هاتف غير متصل';
}
function handleControl(action, missionName) {
  if (action === 'start') startGame(missionName || missionType);
  else if (action === 'pause') { if (phase === 'playing') { paused = !paused; $('barPhase').textContent = paused ? 'متوقفة مؤقتاً' : 'تلعب الآن'; } }
  else if (action === 'restart') restartGame();
  else if (action === 'lobby') toLobby();
  else if (action === 'mission') startMission(missionName || missionType);
}

/* ---------- Three.js: المشهد ---------- */
const canvas = $('cv');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 160, 320);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 1.0); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2cc, 1.6); sun.position.set(60, 100, 40);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005;
{ const sc = sun.shadow.camera; sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 10; sc.far = 320; }
scene.add(sun); scene.add(sun.target);
const moon = new THREE.DirectionalLight(0x8899ff, 0); moon.position.set(-60, 80, -40); scene.add(moon);

const colliders = []; // {x,z,hw,hd} مبانٍ فقط
const lampMats = [];
const bldMats = [];

function buildingTextures(base) {
  const mk = () => { const c = document.createElement('canvas'); c.width = 128; c.height = 256; return c; };
  const c1 = mk(), c2 = mk(); const g1 = c1.getContext('2d'), g2 = c2.getContext('2d');
  g1.fillStyle = base; g1.fillRect(0, 0, 128, 256);
  g2.fillStyle = '#000'; g2.fillRect(0, 0, 128, 256);
  for (let y = 14; y < 240; y += 26) for (let x = 12; x < 116; x += 26) {
    const lit = Math.random() < 0.5;
    g1.fillStyle = lit ? '#ffe9a8' : '#1d2f4a'; g1.fillRect(x, y, 16, 18);
    if (lit) { g2.fillStyle = '#ffd27a'; g2.fillRect(x, y, 16, 18); } // النوافذ المضاءة فقط تتوهج ليلاً
  }
  const t1 = new THREE.CanvasTexture(c1), t2 = new THREE.CanvasTexture(c2);
  t1.colorSpace = THREE.SRGBColorSpace; t2.colorSpace = THREE.SRGBColorSpace;
  t1.wrapS = t1.wrapT = t2.wrapS = t2.wrapT = THREE.RepeatWrapping;
  return [t1, t2];
}
function labelSprite(text, scale = 1) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(5,15,30,0.55)'; g.beginPath(); g.roundRect(6, 18, 500, 92, 24); g.fill();
  g.fillStyle = '#fff'; g.font = 'bold 52px system-ui, Tahoma, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  sp.scale.set(22 * scale, 5.5 * scale, 1); return sp;
}
function addBuilding(cx, cz, w, d, h, col) {
  const [t1, t2] = buildingTextures(col);
  t1.repeat.set(w / 16, h / 36); t2.repeat.set(w / 16, h / 36);
  const mat = new THREE.MeshLambertMaterial({ map: t1, emissiveMap: t2, emissive: 0xffffff, emissiveIntensity: 0 });
  bldMats.push(mat);
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  b.position.set(cx, h / 2, cz); b.castShadow = true; b.receiveShadow = true; scene.add(b);
  colliders.push({ x: cx, z: cz, hw: w / 2 + 0.4, hd: d / 2 + 0.4 });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), new THREE.MeshLambertMaterial({ color: 0x333a4a }));
  roof.position.set(cx, h + 0.25, cz); scene.add(roof);
  if (h > 20) { // هوائي + وحدة تكييف على الأبراج
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 5), new THREE.MeshLambertMaterial({ color: 0x888888 }));
    ant.position.set(cx + w * 0.25, h + 3.2, cz - d * 0.25); scene.add(ant);
    const ac = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 3), new THREE.MeshLambertMaterial({ color: 0x777f8c }));
    ac.position.set(cx - w * 0.2, h + 1.3, cz + d * 0.2); scene.add(ac);
  }
  return b;
}
function pointFree(x, z, pad = 0) {
  for (const b of colliders) if (Math.abs(x - b.x) < b.hw + pad && Math.abs(z - b.z) < b.hd + pad) return false;
  return true;
}
function randomFreeSpot(pad = 1.5) {
  for (let i = 0; i < 40; i++) {
    const x = rand(-100, 98), z = rand(-100, 100);
    if (pointFree(x, z, pad)) return { x, z };
  }
  return { x: 0, z: 10 };
}

function buildCity() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshLambertMaterial({ color: 0x9aa78f }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(22, 240), new THREE.MeshLambertMaterial({ color: 0xf2ddab }));
  sand.rotation.x = -Math.PI / 2; sand.position.set(106, 0.05, 0); scene.add(sand);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(90, 240), new THREE.MeshLambertMaterial({ color: 0x1e90d6 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(162, 0.02, 0); scene.add(sea);
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
  for (let i = 0; i < 10; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 6), pierMat);
    plank.position.set(118 + i * 4.4, 0.6, -30); scene.add(plank);
  }
  // الطرق (شبكة) + الأرصفة
  const roadMat = new THREE.MeshLambertMaterial({ color: 0x2e3440 });
  const walkMat = new THREE.MeshLambertMaterial({ color: 0xcfc8b8 });
  const strip = (w, l, x, z, y, mat, vertical) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(vertical ? w : l, vertical ? l : w), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; scene.add(m);
  };
  for (const r of ROADS) {
    strip(10, 232, 0, r, 0.08, roadMat, false); strip(10, 232, r, 0, 0.08, roadMat, true);
    strip(13, 232, 0, r, 0.06, walkMat, false); strip(13, 232, r, 0, 0.06, walkMat, true);
  }
  // خطوط منتصف الطريق المتقطعة (InstancedMesh واحد)
  const dashGeo = new THREE.PlaneGeometry(0.4, 3); dashGeo.rotateX(-Math.PI / 2);
  const dashPts = [];
  for (const r of ROADS) for (let t = -110; t <= 110; t += 7) {
    if (ROADS.some((q) => Math.abs(t - q) < 8)) continue;
    dashPts.push([t, r, Math.PI / 2]); dashPts.push([r, t, 0]);
  }
  const dashes = new THREE.InstancedMesh(dashGeo, new THREE.MeshBasicMaterial({ color: 0xf0e6a0 }), dashPts.length);
  const dummy = new THREE.Object3D();
  dashPts.forEach((d, i) => { dummy.position.set(d[0], 0.1, d[1]); dummy.rotation.set(0, d[2], 0); dummy.updateMatrix(); dashes.setMatrixAt(i, dummy.matrix); });
  scene.add(dashes);
  // المباني داخل البلوكات (لا على التقاطعات) — وسط المدينة أعلى
  const palette = ['#ff8fb3', '#5ec8c8', '#ffd166', '#ff9a5a', '#b388ff', '#7ddb8a', '#f2f2f2', '#ff6b6b'];
  const special = new Set(['-60,60', '60,-60', '-60,-60']);
  for (const cx of BLOCKS) for (const cz of BLOCKS) {
    if (special.has(cx + ',' + cz)) continue;
    const downtown = Math.abs(cx) <= 20 && Math.abs(cz) <= 20;
    const w = rand(14, 22), d = rand(14, 22), h = downtown ? rand(24, 44) : rand(8, 22);
    addBuilding(cx + rand(-2, 2), cz + rand(-2, 2), w, d, h, palette[Math.floor(Math.random() * palette.length)]);
  }
  // مبنى المستشفى (أبيض + صليب) ومتجر السلاح (أحمر) خلف مناطقهما
  addBuilding(HOSPITAL.x, HOSPITAL.z - 12, 20, 10, 14, '#f4f6f8');
  const crossMat = new THREE.MeshLambertMaterial({ color: 0xe02a2a, emissive: 0x551111 });
  const c1 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 5), crossMat); c1.position.set(HOSPITAL.x, 14.8, HOSPITAL.z - 12); scene.add(c1);
  const c2 = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 1.6), crossMat); c2.position.set(HOSPITAL.x, 14.8, HOSPITAL.z - 12); scene.add(c2);
  addBuilding(SHOP.x, SHOP.z - 12, 14, 8, 7, '#ff6b6b');
  // نخيل (لا داخل المباني)
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x2fae5a });
  for (let i = 0; i < 60; i++) {
    const x = rand(-105, 100), z = rand(-105, 105);
    if (ROADS.some((r) => Math.abs(z - r) < 4) || ROADS.some((r) => Math.abs(x - r) < 4)) continue;
    if (!pointFree(x, z, 2)) continue;
    if (Object.values(ZONES).some((Z) => Math.abs(x - Z.x) < Z.w / 2 + 2 && Math.abs(z - Z.z) < Z.h / 2 + 2)) continue;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 5, 6), trunkMat);
    trunk.position.set(x, 2.5, z); trunk.castShadow = true; scene.add(trunk);
    const top = new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 0), leafMat);
    top.position.set(x, 5.6, z); top.scale.y = 0.7; top.castShadow = true; scene.add(top);
  }
  // أعمدة إنارة
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x222831 });
  for (const r of ROADS) for (let k = -100; k <= 100; k += 40) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6, 6), poleMat);
    pole.position.set(k, 3, r + 6); scene.add(pole);
    const lampMat = new THREE.MeshLambertMaterial({ color: 0x555533, emissive: 0x000000 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), lampMat);
    lamp.position.set(k, 6.2, r + 6); scene.add(lamp); lampMats.push(lampMat);
  }
  for (const [name, x, z] of DISTRICTS) { const sp = labelSprite(name); sp.position.set(x, 30, z); scene.add(sp); }
  // مناطق الكراج والمتجر والمستشفى
  for (const Z of Object.values(ZONES)) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(Z.w, Z.h), new THREE.MeshLambertMaterial({ color: Z.color }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(Z.x, 0.12, Z.z); scene.add(pad);
    const lb = labelSprite(Z.label, 0.9); lb.position.set(Z.x, 10, Z.z); scene.add(lb);
  }
  const gBox = new THREE.Mesh(new THREE.BoxGeometry(GARAGE.w, 3, 1), new THREE.MeshLambertMaterial({ color: 0x333a4a }));
  gBox.position.set(GARAGE.x, 1.5, GARAGE.z - GARAGE.h / 2); scene.add(gBox);
}
buildCity();

/* ---------- الكيانات ---------- */
const playerGroup = new THREE.Group(); scene.add(playerGroup);
const carGroup = new THREE.Group(); scene.add(carGroup);
const npcGroup = new THREE.Group(); scene.add(npcGroup);
const fxGroup = new THREE.Group(); scene.add(fxGroup);
const cars = [];
const npcs = [];
const pickups = [];
const booms = [];
const tracers = [];
const carById = (id) => cars.find((c) => c.id === id);

function makePlayerMesh(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.4, 0.7), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 1.1; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), new THREE.MeshLambertMaterial({ color: 0xffd9b3 }));
  head.position.y = 2.2; head.castShadow = true; g.add(head);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.46, 0.18, 12), new THREE.MeshLambertMaterial({ color }));
  cap.position.y = 2.5; g.add(cap);
  const legMat = new THREE.MeshLambertMaterial({ color: 0x223044 });
  const l1 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), legMat); l1.position.set(-0.28, 0.4, 0); l1.castShadow = true; g.add(l1);
  const l2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), legMat); l2.position.set(0.28, 0.4, 0); l2.castShadow = true; g.add(l2);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 1.0), new THREE.MeshLambertMaterial({ color: 0x222222 }));
  gun.position.set(0.5, 1.35, 0.6); g.add(gun);
  // حلقة ملوّنة تحت اللاعب ليسهل تمييزه في المدينة
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.8, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
  g.userData.legs = [l1, l2]; g.userData.gun = gun;
  return g;
}
function spawnPoint(slot) {
  const spots = [[-6, -6], [6, -6], [-6, 6], [6, 6], [0, -10], [0, 10]];
  const s = spots[(slot - 1) % spots.length];
  return { x: s[0], z: s[1] };
}
function resetPlayerState(p) {
  const sp = spawnPoint(p.slot);
  Object.assign(p, {
    x: sp.x, z: sp.z, y: 0, vy: 0, angle: Math.PI, money: 500, stars: 0, inCar: null, lastCrime: -99, decayAt: 0,
    punchCd: 0, bustT: 0, hp: 100, armor: 0, weapons: ['fists', 'pistol'], ammo: { pistol: { mag: 12, res: 36 } }, wi: 1,
    fireCd: 0, reloadT: 0, reloading: '', dead: false, deadT: 0, hurtT: 0, kills: 0, moving: false, safeT: 0, zoneNow: '',
  });
  p.mesh.rotation.x = 0; p.mesh.visible = true;
}
function addPlayer(slot, name, color) {
  if (players.has(slot)) return players.get(slot);
  const mesh = makePlayerMesh(color);
  const label = labelSprite(name || ('لاعب ' + slot), 0.45);
  label.position.y = 3.6; mesh.add(label);
  playerGroup.add(mesh);
  const p = { slot, name: name || ('لاعب ' + slot), color, mesh, lastCam: null, alive: true };
  resetPlayerState(p);
  players.set(slot, p); return p;
}
function removePlayer(slot) {
  const p = players.get(slot); if (!p) return;
  if (p.inCar) { const c = carById(p.inCar); if (c) { c.driver = null; if (c.type === 'player') c.type = 'parked'; } p.inCar = null; }
  playerGroup.remove(p.mesh); players.delete(slot);
  delete inputs[slot]; delete prevInput[slot];
}

/* ---------- السيارات ---------- */
let carSeq = 0;
function makeCarMesh(color, isPolice, style) {
  const g = new THREE.Group();
  const bodyH = [0.7, 0.9, 0.55][style], cabH = [0.65, 0.8, 0.5][style], cabL = [2.2, 2.8, 1.8][style], cabW = [1.9, 1.95, 1.7][style];
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, bodyH, 4.4), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.3 + bodyH / 2; body.castShadow = true; g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cabW, cabH, cabL), new THREE.MeshLambertMaterial({ color: 0x1d2f4a }));
  cabin.position.set(0, 0.3 + bodyH + cabH / 2, style === 2 ? -0.2 : -0.3); cabin.castShadow = true; g.add(cabin);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  for (const [wx, wz] of [[-1.1, 1.4], [1.1, 1.4], [-1.1, -1.4], [1.1, -1.4]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10), wheelMat);
    w.rotation.z = Math.PI / 2; w.position.set(wx, 0.42, wz); g.add(w);
  }
  if (isPolice) {
    const lr = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.5), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    lr.position.set(-0.35, 1.6, -0.3); lr.name = 'lightR'; g.add(lr);
    const lb = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.5), new THREE.MeshBasicMaterial({ color: 0x2266ff }));
    lb.position.set(0.35, 1.6, -0.3); lb.name = 'lightB'; g.add(lb);
  }
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.8), new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0, side: THREE.DoubleSide }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.06; glow.name = 'neon'; g.add(glow);
  const hl = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff6b0 }));
  hl.position.set(-0.7, 0.6, 2.25); g.add(hl);
  const hl2 = hl.clone(); hl2.position.x = 0.7; g.add(hl2);
  g.userData.headlights = [hl, hl2];
  return g;
}
function addCar(type, x, z, color) {
  const isPolice = type === 'police';
  const paint = color || (isPolice ? '#ffffff' : PAINTS[Math.floor(Math.random() * PAINTS.length)]);
  const mesh = makeCarMesh(paint, isPolice, isPolice ? 0 : Math.floor(Math.random() * 3));
  mesh.position.set(x, 0, z); carGroup.add(mesh);
  const c = {
    id: ++carSeq, type, mesh, x, z, angle: rand(0, Math.PI * 2), speed: 0, color: paint, driver: null, neon: false, loop: null,
    target: null, bustT: 0, hp: isPolice ? 120 : 100, lastAttacker: null, fireCd: rand(0, 1), avoidT: 0, avoidDir: 1,
    cleanup: 0, wreckT: 0, cruise: 0,
  };
  cars.push(c); return c;
}
function removeCar(c) { carGroup.remove(c.mesh); const i = cars.indexOf(c); if (i >= 0) cars.splice(i, 1); }
function pickLoop() {
  const r = ROADS[Math.floor(Math.random() * ROADS.length)];
  return { horiz: Math.random() < 0.5, road: r, dir: Math.random() < 0.5 ? 1 : -1 };
}
function trafficLane(c) { // السير يميناً: لكل اتجاه حارته
  const L = c.loop, off = 2.5 * L.dir * (L.horiz ? 1 : -1);
  if (L.horiz) { c.z = L.road + off; c.angle = L.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
  else { c.x = L.road + off; c.angle = L.dir > 0 ? 0 : Math.PI; }
}
function spawnTraffic(atEdge) {
  const c = addCar('traffic', 0, 0); c.loop = pickLoop(); c.cruise = rand(8, 13); c.speed = c.cruise;
  const t = atEdge ? -108 * c.loop.dir : rand(-100, 100);
  if (c.loop.horiz) c.x = t; else c.z = t;
  trafficLane(c); return c;
}
function spawnParked() {
  const r = ROADS[Math.floor(Math.random() * ROADS.length)], side = Math.random() < 0.5 ? 5.6 : -5.6, t = rand(-100, 95);
  const horiz = Math.random() < 0.5;
  const c = addCar('parked', horiz ? t : r + side, horiz ? r + side : t);
  c.angle = horiz ? (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2) : (Math.random() < 0.5 ? 0 : Math.PI);
  return c;
}
for (let i = 0; i < 12; i++) spawnParked();
for (let i = 0; i < 10; i++) spawnTraffic(false);

/* ---------- المشاة ---------- */
const NPC_COLORS = ['#e8e8e8', '#ffd166', '#7ddb8a', '#ff8fb3'];
function addNpc() {
  const g = new THREE.Group();
  const col = NPC_COLORS[Math.floor(Math.random() * NPC_COLORS.length)];
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.6), new THREE.MeshLambertMaterial({ color: col }));
  body.position.y = 1.05; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), new THREE.MeshLambertMaterial({ color: 0xe8b98a }));
  head.position.y = 2; g.add(head);
  npcGroup.add(g);
  const sp = randomFreeSpot(1);
  const n = {
    mesh: g, x: sp.x, z: sp.z, angle: Math.floor(rand(0, 4)) * Math.PI / 2, speed: rand(1.2, 2.2), hp: 50, down: 0, flee: 0,
    fleeFrom: null, dead: false, deadT: 0, turnT: rand(1, 5), bounty: false, killer: null, marker: null, baseColor: col,
  };
  npcs.push(n); return n;
}
for (let i = 0; i < 24; i++) addNpc();

/* ---------- العناصر الملتقطة: فلوس / صحة / درع ---------- */
const PICK = {
  cash: { color: 0x22ff88, emissive: 0x00aa44, value: 50, css: '#22ff88', size: [1.4, 0.5, 1.4] },
  health: { color: 0xff4d6d, emissive: 0xaa1133, value: 35, css: '#ff4d6d', size: [1, 1, 1] },
  armor: { color: 0x4da3ff, emissive: 0x1144aa, value: 50, css: '#4da3ff', size: [1.1, 1.1, 0.5] },
};
function addPickup(kind, x, z, opts = {}) {
  const P = PICK[kind];
  const m = new THREE.Mesh(new THREE.BoxGeometry(P.size[0], P.size[1], P.size[2]), new THREE.MeshLambertMaterial({ color: P.color, emissive: P.emissive }));
  m.position.set(x, 0.8, z); fxGroup.add(m);
  const k = { mesh: m, x, z, kind, value: opts.value || P.value, taken: false, respawnAt: 0, temp: !!opts.temp, expire: opts.temp ? performance.now() / 1000 + 30 : 0 };
  pickups.push(k); return k;
}
for (let i = 0; i < 12; i++) { const s = randomFreeSpot(); addPickup('cash', s.x, s.z); }
for (let i = 0; i < 6; i++) { const s = randomFreeSpot(); addPickup('health', s.x, s.z); }
for (let i = 0; i < 4; i++) { const s = randomFreeSpot(); addPickup('armor', s.x, s.z); }

/* علامة المهمة */
const checkpoint = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 6, 20, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
checkpoint.position.y = 3; checkpoint.visible = false; scene.add(checkpoint);
const checkpointTop = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 3, 5, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5 }));
checkpointTop.position.y = 8; checkpointTop.visible = false; scene.add(checkpointTop);
/* حلقة التصويب المساعد على الهدف */
const aimRing = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.25, 20), new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
aimRing.rotation.x = -Math.PI / 2; aimRing.visible = false; scene.add(aimRing);

/* ---------- التصادم مع المباني والأشعة ---------- */
function collideBuildings(x, z, r) {
  for (const b of colliders) {
    const dx = x - clamp(x, b.x - b.hw, b.x + b.hw);
    const dz = z - clamp(z, b.z - b.hd, b.z + b.hd);
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 < 1e-6) { x = b.x + b.hw + r; continue; }
      const d = Math.sqrt(d2);
      x += (dx / d) * (r - d); z += (dz / d) * (r - d);
    }
  }
  return { x, z };
}
function rayAABB(ox, oz, dx, dz, b) { // مسافة دخول الشعاع للصندوق أو Infinity
  let tmin = 0, tmax = Infinity;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let t1 = (lo - o) / d, t2 = (hi - o) / d; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); return tmin <= tmax;
  };
  if (!slab(ox, dx, b.x - b.hw, b.x + b.hw)) return Infinity;
  if (!slab(oz, dz, b.z - b.hd, b.z + b.hd)) return Infinity;
  return tmin;
}
function wallDist(ox, oz, dx, dz, maxD) {
  let best = maxD;
  for (const b of colliders) { const t = rayAABB(ox, oz, dx, dz, b); if (t < best) best = t; }
  return best;
}

/* ---------- المهام ---------- */
function randomRoadPoint() {
  const r = ROADS[Math.floor(Math.random() * ROADS.length)];
  if (Math.random() < 0.5) return { x: rand(-100, 95), z: r };
  return { x: r, z: rand(-100, 100) };
}
function setMarker(x, z) {
  checkpoint.position.set(x, 3, z); checkpoint.visible = true;
  checkpointTop.position.set(x, 8, z); checkpointTop.visible = true;
}
function hideMarker() { checkpoint.visible = false; checkpointTop.visible = false; }
function makeBounty(n) {
  n.bounty = true; n.hp = 120; n.dead = false;
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.4, 6), new THREE.MeshBasicMaterial({ color: 0xff2233 }));
  m.rotation.x = Math.PI; m.position.y = 3.6; n.mesh.add(m); n.marker = m;
  n.mesh.children[0].material.color.set('#c0392b');
}
function clearBounty() {
  for (const n of npcs) if (n.bounty) {
    n.bounty = false;
    if (n.marker) { n.mesh.remove(n.marker); n.marker = null; }
    n.mesh.children[0].material.color.set(n.baseColor);
  }
}
function bountyBar() {
  if (!mission || mission.type !== 'bounty') return;
  const left = mission.targets.filter((n) => !n.dead).length;
  $('barMid').textContent = '🎯 مطلوبون — تبقّى ' + left + ' من ' + mission.targets.length + ' (+$1500)';
}
function startMission(type) {
  missionType = type; clearBounty();
  document.querySelectorAll('.mBtn').forEach((b) => b.classList.toggle('sel', b.dataset.m === type));
  if (type === 'free') {
    mission = null; hideMarker(); $('barMid').textContent = '🌴 تجول حر';
  } else if (type === 'courier') {
    const pt = randomRoadPoint();
    mission = { type: 'courier', idx: 0, x: pt.x, z: pt.z, timeLeft: 0 };
    setMarker(pt.x, pt.z);
    $('barMid').textContent = '📦 مهمة توصيل — أوصل للنقطة الصفراء (+$600)';
    showToast('📦 مهمة توصيل جديدة! أوصل للنقطة الصفراء');
  } else if (type === 'race') {
    const cps = [];
    for (let i = 0; i < 9; i++) cps.push(randomRoadPoint());
    mission = { type: 'race', idx: 0, x: cps[0].x, z: cps[0].z, timeLeft: 120, checkpoints: cps };
    setMarker(cps[0].x, cps[0].z);
    $('barMid').textContent = '🏁 سباق — النقطة 1 من 9 • ⏱ 120 ثانية';
    showToast('🏁 بدأ السباق! 9 نقاط خلال 120 ثانية');
  } else if (type === 'bounty') {
    const cand = npcs.filter((n) => !n.dead);
    const targets = [];
    for (let i = 0; i < 3 && cand.length; i++) { const n = cand.splice(Math.floor(Math.random() * cand.length), 1)[0]; makeBounty(n); targets.push(n); }
    mission = { type: 'bounty', targets, x: 0, z: 0 };
    hideMarker(); bountyBar();
    showToast('🎯 مهمة جديدة: اقضِ على المطلوبين الثلاثة (أصحاب العلامة الحمراء)');
  }
}
function missionReached(p) {
  if (!mission) return;
  if (mission.type === 'courier') {
    p.money += 600; sfxMission();
    showToast('📦 ' + p.name + ' أكمل التوصيل! +$600');
    const pt = randomRoadPoint(); mission.x = pt.x; mission.z = pt.z; setMarker(pt.x, pt.z);
  } else if (mission.type === 'race') {
    mission.idx++; p.money += 100;
    if (mission.idx >= 9) {
      p.money += 1000; sfxMission(); mission = null; hideMarker();
      $('barMid').textContent = '🏆 ' + p.name + ' فاز بالسباق! +$1000';
      showToast('🏆 ' + p.name + ' فاز بالسباق! +$1000', 4000);
      setTimeout(() => { if (!mission) $('barMid').textContent = '🌴 تجول حر'; }, 4000);
    } else {
      const cp = mission.checkpoints[mission.idx];
      mission.x = cp.x; mission.z = cp.z; setMarker(cp.x, cp.z);
      $('barMid').textContent = '🏁 سباق — النقطة ' + (mission.idx + 1) + ' من 9 • ⏱ ' + Math.ceil(mission.timeLeft) + ' ثانية';
      sfxPickup();
    }
  }
}

/* ---------- الجريمة والشرطة ---------- */
function addWanted(p, n) {
  const now = performance.now() / 1000;
  if (p.stars > 0 && now - p.lastCrime < 2.5) { p.decayAt = now + 20; return; } // تصعيد بطيء أثناء العنف المتواصل
  const before = p.stars;
  p.stars = clamp(p.stars + n, 0, 5);
  p.lastCrime = now; p.decayAt = now + 20;
  if (p.stars > before) showToast('🚨 ' + p.name + ' مطلوب! ' + '★'.repeat(p.stars));
}
function bustPlayer(p) {
  p.money = Math.max(0, p.money - 100);
  p.stars = 0; p.bustT = 0;
  if (p.inCar) { const c = carById(p.inCar); if (c) { c.driver = null; c.type = 'parked'; c.speed = 0; } p.inCar = null; }
  const sp = spawnPoint(p.slot); p.x = sp.x; p.z = sp.z; p.y = 0; p.vy = 0;
  sfxBust();
  showToast('🚔 ' + p.name + ' قُبض عليه! -$100');
}
function roadPointNear(x, z, minD, maxD) {
  for (let i = 0; i < 30; i++) {
    const pt = randomRoadPoint(); const d = Math.sqrt(dist2(pt.x, pt.z, x, z));
    if (d >= minD && d <= maxD) return pt;
  }
  return randomRoadPoint();
}
const POLICE_COUNT = [0, 1, 2, 3, 4, 4];
function syncPolice() {
  const alive = [...players.values()].filter((p) => !p.dead);
  const maxStars = Math.max(0, ...alive.map((p) => p.stars));
  const want = POLICE_COUNT[maxStars];
  const most = alive.filter((p) => p.stars === maxStars)[0];
  let have = cars.filter((c) => c.type === 'police').length;
  while (have < want && most) {
    const pt = roadPointNear(most.x, most.z, 45, 80);
    const c = addCar('police', pt.x, pt.z, '#ffffff'); c.target = most.slot; have++;
  }
  while (have > want) {
    const pol = cars.filter((c) => c.type === 'police');
    pol.sort((a, b) => dist2(b.x, b.z, most ? most.x : 0, most ? most.z : 0) - dist2(a.x, a.z, most ? most.x : 0, most ? most.z : 0));
    removeCar(pol[0]); have--;
  }
  // مروحية عند 5 نجوم
  if (maxStars >= 5 && !heli) makeHeli();
  if (maxStars < 5 && heli) { scene.remove(heli.mesh); heli = null; }
}
let heli = null;
function makeHeli() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 5), new THREE.MeshLambertMaterial({ color: 0x1b2330 })); g.add(body);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 5), new THREE.MeshLambertMaterial({ color: 0x1b2330 })); tail.position.z = -4.5; g.add(tail);
  const rotor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.12, 0.5), new THREE.MeshBasicMaterial({ color: 0x889099 })); rotor.position.y = 1.4; rotor.name = 'rotor'; g.add(rotor);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3344 })); lamp.position.set(0, -1.1, 2); g.add(lamp);
  g.position.set(0, 24, 0); scene.add(g);
  heli = { mesh: g, x: 0, z: 0, ang: 0, fireCd: 2 };
  const t = [...players.values()].filter((p) => !p.dead).sort((a, b) => b.stars - a.stars)[0];
  if (t) { heli.x = t.x + 40; heli.z = t.z; }
  showToast('🚁 مروحية الشرطة وصلت!');
}

/* ---------- القتال ---------- */
function damagePlayer(p, amt) {
  if (p.dead || amt <= 0) return;
  if (p.armor > 0) { const a = Math.min(p.armor, amt * 0.7); p.armor -= a; amt -= a; }
  p.hp -= amt; p.hurtT = 0.35; sfxHurt();
  if (p.hp <= 0) killPlayer(p);
}
function killPlayer(p) {
  p.hp = 0; p.dead = true; p.deadT = 3.5;
  if (p.inCar) { const c = carById(p.inCar); if (c) { c.driver = null; if (c.type === 'player') c.type = 'parked'; c.speed = 0; } p.inCar = null; }
  p.mesh.visible = true; p.mesh.rotation.x = Math.PI / 2;
  showToast('☠️ ' + p.name + ' سقط! يُنقل إلى المستشفى…', 3000); sfxBust();
}
function respawnPlayer(p) {
  p.dead = false; p.hp = 100; p.armor = 0; p.stars = 0; p.bustT = 0; p.mesh.rotation.x = 0;
  p.money = Math.max(0, p.money - 200);
  p.x = HOSPITAL.x; p.z = HOSPITAL.z; p.y = 0; p.vy = 0;
  showToast('🏥 ' + p.name + ' خرج من المستشفى — رسوم العلاج -$200');
}
function hurtNpc(n, amt, bySlot, knock) {
  if (n.dead) return;
  const by = bySlot ? players.get(bySlot) : null;
  n.hp -= amt; n.flee = 8; n.fleeFrom = by ? { x: by.x, z: by.z } : null;
  if (knock) n.down = knock;
  if (by) addWanted(by, 1);
  if (n.hp <= 0) {
    n.dead = true; n.deadT = 7; n.down = 0; n.killer = bySlot || null;
    if (by) { by.kills++; addWanted(by, 1); }
    addPickup('cash', n.x, n.z, { value: Math.floor(rand(30, 110)), temp: true });
    if (mission && mission.type === 'bounty' && n.bounty) bountyBar();
  }
}
function damageCar(c, amt, bySlot) {
  if (c.type === 'wreck' || amt <= 0) return;
  c.hp -= amt; if (bySlot) c.lastAttacker = bySlot;
  if (c.hp <= 0) destroyCar(c);
}
function destroyCar(c) {
  const wasPolice = c.type === 'police', wasTraffic = c.type === 'traffic';
  const by = c.lastAttacker ? players.get(c.lastAttacker) : null;
  if (c.driver) {
    const dp = players.get(c.driver);
    if (dp) { dp.inCar = null; dp.mesh.visible = true; dp.x = c.x + Math.cos(c.angle) * 3; dp.z = c.z - Math.sin(c.angle) * 3; }
    c.driver = null;
  }
  c.type = 'wreck'; c.speed = 0; c.wreckT = 8;
  c.mesh.children[0].material.color.set('#1a1a1a'); c.mesh.children[0].material.emissive.setHex(0x000000);
  explode(c.x, c.z, c.lastAttacker);
  if (by) {
    if (wasPolice) { by.money += 150; addWanted(by, 2); showToast('💥 ' + by.name + ' دمّر سيارة شرطة! +$150'); }
    else if (wasTraffic) addWanted(by, 1);
  }
}
function explode(x, z, bySlot) {
  sfxBoom();
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0.9 }));
  m.position.set(x, 1.5, z); fxGroup.add(m); booms.push({ mesh: m, t: 0 });
  for (const p of players.values()) {
    if (p.dead || p.inCar) continue;
    const d = Math.sqrt(dist2(p.x, p.z, x, z)); if (d < 7) damagePlayer(p, 45 * (1 - d / 7) + 5);
  }
  for (const n of npcs) if (!n.dead && dist2(n.x, n.z, x, z) < 49) hurtNpc(n, 90, bySlot);
  for (const c of cars) if (c.type !== 'wreck' && dist2(c.x, c.z, x, z) < 49) damageCar(c, 35, bySlot);
}
const tracerGeo = new THREE.BoxGeometry(0.08, 0.08, 1);
const tracerMats = { y: new THREE.MeshBasicMaterial({ color: 0xffee88 }), r: new THREE.MeshBasicMaterial({ color: 0xff6666 }) };
function tracer(x1, z1, x2, z2, kind) {
  const len = Math.hypot(x2 - x1, z2 - z1); if (len < 0.5) return;
  const m = new THREE.Mesh(tracerGeo, tracerMats[kind || 'y']);
  m.position.set((x1 + x2) / 2, 1.4, (z1 + z2) / 2); m.scale.z = len; m.rotation.y = Math.atan2(x2 - x1, z2 - z1);
  fxGroup.add(m); tracers.push({ mesh: m, t: 0.07 });
}
function startReload(p, w) {
  const am = p.ammo[w], W = WEAPONS[w];
  if (!am || p.reloadT > 0 || am.mag >= W.mag || am.res <= 0) return;
  p.reloadT = W.reload; p.reloading = w; sfxReload();
}
function finishReload(p) {
  const am = p.ammo[p.reloading], W = WEAPONS[p.reloading];
  if (am && W) { const take = Math.min(W.mag - am.mag, am.res); am.mag += take; am.res -= take; }
  p.reloading = '';
}
function findTarget(p, range) {
  let best = null, bestScore = Infinity;
  const consider = (obj, x, z, w) => {
    const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz); if (d > range || d < 0.5) return;
    const da = Math.abs(angDiff(Math.atan2(dx, dz), p.angle));
    if (p.moving && da > 1.0) return; // أثناء الحركة: مخروط أمامي فقط
    if (wallDist(p.x, p.z, dx / d, dz / d, d) < d - 0.5) return; // لا تصويب عبر المباني
    const score = d * (1 + da * 1.5) * w;
    if (score < bestScore) { bestScore = score; best = { obj, x, z, d }; }
  };
  for (const n of npcs) if (!n.dead && n.down <= 0) consider(n, n.x, n.z, n.bounty ? 0.5 : (p.stars > 0 ? 1.3 : 1));
  for (const c of cars) if (c.type === 'police') consider(c, c.x, c.z, p.stars > 0 ? 0.5 : 0.8);
  return best;
}
function fireRay(p, ox, oz, ang, W) {
  const dx = Math.sin(ang), dz = Math.cos(ang);
  let best = Math.min(W.range, wallDist(ox, oz, dx, dz, W.range)), hit = null;
  const consider = (obj, x, z, rad, kind) => {
    const vx = x - ox, vz = z - oz, t = vx * dx + vz * dz; if (t < 0 || t > best) return;
    if (Math.abs(vx * dz - vz * dx) < rad) { best = t; hit = { obj, kind }; }
  };
  for (const n of npcs) if (!n.dead) consider(n, n.x, n.z, 0.9, 'npc');
  for (const c of cars) if (c.type !== 'wreck' && c.type !== 'player') consider(c, c.x, c.z, 2.0, 'car');
  if (hit) {
    if (hit.kind === 'npc') hurtNpc(hit.obj, W.dmg, p.slot, hit.obj.hp - W.dmg > 0 ? 0.6 : 0);
    else {
      const c = hit.obj;
      if (c.type === 'police') addWanted(p, 2); else if (c.type === 'traffic') addWanted(p, 1);
      damageCar(c, W.dmg, p.slot);
    }
  }
  tracer(ox, oz, ox + dx * best, oz + dz * best, 'y');
}
function shoot(p, wname) {
  const W = WEAPONS[wname], am = p.ammo[wname];
  if (!am || am.mag <= 0) {
    if (am && am.res > 0) startReload(p, wname); else showToast('❌ بلا ذخيرة: ' + W.name + ' — اشترِ من المتجر', 1500);
    p.fireCd = 0.4; return;
  }
  am.mag--; p.fireCd = W.rate; sfxShot(wname);
  const tgt = findTarget(p, W.range);
  if (tgt) p.angle = Math.atan2(tgt.x - p.x, tgt.z - p.z);
  else if (!p.moving && camMode === 'chase' && p === focusP) p.angle = camHeading; // أطلق باتجاه الكاميرا
  const ox = p.x + Math.sin(p.angle) * 0.8, oz = p.z + Math.cos(p.angle) * 0.8;
  for (let i = 0; i < W.pellets; i++) fireRay(p, ox, oz, p.angle + (Math.random() - 0.5) * 2 * W.spread, W);
  for (const n of npcs) if (!n.dead && dist2(n.x, n.z, p.x, p.z) < 900) { n.flee = Math.max(n.flee, 4); n.fleeFrom = { x: p.x, z: p.z }; }
  if (am.mag === 0 && am.res > 0) startReload(p, wname);
}
function doPunch(p) {
  if (p.punchCd > 0) return;
  p.punchCd = 0.5; sfxPunch();
  for (const n of npcs) {
    if (n.dead || n.down > 0) continue;
    if (dist2(p.x, p.z, n.x, n.z) < 9) { hurtNpc(n, 20, p.slot, 2); break; }
  }
}

/* ---------- المتجر والمستشفى والكراج ---------- */
function shopBuyWeapon(p) {
  const next = ['smg', 'shotgun'].find((w) => !p.weapons.includes(w));
  if (!next) { // امتلك كل شيء: تعبئة ذخيرة كل الأسلحة
    if (p.money < 150) return showToast('💵 تحتاج $150 لتعبئة الذخيرة');
    p.money -= 150;
    for (const w of Object.keys(p.ammo)) { p.ammo[w].res = WEAPONS[w].pack * 3; p.ammo[w].mag = WEAPONS[w].mag; }
    sfxPickup(); return showToast('📦 ذخيرة مليئة لكل الأسلحة! -$150');
  }
  const W = WEAPONS[next];
  if (p.money < W.cost) return showToast('💵 ' + W.name + ' بسعر $' + W.cost);
  p.money -= W.cost; p.weapons.push(next); p.ammo[next] = { mag: W.mag, res: W.pack * 2 }; p.wi = p.weapons.length - 1;
  sfxPickup(); showToast('🔫 اشتريت ' + W.name + '! -$' + W.cost);
}
function shopBuyAmmo(p) {
  const w = p.weapons[p.wi], W = WEAPONS[w];
  if (W.melee) return showToast('اختر سلاحاً ناريّاً أولاً (زر 🔄)');
  if (p.money < 100) return showToast('💵 تحتاج $100 للذخيرة');
  p.money -= 100; p.ammo[w].res += W.pack; sfxPickup(); showToast('📦 +' + W.pack + ' طلقة ' + W.name + ' -$100');
}
function shopBuyArmor(p) {
  if (p.armor >= 100) return showToast('🛡 الدرع ممتلئ');
  if (p.money < 300) return showToast('💵 تحتاج $300 للدرع');
  p.money -= 300; p.armor = 100; sfxPickup(); showToast('🛡 درع كامل! -$300');
}

/* ---------- بدء / إعادة / ردهة ---------- */
let snapCam = true;
function ensurePlayers() {
  if (roomPlayers.length) {
    for (const rp of roomPlayers) addPlayer(rp.slot, rp.name, rp.color);
    for (const slot of [...players.keys()]) if (!roomPlayers.some((q) => q.slot === slot)) removePlayer(slot);
  } else if (!players.size) {
    addPlayer(1, 'لاعب 1', COLORS[0]); // لاعب لوحة المفاتيح للاختبار
  }
}
function startGame(mtype) {
  ensureAudio(); ensurePlayers();
  phase = 'playing'; paused = false; snapCam = true;
  $('lobby').hidden = true; $('game').hidden = false;
  $('barPhase').textContent = 'تلعب الآن';
  resize();
  startMission(mtype || missionType);
  showToast('🌴 أهلاً بكم في ميامي! اجمعوا الفلوس وانتبهوا للشرطة');
}
function restartGame() {
  for (const p of players.values()) resetPlayerState(p);
  for (const c of [...cars]) if (c.type === 'police') removeCar(c);
  for (const c of cars) if (c.driver || c.type === 'player') { c.driver = null; c.type = 'parked'; }
  if (heli) { scene.remove(heli.mesh); heli = null; }
  phase = 'playing'; paused = false; snapCam = true;
  $('overlay').hidden = true; $('barPhase').textContent = 'تلعب الآن';
  startMission(missionType);
}
function toLobby() {
  phase = 'lobby'; paused = false;
  $('game').hidden = true; $('lobby').hidden = false; $('overlay').hidden = true;
  renderSlots();
}
$('startBtn').addEventListener('click', () => startGame(missionType));
$('ovRestart').addEventListener('click', () => restartGame());
$('ovLobby').addEventListener('click', () => toLobby());
$('missionBtn').addEventListener('click', () => startMission(missionType));
$('pauseBtn').addEventListener('click', () => handleControl('pause'));
$('restartBtn').addEventListener('click', () => restartGame());
$('lobbyBtn').addEventListener('click', () => toLobby());
document.querySelectorAll('.mBtn').forEach((b) => b.addEventListener('click', () => {
  missionType = b.dataset.m;
  document.querySelectorAll('.mBtn').forEach((q) => q.classList.toggle('sel', q === b));
  if (phase === 'playing') startMission(missionType);
}));

/* ---------- لوحة المفاتيح + الفأرة (للاختبار على التلفاز) ---------- */
const keys = {};
let kbCam = 0, camPref = 'auto'; // auto | group | chase
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyM' && phase === 'playing') {
    const order = ['courier', 'race', 'bounty'];
    startMission(order[(order.indexOf(missionType) + 1) % order.length]);
  }
  if (e.code === 'KeyC') {
    camPref = camPref === 'auto' ? 'group' : camPref === 'group' ? 'chase' : 'auto';
    showToast('📷 الكاميرا: ' + { auto: 'تلقائية', group: 'مجموعة (علوية)', chase: 'خلف اللاعب' }[camPref]);
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('pointermove', (e) => { if (e.buttons & 1) kbCam += (e.movementX || 0) * 0.006; });
function keyboardInput() {
  return {
    x: ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0),
    y: ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0),
    jump: !!keys.Space, action: !!keys.KeyE, punch: !!keys.KeyF,
    run: !!(keys.ShiftLeft || keys.ShiftRight),
    fire: !!(keys.KeyG || keys.Enter), swap: !!keys.KeyQ, cam: kbCam,
  };
}

/* ---------- التحديث ---------- */
let lastT = performance.now();
let hudTimer = 0;
let stepCount = 0;

function step(dt) {
  stepCount++;
  const now = performance.now() / 1000;
  dayT = (dayT + dt / 120) % 1; // دورة نهار/ليل كاملة كل دقيقتين
  updateDayNight();
  if (phase !== 'playing' || paused) { renderFrame(dt, now); return; }

  ensurePlayers();
  if (keys.KeyZ) kbCam -= 2 * dt;
  if (keys.KeyX) kbCam += 2 * dt;
  if (!roomPlayers.some((q) => q.slot === 1) || !inputs[1]) inputs[1] = keyboardInput();
  updateCameraMode();
  updateMission(dt);
  for (const p of players.values()) updatePlayer(p, dt, now);
  updateTraffic(dt);
  updateCarCollisions();
  updateNpcs(dt);
  updatePickups(dt, now);
  updatePolice(dt);
  updateFx(dt);
  syncMeshes(now);
  renderFrame(dt, now);
}

function updateMission(dt) {
  if (!mission) return;
  if (mission.type === 'race') {
    mission.timeLeft -= dt;
    $('barMid').textContent = '🏁 سباق — النقطة ' + (mission.idx + 1) + ' من 9 • ⏱ ' + Math.max(0, Math.ceil(mission.timeLeft)) + ' ثانية';
    if (mission.timeLeft <= 0) { mission = null; hideMarker(); $('barMid').textContent = '🌴 تجول حر'; showToast('⏱ انتهى وقت السباق!'); }
  } else if (mission.type === 'bounty' && mission.targets.every((n) => n.dead)) {
    const slot = mission.targets.map((n) => n.killer).filter(Boolean).pop();
    const p = slot ? players.get(slot) : null;
    if (p) { p.money += 1500; showToast('🎯 ' + p.name + ' أنهى المطلوبين! +$1500', 4000); } else showToast('🎯 انتهت المهمة', 3000);
    sfxMission(); clearBounty(); mission = null; $('barMid').textContent = '🌴 تجول حر';
  }
}

function enterNearestCar(p) {
  let best = null, bestD = 25;
  for (const c of cars) {
    if (c.type === 'police' || c.type === 'wreck' || c.driver) continue;
    const d = dist2(p.x, p.z, c.x, c.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return;
  if (best.type === 'traffic') { addWanted(p, 1); best.loop = null; }
  best.driver = p.slot; best.type = 'player'; best.speed = 0; p.inCar = best.id; p.reloadT = 0;
}
function zoneHint(p, name, msg) {
  if (p.zoneNow === name) return;
  p.zoneNow = name; if (name) showToast(msg, 4500);
}

function updatePlayer(p, dt, now) {
  const inp = inputs[p.slot] || {};
  const prev = prevInput[p.slot] || {};
  const edge = (k) => !!inp[k] && !prev[k];
  const actionEdge = edge('action'), punchEdge = edge('punch'), fireEdge = edge('fire'), swapEdge = edge('swap');
  prevInput[p.slot] = { ...inp };
  const ix = Number(inp.x) || 0, iy = Number(inp.y) || 0;
  // تدوير الكاميرا بالسحب (الهاتف يرسل مجموع الزاوية)
  const camNow = Number(inp.cam) || 0;
  if (p.lastCam === null) p.lastCam = camNow;
  const camDelta = clamp(camNow - p.lastCam, -2, 2); p.lastCam = camNow;
  if (camDelta && camMode === 'chase' && p === focusP) { camHeading -= camDelta; lastLookT = now; }
  if (p.hurtT > 0) p.hurtT -= dt;
  if (p.dead) { p.deadT -= dt; if (p.deadT <= 0) respawnPlayer(p); return; }
  if (p.punchCd > 0) p.punchCd -= dt;
  if (p.fireCd > 0) p.fireCd -= dt;
  if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) finishReload(p); }
  if (p.stars > 0 && now > p.decayAt) { p.stars--; p.decayAt = now + 12; }
  p.moving = false;

  const car = p.inCar ? carById(p.inCar) : null;
  if (p.inCar && (!car || car.type === 'wreck')) p.inCar = null;
  if (car && p.inCar) {
    car.speed = clamp(car.speed + iy * 24 * dt, -10, 30);
    if (Math.abs(iy) < 0.1) car.speed *= Math.max(0, 1 - 1.2 * dt);
    if (inp.fire) car.speed *= Math.max(0, 1 - 3.2 * dt); // فرامل يد
    car.angle += ix * clamp(car.speed / 10, -1, 1) * -1.4 * dt * (car.speed < 0 ? -1 : 1);
    car.x += Math.sin(car.angle) * car.speed * dt;
    car.z += Math.cos(car.angle) * car.speed * dt;
    const col = collideBuildings(car.x, car.z, 2.2);
    if (col.x !== car.x || col.z !== car.z) {
      const imp = Math.abs(car.speed);
      if (imp > 8) { damageCar(car, (imp - 8) * 2.5, null); sfxCrash(); }
      car.speed *= 0.4;
    }
    car.x = clamp(col.x, -WORLD, 112); car.z = clamp(col.z, -WORLD, WORLD);
    if (car.hp < 25 && car.type !== 'wreck') { // سيارة تحترق: ستنفجر قريباً
      if (!car.burning) { car.burning = true; showToast('🔥 سيارتك تحترق! انزل بسرعة'); }
      damageCar(car, 4 * dt, null);
    }
    if (car.type === 'wreck' || !p.inCar) return;
    p.x = car.x; p.z = car.z; p.angle = car.angle;
    if (inZone(GARAGE, car.x, car.z)) {
      zoneHint(p, 'garage', '🎨 الكراج: 🚗 يغيّر اللون ($200) • 👊 النيون ($150)');
      if (actionEdge) {
        if (p.money >= 200) {
          p.money -= 200;
          const ci = (PAINTS.indexOf(car.color) + 1) % PAINTS.length;
          car.color = PAINTS[ci]; car.mesh.children[0].material.color.set(car.color);
          sfxPickup(); showToast('🎨 لون جديد! -$200');
        } else showToast('💵 تحتاج $200 لتغيير اللون');
      } else if (punchEdge) {
        if (!car.neon && p.money >= 150) { p.money -= 150; car.neon = true; showToast('✨ نيون مضاء! -$150'); }
        else if (car.neon) { car.neon = false; showToast('✨ النيون مطفأ'); }
        else showToast('💵 تحتاج $150 للنيون');
      }
    } else {
      zoneHint(p, '', '');
      if (actionEdge) { // النزول من السيارة
        car.driver = null; car.type = 'parked'; p.inCar = null; car.speed = 0;
        p.x = car.x + Math.sin(car.angle + Math.PI / 2) * 3; p.z = car.z + Math.cos(car.angle + Math.PI / 2) * 3;
      }
    }
    // الدهس: سيارة اللاعب تصدم المشاة
    if (Math.abs(car.speed) > 6) for (const n of npcs) if (!n.dead && dist2(n.x, n.z, car.x, car.z) < 5) hurtNpc(n, 70, p.slot);
  } else {
    // على الأقدام: الحركة نسبةً للكاميرا
    const len = Math.hypot(ix, iy);
    if (len > 0.1) {
      p.moving = true;
      const f = Math.sin(camHeading), g = Math.cos(camHeading); // الأمام (f,g) واليمين (-g,f)
      const mx = f * iy - g * ix, mz = g * iy + f * ix, ml = Math.hypot(mx, mz) || 1;
      const sp = inp.run ? 11 : 7, k = Math.min(1, len);
      p.x += (mx / ml) * sp * k * dt; p.z += (mz / ml) * sp * k * dt;
      p.angle = Math.atan2(mx, mz);
      if (camMode === 'chase' && p === focusP && iy > 0.5 && Math.abs(ix) > 0.2 && now - lastLookT > 0.4) camHeading -= ix * 1.3 * dt;
    }
    const col = collideBuildings(p.x, p.z, 0.9);
    p.x = clamp(col.x, -WORLD, 112); p.z = clamp(col.z, -WORLD, WORLD);
    if (inp.jump && p.y === 0) p.vy = 8;
    if (p.y > 0 || p.vy !== 0) { p.vy -= 22 * dt; p.y += p.vy * dt; if (p.y <= 0) { p.y = 0; p.vy = 0; } }

    // الأسلحة
    if (swapEdge) {
      p.wi = (p.wi + 1) % p.weapons.length; p.reloadT = 0; p.reloading = '';
      const W2 = WEAPONS[p.weapons[p.wi]], am2 = p.ammo[p.weapons[p.wi]];
      showToast(W2.icon + ' ' + p.name + ': ' + W2.name + (am2 ? ' ' + am2.mag + '/' + am2.res : ''), 1200);
    }
    const wname = p.weapons[p.wi], W = WEAPONS[wname];
    if (inZone(HOSPITAL, p.x, p.z)) {
      zoneHint(p, 'hospital', '🏥 المستشفى: علاج مجاني ما دمت داخل المنطقة');
      if (p.hp < 100) p.hp = Math.min(100, p.hp + 25 * dt);
    } else if (inZone(SHOP, p.x, p.z)) {
      zoneHint(p, 'shop', '🔫 المتجر: 🚗 سلاح جديد (رشاش $800، بندقية $1200) • 🔫 ذخيرة $100 • 👊 درع $300');
      if (actionEdge) shopBuyWeapon(p); else if (fireEdge) shopBuyAmmo(p); else if (punchEdge) shopBuyArmor(p);
    } else {
      zoneHint(p, '', '');
      if (actionEdge) enterNearestCar(p);
      if (punchEdge) doPunch(p);
      if (W.melee) { if (fireEdge) doPunch(p); }
      else if ((W.auto ? inp.fire : fireEdge) && p.fireCd <= 0 && p.reloadT <= 0) shoot(p, wname);
    }
  }

  if (mission && (mission.type === 'courier' || mission.type === 'race') && dist2(p.x, p.z, mission.x, mission.z) < 16) missionReached(p);
  if (camMode === 'group') { // من ابتعد عن الكاميرا يعود قرب القائد
    if (dist2(p.x, p.z, camTarget.x, camTarget.z) > 70 * 70) {
      const leader = [...players.values()].filter((q) => !q.dead).sort((a, b) => b.money - a.money)[0];
      if (leader && leader !== p && !p.inCar) { p.x = leader.x + rand(-4, 4); p.z = leader.z + rand(-4, 4); }
    }
  }
}

/* المرور: حارات يمينية، توقف أمام العوائق */
function updateTraffic(dt) {
  let count = 0;
  for (const c of cars) {
    if (c.type !== 'traffic' || !c.loop) continue;
    count++;
    const L = c.loop, fx = L.horiz ? L.dir : 0, fz = L.horiz ? 0 : L.dir;
    let target = c.cruise;
    const blocked = (x, z, ahead, side) => { const vx = x - c.x, vz = z - c.z; const a = vx * fx + vz * fz; return a > 0 && a < ahead && Math.abs(vx * fz - vz * fx) < side; };
    for (const o of cars) { if (o !== c && blocked(o.x, o.z, 9, 2.6)) { target = 0; break; } }
    if (target) for (const p of players.values()) if (!p.inCar && !p.dead && blocked(p.x, p.z, 7, 1.8)) { target = 0; break; }
    if (target) for (const n of npcs) if (!n.dead && n.down <= 0 && blocked(n.x, n.z, 6, 1.5)) { target = 0; break; }
    c.speed += clamp(target - c.speed, -20 * dt, 6 * dt);
    if (L.horiz) { c.x += L.dir * c.speed * dt; if (c.x > 110) c.x = -110; if (c.x < -110) c.x = 110; }
    else { c.z += L.dir * c.speed * dt; if (c.z > 110) c.z = -110; if (c.z < -110) c.z = 110; }
    trafficLane(c);
  }
  if (count < 10 && Math.random() < dt * 0.8) spawnTraffic(true);
}

/* تصادم السيارات ببعضها (دائرة نصف قطرها 2.2 لكل سيارة) */
function updateCarCollisions() {
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (a.type === 'traffic' && b.type === 'traffic') continue;
    const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz;
    if (d2 > 19.36 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, overlap = 4.4 - d;
    const rel = (Math.sin(a.angle) * a.speed - Math.sin(b.angle) * b.speed) * nx + (Math.cos(a.angle) * a.speed - Math.cos(b.angle) * b.speed) * nz;
    const hard = rel > 3;
    const moveA = a.type !== 'traffic' || hard, moveB = b.type !== 'traffic' || hard;
    if (hard) { // السيارة المرورية المصدومة تتعطل في مكانها وتُزال لاحقاً
      for (const c of [a, b]) if (c.type === 'traffic') { c.type = 'parked'; c.loop = null; c.speed = 0; c.cleanup = 15; }
    }
    if (moveA) { a.x -= nx * overlap * (moveB ? 0.5 : 1); a.z -= nz * overlap * (moveB ? 0.5 : 1); }
    if (moveB) { b.x += nx * overlap * (moveA ? 0.5 : 1); b.z += nz * overlap * (moveA ? 0.5 : 1); }
    for (const c of [a, b]) { const cl = collideBuildings(c.x, c.z, 2.2); c.x = cl.x; c.z = cl.z; }
    if (hard) {
      const dmg = (rel - 3) * 2.2;
      const sa = a.driver || null, sb = b.driver || null;
      damageCar(a, dmg, sb); damageCar(b, dmg, sa);
      a.speed *= 0.6; b.speed *= 0.6; sfxCrash();
      for (const [x, y] of [[a, b], [b, a]]) if (x.driver && rel > 8 && (y.type === 'parked' || y.type === 'traffic')) { const pl = players.get(x.driver); if (pl && y.cleanup > 0) addWanted(pl, 1); }
    }
  }
}

function respawnNpc(n) {
  const s = randomFreeSpot(1); n.x = s.x; n.z = s.z; n.hp = 50; n.dead = false; n.down = 0; n.flee = 0; n.killer = null;
}
function updateNpcs(dt) {
  for (const n of npcs) {
    if (n.dead) { n.deadT -= dt; if (n.deadT <= 0 && !n.bounty) respawnNpc(n); continue; }
    if (n.down > 0) { n.down -= dt; continue; }
    if (n.bounty) { // المطلوبون يهربون من أقرب لاعب
      let near = null, nd = 900;
      for (const p of players.values()) { const d = dist2(p.x, p.z, n.x, n.z); if (!p.dead && d < nd) { nd = d; near = p; } }
      if (near) { n.flee = Math.max(n.flee, 1); n.fleeFrom = { x: near.x, z: near.z }; }
    }
    if (n.flee > 0) {
      n.flee -= dt;
      if (n.fleeFrom) n.angle = Math.atan2(n.x - n.fleeFrom.x, n.z - n.fleeFrom.z);
    } else {
      n.turnT -= dt;
      if (n.turnT <= 0) { n.angle = Math.floor(rand(0, 4)) * Math.PI / 2 + rand(-0.12, 0.12); n.turnT = rand(2, 6); }
    }
    const sp = n.flee > 0 ? 5.5 : n.speed;
    n.x += Math.sin(n.angle) * sp * dt; n.z += Math.cos(n.angle) * sp * dt;
    const col = collideBuildings(n.x, n.z, 0.7);
    if (col.x !== n.x || col.z !== n.z) { n.turnT = 0; if (n.flee > 0) n.angle += Math.PI / 2; }
    n.x = clamp(col.x, -105, 105); n.z = clamp(col.z, -105, 105);
    // دهس بسيارات المرور والشرطة
    for (const c of cars) {
      if ((c.type === 'traffic' || c.type === 'police') && c.speed > 5 && dist2(n.x, n.z, c.x, c.z) < 5) { hurtNpc(n, 70, null); break; }
    }
  }
}

function applyPickup(k, p) {
  if (k.kind === 'cash') { p.money += k.value; sfxPickup(); return true; }
  if (k.kind === 'health') { if (p.hp >= 100) return false; p.hp = Math.min(100, p.hp + k.value); sfxPickup(); return true; }
  if (k.kind === 'armor') { if (p.armor >= 100) return false; p.armor = Math.min(100, p.armor + k.value); sfxPickup(); return true; }
  return false;
}
function updatePickups(dt, now) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const k = pickups[i];
    if (k.taken) {
      if (k.temp) { fxGroup.remove(k.mesh); pickups.splice(i, 1); continue; }
      if (now > k.respawnAt) {
        const s = randomFreeSpot(); k.x = s.x; k.z = s.z; k.taken = false; k.mesh.visible = true; k.mesh.position.set(k.x, 0.8, k.z);
      }
      continue;
    }
    if (k.temp && now > k.expire) { fxGroup.remove(k.mesh); pickups.splice(i, 1); continue; }
    k.mesh.rotation.y += dt * 2; k.mesh.position.y = 0.8 + Math.sin(now * 2 + k.x) * 0.2;
    for (const p of players.values()) {
      if (p.dead || dist2(p.x, p.z, k.x, k.z) >= 4) continue;
      if (applyPickup(k, p)) { k.taken = true; k.mesh.visible = false; k.respawnAt = now + (k.kind === 'cash' ? 20 : 35); break; }
    }
  }
}

/* الشرطة: مطاردة، إطلاق نار من 3 نجوم، ومروحية عند 5 */
function updatePolice(dt) {
  syncPolice();
  const alive = [...players.values()].filter((p) => !p.dead);
  const t = alive.filter((p) => p.stars > 0).sort((a, b) => b.stars - a.stars)[0];
  for (const c of cars) {
    if (c.type !== 'police') continue;
    c.fireCd -= dt;
    const tgt = t || alive[0]; if (!tgt) continue;
    const dx = tgt.x - c.x, dz = tgt.z - c.z, d = Math.hypot(dx, dz) || 1;
    const wantAngle = Math.atan2(dx, dz) + (c.avoidT > 0 ? c.avoidDir * 0.9 : 0);
    c.angle += clamp(angDiff(wantAngle, c.angle), -2.2 * dt, 2.2 * dt);
    c.speed = clamp(c.speed + 10 * dt, 0, 15 + tgt.stars * 1.5);
    if (d < 6) c.speed = Math.min(c.speed, 8);
    c.x += Math.sin(c.angle) * c.speed * dt; c.z += Math.cos(c.angle) * c.speed * dt;
    const col = collideBuildings(c.x, c.z, 2.2);
    if (col.x !== c.x || col.z !== c.z) { c.avoidT = 0.7; c.avoidDir = Math.random() < 0.5 ? 1 : -1; }
    if (c.avoidT > 0) c.avoidT -= dt;
    c.x = clamp(col.x, -WORLD, 112); c.z = clamp(col.z, -WORLD, WORLD);
    if (tgt.stars <= 3 && d < 3) { // القبض (حتى 3 نجوم فقط؛ بعدها يطلقون النار)
      if (tgt.inCar) { c.bustT += dt; if (c.bustT > 2.5) { c.bustT = 0; bustPlayer(tgt); } }
      else { tgt.bustT += dt; if (tgt.bustT > 0.8) bustPlayer(tgt); }
    } else { c.bustT = 0; if (!tgt.inCar) tgt.bustT = Math.max(0, tgt.bustT - dt); }
    if (tgt.stars >= 3 && d < 28 && c.fireCd <= 0 && wallDist(c.x, c.z, dx / d, dz / d, d) >= d - 1) {
      c.fireCd = rand(0.7, 1.2) - tgt.stars * 0.05;
      tracer(c.x, c.z, tgt.x + rand(-1.5, 1.5), tgt.z + rand(-1.5, 1.5), 'r'); noise(0.07, 0.07, 3000);
      if (Math.random() < 0.5) {
        if (tgt.inCar) { const tc = carById(tgt.inCar); if (tc) damageCar(tc, 3 + tgt.stars, null); }
        else damagePlayer(tgt, 3 + tgt.stars);
      }
    }
  }
  for (const p of alive) { // الإفلات من الشرطة: ابتعد عنهم فتتراجع النجوم أسرع
    if (p.stars <= 0) { p.safeT = 0; continue; }
    const near = cars.some((c) => c.type === 'police' && dist2(c.x, c.z, p.x, p.z) < 85 * 85);
    if (near) p.safeT = 0; else { p.safeT += dt; if (p.safeT > 6) { p.stars--; p.safeT = 0; showToast('🕵️ ' + p.name + ' يفلت من الشرطة…'); } }
  }
  if (heli) {
    const tgt = t || alive[0];
    if (tgt) {
      heli.ang += dt * 0.7;
      const tx = tgt.x + Math.cos(heli.ang) * 16, tz = tgt.z + Math.sin(heli.ang) * 16, k = Math.min(1, dt * 1.2);
      heli.x += (tx - heli.x) * k; heli.z += (tz - heli.z) * k;
      heli.mesh.rotation.y = Math.atan2(tgt.x - heli.x, tgt.z - heli.z);
      heli.fireCd -= dt;
      if (heli.fireCd <= 0) {
        heli.fireCd = 0.6;
        tracer(heli.x, heli.z, tgt.x + rand(-2, 2), tgt.z + rand(-2, 2), 'r'); noise(0.06, 0.06, 3200);
        if (Math.random() < 0.45) { if (tgt.inCar) { const tc = carById(tgt.inCar); if (tc) damageCar(tc, 4, null); } else damagePlayer(tgt, 5); }
      }
    }
    heli.mesh.position.set(heli.x, 24, heli.z);
    const rotor = heli.mesh.getObjectByName('rotor'); if (rotor) rotor.rotation.y += dt * 30;
  }
}

/* انفجارات، رصاص مرئي، حطام، وإعادة تعويض المرور */
function updateFx(dt) {
  for (let i = booms.length - 1; i >= 0; i--) {
    const b = booms[i]; b.t += dt; const k = b.t / 0.7;
    if (k >= 1) { fxGroup.remove(b.mesh); booms.splice(i, 1); continue; }
    const s = 1 + k * 6; b.mesh.scale.set(s, s, s); b.mesh.material.opacity = 0.9 * (1 - k);
  }
  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].t -= dt; if (tracers[i].t <= 0) { fxGroup.remove(tracers[i].mesh); tracers.splice(i, 1); }
  }
  let parked = 0;
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (c.type === 'wreck') { c.wreckT -= dt; if (c.wreckT <= 0) removeCar(c); continue; }
    if (c.type === 'parked') {
      if (c.cleanup > 0) { c.cleanup -= dt; if (c.cleanup <= 0) { removeCar(c); continue; } }
      else parked++;
    }
  }
  if (parked < 10 && Math.random() < dt) spawnParked();
}

function syncMeshes(now) {
  for (const p of players.values()) {
    const m = p.mesh;
    m.visible = !p.inCar;
    m.position.set(p.x, p.y + (p.dead ? 0.35 : 0), p.z);
    m.rotation.y = p.angle; m.rotation.x = p.dead ? Math.PI / 2 : 0;
    const sw = p.moving && !p.dead ? Math.sin(now * 12) * 0.7 : 0;
    m.userData.legs[0].rotation.x = sw; m.userData.legs[1].rotation.x = -sw;
    m.userData.gun.visible = !p.dead && !WEAPONS[p.weapons[p.wi]].melee;
  }
  const night = isNight(), flash = Math.floor(now * 5) % 2 === 0;
  for (const c of cars) {
    c.mesh.position.set(c.x, 0, c.z); c.mesh.rotation.y = c.angle;
    const neon = c.mesh.getObjectByName('neon');
    if (neon) neon.material.opacity = c.neon ? 0.55 : 0;
    for (const h of c.mesh.userData.headlights || []) h.visible = night && c.type !== 'wreck';
    if (c.type === 'police') {
      const lr = c.mesh.getObjectByName('lightR'), lb = c.mesh.getObjectByName('lightB');
      if (lr) lr.visible = flash; if (lb) lb.visible = !flash;
    }
    if (c.type !== 'wreck') c.mesh.children[0].material.emissive.setHex(c.hp < 25 ? 0x552200 : 0x000000);
  }
  for (const n of npcs) {
    const lying = n.dead || n.down > 0;
    n.mesh.position.set(n.x, lying ? 0.3 : Math.abs(Math.sin(now * 9 + n.x)) * 0.08, n.z);
    n.mesh.rotation.y = n.angle; n.mesh.rotation.x = lying ? Math.PI / 2 : 0;
  }
  checkpoint.rotation.y += 0.016;
}

function isNight() { return dayT > 0.55 && dayT < 0.95; }
function updateDayNight() {
  const day = !isNight();
  const sunI = day ? 1.6 : 0.25;
  sun.intensity += (sunI - sun.intensity) * 0.02;
  moon.intensity += ((day ? 0 : 0.5) - moon.intensity) * 0.02;
  hemi.intensity += ((day ? 1.0 : 0.45) - hemi.intensity) * 0.02;
  const sky = day ? new THREE.Color(0x87ceeb) : new THREE.Color(0x0b1030);
  scene.background.lerp(sky, 0.02); scene.fog.color.copy(scene.background);
  const night = !day;
  for (const m of lampMats) m.emissive.setHex(night ? 0xffcc44 : 0x000000);
  for (const m of bldMats) m.emissiveIntensity += ((night ? 1 : 0) - m.emissiveIntensity) * 0.03;
  if (AC) {
    const anyWanted = [...players.values()].some((p) => p.stars > 0);
    sirenGain.gain.value = anyWanted && phase === 'playing' ? 0.04 : 0;
    const inCar = [...players.values()].some((p) => p.inCar);
    const spd = cars.filter((c) => c.driver).reduce((a, c) => a + Math.abs(c.speed), 0);
    engineGain.gain.value = inCar ? 0.035 : 0;
    engineOsc.frequency.value = 55 + spd * 4;
  }
}

/* ---------- الكاميرا: ثالث-شخص للاعب الوحيد، وعلوية لمجموعة اللاعبين ---------- */
let camMode = 'group', camHeading = Math.PI, focusP = null, lastLookT = -99;
const camTarget = new THREE.Vector3(0, 0, 0);
const camPos = { x: 0, y: 58, z: 34 }, camLook = { x: 0, y: 0, z: 0 };
function updateCameraMode() {
  const ps = [...players.values()];
  const wantChase = camPref === 'chase' || (camPref === 'auto' && ps.length === 1);
  camMode = wantChase && ps.length ? 'chase' : 'group';
  focusP = camMode === 'chase' ? ps.sort((a, b) => a.slot - b.slot)[0] : null;
}
function updateCamera(dt, now) {
  const ps = [...players.values()];
  let k = 1 - Math.exp(-dt * (camMode === 'chase' ? 9 : 3)), fovT = 55;
  if (snapCam) { k = 1; snapCam = false; }
  if (camMode === 'chase' && focusP) {
    const p = focusP, car = p.inCar ? carById(p.inCar) : null;
    if (car && Math.abs(car.speed) > 2 && now - lastLookT > 1.5) {
      camHeading = lerpAngle(camHeading, car.speed >= 0 ? car.angle : car.angle + Math.PI, 1 - Math.exp(-dt * 2.2));
    }
    const dist = car ? 17 + Math.min(Math.abs(car.speed), 30) * 0.22 : 11, height = car ? 7.5 : 5.5;
    const fx = Math.sin(camHeading), fz = Math.cos(camHeading);
    const dd = clamp(wallDist(p.x, p.z, -fx, -fz, dist + 2) - 1.2, 3.5, dist); // لا تدخل الكاميرا في المباني
    const hh = height * (0.6 + 0.4 * dd / dist);
    camPos.x += (p.x - fx * dd - camPos.x) * k; camPos.y += (hh + p.y - camPos.y) * k; camPos.z += (p.z - fz * dd - camPos.z) * k;
    camLook.x += (p.x + fx * 5 - camLook.x) * k; camLook.y += (1.8 - camLook.y) * k; camLook.z += (p.z + fz * 5 - camLook.z) * k;
    fovT = car ? 58 + Math.abs(car.speed) * 0.55 : 55;
    camTarget.x = p.x; camTarget.z = p.z;
  } else {
    camHeading = lerpAngle(camHeading, Math.PI, 1 - Math.exp(-dt * 3));
    let tx = 0, tz = 0;
    if (ps.length) { for (const p of ps) { tx += p.x; tz += p.z; } tx /= ps.length; tz /= ps.length; }
    const gk = snapCam ? 1 : Math.min(1, dt * 1.8);
    camTarget.x += (tx - camTarget.x) * gk; camTarget.z += (tz - camTarget.z) * gk;
    let spread = 0; for (const p of ps) spread = Math.max(spread, Math.sqrt(dist2(p.x, p.z, camTarget.x, camTarget.z)));
    const extra = Math.max(0, spread - 30);
    camPos.x += (camTarget.x - camPos.x) * k; camPos.y += (58 + extra * 0.9 - camPos.y) * k; camPos.z += (camTarget.z + 34 + extra * 0.5 - camPos.z) * k;
    camLook.x += (camTarget.x - camLook.x) * k; camLook.y += (0 - camLook.y) * k; camLook.z += (camTarget.z - camLook.z) * k;
  }
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(camLook.x, camLook.y, camLook.z);
  camera.fov += (fovT - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix();
  sun.position.set(camTarget.x + 60, 100, camTarget.z + 40); sun.target.position.set(camTarget.x, 0, camTarget.z);
}
function updateAimRing(dt) {
  aimRing.visible = false;
  const p = focusP; if (!p || p.dead || p.inCar || phase !== 'playing') return;
  const W = WEAPONS[p.weapons[p.wi]]; if (W.melee) return;
  const t = findTarget(p, W.range);
  if (t) { aimRing.visible = true; aimRing.position.set(t.x, 0.35, t.z); aimRing.rotation.z += dt * 3; }
}
function renderFrame(dt, now) {
  updateCameraMode();
  updateCamera(dt, now);
  updateAimRing(dt);
  renderer.render(scene, camera);
  drawMinimap();
  updateHud();
}

function drawMinimap() {
  const mm = $('minimap'); if (!mm || $('game').hidden) return;
  const g = mm.getContext('2d');
  const W = 200, S = W / 240;
  const X = (v) => (v + 120) * S;
  g.fillStyle = '#0b1526'; g.fillRect(0, 0, W, W);
  g.fillStyle = '#2e6db0'; g.fillRect(190, 0, 10, W); // البحر شرقاً
  g.fillStyle = '#f2ddab'; g.fillRect(178, 0, 12, W);
  g.strokeStyle = '#3a4556'; g.lineWidth = 5;
  for (const r of ROADS) {
    g.beginPath(); g.moveTo(0, X(r)); g.lineTo(W, X(r)); g.stroke();
    g.beginPath(); g.moveTo(X(r), 0); g.lineTo(X(r), W); g.stroke();
  }
  for (const Z of Object.values(ZONES)) { g.fillStyle = Z.css; g.fillRect(X(Z.x - Z.w / 2), X(Z.z - Z.h / 2), Z.w * S, Z.h * S); }
  for (const c of pickups) if (!c.taken) {
    g.fillStyle = PICK[c.kind].css; g.fillRect(X(c.x) - 2, X(c.z) - 2, 4, 4);
  }
  if (mission && mission.type === 'bounty') {
    g.fillStyle = '#ff2233';
    for (const n of mission.targets) if (!n.dead) { g.beginPath(); g.arc(X(n.x), X(n.z), 4.5, 0, 7); g.fill(); }
  } else if (mission) {
    g.fillStyle = '#ffd166'; g.beginPath(); g.arc(X(mission.x), X(mission.z), 6, 0, 7); g.fill();
  }
  for (const c of cars) {
    if (c.type === 'wreck') continue;
    g.fillStyle = c.type === 'police' ? '#ff2222' : (c.type === 'player' ? '#ffffff' : '#9fb0d0');
    g.beginPath(); g.arc(X(c.x), X(c.z), c.type === 'police' ? 4 : 3, 0, 7); g.fill();
  }
  if (heli) { g.fillStyle = '#4da3ff'; g.fillRect(X(heli.x) - 4, X(heli.z) - 4, 8, 8); }
  for (const p of players.values()) {
    g.fillStyle = p.dead ? '#555' : p.color; g.beginPath(); g.arc(X(p.x), X(p.z), 5, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
    if (p === focusP) { // سهم اتجاه الكاميرا
      g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath();
      g.moveTo(X(p.x), X(p.z)); g.lineTo(X(p.x) + Math.sin(camHeading) * 14, X(p.z) + Math.cos(camHeading) * 14); g.stroke();
    }
  }
}

/* ---------- الواجهة ---------- */
function gunText(p) {
  const w = p.weapons[p.wi], W = WEAPONS[w], am = p.ammo[w];
  return W.melee || !am ? '👊 ' + W.name : W.icon + ' ' + W.name + ' ' + am.mag + '/' + am.res + (p.reloadT > 0 ? ' 🔄' : '');
}
function carHpOf(p) { const c = p.inCar ? carById(p.inCar) : null; return c ? Math.max(0, Math.ceil(c.hp)) : null; }
function updateHud() {
  if ($('game').hidden) return;
  const ps = [...players.values()].sort((a, b) => b.money - a.money);
  $('chips').innerHTML = ps.map((p) => {
    const ch = carHpOf(p);
    return '<span class="chip" style="--c:' + p.color + '"><span class="dot"></span><b>' + escapeHtml(p.name) + '</b>'
      + '<span>' + moneyFmt(p.money) + '</span><span>' + '★'.repeat(p.stars) + (p.stars ? '' : '☆') + '</span>'
      + '<span>' + (p.dead ? '☠️' : '❤ ' + Math.ceil(p.hp)) + '</span>'
      + (p.armor > 0 ? '<span>🛡 ' + Math.ceil(p.armor) + '</span>' : '')
      + '<span>' + gunText(p) + '</span>'
      + (ch !== null ? '<span>🚗 ' + ch + '%</span>' : '') + '</span>';
  }).join('');
  const fl = $('flash');
  if (fl) { const fp = focusP || ps[0]; fl.style.opacity = fp ? (fp.dead ? 0.55 : Math.min(0.5, (fp.hurtT || 0) * 1.5)) : 0; }
  hudTimer += 1;
  if (hudTimer % 4 === 0 && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      t: 'hud', phase, mission: mission ? mission.type : null,
      missionName: $('barMid').textContent, time: mission && mission.type === 'race' ? Math.max(0, Math.ceil(mission.timeLeft)) : 0,
      players: ps.map((p) => ({ slot: p.slot, name: p.name, color: p.color, score: p.money, stars: p.stars, inCar: !!p.inCar, hp: Math.ceil(p.hp), armor: Math.ceil(p.armor), gun: gunText(p), dead: p.dead })),
      standings: ps.map((p) => ({ slot: p.slot, name: p.name, color: p.color, score: p.money, stars: p.stars })),
    }));
  }
}

/* ---------- الحلقة الرئيسية ---------- */
function resize() {
  const stage = $('stage'); if (!stage) return;
  const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
function loop(t) {
  const dt = clamp((t - lastT) / 1000, 0, 0.1); lastT = t;
  try { step(dt); } catch (e) { console.error(e); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
// احتياط إذا خُفي التبويب (المتصفح يخنق requestAnimationFrame)
setInterval(() => { if (document.hidden) { const t = performance.now(); const dt = clamp((t - lastT) / 1000, 0, 0.1); lastT = t; try { step(dt); } catch (e) {} } }, 50);

connect();
resize();
window.__miami = {
  get players() { return players; }, get cars() { return cars; }, get npcs() { return npcs; }, get pickups() { return pickups; },
  get mission() { return mission; }, get phase() { return phase; }, get stepCount() { return stepCount; }, get keys() { return keys; },
  get inputs() { return inputs; }, get camMode() { return camMode; }, get camHeading() { return camHeading; }, get heli() { return heli; },
  startGame, startMission, step, colliders, explode, addWanted, damagePlayer, hurtNpc, damageCar, destroyCar,
  shopBuyWeapon, shopBuyArmor, shopBuyAmmo, enterNearestCar, ZONES, WEAPONS, setCamPref: (v) => { camPref = v; },
};
