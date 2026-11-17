import { el, modal, toast, icon } from './util.js';

const KEY = 'signatures';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const store = (list) => localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8)));

function trim(canvas, padding = 8) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 10) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  }
  if (x2 < 0) return null;
  x1 = Math.max(0, x1 - padding); y1 = Math.max(0, y1 - padding);
  x2 = Math.min(w - 1, x2 + padding); y2 = Math.min(h - 1, y2 + padding);
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1; out.height = y2 - y1 + 1;
  out.getContext('2d').drawImage(canvas, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height };
}

function drawPad() {
  const wrap = el('div', { class: 'sigpad' });
  const canvas = el('canvas', { class: 'sigcanvas' });
  let color = '#111111';
  const colors = el('div', { class: 'sig-colors' });
  for (const c of ['#111111', '#1E3A8A', '#C62828']) {
    colors.append(el('button', { class: `swatch ${c === color ? 'on' : ''}`, style: { background: c }, onclick: (e) => {
      color = c; colors.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on')); e.currentTarget.classList.add('on');
    } }));
  }
  const clearBtn = el('button', { class: 'btn small', onclick: () => ctx.clearRect(0, 0, canvas.width, canvas.height) }, '지우기');
  const keep = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: true }), ' 서명 저장해두기');
  wrap.append(canvas, el('div', { class: 'sig-tools' }, colors, clearBtn, keep));
  let ctx;
  requestAnimationFrame(() => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  });
  let last = null, lastW = 2.6;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); const r = canvas.getBoundingClientRect(); last = [e.clientX - r.left, e.clientY - r.top, e.timeStamp]; e.preventDefault(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!last || !ctx) return;
    const r = canvas.getBoundingClientRect();
    const p = [e.clientX - r.left, e.clientY - r.top, e.timeStamp];
    const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
    const v = dist / Math.max(1, p[2] - last[2]);
    const pressure = e.pointerType === 'pen' && e.pressure ? e.pressure : null;
    const w = pressure ? 1 + pressure * 3.5 : Math.max(1.2, Math.min(3.6, 3.6 - v * 1.4));
    lastW = lastW * 0.6 + w * 0.4;
    ctx.strokeStyle = color; ctx.lineWidth = lastW;
    ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    last = p;
  });
  const up = () => { last = null; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  return { node: wrap, result: () => (ctx ? trim(canvas) : null), keep: () => keep.querySelector('input').checked };
}

async function drawNew() {
  const pad = drawPad();
  const r = await modal({ title: '서명 그리기', body: pad.node, wide: true, buttons: [{ label: '취소', value: null }, { label: '사용', value: () => pad.result() || 'empty', primary: true }] });
  if (r === 'empty') { toast('서명을 그려주세요'); return null; }
  if (r && pad.keep()) store([r, ...load()]);
  return r;
}

async function fromImage() {
  const input = el('input', { type: 'file', accept: 'image/*' });
  const file = await new Promise((res) => { input.onchange = () => res(input.files[0]); input.click(); });
  if (!file) return null;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
  const c = el('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (l > 200) d[i + 3] = 0; else if (l > 150) d[i + 3] = Math.round(((200 - l) / 50) * 255);
  }
  ctx.putImageData(id, 0, 0);
  const r = trim(c, 4);
  if (r) store([r, ...load()]);
  return r;
}

/** returns {dataUrl, w, h} or null */
export function pickSignature() {
  return new Promise((resolve) => {
    const list = load();
    const grid = el('div', { class: 'sig-grid' });
    let closeModal;
    const choose = (s) => { closeModal?.(s); };
    const render = () => {
      grid.replaceChildren();
      const cur = load();
      if (!cur.length) grid.append(el('div', { class: 'muted' }, '저장된 서명이 없어요.'));
      cur.forEach((s, i) => {
        grid.append(el('div', { class: 'sig-item', onclick: () => choose(s) },
          el('img', { src: s.dataUrl, alt: '서명' }),
          el('button', { class: 'sig-del', title: '삭제', html: icon('x'), onclick: (e) => { e.stopPropagation(); const l = load(); l.splice(i, 1); store(l); render(); } })));
      });
    };
    render();
    const body = el('div', {}, grid,
      el('div', { class: 'row gap' },
        el('button', { class: 'btn', icon: 'pen', onclick: async () => { const r = await drawNew(); if (r) choose(r); } }, ' 새 서명 그리기'),
        el('button', { class: 'btn', icon: 'image', onclick: async () => { const r = await fromImage(); if (r) choose(r); } }, ' 이미지에서')));
    const p = modal({ title: '서명 선택', body, buttons: [{ label: '닫기', value: null }], onOpen: (c) => (closeModal = c) });
    void list;
    p.then((v) => resolve(v || null));
  });
}
