'use strict';
/* ميامي 3D — شاشة التلفاز: محاكاة اللعبة كاملة (Three.js) + استقبال
   مدخلات الهواتف عبر الخادم. لعبة أصلية مبنية من صناديق وأسطوانات
   فقط — لا أصول ولا كود ولا علامات من أي لعبة أخرى. */
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const L = (s) => String.fromCharCode(0x2066) + s + String.fromCharCode(0x2069);
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
const GARAGE = { x: -62, z: 62, w: 18, h: 14 }; // منطقة الكراج
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
function escapeHtml(s) { return String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- حالة الغرفة واللعبة ---------- */
let ws = null, code = '', phase = 'lobby'; // lobby | playing | paused | over
let missionType = 'courier';
let players = new Map(); // slot -> player state
let roomPlayers = []; // من الخادم {slot,name,color}
const inputs = {}; // slot -> {x,y,jump,action,punch,run}
const prevInput = {};
let mission = null; // {type, idx, x, z, timeLeft, checkpoints:[{x,z}]}
let paused = false;
let dayT = 0.25; // 0..1 دورة نهار/ليل (تبدأ صباحاً)
let toastTimer = 0;

function showToast(text, ms = 2500) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function moneyFmt(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

/* ---------- الصوت: WebAudio مولّد فقط، بلا ملفات ---------- */
let AC = null, engineOsc = null, engineGain = null, sirenOsc = null, sirenGain = null, sirenLfo = null;
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
const sfxPickup = () => { beep(880, 0.12); beep(1318, 0.18, 'sine', 0.15, 0.09); };
const sfxPunch = () => beep(120, 0.15, 'square', 0.2);
const sfxBust = () => { beep(220, 0.3, 'sawtooth', 0.2); beep(165, 0.4, 'sawtooth', 0.2, 0.2); };
const sfxMission = () => { beep(523, 0.15); beep(659, 0.15, 'sine', 0.15, 0.12); beep(784, 0.3, 'sine', 0.15, 0.24); };

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
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 160, 320);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 1.0); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2cc, 1.6); sun.position.set(60, 100, 40); scene.add(sun);
const moon = new THREE.DirectionalLight(0x8899ff, 0); moon.position.set(-60, 80, -40); scene.add(moon);

const colliders = []; // {x,z,hw,hd} مبانٍ فقط
const lampMats = [];
const headlights = [];

