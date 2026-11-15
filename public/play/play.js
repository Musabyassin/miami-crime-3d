'use strict';
/* يد تحكم الهاتف: انضمام بكود، عصا لمس للحركة + أزرار أفعال.
   ترسل حالة المدخلات للتلفاز عبر الخادم (عند التغيير + نبضة). */
const $ = (id) => document.getElementById(id);
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

let ws = null, code = '', role = '';
let mySlot = 0, myColor = '';
const input = { x: 0, y: 0, jump: false, action: false, punch: false, run: false, fire: false, swap: false, cam: 0 };
let lastSent = '';
window.__phone = { input, get role() { return role; }, get code() { return code; }, get slot() { return mySlot; } };

function escapeHtml(s) {
  return String(s).replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const params = new URLSearchParams(location.search);
if (params.get('c')) $('codeInput').value = params.get('c').slice(0, 4);

function sendInput(force) {
  if (!ws || ws.readyState !== 1 || role !== 'controller') return;
  const s = JSON.stringify(input);
  if (force || s !== lastSent) { lastSent = s; ws.send(JSON.stringify({ t: 'input', input })); }
}
setInterval(() => sendInput(false), 50);

function setKey(k, on) {
  input[k] = on;
  const btn = document.querySelector('[data-k="' + k + '"]');
  if (btn) btn.classList.toggle('held', on);
  sendInput(true);
}
document.querySelectorAll('.ctl').forEach((btn) => {
  const k = btn.dataset.k;
  const down = (e) => { e.preventDefault(); setKey(k, true); };
  const up = (e) => { e.preventDefault(); setKey(k, false); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});

/* العصا الافتراضية */
const stick = $('stick'), knob = $('knob');
let stickId = null;
function stickMove(e) {
  const r = stick.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = (e.clientX - cx) / (r.width / 2), dy = (e.clientY - cy) / (r.height / 2);
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  knob.style.transform = 'translate(' + dx * 34 + 'px,' + dy * 34 + 'px)';
  input.x = Math.round(dx * 100) / 100;
  input.y = Math.round(-dy * 100) / 100; // لأعلى = أمام (+y)
  sendInput(true);
}
function stickEnd(e) {
  if (stickId !== null && e.pointerId !== stickId) return;
  stickId = null; knob.style.transform = '';
  input.x = 0; input.y = 0; sendInput(true);
}
stick.addEventListener('pointerdown', (e) => { e.preventDefault(); stickId = e.pointerId; stick.setPointerCapture(e.pointerId); stickMove(e); });
stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
stick.addEventListener('pointerup', stickEnd);
stick.addEventListener('pointercancel', stickEnd);

/* سحب لتدوير الكاميرا: نرسل مجموع الزاوية والتلفاز يحسب الفرق */
const look = $('lookZone');
let lookId = null, lookX = 0;
look.addEventListener('pointerdown', (e) => { e.preventDefault(); lookId = e.pointerId; lookX = e.clientX; look.setPointerCapture(e.pointerId); });
look.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookId) return;
  input.cam = Math.round((input.cam + (e.clientX - lookX) * 0.008) * 1000) / 1000; lookX = e.clientX;
  sendInput(false);
});
const lookEnd = (e) => { if (e.pointerId === lookId) lookId = null; };
look.addEventListener('pointerup', lookEnd); look.addEventListener('pointercancel', lookEnd);

function sendControl(action) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'control', action }));
}
$('startBtn').addEventListener('click', () => sendControl('start'));
$('pauseBtn').addEventListener('click', () => sendControl('pause'));
$('restartBtn').addEventListener('click', () => sendControl('restart'));

