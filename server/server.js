'use strict';
/* ميامي 3D: خادم غرف بكود، WebSocket، وتقديم صفحات التلفاز والهاتف.
   نفس نموذج سيد العقار / سوبر ماريو ويب: الخادم «مُرحِّل» فقط —
   محاكاة اللعبة تعمل على صفحة التلفاز، وكل هاتف لاعب يرسل حالة
   أزراره/عصاه فيُمرَّرها الخادم للتلفاز موسومةً برقم اللاعب
   (حتى 6 لاعبين في الغرفة). لا يحتفظ الخادم بأي حالة لعب. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const MAX_ROOMS = 300;
const MAX_PLAYERS = 6;
/* ألوان اللاعبين الستة */
const PLAYER_COLORS = ['#e52521', '#22a447', '#2f6df6', '#f5b800', '#9b30ff', '#ff7f00'];
const rooms = new Map();

function send(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } } }

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    if (p === '/tv' || p === '/play') { res.writeHead(302, { Location: p + '/' + url.search }); return res.end(); }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end(); }
    return serveFile(res, file);
  } catch (e) { res.writeHead(500); res.end('server error'); }
});

function serveFile(res, file) {
  fs.stat(file, (statErr, st) => {
    if (!statErr && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
}

/* ---------- Rooms ---------- */
function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}
function newRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newCode(); if (!code) return null;
  const room = { code, tv: null, controllers: [], spectators: new Set(), created: Date.now(), last: Date.now(), emptyTimer: null };
  rooms.set(code, room); return room;
}
function roomState(room) {
  return {
    t: 'room', code: room.code, tv: !!room.tv,
    players: room.controllers.map((c) => ({ slot: c.slot, name: c.name, color: PLAYER_COLORS[c.slot - 1] })),
    spectators: room.spectators.size,
  };
}
function notifyRoom(room) {
  const m = roomState(room);
  if (room.tv) send(room.tv, m);
  room.controllers.forEach((c) => send(c.ws, m));
  room.spectators.forEach((ws) => send(ws, m));
}
function maybeDelete(room) {
  if (room.tv || room.controllers.length || room.spectators.size) return;
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    if (!room.tv && !room.controllers.length && !room.spectators.size) rooms.delete(room.code);
    room.emptyTimer = null;
  }, 60000);
}
function normInput(inp) {
  const o = inp || {};
  const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
  return {
    x: clamp(o.x !== undefined ? o.x : ((o.right ? 1 : 0) - (o.left ? 1 : 0))),
    y: clamp(o.y !== undefined ? o.y : ((o.forward ? 1 : 0) - (o.back ? 1 : 0))),
    jump: !!o.jump, action: !!o.action, punch: !!o.punch, run: !!o.run || !!o.boost,
  };
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const room = ws.room;
    if (room) room.last = Date.now();
    switch (msg.t) {
      case 'ping': return send(ws, { t: 'pong' });
      case 'create': {
        if (room) return;
        let r = null;
        if (msg.resume) { const cand = rooms.get(String(msg.resume)); if (cand && !cand.tv) r = cand; }
        if (!r) r = newRoom();
        if (!r) return send(ws, { t: 'err', m: 'الخادم ممتلئ حالياً، حاول لاحقاً' });
        r.tv = ws; ws.room = r; ws.role = 'tv';
        send(ws, { t: 'created', code: r.code });
        notifyRoom(r);
        return;
      }
      case 'watch': {
        const r = rooms.get(String(msg.code || '').trim());
        if (!r) return send(ws, { t: 'err', m: 'كود الغرفة غير صحيح', fatal: true });
        ws.room = r; ws.role = 'spectator'; r.spectators.add(ws);
        send(ws, { t: 'joined', code: r.code, role: 'spectator' });
        notifyRoom(r);
        return;
      }
      case 'join': {
        const r = rooms.get(String(msg.code || '').trim());
        if (!r) return send(ws, { t: 'err', m: 'كود الغرفة غير صحيح', fatal: true });
        ws.room = r;
        const used = new Set(r.controllers.map((c) => c.slot));
        let slot = 0;
        for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) { slot = s; break; }
        const name = String(msg.name || '').trim().slice(0, 14) || ('لاعب ' + (slot || ''));
        if (slot) {
          r.controllers.push({ ws, slot, name });
          ws.role = 'controller'; ws.slot = slot;
          send(ws, { t: 'joined', code: r.code, role: 'controller', slot, color: PLAYER_COLORS[slot - 1], name });
        } else {
          r.spectators.add(ws); ws.role = 'spectator';
          send(ws, { t: 'joined', code: r.code, role: 'spectator', name: name || 'مشاهد' });
        }
        notifyRoom(r);
        return;
      }
      case 'input': {
        if (room && ws.role === 'controller' && room.tv) {
          send(room.tv, { t: 'input', player: ws.slot, input: normInput(msg.input) });
        }
        return;
      }
      case 'control': {
        if (!room) return;
        const m = { t: 'control', action: String(msg.action || ''), mission: String(msg.mission || '') };
        if (ws.role === 'controller' && room.tv) send(room.tv, m);
        if (ws.role === 'tv') send(ws, m);
        return;
      }
      case 'hud': {
        if (!room || ws.role !== 'tv') return;
        const m = {
          t: 'hud', phase: String(msg.phase || ''), mission: msg.mission || null,
          missionName: String(msg.missionName || ''), time: Number(msg.time) || 0,
          players: Array.isArray(msg.players) ? msg.players : [],
          standings: msg.standings || null, winner: msg.winner || null,
        };
        room.controllers.forEach((c) => send(c.ws, m));
        room.spectators.forEach((s) => send(s, m));
        return;
      }
      default: return;
    }
  });
  ws.on('close', () => {
    const room = ws.room; if (!room) return;
    if (ws.role === 'tv' && room.tv === ws) room.tv = null;
    if (ws.role === 'controller') room.controllers = room.controllers.filter((c) => c.ws !== ws);
    if (ws.role === 'spectator') room.spectators.delete(ws);
    ws.room = null;
    notifyRoom(room);
    maybeDelete(room);
  });
});

setInterval(() => { wss.clients.forEach((ws) => { if (!ws.alive) { try { ws.terminate(); } catch (e) {} return; } ws.alive = false; try { ws.ping(); } catch (e) {} }); }, 30000);

server.listen(PORT, () => console.log(`miami-crime-3d listening on ${PORT}`));