function buildingTexture(base) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 128, 256);
  for (let y = 14; y < 240; y += 26) for (let x = 12; x < 116; x += 26) {
    g.fillStyle = Math.random() < 0.5 ? '#ffe9a8' : '#1d2f4a';
    g.fillRect(x, y, 16, 18);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const texCache = {};
function texFor(base) { if (!texCache[base]) texCache[base] = buildingTexture(base); return texCache[base]; }
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

function buildCity() {
  // أرض المدينة
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshLambertMaterial({ color: 0x9aa78f }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  // الشاطئ والبحر شرقاً
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(22, 240), new THREE.MeshLambertMaterial({ color: 0xf2ddab }));
  sand.rotation.x = -Math.PI / 2; sand.position.set(106, 0.05, 0); scene.add(sand);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(90, 240), new THREE.MeshLambertMaterial({ color: 0x1e90d6 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(162, 0.02, 0); scene.add(sea);
  // رصيف خشبي في البحر
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
  for (let i = 0; i < 10; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 6), pierMat);
    plank.position.set(118 + i * 4.4, 0.6, -30); scene.add(plank);
  }
  // الطرق (شبكة)
  const roadMat = new THREE.MeshLambertMaterial({ color: 0x2e3440 });
  const walkMat = new THREE.MeshLambertMaterial({ color: 0xcfc8b8 });
  for (const r of ROADS) {
    const h = new THREE.Mesh(new THREE.PlaneGeometry(232, 10), roadMat);
    h.rotation.x = -Math.PI / 2; h.position.set(0, 0.08, r); scene.add(h);
    const v = new THREE.Mesh(new THREE.PlaneGeometry(10, 232), roadMat);
    v.rotation.x = -Math.PI / 2; v.position.set(r, 0.08, 0); scene.add(v);
    const hw = new THREE.Mesh(new THREE.PlaneGeometry(232, 13), walkMat);
    hw.rotation.x = -Math.PI / 2; hw.position.set(0, 0.06, r); scene.add(hw);
    const vw = new THREE.Mesh(new THREE.PlaneGeometry(13, 232), walkMat);
    vw.rotation.x = -Math.PI / 2; vw.position.set(r, 0.06, 0); scene.add(vw);
  }
  // المباني بين الطرق
  const palette = ['#ff8fb3', '#5ec8c8', '#ffd166', '#ff9a5a', '#b388ff', '#7ddb8a', '#f2f2f2', '#ff6b6b'];
  const blocks = [];
  for (let gx = 0; gx < 5; gx++) for (let gz = 0; gz < 5; gz++) {
    const cx = -80 + gx * 40, cz = -80 + gz * 40;
    blocks.push([cx, cz]);
  }
  for (const [cx, cz] of blocks) {
    if (Math.abs(cx) < 8 && Math.abs(cz) < 8) continue; // الساحة المركزية فارغة
    if (cx === -60 && cz === 60) continue; // الكراج
    const w = rand(14, 20), d = rand(14, 20), h = rand(7, 26);
    const col = palette[Math.floor(Math.random() * palette.length)];
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ map: texFor(col), emissive: 0x222222 }));
    b.position.set(cx + rand(-3, 3), h / 2, cz + rand(-3, 3));
    scene.add(b);
    colliders.push({ x: b.position.x, z: b.position.z, hw: w / 2 + 0.4, hd: d / 2 + 0.4 });
    // سطح ملوّن
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), new THREE.MeshLambertMaterial({ color: 0x333a4a }));
    roof.position.set(b.position.x, h + 0.25, b.position.z); scene.add(roof);
  }
  // نخيل على الأرصفة
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x2fae5a });
  for (let i = 0; i < 40; i++) {
    const x = rand(-105, 100), z = rand(-105, 105);
    if (ROADS.some((r) => Math.abs(z - r) < 4) || ROADS.some((r) => Math.abs(x - r) < 4)) continue;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 5, 6), trunkMat);
    trunk.position.set(x, 2.5, z); scene.add(trunk);
    const top = new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 0), leafMat);
    top.position.set(x, 5.6, z); top.scale.y = 0.7; scene.add(top);
  }
  // أعمدة إنارة على الطرق
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x222831 });
  for (const r of ROADS) for (let k = -100; k <= 100; k += 40) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6, 6), poleMat);
    pole.position.set(k, 3, r + 6); scene.add(pole);
    const lampMat = new THREE.MeshLambertMaterial({ color: 0x555533, emissive: 0x000000 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), lampMat);
    lamp.position.set(k, 6.2, r + 6); scene.add(lamp); lampMats.push(lampMat);
  }
  // لافتات الأحياء التسعة
  for (const [name, x, z] of DISTRICTS) {
    const sp = labelSprite(name); sp.position.set(x, 30, z); scene.add(sp);
  }
  // الكراج: أرضية + لافتة
  const gar = new THREE.Mesh(new THREE.PlaneGeometry(GARAGE.w, GARAGE.h), new THREE.MeshLambertMaterial({ color: 0xffd166 }));
  gar.rotation.x = -Math.PI / 2; gar.position.set(GARAGE.x, 0.12, GARAGE.z); scene.add(gar);
  const gLabel = labelSprite('🎨 الكراج', 0.9); gLabel.position.set(GARAGE.x, 10, GARAGE.z); scene.add(gLabel);
  const gBox = new THREE.Mesh(new THREE.BoxGeometry(GARAGE.w, 3, 1), new THREE.MeshLambertMaterial({ color: 0x333a4a }));
  gBox.position.set(GARAGE.x, 1.5, GARAGE.z - GARAGE.h / 2); scene.add(gBox);
}
buildCity();

/* ---------- الكيانات ---------- */
const playerGroup = new THREE.Group(); scene.add(playerGroup);
const carGroup = new THREE.Group(); scene.add(carGroup);
const npcGroup = new THREE.Group(); scene.add(npcGroup);
const fxGroup = new THREE.Group(); scene.add(fxGroup);

