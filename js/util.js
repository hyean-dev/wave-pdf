import { I } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'icon') e.insertAdjacentHTML('afterbegin', I[v] || '');
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const icon = (name) => I[name] || '';

export function svgEl(tag, attrs = {}) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}

let toastTimer;
export function toast(msg, ms = 2400) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Generic modal. buttons: [{label, value, primary, danger}] → resolves value (null on dismiss) */
export function modal({ title, body, buttons = [{ label: '확인', value: true, primary: true }], dismissible = true, wide = false, className = '', onOpen } = {}) {
  return new Promise((resolve) => {
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: `modal ${wide ? 'wide' : ''} ${className}` });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    if (title) box.append(el('div', { class: 'modal-title' }, title));
    if (body) box.append(el('div', { class: 'modal-body' }, body));
    if (buttons.length) {
      const bar = el('div', { class: 'modal-btns' });
      for (const b of buttons) {
        bar.append(el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: async () => {
          if (b.validate && !(await b.validate())) return;
          close(typeof b.value === 'function' ? b.value() : b.value);
        } }, b.label));
      }
      box.append(bar);
    }
    back.append(box);
    if (dismissible) back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) close(null);
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA') {
        const p = buttons.find((b) => b.primary); if (p) { e.preventDefault(); bar_click(p); }
      }
    };
    const bar_click = (p) => { const idx = buttons.indexOf(p); box.querySelectorAll('.modal-btns .btn')[idx]?.click(); };
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    back._close = close;
    onOpen?.(close);
    setTimeout(() => box.querySelector('input,textarea')?.focus(), 30);
  });
}

export const confirmDialog = (msg, ok = '확인', danger = false) =>
  modal({ title: msg, buttons: [{ label: '취소', value: false }, { label: ok, value: true, primary: !danger, danger }] }).then((v) => !!v);

export function promptDialog(title, value = '', { placeholder = '', type = 'text', multiline = false, ok = '확인' } = {}) {
  const input = multiline
    ? el('textarea', { class: 'input', rows: 5, placeholder })
    : el('input', { class: 'input', type, placeholder });
  input.value = value;
  return modal({ title, body: input, buttons: [{ label: '취소', value: null }, { label: ok, value: () => input.value, primary: true }] });
}

export function busy(msg = '처리 중…') {
  const b = el('div', { class: 'busy' }, el('div', { class: 'spinner' }), el('div', { class: 'busy-msg' }, msg));
  document.body.append(b);
  const t = setTimeout(() => {
    if (!b.isConnected) return;
    b.append(el('div', { class: 'busy-slow' }, '오래 걸리고 있어요.',
      el('button', { class: 'btn small', onclick: () => b.remove() }, '닫기'),
      el('button', { class: 'btn small', onclick: () => location.replace(location.pathname + '?reset=1') }, '앱 초기화')));
  }, 12000);
  return { close: () => { clearTimeout(t); b.remove(); }, set: (m) => (b.querySelector('.busy-msg').textContent = m) };
}
/** reject if a promise takes longer than ms */
export function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

export function downloadBlob(blob, name) {
  if (window.Capacitor?.isNativePlatform?.()) {
    // the APK has no downloads folder flow: ask where to save
    blob.arrayBuffer().then((b) => import('./native.js').then((N) => N.saveAs(name, new Uint8Array(b))))
      .then(() => toast('저장했어요')).catch((e) => { if (e?.message !== 'CANCELLED') toast('저장 실패: ' + e.message); });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = () => { clearTimeout(t); fn(); };
  return d;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c) {
  if (!c) return '#000000';
  return '#' + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;
export const baseName = (n) => (n || 'document.pdf').replace(/\.pdf$/i, '');
export const fmtDate = (s) => { try { const d = new Date(s); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; } catch { return ''; } };
export const fmtSize = (b) => (b == null ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');
