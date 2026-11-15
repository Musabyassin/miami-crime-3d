'use strict';
/* WS relay test (multiplayer): TV creates a room; 6 phones join as
   controllers 1-6 with distinct colours; each phone's input reaches
   the TV tagged with its player slot; a 7th phone becomes a spectator;
   a freed slot is reused by the next joiner; wrong code is rejected.
   Run: node test/relay.test.js (expects the server on PORT or 3000). */
const assert = require('assert');
const WebSocket = require('ws');
const PORT = Number(process.env.PORT) || 3000;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const COLORS = ['#e52521', '#22a447', '#2f6df6', '#f5b800', '#9b30ff', '#ff7f00'];

function connect() { return new Promise((res, rej) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); ws.on('error', rej); }); }
const logs = new WeakMap();
function waitFor(ws, pred, timeout = 5000) {
  if (!logs.has(ws)) {
    const arr = [];
    logs.set(ws, arr);
    ws.on('message', (raw) => { try { arr.push(JSON.parse(raw)); } catch (e) {} });
  }
  const seen = logs.get(ws);
  return new Promise((res, rej) => {
    const found = seen.find(pred);
    if (found) return res(found);
    const timer = setTimeout(() => rej(new Error('timeout waiting for ' + JSON.stringify(seen))), timeout);
    const onMsg = () => {
      const f = seen.find(pred);
      if (f) { clearTimeout(timer); ws.off('message', onMsg); res(f); }
    };
    ws.on('message', onMsg);
  });
}

(async () => {
  const tv = await connect();
  tv.send(JSON.stringify({ t: 'create', role: 'tv' }));
  const created = await waitFor(tv, (m) => m.t === 'created');
  assert.ok(/^\d{4}$/.test(created.code), 'room code is 4 digits');
  console.log('room created:', created.code);

  const phones = [];
  for (let slot = 1; slot <= 6; slot++) {
    const ph = await connect();
    ph.send(JSON.stringify({ t: 'join', code: created.code, name: 'p' + slot }));
    const joined = await waitFor(ph, (m) => m.t === 'joined');
    assert.strictEqual(joined.role, 'controller', 'phone ' + slot + ' is a controller');
    assert.strictEqual(joined.slot, slot, 'phone gets slot ' + slot);
    assert.strictEqual(joined.color, COLORS[slot - 1], 'slot ' + slot + ' colour');
    phones.push(ph);
    console.log('phone joined as controller slot', slot, 'colour', joined.color);
  }

  for (let slot = 1; slot <= 6; slot++) {
    const want = { x: slot % 2 ? 1 : -1, y: slot <= 3 ? 1 : -1, jump: slot === 3, action: slot === 2, punch: slot === 4, run: slot === 5 };
    const tvInput = waitFor(tv, (m) => m.t === 'input' && m.player === slot);
    phones[slot - 1].send(JSON.stringify({ t: 'input', input: want }));
    const got = await tvInput;
    assert.deepStrictEqual(got.input, want, 'slot ' + slot + ' input relayed');
    console.log('TV received input from player', slot, JSON.stringify(got.input));
  }

  const roomMsg = await waitFor(tv, (m) => m.t === 'room' && m.players && m.players.length === 6);
  assert.deepStrictEqual(roomMsg.players.map((p) => p.slot), [1, 2, 3, 4, 5, 6]);
  console.log('room state lists 6 players');

  const phone7 = await connect();
  phone7.send(JSON.stringify({ t: 'join', code: created.code, name: 'watcher' }));
  const joined7 = await waitFor(phone7, (m) => m.t === 'joined');
  assert.strictEqual(joined7.role, 'spectator');
  console.log('7th phone joined as spectator');

  phones[1].close();
  await waitFor(tv, (m) => m.t === 'room' && m.players && m.players.length === 5);
  const phone8 = await connect();
  phone8.send(JSON.stringify({ t: 'join', code: created.code, name: 'late' }));
  const joined8 = await waitFor(phone8, (m) => m.t === 'joined');
  assert.strictEqual(joined8.role, 'controller');
  assert.strictEqual(joined8.slot, 2, 'freed slot 2 reused');
  console.log('freed slot 2 reused by late joiner');

  const bad = await connect();
  bad.send(JSON.stringify({ t: 'join', code: '0000', name: 'x' }));
  const err = await waitFor(bad, (m) => m.t === 'err');
  assert.ok(err.m, 'wrong code rejected');
  console.log('wrong code rejected:', err.m);

  [tv, phone7, phone8, bad, ...phones.filter((p) => p.readyState === 1)].forEach((w) => { try { w.close(); } catch (e) {} });
  console.log('RELAY TEST: PASS');
  process.exit(0);
})().catch((e) => { console.error('RELAY TEST: FAIL', e.message); process.exit(1); });