function makePlayerMesh(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.4, 0.7), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 1.1; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), new THREE.MeshLambertMaterial({ color: 0xffd9b3 }));
  head.position.y = 2.2; g.add(head);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.46, 0.18, 12), new THREE.MeshLambertMaterial({ color }));
  cap.position.y = 2.5; g.add(cap);
  const legMat = new THREE.MeshLambertMaterial({ color: 0x223044 });
  const l1 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), legMat); l1.position.set(-0.28, 0.4, 0); g.add(l1);
  const l2 = l1.clone(); l2.position.x = 0.28; g.add(l2);
  // حلقة ملوّنة تحت اللاعب ليسهل تمييزه في المدينة
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.8, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
  return g;
}
function spawnPoint(slot) {
  const spots = [[-6, -6], [6, -6], [-6, 6], [6, 6], [0, -10], [0, 10]];
  const s = spots[(slot - 1) % spots.length];
  return { x: s[0], z: s[1] };
}
function addPlayer(slot, name, color) {
  if (players.has(slot)) return players.get(slot);
  const sp = spawnPoint(slot);
  const mesh = makePlayerMesh(color);
  const label = labelSprite(name || ('لاعب ' + slot), 0.45);
  label.position.y = 3.6; mesh.add(label);
  playerGroup.add(mesh);
  const p = {
    slot, name: name || ('لاعب ' + slot), color, mesh,
    x: sp.x, z: sp.z, y: 0, vy: 0, angle: 0, money: 500, stars: 0,
    inCar: null, lastCrime: 0, decayAt: 0, punchCd: 0, bustT: 0, alive: true,
  };
  players.set(slot, p); return p;
}
function removePlayer(slot) {
  const p = players.get(slot); if (!p) return;
  if (p.inCar) { const c = cars.find((q) => q.id === p.inCar); if (c) { c.driver = null; } p.inCar = null; }
  playerGroup.remove(p.mesh); players.delete(slot);
  delete inputs[slot]; delete prevInput[slot];
}

let carSeq = 0;
const cars = [];
function makeCarMesh(color, isPolice) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 4.4), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.55; g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.65, 2.2), new THREE.MeshLambertMaterial({ color: 0x1d2f4a }));
  cabin.position.set(0, 1.15, -0.3); g.add(cabin);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  for (const [wx, wz] of [[-1.1, 1.4], [1.1, 1.4], [-1.1, -1.4], [1.1, -1.4]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10), wheelMat);
    w.rotation.z = Math.PI / 2; w.position.set(wx, 0.42, wz); g.add(w);
  }
  if (isPolice) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.25, 0.5), new THREE.MeshLambertMaterial({ color: 0xff2222, emissive: 0x661111 }));
    bar.position.set(0, 1.6, -0.3); g.add(bar);
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
  const mesh = makeCarMesh(color || (isPolice ? '#ffffff' : PAINTS[Math.floor(Math.random() * PAINTS.length)]), isPolice);
  mesh.position.set(x, 0, z); carGroup.add(mesh);
  const c = { id: ++carSeq, type, mesh, x, z, angle: rand(0, Math.PI * 2), speed: 0, color: color || '#888888', driver: null, neon: false, loop: null, loopT: rand(0, 100), target: null, bustT: 0 };
  if (type === 'traffic') { c.loop = pickLoop(); c.speed = rand(8, 12); }
  cars.push(c); return c;
}
function pickLoop() {
  const r = ROADS[Math.floor(Math.random() * ROADS.length)];
  const horiz = Math.random() < 0.5;
  return { horiz, road: r, dir: Math.random() < 0.5 ? 1 : -1 };
}
// سيارات مركونة + مرور
for (let i = 0; i < 10; i++) {
  const r = ROADS[Math.floor(Math.random() * ROADS.length)];
  addCar('parked', rand(-100, 95), r + (Math.random() < 0.5 ? 6.5 : -6.5));
}
for (let i = 0; i < 8; i++) addCar('traffic', rand(-90, 90), ROADS[Math.floor(Math.random() * ROADS.length)]);

/* المشاة */
const npcs = [];
function addNpc() {
  const g = new THREE.Group();
  const col = ['#e8e8e8', '#ffd166', '#7ddb8a', '#ff8fb3'][Math.floor(Math.random() * 4)];
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.6), new THREE.MeshLambertMaterial({ color: col }));
  body.position.y = 1.05; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), new THREE.MeshLambertMaterial({ color: 0xe8b98a }));
  head.position.y = 2; g.add(head);
  npcGroup.add(g);
  const n = { mesh: g, x: rand(-100, 100), z: rand(-100, 100), angle: rand(0, Math.PI * 2), speed: rand(1.2, 2.2), down: 0, flee: 0 };
  npcs.push(n); return n;
}
for (let i = 0; i < 10; i++) addNpc();

/* فلوس خضراء متوهجة */
const cashItems = [];
function addCash(x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.4),
    new THREE.MeshLambertMaterial({ color: 0x22ff88, emissive: 0x00aa44 }));
  m.position.set(x, 0.8, z); fxGroup.add(m);
  const c = { mesh: m, x, z, taken: false, respawnAt: 0 };
  cashItems.push(c); return c;
}
for (let i = 0; i < 12; i++) addCash(rand(-100, 95), rand(-100, 100));