function renderStandings(list) {
  const el = $('standings');
  if (!list || !list.length) { el.hidden = true; return; }
  const rows = [...list].sort((a, b) => (b.score - a.score));
  el.hidden = false;
  el.innerHTML = '<div class="stTitle">🏆 الترتيب — حسب الفلوس</div>' + rows.map((p, i) =>
    '<div class="stRow"><span>' + (i + 1) + '</span>'
    + '<span class="chipDot" style="background:' + (p.color || '#888') + '"></span>'
    + '<b>' + escapeHtml(p.name || ('اللاعب ' + p.slot)) + '</b>'
    + '<span>$' + (p.score || 0) + '</span><span>' + '★'.repeat(p.stars || 0) + '</span></div>').join('');
}

function join() {
  code = $('codeInput').value.trim();
  if (!/^\d{4}$/.test(code)) { $('joinErr').textContent = 'أدخل كوداً من 4 أرقام'; return; }
  $('joinErr').textContent = '';
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = '⏳ جارٍ الاتصال…';
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', code, name: $('nameInput').value.trim() }));
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.t === 'joined') {
      role = msg.role;
      $('join').hidden = true;
      $('pad').hidden = false;
      $('roomLbl').textContent = 'غرفة ' + msg.code;
      $('connLbl').textContent = '✅ متصل';
      if (role === 'controller') {
        mySlot = msg.slot; myColor = msg.color || '#e52521';
        const b = $('slotBadge');
        b.hidden = false;
        b.textContent = '🎮 أنت اللاعب ' + msg.slot + (msg.name ? ' — ' + msg.name : '');
        b.style.background = myColor;
        b.style.borderColor = myColor;
      }
      if (role === 'spectator') {
        $('specNote').hidden = false;
        document.getElementById('controls').style.opacity = '.35';
        document.getElementById('controls').style.pointerEvents = 'none';
        $('phaseLbl').textContent = 'أنت تشاهد اللعبة فقط';
      }
    } else if (msg.t === 'hud') {
      const ps = msg.players || [];
      const me = ps.find((p) => p.slot === mySlot);
      if (role === 'spectator') {
        $('hudLbl').textContent = '👀 تشاهد • ' + ps.length + (ps.length === 1 ? ' لاعب' : ' لاعبين');
        renderStandings(msg.standings || ps);
      } else if (me) {
        $('hudLbl').textContent = me.dead ? '☠️ سقطت — جارٍ نقلك للمستشفى…' : '💵 $' + me.score + ' • ' + '★'.repeat(me.stars || 0) + (me.stars ? '' : '☆') + ' • ❤ ' + (me.hp === undefined ? 100 : me.hp) + (me.armor ? ' 🛡' + me.armor : '') + (me.gun ? ' • ' + me.gun : '') + (me.inCar ? ' • 🚗' : '');
      }
      const phases = { lobby: 'الردهة', playing: 'تلعب الآن', paused: 'متوقفة مؤقتاً', over: 'انتهت اللعبة' };
      if (role !== 'spectator') $('phaseLbl').textContent = phases[msg.phase] || (msg.missionName || msg.phase || '');
      if (msg.missionName && role !== 'spectator') $('phaseLbl').textContent = msg.missionName;
      if (msg.standings && msg.standings.length > 1 && role === 'spectator') renderStandings(msg.standings);
    } else if (msg.t === 'err') {
      $('joinErr').textContent = msg.m || 'خطأ';
      $('joinBtn').disabled = false;
      $('joinBtn').textContent = '🎮 انضم للعب';
      if (msg.fatal && ws) { try { ws.close(); } catch (e) {} }
    } else if (msg.t === 'room') {
      const n = (msg.players || []).length;
      $('connLbl').textContent = '✅ متصل • ' + n + (n === 1 ? ' لاعب' : ' لاعبين');
    }
  };
  ws.onclose = () => { $('connLbl').textContent = '⚠ انقطع الاتصال'; };
  ws.onerror = () => { $('joinErr').textContent = 'تعذر الاتصال بالخادم'; $('joinBtn').disabled = false; $('joinBtn').textContent = '🎮 انضم للعب'; };
}
$('joinBtn').addEventListener('click', join);
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
