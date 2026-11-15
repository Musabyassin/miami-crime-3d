import './globals.mjs';
import fs from 'fs';
fs.writeFileSync(new URL('./tv.test.mjs', import.meta.url), fs.readFileSync(new URL('../../../public/tv/tv.js', import.meta.url), 'utf8').replace("from 'three'", "from './mock-three.mjs'"));
await import('./tv.test.mjs');
const M = globalThis.__miami;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL:', m); } else console.log('ok  :', m); };
const frames = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) M.step(dt); };
const P = () => [...M.players.values()][0];
const inside = (x, z) => M.colliders.some((b) => Math.abs(x - b.x) < b.hw - 0.6 && Math.abs(z - b.z) < b.hd - 0.6);

M.startGame('free');
ok(M.phase === 'playing', 'game started');
frames(5);
ok(M.camMode === 'chase', 'single player => third-person chase camera');

// 1. random fuzz: movement, fire, jump, car, swap
const k = M.keys; const codes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyE', 'KeyF', 'KeyG', 'KeyQ', 'ShiftLeft', 'KeyZ', 'KeyX'];
let err = null;
try {
  for (let i = 0; i < 6000; i++) {
    if (i % 20 === 0) for (const c of codes) k[c] = Math.random() < 0.35;
    M.step(1 / 60);
    const p = P();
    if (!isFinite(p.x) || !isFinite(p.z) || !isFinite(p.hp)) throw new Error('non-finite at ' + i);
  }
} catch (e) { err = e; }
ok(!err, 'fuzz 6000 frames no exception ' + (err ? err.stack : ''));
for (const c of codes) k[c] = false;
const p = P();
ok(!inside(p.x, p.z) || p.inCar, 'player not stuck inside a building');
const bad = M.cars.filter((c) => !isFinite(c.x) || !isFinite(c.z));
ok(bad.length === 0, 'all cars finite');

// 2. shooting an NPC in front of player
p.dead = false; p.hp = 100; p.inCar = null; p.x = 0; p.z = 0; p.angle = 0; p.stars = 0; p.lastCrime = -99; p.weapons = ['fists', 'pistol']; p.wi = 1; p.ammo = { pistol: { mag: 12, res: 36 } }; p.reloadT = 0; p.fireCd = 0; p.reloading = ''; p.zoneNow = '';
const n = M.npcs[0]; n.dead = false; n.down = 0; n.hp = 50; n.x = 0; n.z = 8; n.flee = 0;
const ax = M.inputs; for (const c of codes) k[c] = false;
frames(3); k.KeyG = true; frames(2); k.KeyG = false; frames(2);
ok(n.hp < 50 || n.dead, 'pistol shot damages NPC (hp ' + n.hp + ')');
ok(p.stars >= 1, 'shooting a pedestrian raises wanted level');
ok(p.ammo.pistol.mag < 12, 'ammo consumed');

// 3. kill -> cash drop, then respawn
M.hurtNpc(n, 999, p.slot);
ok(n.dead && M.pickups.some((x) => x.temp), 'dead NPC drops cash');
let rs = false; for (let i = 0; i < 60 * 10 && !rs; i++) { M.step(1 / 60); if (!n.dead) rs = true; } ok(rs, 'NPC respawns');

// 4. police at 5 stars + helicopter
p.stars = 0; p.lastCrime = -99; M.addWanted(p, 5);
p.x = 0; p.z = 0; frames(120);
ok(M.cars.filter((c) => c.type === 'police').length === 4, 'police cars spawned for 5 stars');
ok(!!M.heli, 'helicopter at 5 stars');
frames(60 * 20); ok(isFinite(p.hp), 'long chase stable; hp=' + Math.round(p.hp) + ' dead=' + p.dead);

// 5. death -> hospital respawn
p.stars = 0; p.dead = false; p.hp = 100; p.money = 1000; p.x = 5; p.z = 5; M.damagePlayer(p, 500);
ok(p.dead, 'player dies at 0 hp');
frames(60 * 4);
ok(!p.dead && Math.abs(p.x - M.ZONES.hospital.x) < 1 && Math.abs(p.z - M.ZONES.hospital.z) < 1, 'respawn at hospital');
ok(p.money === 800, 'hospital fee charged (money ' + p.money + ')');

// 6. shop purchases
p.money = 5000; p.x = M.ZONES.shop.x; p.z = M.ZONES.shop.z; p.dead = false;
M.shopBuyWeapon(p); M.shopBuyWeapon(p);
ok(p.weapons.includes('smg') && p.weapons.includes('shotgun'), 'bought smg + shotgun, money ' + p.money);
M.shopBuyArmor(p); ok(p.armor === 100, 'armor bought');

// 7. car destroy + wreck cleanup
const car = M.cars.find((c) => c.type === 'parked' && c.cleanup === 0);
M.destroyCar(car); ok(car.type === 'wreck', 'car destroyed -> wreck');
frames(60 * 9); ok(!M.cars.includes(car), 'wreck removed after timeout');

// 8. bounty mission
M.startMission('bounty'); ok(M.mission && M.mission.targets.length === 3, 'bounty mission with 3 targets');
const before = p.money; p.dead = false; p.stars = 0;
for (const t of M.mission.targets) M.hurtNpc(t, 999, p.slot);
frames(3); ok(p.money === before + 1500 && !M.mission, 'bounty payout +1500');

// 9. enter car & drive & ram
M.startMission('free'); p.hp = 100; p.dead = false; p.x = 0; p.z = 6; p.stars = 0;
const pc = M.cars.find((c) => c.type === 'parked'); pc.x = 3; pc.z = 6; pc.hp = 100;
for (const c of codes) k[c] = false; k.KeyE = true; frames(2); k.KeyE = false; frames(2);
ok(p.inCar === pc.id, 'entered nearest car');
k.KeyW = true; frames(240); k.KeyW = false;
ok(Math.abs(pc.speed) > 5 || pc.hp < 100, 'car drives (speed ' + pc.speed.toFixed(1) + ', hp ' + Math.round(pc.hp) + ')');

// 10. multiplayer: group camera, 4 players, inputs
globalThis.__ws.onmessage({ data: JSON.stringify({ t: 'room', players: [1, 2, 3, 4].map((s) => ({ slot: s, name: 'p' + s, color: '#fff' })) }) });
frames(5); ok(M.camMode === 'group', 'multi-player => group camera');
try {
  for (let i = 0; i < 2000; i++) {
    for (let s = 2; s <= 4; s++) M.inputs[s] = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, jump: Math.random() < .05, action: Math.random() < .03, punch: Math.random() < .05, run: false, fire: Math.random() < .2, swap: Math.random() < .02, cam: i * 0.01 };
    M.inputs[1] = { x: 0, y: 0, cam: 0 };
    M.step(1 / 60);
  }
  ok(true, 'multiplayer fuzz 2000 frames ok, players=' + M.players.size);
} catch (e) { ok(false, 'multiplayer fuzz: ' + e.stack); }

console.log(fails ? 'TESTS FAILED: ' + fails : 'ALL TESTS PASSED');
process.exit(fails ? 1 : 0);