/* علامة المهمة */
const checkpoint = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 6, 20, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
checkpoint.position.y = 3; checkpoint.visible = false; scene.add(checkpoint);
const checkpointTop = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 3, 5, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5 }));
checkpointTop.position.y = 8; checkpointTop.visible = false; scene.add(checkpointTop);

/* ---------- المهام ---------- */
function randomRoadPoint() {
  const r = ROADS[Math.floor(Math.random() * ROADS.length)];
  if (Math.random() < 0.5) return { x: rand(-100, 95), z: r };
  return { x: r, z: rand(-100, 100) };
}
function startMission(type) {
  missionType = type;
  document.querySelectorAll('.mBtn').forEach((b) => b.classList.toggle('sel', b.dataset.m === type));
  if (type === 'free') {
    mission = null; checkpoint.visible = false; checkpointTop.visible = false;
    $('barMid').textContent = '🌴 تجول حر';
    return;
  }
  if (type === 'courier') {
    const pt = randomRoadPoint();
    mission = { type: 'courier', idx: 0, x: pt.x, z: pt.z, timeLeft: 0 };
    checkpoint.position.set(pt.x, 3, pt.z); checkpoint.visible = true;
    checkpointTop.position.set(pt.x, 8, pt.z); checkpointTop.visible = true;
    $('barMid').textContent = '📦 مهمة توصيل — أوصل للنقطة الصفراء (+$600)';
    showToast('📦 مهمة توصيل جديدة! أوصل للنقطة الصفراء');
  } else if (type === 'race') {
    const cps = [];
    for (let i = 0; i < 9; i++) cps.push(randomRoadPoint());
    mission = { type: 'race', idx: 0, x: cps[0].x, z: cps[0].z, timeLeft: 120, checkpoints: cps };
    checkpoint.position.set(cps[0].x, 3, cps[0].z); checkpoint.visible = true;
    checkpointTop.position.set(cps[0].x, 8, cps[0].z); checkpointTop.visible = true;
    $('barMid').textContent = '🏁 سباق — النقطة 1 من 9 • ⏱ 120 ثانية';
    showToast('🏁 بدأ السباق! 9 نقاط خلال 120 ثانية');
  }
}
function missionReached(p) {
  if (!mission) return;
  if (mission.type === 'courier') {
    p.money += 600; sfxMission();
    showToast('📦 ' + p.name + ' أكمل التوصيل! +$600');
    const pt = randomRoadPoint();
    mission.x = pt.x; mission.z = pt.z;
    checkpoint.position.set(pt.x, 3, pt.z); checkpointTop.position.set(pt.x, 8, pt.z);
  } else if (mission.type === 'race') {
    mission.idx++;
    p.money += 100;
    if (mission.idx >= 9) {
      p.money += 1000; sfxMission();
      mission = null; checkpoint.visible = false; checkpointTop.visible = false;
      $('barMid').textContent = '🏆 ' + p.name + ' فاز بالسباق! +$1000';
      showToast('🏆 ' + p.name + ' فاز بالسباق! +$1000', 4000);
      setTimeout(() => { if (!mission) $('barMid').textContent = '🌴 تجول حر'; }, 4000);
    } else {
      const cp = mission.checkpoints[mission.idx];
      mission.x = cp.x; mission.z = cp.z;
      checkpoint.position.set(cp.x, 3, cp.z); checkpointTop.position.set(cp.x, 8, cp.z);
      $('barMid').textContent = '🏁 سباق — النقطة ' + (mission.idx + 1) + ' من 9 • ⏱ ' + Math.ceil(mission.timeLeft) + ' ثانية';
      sfxPickup();
    }
  }
}

/* ---------- الجريمة والشرطة ---------- */
function addWanted(p, n) {
  p.stars = clamp(p.stars + n, 0, 5);
  p.lastCrime = performance.now() / 1000;
  p.decayAt = p.lastCrime + 20;
}
function bustPlayer(p) {
  p.money = Math.max(0, p.money - 100);
  p.stars = 0; p.bustT = 0;
  if (p.inCar) { const c = cars.find((q) => q.id === p.inCar); if (c) { c.driver = null; c.type = 'parked'; c.speed = 0; } p.inCar = null; }
  const sp = spawnPoint(p.slot); p.x = sp.x; p.z = sp.z; p.y = 0; p.vy = 0;
  sfxBust();
  showToast('🚔 ' + p.name + ' قُبض عليه! -$100');
}
function syncPolice() {
  const maxStars = Math.max(0, ...[...players.values()].map((p) => p.stars));
  const want = maxStars > 0 ? Math.min(3, maxStars) : 0;
  let have = cars.filter((c) => c.type === 'police').length;
  while (have < want) {
    const most = [...players.values()].filter((p) => p.stars === maxStars).sort((a, b) => b.stars - a.stars)[0];
    const c = addCar('police', (most ? most.x : 0) + rand(-20, 20), (most ? most.z : 0) + rand(-20, 20), '#ffffff');
    c.target = most ? most.slot : null; have++;
  }
  while (have > want) {
    const c = cars.find((q) => q.type === 'police'); if (!c) break;
    carGroup.remove(c.mesh); cars.splice(cars.indexOf(c), 1); have--;
  }
}

