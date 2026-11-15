const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const mkEl = () => {
  const el = { hidden: false, style: {}, textContent: '', innerHTML: '', clientWidth: 800, clientHeight: 600, disabled: false, dataset: {}, value: '',
    classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, getContext: () => ctx, appendChild() {} };
  return el;
};
const els = {};
globalThis.document = { hidden: false, getElementById: (id) => (els[id] = els[id] || mkEl()), createElement: () => mkEl(), querySelectorAll: () => [], head: mkEl(), body: mkEl() };
globalThis.window = globalThis;
globalThis.location = { protocol: 'http:', host: 'x' };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.devicePixelRatio = 1; globalThis.innerWidth = 800; globalThis.innerHeight = 600;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => {};
globalThis.WebSocket = class { constructor() { globalThis.__ws = this; this.readyState = 1; } send() {} };
globalThis.__els = els;