/* ---------- التصادم مع المباني ---------- */
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
function inGarage(x, z) {
  return Math.abs(x - GARAGE.x) < GARAGE.w / 2 && Math.abs(z - GARAGE.z) < GARAGE.h / 2;
}

/* ---------- بدء / إعادة / ردهة ---------- */
function ensurePlayers() {
  if (roomPlayers.length) {
    for (const rp of roomPlayers) addPlayer(rp.slot, rp.name, rp.color);
    for (const slot of [...players.keys()]) if (!roomPlayers.some((q) => q.slot === slot)) removePlayer(slot);
  } else if (!players.size) {
    // لا هواتف بعد — لاعب لوحة المفاتيح للاختبار؛ لا نحذفه كل إطار
    addPlayer(1, 'لاعب 1', COLORS[0]);
  }
}
function startGame(mtype) {
  ensureAudio(); ensurePlayers();
  phase = 'playing'; paused = false;
  $('lobby').hidden = true; $('game').hidden = false;
  $('barPhase').textContent = 'تلعب الآن';
  resize();
  startMission(mtype || missionType);
  showToast('🌴 أهلاً بكم في ميامي! اجمعوا الفلوس وانتبهوا للشرطة');
}
function restartGame() {
  for (const p of players.values()) {
    const sp = spawnPoint(p.slot); p.x = sp.x; p.z = sp.z; p.y = 0; p.vy = 0; p.money = 500; p.stars = 0; p.inCar = null; p.bustT = 0;
  }
  for (const c of [...cars]) if (c.type === 'police') { carGroup.remove(c.mesh); cars.splice(cars.indexOf(c), 1); }
  for (const c of cars) if (c.driver) c.driver = null;
  phase = 'playing'; paused = false;
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

/* ---------- لوحة المفاتيح (للاختبار على التلفاز) ---------- */
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyM') startMission(missionType === 'courier' ? 'race' : 'courier');
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
function keyboardInput() {
  return {
    x: ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0),
    y: ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0),
    jump: !!keys.Space, action: !!keys.KeyE, punch: !!keys.KeyF,
    run: !!(keys.ShiftLeft || keys.ShiftRight),
  };
}

/* ---------- التحديث ---------- */
let lastT = performance.now();
let hudTimer = 0;
let stepCount = 0;
const camTarget = new THREE.Vector3(0, 0, 0);

function step(dt) {
  stepCount++;
  const now = performance.now() / 1000;
  dayT = (dayT + dt / 120) % 1; // دورة نهار/ليل كاملة كل دقيقتين
  updateDayNight();
  if (phase !== 'playing' || paused) { renderFrame(dt); return; }

  ensurePlayers();
  // لوحة المفاتيح تتحكم باللاعب 1 إذا لم يكن لديه هاتف
  if (!roomPlayers.some((q) => q.slot === 1) || !inputs[1]) inputs[1] = keyboardInput();

  // السباق: المؤقت
  if (mission && mission.type === 'race') {
    mission.timeLeft -= dt;
    $('barMid').textContent = '🏁 سباق — النقطة ' + (mission.idx + 1) + ' من 9 • ⏱ ' + Math.max(0, Math.ceil(mission.timeLeft)) + ' ثانية';
    if (mission.timeLeft <= 0) {
      mission = null; checkpoint.visible = false; checkpointTop.visible = false;
      $('barMid').textContent = '🌴 تجول حر'; showToast('⏱ انتهى وقت السباق!');
    }
  }

  for (const p of players.values()) {
    const inp = inputs[p.slot] || { x: 0, y: 0, jump: false, action: false, punch: false, run: false };
    const prev = prevInput[p.slot] || {};
    const actionEdge = inp.action && !prev.action;
    const punchEdge = inp.punch && !prev.punch;
    prevInput[p.slot] = { ...inp };
    if (p.punchCd > 0) p.punchCd -= dt;

    // اضمحلال المطلوبية
    if (p.stars > 0 && now > p.decayAt) { p.stars--; p.decayAt = now + 12; }

    if (p.inCar) {
      const car = cars.find((c) => c.id === p.inCar);
      if (!car) { p.inCar = null; }
      else {
        const accel = inp.y * 22;
        car.speed = clamp(car.speed + accel * dt, -10, 26);
        if (Math.abs(inp.y) < 0.1) car.speed *= Math.max(0, 1 - 1.2 * dt);
        car.angle += inp.x * clamp(car.speed / 10, -1, 1) * -1.4 * dt * (car.speed < 0 ? -1 : 1);
        car.x += Math.sin(car.angle) * car.speed * dt;
        car.z += Math.cos(car.angle) * car.speed * dt;
        const col = collideBuildings(car.x, car.z, 2.2);
        if (col.x !== car.x || col.z !== car.z) { car.speed *= 0.4; }
        car.x = clamp(col.x, -WORLD, 112); car.z = clamp(col.z, -WORLD, WORLD);
        p.x = car.x; p.z = car.z; p.angle = car.angle;
        p.mesh.visible = false;
        if (inGarage(car.x, car.z)) {
          if (actionEdge) { // تغيير اللون — داخل الكراج أولاً قبل النزول
            if (p.money >= 200) {
              p.money -= 200;
              const ci = (PAINTS.indexOf(car.color) + 1) % PAINTS.length;
              car.color = PAINTS[ci];
              car.mesh.children[0].material.color.set(car.color);
              sfxPickup(); showToast('🎨 لون جديد! -$200');
            } else showToast('💵 تحتاج $200 لتغيير اللون');
          } else if (punchEdge) { // النيون
            if (!car.neon && p.money >= 150) { p.money -= 150; car.neon = true; showToast('✨ نيون مضاء! -$150'); }
            else if (car.neon) { car.neon = false; showToast('✨ النيون مطفأ'); }
            else showToast('💵 تحتاج $150 للنيون');
          }
        } else if (actionEdge) { // النزول من السيارة
          car.driver = null; p.inCar = null; p.mesh.visible = true;
          p.x = car.x + Math.sin(car.angle + Math.PI / 2) * 3; p.z = car.z + Math.cos(car.angle + Math.PI / 2) * 3;
        }
      }
    } else {
      // على الأقدام
      const speed = (inp.run ? 11 : 7);
      const mx = inp.x, mz = -inp.y; // العصا لأعلى = شمال (-z)
      const len = Math.hypot(mx, mz);
      if (len > 0.1) {
        const nx = mx / Math.max(1, len), nz = mz / Math.max(1, len);
        p.x += nx * speed * dt; p.z += nz * speed * dt;
        p.angle = Math.atan2(nx, nz);
      }
      const col = collideBuildings(p.x, p.z, 0.9);
      p.x = clamp(col.x, -WORLD, 112); p.z = clamp(col.z, -WORLD, WORLD);
      if (inp.jump && p.y === 0) { p.vy = 8; }
      if (p.y > 0 || p.vy !== 0) { p.vy -= 22 * dt; p.y += p.vy * dt; if (p.y <= 0) { p.y = 0; p.vy = 0; } }
      p.mesh.visible = true;
      if (actionEdge) { // ركوب أقرب سيارة
        let best = null, bestD = 25;
        for (const c of cars) {
          if (c.type === 'police' || c.driver) continue;
          const d = dist2(p.x, p.z, c.x, c.z);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (best) {
          if (best.type === 'traffic') { addWanted(p, 1); showToast('🚨 سرقت سيارة مرور! نجمة مطلوبية +1'); }
          best.driver = p.slot; best.type = 'player'; best.speed = 0;
          p.inCar = best.id;
        }
      }
      if (punchEdge && p.punchCd <= 0) {
        p.punchCd = 0.5; sfxPunch();
        for (const n of npcs) {
          if (n.down > 0) continue;
          if (dist2(p.x, p.z, n.x, n.z) < 9) {
            n.down = 2; n.flee = 6; addWanted(p, 1);
            showToast('👊 ' + p.name + ' ضرب أحد المارة! نجمة +1');
            break;
          }
        }
      }
    }

    // فلوس خضراء
    for (const c of cashItems) {
      if (!c.taken && dist2(p.x, p.z, c.x, c.z) < 4) {
        c.taken = true; c.mesh.visible = false; c.respawnAt = now + 20;
        p.money += 50; sfxPickup();
      }
    }
    // نقطة المهمة
    if (mission && dist2(p.x, p.z, mission.x, mission.z) < 16) missionReached(p);

    // إعادة قرب القائد إذا ابتعد كثيراً عن الكاميرا
    const cx = camTarget.x, cz = camTarget.z;
    if (dist2(p.x, p.z, cx, cz) > 70 * 70) {
      const leader = [...players.values()].sort((a, b) => b.money - a.money)[0];
      if (leader && leader !== p) { p.x = leader.x + rand(-4, 4); p.z = leader.z + rand(-4, 4); }
    }
    // مزامنة مجسّم اللاعب
    p.mesh.position.set(p.x, p.y, p.z);
    p.mesh.rotation.y = p.angle;
  }

  // مرور: سيارات تسير في حلقات على الطرق
  for (const c of cars) {
    if (c.type !== 'traffic' || !c.loop) continue;
    const L = c.loop;
    if (L.horiz) { c.x += L.dir * c.speed * dt; c.angle = L.dir > 0 ? Math.PI / 2 : -Math.PI / 2; if (c.x > 110) c.x = -110; if (c.x < -110) c.x = 110; c.z = L.road; }
    else { c.z += L.dir * c.speed * dt; c.angle = L.dir > 0 ? 0 : Math.PI; if (c.z > 110) c.z = -110; if (c.z < -110) c.z = 110; c.x = L.road; }
  }
  // المشاة يتجولون ويهربون
  for (const n of npcs) {
    if (n.down > 0) { n.down -= dt; n.mesh.rotation.x = n.down > 0 ? Math.PI / 2 : 0; n.mesh.position.y = n.down > 0 ? 0.3 : 0; continue; }
    if (Math.random() < dt * 0.2) n.angle = rand(0, Math.PI * 2);
    const sp = n.flee > 0 ? 5 : n.speed; if (n.flee > 0) n.flee -= dt;
    n.x = clamp(n.x + Math.sin(n.angle) * sp * dt, -105, 105);
    n.z = clamp(n.z + Math.cos(n.angle) * sp * dt, -105, 105);
    n.mesh.position.set(n.x, 0, n.z); n.mesh.rotation.y = n.angle;
  }
  // إعادة ظهور الفلوس
  for (const c of cashItems) {
    if (c.taken && now > c.respawnAt) {
      c.taken = false; c.mesh.visible = true;
      c.x = rand(-100, 95); c.z = rand(-100, 100); c.mesh.position.set(c.x, 0.8, c.z);
    } else if (!c.taken) { c.mesh.rotation.y += dt * 2; c.mesh.position.y = 0.8 + Math.sin(now * 2 + c.x) * 0.2; }
  }
  // الشرطة
  syncPolice();
  const mostWanted = [...players.values()].filter((p) => p.stars > 0).sort((a, b) => b.stars - a.stars)[0];
  for (const c of cars) {
    if (c.type !== 'police') continue;
    const t = mostWanted || [...players.values()][0];
    if (!t) continue;
    const dx = t.x - c.x, dz = t.z - c.z, d = Math.hypot(dx, dz) || 1;
    const wantAngle = Math.atan2(dx, dz);
    let da = wantAngle - c.angle; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
    c.angle += clamp(da, -2 * dt, 2 * dt);
    c.speed = clamp(c.speed + 10 * dt, 0, 15);
    c.x += Math.sin(c.angle) * c.speed * dt; c.z += Math.cos(c.angle) * c.speed * dt;
    const col = collideBuildings(c.x, c.z, 2.2); c.x = clamp(col.x, -WORLD, 112); c.z = clamp(col.z, -WORLD, WORLD);
    if (d < 3) {
      if (t.inCar) { c.bustT += dt; if (c.bustT > 2.5) { c.bustT = 0; bustPlayer(t); } }
      else { t.bustT += dt; if (t.bustT > 0.8) bustPlayer(t); }
    } else { c.bustT = 0; if (!t.inCar) t.bustT = Math.max(0, t.bustT - dt); }
  }
  // مزامنة مجسّمات السيارات
  for (const c of cars) {
    c.mesh.position.set(c.x, 0, c.z); c.mesh.rotation.y = c.angle;
    const neon = c.mesh.getObjectByName('neon');
    if (neon) neon.material.opacity = c.neon ? 0.55 : 0;
    const night = isNight();
    for (const h of c.mesh.userData.headlights || []) h.visible = night;
  }
  checkpoint.rotation.y += dt;
  renderFrame(dt);
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
  const night = isNight();
  for (const m of lampMats) m.emissive.setHex(night ? 0xffcc44 : 0x000000);
  if (AC) {
    const anyWanted = [...players.values()].some((p) => p.stars > 0);
    sirenGain.gain.value = anyWanted && phase === 'playing' ? 0.04 : 0;
    const inCar = [...players.values()].some((p) => p.inCar);
    const spd = cars.filter((c) => c.driver).reduce((a, c) => a + Math.abs(c.speed), 0);
    engineGain.gain.value = inCar ? 0.035 : 0;
    engineOsc.frequency.value = 55 + spd * 4;
  }
}

function renderFrame(dt) {
  // الكاميرا تتبع وسط اللاعبين (أو القائد)
  const ps = [...players.values()];
  if (ps.length) {
    let tx = 0, tz = 0; for (const p of ps) { tx += p.x; tz += p.z; }
    tx /= ps.length; tz /= ps.length;
    camTarget.x += (tx - camTarget.x) * 0.03; camTarget.z += (tz - camTarget.z) * 0.03;
  }
  camera.position.set(camTarget.x, 58, camTarget.z + 34); // زاوية أعلى: المباني تحجب اللاعب أقل
  camera.lookAt(camTarget.x, 0, camTarget.z);
  renderer.render(scene, camera);
  drawMinimap();
  updateHud();
}

function drawMinimap() {
  const mm = $('minimap'); if (!mm || $('game').hidden) return;
  const g = mm.getContext('2d');
  const W = 200, S = W / 240;
  g.fillStyle = '#0b1526'; g.fillRect(0, 0, W, W);
  g.fillStyle = '#2e6db0'; g.fillRect(190, 0, 10, W); // البحر شرقاً
  g.fillStyle = '#f2ddab'; g.fillRect(178, 0, 12, W);
  g.strokeStyle = '#3a4556'; g.lineWidth = 5;
  for (const r of ROADS) {
    g.beginPath(); g.moveTo(0, (r + 120) * S); g.lineTo(W, (r + 120) * S); g.stroke();
    g.beginPath(); g.moveTo((r + 120) * S, 0); g.lineTo((r + 120) * S, W); g.stroke();
  }
  g.fillStyle = '#ffd166'; g.fillRect((GARAGE.x - 9 + 120) * S, (GARAGE.z - 7 + 120) * S, 18 * S, 14 * S);
  for (const c of cashItems) if (!c.taken) {
    g.fillStyle = '#22ff88'; g.fillRect((c.x + 120) * S - 2, (c.z + 120) * S - 2, 4, 4);
  }
  if (mission) {
    g.fillStyle = '#ffd166'; g.beginPath(); g.arc((mission.x + 120) * S, (mission.z + 120) * S, 6, 0, 7); g.fill();
  }
  for (const c of cars) {
    g.fillStyle = c.type === 'police' ? '#ff2222' : (c.type === 'player' ? '#ffffff' : '#9fb0d0');
    g.beginPath(); g.arc((c.x + 120) * S, (c.z + 120) * S, c.type === 'police' ? 4 : 3, 0, 7); g.fill();
  }
  for (const p of players.values()) {
    g.fillStyle = p.color; g.beginPath(); g.arc((p.x + 120) * S, (p.z + 120) * S, 5, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
  }
}

function updateHud() {
  if ($('game').hidden) return;
  const ps = [...players.values()].sort((a, b) => b.money - a.money);
  $('chips').innerHTML = ps.map((p) =>
    '<span class="chip" style="--c:' + p.color + '"><span class="dot"></span><b>' + escapeHtml(p.name) + '</b>'
    + '<span>' + moneyFmt(p.money) + '</span><span>' + '★'.repeat(p.stars) + (p.stars ? '' : '☆') + '</span>'
    + (p.inCar ? '<span>🚗</span>' : '') + '</span>').join('');
  hudTimer += 1;
  if (hudTimer % 4 === 0 && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      t: 'hud', phase, mission: mission ? mission.type : null,
      missionName: $('barMid').textContent, time: mission && mission.type === 'race' ? Math.max(0, Math.ceil(mission.timeLeft)) : 0,
      players: ps.map((p) => ({ slot: p.slot, name: p.name, color: p.color, score: p.money, stars: p.stars, inCar: !!p.inCar })),
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
window.__miami = { get players() { return players; }, get cars() { return cars; }, get mission() { return mission; }, get phase() { return phase; }, get stepCount() { return stepCount; }, get keys() { return keys; }, get inputs() { return inputs; }, startGame, startMission };
