// Annotation model, overlay rendering and tool interaction
import { S, CFG, emit, on, PALETTE, saveCfg } from './state.js';
import { viewer, eventBus, scrollToPoint } from './viewer.js';
import { $, el, svgEl, uid, hexToRgb, rgbToHex, toast, modal, icon, clamp } from './util.js';
import { underlineRect, arrowHead, wrapText } from './pdfio.js';

let container;
const MARKUP = new Set(['highlight', 'underline', 'strike']);
const RECTISH = new Set(['square', 'circle', 'freetext', 'stamp']);
const TYPE_LABEL = { highlight: '하이라이트', underline: '밑줄', strike: '취소선', ink: '펜', freetext: '글상자', note: '메모', square: '사각형', circle: '원', arrow: '화살표', stamp: '서명' };
export const typeLabel = (a) => (a.type === 'ink' && a.marker ? '형광펜' : TYPE_LABEL[a.type] || a.type);

// ---------------- history ----------------
const undoStack = [], redoStack = [];
const snap = () => JSON.stringify(S.annots);
export function resetHistory() { undoStack.length = 0; redoStack.length = 0; emitHistory(); }
function emitHistory() { emit('history', { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }); }
function pushUndo() { undoStack.push(snap()); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; }
function changed(pages) {
  S.dirty = true;
  emit('changed', {});
  if (pages == null || pages === 'all') renderAll(); else [].concat(pages).forEach(renderPage);
  emitHistory();
}
export function commit(mutator, pages) { pushUndo(); mutator(); changed(pages); }
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snap()); S.annots = JSON.parse(undoStack.pop());
  deselect(false); changed('all');
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap()); S.annots = JSON.parse(redoStack.pop());
  deselect(false); changed('all');
}

function pageAnns(p) { return (S.annots[p] ||= []); }
export function findAnn(p, id) { return pageAnns(p).find((a) => a.id === id); }
function newAnn(type, props) {
  return { id: uid(), type, author: S.author, modified: Date.now(), text: '', ...props };
}

// ---------------- geometry ----------------
function vpOf(p) { return viewer.getPageView(p)?.viewport; }
function toV(vp, x, y) { return vp.convertToViewportPoint(x, y); }
function rectToV(vp, r) {
  const a = toV(vp, r[0], r[1]), b = toV(vp, r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
function rectToPdf(vp, r) {
  const a = vp.convertToPdfPoint(r[0], r[1]), b = vp.convertToPdfPoint(r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((v) => Math.round(v * 100) / 100);
}
function annBBox(a) {
  if (a.rects) return a.rects.reduce((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  if (a.paths) { const f = a.paths.flat(); const xs = f.filter((_, i) => !(i % 2)), ys = f.filter((_, i) => i % 2); const w = (a.width || 1) / 2; return [Math.min(...xs) - w, Math.min(...ys) - w, Math.max(...xs) + w, Math.max(...ys) + w]; }
  if (a.line) return [Math.min(a.line[0], a.line[2]), Math.min(a.line[1], a.line[3]), Math.max(a.line[0], a.line[2]), Math.max(a.line[1], a.line[3])];
  return a.rect;
}
export { annBBox };
function translateAnn(a, dx, dy) {
  const mv = (r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
  if (a.rects) a.rects = a.rects.map(mv);
  if (a.rect) a.rect = mv(a.rect);
  if (a.line) a.line = mv(a.line);
  if (a.paths) a.paths = a.paths.map((p) => p.map((v, i) => (i % 2 ? v + dy : v + dx)));
}
function rotDelta(vp, a) { return ((((vp.rotation - (a.rot || 0)) % 360) + 360) % 360); }
function wrapPoint(e, wrap, vp) {
  const r = wrap.getBoundingClientRect();
  return [(e.clientX - r.left) * (vp.width / r.width), (e.clientY - r.top) * (vp.height / r.height)];
}
function smoothD(pts) {
  // pts: [[x,y],...] viewport
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}l0.01 0`;
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const ex = (pts[i][0] + pts[i + 1][0]) / 2, ey = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  return d + `L${l[0].toFixed(1)} ${l[1].toFixed(1)}`;
}

// ---------------- rendering ----------------
function ensureLayer(pv) {
  let w = pv.div.querySelector(':scope > .ann-wrap');
  if (!w) {
    w = el('div', { class: 'ann-wrap' });
    w.append(svgEl('svg', { class: 'ann-hl', preserveAspectRatio: 'none' }), svgEl('svg', { class: 'ann-top', preserveAspectRatio: 'none' }),
      el('div', { class: 'ann-html' }), svgEl('svg', { class: 'ann-ui', preserveAspectRatio: 'none' }));
    pv.div.append(w);
  }
  return w;
}

export function renderPage(p) {
  const pv = viewer.getPageView(p);
  if (!pv?.div || !pv.viewport) return;
  const w = ensureLayer(pv), vp = pv.viewport;
  const [hl, top, html, ui] = w.children;
  for (const s of [hl, top, ui]) { s.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`); s.replaceChildren(); }
  html.replaceChildren();
  for (const a of S.annots[p] || []) {
    if (editing && editing.a.id === a.id) continue;
    try { drawAnn(a, vp, hl, top, html); } catch (e) { console.warn(e); }
  }
  if (S.selected?.page === p) drawSelection(p, w, vp);
  if (editing?.page === p) placeEditor();
}
export function renderAll() {
  if (!viewer?.pdfDocument) return;
  for (let i = 0; i < viewer.pagesCount; i++) {
    const pv = viewer.getPageView(i);
    if (pv?.div?.querySelector(':scope > .ann-wrap') || pv?.renderingState === 3) renderPage(i);
  }
}

function drawAnn(a, vp, hl, top, html) {
  const col = rgbToHex(a.color);
  const sc = vp.scale;
  const g = svgEl('g', { 'data-id': a.id, class: 'ann' });
  switch (a.type) {
    case 'highlight': {
      g.setAttribute('fill', col); g.setAttribute('opacity', a.opacity ?? 1);
      for (const r of a.rects) { const v = rectToV(vp, r); g.append(svgEl('rect', { x: v[0], y: v[1], width: v[2] - v[0], height: v[3] - v[1] })); }
      hl.append(g); break;
    }
    case 'underline': case 'strike': {
      for (const r of a.rects) {
        const v = rectToV(vp, r);
        g.append(svgEl('rect', { x: v[0], y: v[1], width: v[2] - v[0], height: v[3] - v[1], fill: 'transparent' }));
        const u = rectToV(vp, underlineRect(r, a.type));
        g.append(svgEl('rect', { x: u[0], y: u[1], width: u[2] - u[0], height: Math.max(1, u[3] - u[1]), fill: col }));
      }
      top.append(g); break;
    }
    case 'ink': {
      const sw = Math.max(0.8, (a.width || 1) * sc);
      for (const p of a.paths) {
        const pts = []; for (let i = 0; i < p.length; i += 2) pts.push(toV(vp, p[i], p[i + 1]));
        const d = smoothD(pts);
        g.append(svgEl('path', { d, stroke: 'transparent', 'stroke-width': sw + 14, fill: 'none', class: 'hit', 'stroke-linecap': 'round' }));
        g.append(svgEl('path', { d, stroke: col, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
      if (a.marker) { g.setAttribute('opacity', a.opacity ?? 1); hl.append(g); } else { if ((a.opacity ?? 1) < 1) g.setAttribute('opacity', a.opacity); top.append(g); }
      break;
    }
    case 'square': case 'circle': {
      const v = rectToV(vp, a.rect), sw = Math.max(0.8, (a.width || 1) * sc);
      const attrs = { fill: 'none', stroke: col, 'stroke-width': sw };
      const hit = { fill: 'none', stroke: 'transparent', 'stroke-width': sw + 14, class: 'hit' };
      if (a.type === 'square') {
        const r = { x: v[0], y: v[1], width: v[2] - v[0], height: v[3] - v[1] };
        g.append(svgEl('rect', { ...r, ...hit }), svgEl('rect', { ...r, ...attrs }));
      } else {
        const e = { cx: (v[0] + v[2]) / 2, cy: (v[1] + v[3]) / 2, rx: (v[2] - v[0]) / 2, ry: (v[3] - v[1]) / 2 };
        g.append(svgEl('ellipse', { ...e, ...hit }), svgEl('ellipse', { ...e, ...attrs }));
      }
      top.append(g); break;
    }
    case 'arrow': {
      const sw = Math.max(0.8, (a.width || 1) * sc);
      const p1 = toV(vp, a.line[0], a.line[1]), p2 = toV(vp, a.line[2], a.line[3]);
      let d = `M${p1[0]} ${p1[1]}L${p2[0]} ${p2[1]}`;
      if (a.head !== false) {
        const h = arrowHead(a.line, a.width || 1);
        const h1 = toV(vp, h[0], h[1]), h3 = toV(vp, h[4], h[5]);
        d += `M${h1[0]} ${h1[1]}L${p2[0]} ${p2[1]}L${h3[0]} ${h3[1]}`;
      }
      g.append(svgEl('path', { d, stroke: 'transparent', 'stroke-width': sw + 14, fill: 'none', class: 'hit' }),
        svgEl('path', { d, stroke: col, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      top.append(g); break;
    }
    case 'note': {
      const v = rectToV(vp, a.rect), w = v[2] - v[0], h = v[3] - v[1];
      g.append(svgEl('rect', { x: v[0] + 0.5, y: v[1] + 0.5, width: w - 1, height: h - 1, rx: 2, fill: col, stroke: '#444', 'stroke-width': 0.8 }));
      for (const t of [0.28, 0.48, 0.68]) g.append(svgEl('line', { x1: v[0] + w * 0.2, x2: v[2] - w * 0.2, y1: v[1] + h * t, y2: v[1] + h * t, stroke: '#333', 'stroke-width': Math.max(0.8, sc * 0.9) }));
      if (a.text) g.append(svgEl('circle', { cx: v[2], cy: v[1], r: Math.max(2.5, 2.5 * sc), fill: '#E53935' }));
      top.append(g); break;
    }
    case 'stamp': {
      const v = rectToV(vp, a.rect), src = S.images[a.img];
      if (!src) break;
      const dl = rotDelta(vp, a), swap = dl === 90 || dl === 270;
      const cx = (v[0] + v[2]) / 2, cy = (v[1] + v[3]) / 2;
      const w = swap ? v[3] - v[1] : v[2] - v[0], h = swap ? v[2] - v[0] : v[3] - v[1];
      g.append(svgEl('rect', { x: v[0], y: v[1], width: v[2] - v[0], height: v[3] - v[1], fill: 'transparent' }));
      g.append(svgEl('image', { href: src, x: cx - w / 2, y: cy - h / 2, width: w, height: h, preserveAspectRatio: 'none', transform: dl ? `rotate(${dl} ${cx} ${cy})` : null }));
      top.append(g); break;
    }
    case 'freetext': {
      const v = rectToV(vp, a.rect);
      const box = el('div', { class: 'ann ann-ft', 'data-id': a.id });
      positionBox(box, v, vp);
      const dl = rotDelta(vp, a), swap = dl === 90 || dl === 270;
      const W = v[2] - v[0], H = v[3] - v[1];
      const inner = el('div', { class: 'ft-inner' }, a.text || '');
      Object.assign(inner.style, {
        width: `${((swap ? H : W) / W) * 100}%`,
        height: `${((swap ? W : H) / H) * 100}%`,
        fontSize: `calc(var(--scale-factor) * ${a.fontSize || 12}px)`,
        fontWeight: a.bold ? '700' : '',
        padding: `calc(var(--scale-factor) * 2px)`,
        color: col,
        transform: `translate(-50%,-50%)${dl ? ` rotate(${dl}deg)` : ''}`,
      });
      box.append(inner);
      html.append(box); break;
    }
  }
  if (a.text && a.type !== 'freetext' && a.type !== 'note') g.classList.add('has-comment');
}
function positionBox(box, v, vp) {
  Object.assign(box.style, {
    left: (v[0] / vp.width) * 100 + '%', top: (v[1] / vp.height) * 100 + '%',
    width: ((v[2] - v[0]) / vp.width) * 100 + '%', height: ((v[3] - v[1]) / vp.height) * 100 + '%',
  });
}

function drawSelection(p, wrap, vp) {
  const a = findAnn(p, S.selected.id);
  if (!a) return;
  const ui = wrap.children[3];
  const v = rectToV(vp, annBBox(a));
  const padPx = 4;
  const x = v[0] - padPx, y = v[1] - padPx, w = v[2] - v[0] + padPx * 2, h = v[3] - v[1] + padPx * 2;
  const movable = !MARKUP.has(a.type);
  ui.append(svgEl('rect', { x, y, width: w, height: h, class: `sel-box ${movable ? 'movable' : ''}`, fill: movable ? 'rgba(30,136,229,0.04)' : 'none' }));
  if (RECTISH.has(a.type)) ui.append(svgEl('circle', { cx: x + w, cy: y + h, r: 9, class: 'sel-handle' }));
  queueMicrotask(positionMenu);
}

// ---------------- selection & context menu ----------------
export function select(p, id) {
  const prev = S.selected;
  S.selected = { page: p, id };
  if (prev && prev.page !== p) renderPage(prev.page);
  renderPage(p);
  showAnnMenu();
}
export function deselect(render = true) {
  const prev = S.selected;
  S.selected = null;
  hideMenu();
  if (render && prev) renderPage(prev.page);
}

let menuEl = null, menuAnchor = null;
function hideMenu() { menuEl?.remove(); menuEl = null; menuAnchor = null; }
function showMenu(items, anchorFn, extra) {
  hideMenu();
  menuEl = el('div', { class: 'ctx-menu' });
  if (extra) menuEl.append(extra);
  const row = el('div', { class: 'ctx-row' });
  for (const it of items) {
    if (it.swatches) {
      const sw = el('div', { class: 'ctx-swatches' });
      for (const c of it.swatches) sw.append(el('button', { class: `swatch ${c === it.current ? 'on' : ''}`, style: { background: c }, onclick: (e) => { e.stopPropagation(); it.pick(c); } }));
      row.append(sw);
    } else {
      row.append(el('button', { class: `ctx-btn ${it.danger ? 'danger' : ''}`, title: it.label, onclick: (e) => { e.stopPropagation(); it.run(); } },
        el('span', { class: 'ico', html: icon(it.icon) }), el('span', { class: 'lbl' }, it.label)));
    }
  }
  menuEl.append(row);
  menuEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(menuEl);
  menuAnchor = anchorFn;
  positionMenu();
}
function positionMenu() {
  if (!menuEl || !menuAnchor) return;
  const r = menuAnchor();
  if (!r) { menuEl.style.display = 'none'; return; }
  const cr = container.getBoundingClientRect();
  if (r.bottom < cr.top || r.top > cr.bottom) { menuEl.style.display = 'none'; return; }
  menuEl.style.display = '';
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  let x = clamp(r.left + r.width / 2 - mw / 2, 8, innerWidth - mw - 8);
  let y = r.top - mh - 10;
  if (y < cr.top + 4) y = Math.min(r.bottom + 10, cr.bottom - mh - 4);
  menuEl.style.left = x + 'px'; menuEl.style.top = y + 'px';
}

function selBoxRect() {
  if (!S.selected) return null;
  const pv = viewer.getPageView(S.selected.page);
  return pv?.div.querySelector('.ann-ui .sel-box')?.getBoundingClientRect() || null;
}

function showAnnMenu() {
  const { page, id } = S.selected || {};
  const a = findAnn(page, id);
  if (!a) return hideMenu();
  const isHl = a.type === 'highlight' || (a.type === 'ink' && a.marker);
  const sw = a.type === 'note' ? PAL.note : isHl ? PAL.highlight : PAL.ink;
  const items = [];
  if (a.type !== 'stamp') items.push({ swatches: sw, current: rgbToHex(a.color).toUpperCase(), pick: (c) => { commit(() => { a.color = hexToRgb(c); a.modified = Date.now(); }, page); showAnnMenu(); } });
  if (a.type === 'freetext') {
    items.push({ icon: 'bold', label: a.bold ? '보통' : '굵게', run: () => { commit(() => { a.bold = !a.bold; a.modified = Date.now(); refitFreetext(page, a); }, page); showAnnMenu(); } });
    items.push({ icon: 'edit', label: '편집', run: () => startEdit(page, a) });
  }
  else items.push({ icon: 'note', label: a.text ? '메모 수정' : '메모', run: () => editComment(page, a) });
  if (a.quote) items.push({ icon: 'copy', label: '복사', run: () => copyText(a.quote) });
  items.push({ icon: 'trash', label: '삭제', danger: true, run: () => deleteSelected() });
  let extra = null;
  if (a.text && a.type !== 'freetext') extra = el('div', { class: 'ctx-comment', onclick: () => editComment(page, a) }, el('b', {}, a.author || ''), ' ', a.text);
  showMenu(items, selBoxRect, extra);
}
const PAL = PALETTE;

export function deleteSelected() {
  if (!S.selected) return;
  const { page, id } = S.selected;
  deselect(false);
  commit(() => { S.annots[page] = pageAnns(page).filter((x) => x.id !== id); }, page);
}

async function editComment(page, a) {
  hideMenu();
  const ta = el('textarea', { class: 'input', rows: 5, placeholder: '메모를 입력하세요' });
  ta.value = a.text || '';
  const quote = a.quote ? el('div', { class: 'quote' }, a.quote) : null;
  const v = await modal({ title: `${typeLabel(a)} 메모`, body: el('div', {}, quote, ta), buttons: [{ label: '취소', value: null }, { label: '저장', value: () => ta.value, primary: true }] });
  if (v == null) {
    if (a.type === 'note' && !a.text && a._new) commit(() => { S.annots[page] = pageAnns(page).filter((x) => x.id !== a.id); }, page);
    delete a._new;
    if (S.selected) showAnnMenu();
    return;
  }
  delete a._new;
  commit(() => { a.text = v.trim(); a.modified = Date.now(); }, page);
  if (S.selected?.id === a.id) showAnnMenu();
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('복사했어요'); }
  catch { toast('복사하지 못했어요'); }
}

// ---------------- text selection model ----------------
function getChars(pv, wrap) {
  const vp = pv.viewport;
  const key = `${vp.width}x${vp.height}`;
  if (pv._chars?.key === key && pv._chars.chars.length) return pv._chars.chars;
  const tl = pv.div.querySelector('.textLayer');
  const chars = [];
  if (tl) {
    const wr = wrap.getBoundingClientRect();
    const sx = vp.width / wr.width, sy = vp.height / wr.height;
    const range = document.createRange();
    const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    let n, ni = 0;
    while ((n = walker.nextNode())) {
      const t = n.data;
      for (let i = 0; i < t.length; i++) {
        const code = t.charCodeAt(i);
        const len = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
        range.setStart(n, i); range.setEnd(n, Math.min(t.length, i + len));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) chars.push({ x1: (r.left - wr.left) * sx, y1: (r.top - wr.top) * sy, x2: (r.right - wr.left) * sx, y2: (r.bottom - wr.top) * sy, c: t.slice(i, i + len), n: ni });
        i += len - 1;
      }
      ni++;
    }
  }
  const ordered = visualOrder(chars);
  pv._chars = { key, chars: ordered };
  return ordered;
}
/** Re-order characters by on-screen lines (top→bottom, left→right) so selection
 *  follows what the user sees, not the PDF's internal text order. */
function visualOrder(chars) {
  if (chars.length < 2) return chars;
  const byY = chars.map((c) => ({ c, cy: (c.y1 + c.y2) / 2, h: c.y2 - c.y1 })).sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const it of byY) {
    const ln = lines[lines.length - 1];
    if (ln && Math.abs(it.cy - ln.cy) < Math.max(it.h, ln.h) * 0.45) {
      ln.items.push(it.c);
      ln.cy = (ln.cy * (ln.items.length - 1) + it.cy) / ln.items.length;
      ln.h = Math.max(ln.h, it.h);
    } else lines.push({ cy: it.cy, h: it.h, items: [it.c] });
  }
  const out = [];
  for (const ln of lines) out.push(...ln.items.sort((a, b) => a.x1 - b.x1));
  return out;
}
function nearestChar(chars, p, maxD = Infinity) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const dx = p[0] < c.x1 ? c.x1 - p[0] : p[0] > c.x2 ? p[0] - c.x2 : 0;
    const dy = p[1] < c.y1 ? c.y1 - p[1] : p[1] > c.y2 ? p[1] - c.y2 : 0;
    const d = dx + dy * 3;
    if (d < bd) { bd = d; best = i; if (d === 0) break; }
  }
  return bd <= maxD ? best : -1;
}
function selLines(chars, i0, i1) {
  const lines = [];
  let cur = null;
  for (let i = i0; i <= i1; i++) {
    const c = chars[i];
    const h = c.y2 - c.y1, cy = (c.y1 + c.y2) / 2;
    if (cur && Math.abs(cy - cur.cy) < Math.max(h, cur.h) * 0.5 && c.x1 >= cur.x2 - h * 0.6 && c.x1 - cur.x2 < h * 2.5) {
      if (c.n !== cur.lastN && c.x1 - cur.x2 > h * 0.15 && !/\s$/.test(cur.text)) cur.text += ' ';
      cur.x2 = Math.max(cur.x2, c.x2); cur.y1 = Math.min(cur.y1, c.y1); cur.y2 = Math.max(cur.y2, c.y2); cur.text += c.c; cur.lastN = c.n;
    } else {
      if (cur) lines.push(cur);
      cur = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, cy, h, text: c.c, lastN: c.n };
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------- tools / pointer interaction ----------------
let gesture = null;
let editing = null; // {page, a, isNew, ta}

export function initAnnots(containerEl) {
  container = containerEl;
  eventBus.on('pagerendered', ({ pageNumber }) => renderPage(pageNumber - 1));
  eventBus.on('textlayerrendered', ({ pageNumber }) => { const pv = viewer.getPageView(pageNumber - 1); if (pv) pv._chars = null; });
  container.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', (e) => { if (gesture?.id === e.pointerId) cancelGesture(); });
  container.addEventListener('scroll', () => requestAnimationFrame(positionMenu), { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(positionMenu));
  on('pinchstart', () => cancelGesture());
  on('scale', () => requestAnimationFrame(() => requestAnimationFrame(positionMenu)));
  container.addEventListener('dblclick', (e) => {
    const hit = e.target.closest?.('[data-id]');
    const pageEl = e.target.closest?.('.page');
    if (!hit || !pageEl || S.tool !== 'hand') return;
    const p = +pageEl.dataset.pageNumber - 1, a = findAnn(p, hit.dataset.id);
    if (a?.type === 'freetext') startEdit(p, a);
    else if (a) editComment(p, a);
  });
}

export function setTool(t) {
  if (editing) finishEdit();
  cancelGesture();
  deselect();
  hideMenu();
  S.tool = t;
  container.dataset.tool = t;
  container.classList.toggle('tool-draw', t !== 'hand');
}

function cancelGesture() {
  if (!gesture) return;
  gesture.temp?.remove();
  if (gesture.type === 'move' || gesture.type === 'resize') { S.annots = JSON.parse(undoStack.pop()); renderAll(); emitHistory(); }
  gesture = null;
}

function pageFromEvent(e) {
  const pageEl = e.target.closest?.('.page');
  if (!pageEl) return null;
  const p = +pageEl.dataset.pageNumber - 1;
  const pv = viewer.getPageView(p);
  if (!pv?.viewport) return null;
  const wrap = ensureLayer(pv);
  return { p, pv, wrap, vp: pv.viewport, pt: wrapPoint(e, wrap, pv.viewport) };
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (menuEl?.contains(e.target)) return;
  if (gesture) { // second pointer → abort current gesture (pinch)
    if (e.pointerType === 'touch') cancelGesture();
    return;
  }
  if (editing) {
    if (editing.ta.contains(e.target)) return;
    finishEdit();
    e.preventDefault();
    return;
  }
  const info = pageFromEvent(e);
  const tool = S.tool;

  if (tool === 'hand') {
    const handle = e.target.closest?.('.sel-handle');
    const selBox = e.target.closest?.('.sel-box.movable');
    if (info && S.selected && S.selected.page === info.p && (handle || selBox)) {
      e.preventDefault();
      pushUndo();
      gesture = { id: e.pointerId, type: handle ? 'resize' : 'move', ...info, start: info.pt, orig: JSON.parse(JSON.stringify(findAnn(info.p, S.selected.id))), moved: false };
      return;
    }
    const hit = e.target.closest?.('[data-id]');
    if (info && hit) {
      const id = hit.dataset.id;
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        e.preventDefault();
        select(info.p, id);
        const a = findAnn(info.p, id);
        if (a && !MARKUP.has(a.type)) {
          pushUndo();
          gesture = { id: e.pointerId, type: 'move', ...info, start: info.pt, orig: JSON.parse(JSON.stringify(a)), moved: false };
        }
      } else {
        gesture = { id: e.pointerId, type: 'tap-select', ...info, annId: id, start: [e.clientX, e.clientY] };
      }
      return;
    }
    if (S.selected) gesture = { id: e.pointerId, type: 'tap-deselect', start: [e.clientX, e.clientY] };
    return;
  }

  if (!info) return;
  if (tool !== 'hand' && e.pointerType === 'touch' && CFG.penOnly && ['pen', 'marker', 'shape', 'eraser'].includes(tool)) {
    gesture = { id: e.pointerId, type: 'pan', last: [e.clientX, e.clientY] };
    return;
  }
  e.preventDefault();
  const ui = info.wrap.children[3];
  switch (tool) {
    case 'text': case 'highlight': case 'underline': case 'strike': {
      hideMenu();
      const chars = getChars(info.pv, info.wrap);
      let i0 = -1;
      if (chars.length) i0 = nearestChar(chars, info.pt, tool === 'highlight' ? 18 : 60);
      if (i0 < 0 && tool === 'highlight') {
        const temp = svgEl('rect', { class: 'tmp-sel', fill: CFG.highlight.color, opacity: 0.6 });
        ui.append(temp);
        gesture = { id: e.pointerId, type: 'hlrect', ...info, start: info.pt, temp };
      } else if (i0 >= 0) {
        const temp = svgEl('g', { class: 'tmp-sel' });
        ui.append(temp);
        gesture = { id: e.pointerId, type: 'textsel', ...info, chars, i0, i1: i0, temp };
        drawTextSel();
      } else {
        toast('이 페이지에서 선택할 텍스트를 찾지 못했어요');
      }
      break;
    }
    case 'pen': case 'marker': {
      const cfg = CFG[tool];
      const temp = svgEl('path', { fill: 'none', stroke: cfg.color, 'stroke-width': Math.max(0.8, cfg.width * info.vp.scale), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: tool === 'marker' ? 0.6 : 1 });
      ui.append(temp);
      gesture = { id: e.pointerId, type: 'ink', ...info, pts: [info.pt], temp, tool };
      updateInkTemp();
      break;
    }
    case 'shape': {
      const kind = CFG.shape.kind;
      const temp = svgEl(kind === 'circle' ? 'ellipse' : kind === 'arrow' ? 'path' : 'rect', { fill: 'none', stroke: CFG.shape.color, 'stroke-width': Math.max(0.8, CFG.shape.width * info.vp.scale) });
      ui.append(temp);
      gesture = { id: e.pointerId, type: 'shape', kind, ...info, start: info.pt, cur: info.pt, temp };
      break;
    }
    case 'eraser':
      gesture = { id: e.pointerId, type: 'erase', erased: false };
      eraseAt(e);
      break;
    case 'freetext': case 'note': case 'sign':
      gesture = { id: e.pointerId, type: 'tap-' + tool, ...info, start: [e.clientX, e.clientY] };
      break;
  }
}

function onMove(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  switch (g.type) {
    case 'pan': {
      container.scrollLeft -= e.clientX - g.last[0];
      container.scrollTop -= e.clientY - g.last[1];
      g.last = [e.clientX, e.clientY];
      break;
    }
    case 'tap-select': case 'tap-deselect': case 'tap-freetext': case 'tap-note': case 'tap-sign':
      if (Math.hypot(e.clientX - g.start[0], e.clientY - g.start[1]) > 10) gesture = null;
      break;
    case 'textsel': {
      e.preventDefault();
      const pt = wrapPoint(e, g.wrap, g.vp);
      const i = nearestChar(g.chars, pt);
      if (i >= 0 && i !== g.i1) { g.i1 = i; drawTextSel(); }
      break;
    }
    case 'hlrect': case 'shape': {
      e.preventDefault();
      g.cur = wrapPoint(e, g.wrap, g.vp);
      const [x1, y1] = g.start, [x2, y2] = g.cur;
      if (g.type === 'shape' && g.kind === 'arrow') g.temp.setAttribute('d', `M${x1} ${y1}L${x2} ${y2}`);
      else if (g.type === 'shape' && g.kind === 'circle') { g.temp.setAttribute('cx', (x1 + x2) / 2); g.temp.setAttribute('cy', (y1 + y2) / 2); g.temp.setAttribute('rx', Math.abs(x2 - x1) / 2); g.temp.setAttribute('ry', Math.abs(y2 - y1) / 2); }
      else { g.temp.setAttribute('x', Math.min(x1, x2)); g.temp.setAttribute('y', Math.min(y1, y2)); g.temp.setAttribute('width', Math.abs(x2 - x1)); g.temp.setAttribute('height', Math.abs(y2 - y1)); }
      break;
    }
    case 'ink': {
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const pt = wrapPoint(ev, g.wrap, g.vp);
        const l = g.pts[g.pts.length - 1];
        if (Math.hypot(pt[0] - l[0], pt[1] - l[1]) >= 1.5) g.pts.push(pt);
      }
      updateInkTemp();
      break;
    }
    case 'erase': e.preventDefault(); eraseAt(e); break;
    case 'move': case 'resize': {
      e.preventDefault();
      const pt = wrapPoint(e, g.wrap, g.vp);
      const dx = pt[0] - g.start[0], dy = pt[1] - g.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 2) g.moved = true;
      const a = findAnn(g.p, g.orig.id);
      if (!a) return;
      const fresh = JSON.parse(JSON.stringify(g.orig));
      if (g.type === 'move') {
        const p0 = g.vp.convertToPdfPoint(0, 0), p1 = g.vp.convertToPdfPoint(dx, dy);
        translateAnn(fresh, p1[0] - p0[0], p1[1] - p0[1]);
      } else {
        const v = rectToV(g.vp, g.orig.rect);
        let nx2 = Math.max(v[0] + 12, v[2] + dx), ny2 = Math.max(v[1] + 12, v[3] + dy);
        if (g.orig.type === 'stamp') { const ar = (v[3] - v[1]) / (v[2] - v[0]); ny2 = v[1] + (nx2 - v[0]) * ar; }
        fresh.rect = rectToPdf(g.vp, [v[0], v[1], nx2, ny2]);
      }
      Object.assign(a, fresh);
      renderPage(g.p);
      break;
    }
  }
}

function onUp(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = null;
  g.temp?.remove();
  switch (g.type) {
    case 'tap-select': select(g.p, g.annId); break;
    case 'tap-deselect': deselect(); break;
    case 'textsel': finishTextSel(g); break;
    case 'hlrect': {
      const [x1, y1] = g.start, [x2, y2] = g.cur || g.start;
      if (Math.abs(x2 - x1) < 4 || Math.abs(y2 - y1) < 4) return;
      const r = rectToPdf(g.vp, [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
      commit(() => pageAnns(g.p).push(newAnn('highlight', { rects: [r], color: hexToRgb(CFG.highlight.color), opacity: 1 })), g.p);
      break;
    }
    case 'ink': {
      if (!g.pts.length) return;
      const cfg = CFG[g.tool];
      const path = [];
      for (const pt of g.pts) { const q = g.vp.convertToPdfPoint(pt[0], pt[1]); path.push(Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100); }
      commit(() => pageAnns(g.p).push(newAnn('ink', { paths: [path], width: cfg.width, color: hexToRgb(cfg.color), opacity: 1, marker: g.tool === 'marker' })), g.p);
      break;
    }
    case 'shape': {
      const [x1, y1] = g.start, [x2, y2] = g.cur;
      if (Math.hypot(x2 - x1, y2 - y1) < 6) return;
      const base = { width: CFG.shape.width, color: hexToRgb(CFG.shape.color), opacity: 1 };
      let a;
      if (g.kind === 'arrow') { const p1 = g.vp.convertToPdfPoint(x1, y1), p2 = g.vp.convertToPdfPoint(x2, y2); a = newAnn('arrow', { ...base, line: [p1[0], p1[1], p2[0], p2[1]].map((v) => Math.round(v * 100) / 100), head: true }); }
      else a = newAnn(g.kind, { ...base, rect: rectToPdf(g.vp, [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]) });
      commit(() => pageAnns(g.p).push(a), g.p);
      break;
    }
    case 'move': case 'resize':
      if (g.moved) { const a = findAnn(g.p, g.orig.id); if (a) a.modified = Date.now(); changed(g.p); }
      else { undoStack.pop(); emitHistory(); }
      showAnnMenu();
      break;
    case 'tap-freetext': {
      const hit = e.target.closest?.('.ann-ft');
      const ex = hit && findAnn(g.p, hit.dataset.id);
      if (ex) { startEdit(g.p, ex); break; }
      const fs = CFG.freetext.size, sc = g.vp.scale;
      const w = Math.min(200 * sc, g.vp.width - g.pt[0] - 4), h = fs * 1.25 * sc + 4 * sc;
      if (w < 30) return;
      const r = rectToPdf(g.vp, [g.pt[0], g.pt[1] - h / 2, g.pt[0] + w, g.pt[1] + h / 2]);
      const a = newAnn('freetext', { rect: r, fontSize: fs, color: hexToRgb(CFG.freetext.color), rot: g.vp.rotation, opacity: 1 });
      startEdit(g.p, a, true);
      break;
    }
    case 'tap-note': {
      const s = 20;
      const q = g.vp.convertToPdfPoint(g.pt[0], g.pt[1]);
      const a = newAnn('note', { rect: [q[0] - s / 2, q[1] - s / 2, q[0] + s / 2, q[1] + s / 2], color: hexToRgb(CFG.note.color), _new: true });
      commit(() => pageAnns(g.p).push(a), g.p);
      editComment(g.p, a);
      break;
    }
    case 'tap-sign': placeSignature(g); break;
    case 'erase': break;
  }
}

function drawTextSel() {
  const g = gesture;
  const [i0, i1] = g.i0 <= g.i1 ? [g.i0, g.i1] : [g.i1, g.i0];
  const lines = selLines(g.chars, i0, i1);
  g.temp.replaceChildren(...lines.map((l) => svgEl('rect', { x: l.x1, y: l.y1, width: l.x2 - l.x1, height: l.y2 - l.y1, fill: 'rgba(30,136,229,0.28)' })));
}

function finishTextSel(g) {
  const [i0, i1] = g.i0 <= g.i1 ? [g.i0, g.i1] : [g.i1, g.i0];
  const lines = selLines(g.chars, i0, i1);
  if (!lines.length) return;
  const rects = lines.map((l) => rectToPdf(g.vp, [l.x1, l.y1, l.x2, l.y2]));
  const quote = lines.map((l) => l.text.trim()).join('\n');
  const add = (type, withComment) => {
    hideMenu();
    const cfg = CFG[type];
    const a = newAnn(type, { rects, quote, color: hexToRgb(cfg.color), opacity: 1 });
    commit(() => pageAnns(g.p).push(a), g.p);
    if (withComment) { select(g.p, a.id); editComment(g.p, a); }
  };
  if (S.tool !== 'text') { add(S.tool, false); return; }
  // text tool: keep selection visible and show menu
  const ui = g.wrap.children[3];
  const keep = svgEl('g', { class: 'tmp-sel keep' });
  for (const l of lines) keep.append(svgEl('rect', { x: l.x1, y: l.y1, width: l.x2 - l.x1, height: l.y2 - l.y1, fill: 'rgba(30,136,229,0.28)' }));
  ui.append(keep);
  const clear = () => { keep.remove(); hideMenu(); };
  showMenu([
    { icon: 'highlight', label: '하이라이트', run: () => { clear(); add('highlight'); } },
    { icon: 'underline', label: '밑줄', run: () => { clear(); add('underline'); } },
    { icon: 'strike', label: '취소선', run: () => { clear(); add('strike'); } },
    { icon: 'note', label: '메모', run: () => { clear(); add('highlight', true); } },
    { icon: 'copy', label: '복사', run: () => { clear(); copyText(quote); } },
  ], () => keep.isConnected ? keep.getBoundingClientRect() : null);
  const off = (ev) => { if (menuEl?.contains(ev.target)) return; clear(); window.removeEventListener('pointerdown', off, true); };
  setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
}

function updateInkTemp() {
  const g = gesture;
  g.temp.setAttribute('d', smoothD(g.pts));
}

function eraseAt(e) {
  const els = document.elementsFromPoint(e.clientX, e.clientY);
  for (const x of els) {
    const hit = x.closest?.('[data-id]');
    const pageEl = x.closest?.('.page');
    if (!hit || !pageEl) continue;
    const p = +pageEl.dataset.pageNumber - 1, id = hit.dataset.id;
    if (!gesture.erased) { pushUndo(); gesture.erased = true; }
    S.annots[p] = pageAnns(p).filter((a) => a.id !== id);
    changed(p);
    break;
  }
}

// ---------------- free text editing ----------------
function startEdit(p, a, isNew = false) {
  if (editing) finishEdit();
  deselect();
  const ta = el('textarea', { class: 'ft-editor', placeholder: '텍스트 입력', spellcheck: 'false' });
  ta.value = a.text || '';
  editing = { page: p, a, isNew, ta, style: { color: rgbToHex(a.color), fontSize: a.fontSize || 12, bold: !!a.bold } };
  renderPage(p);
  ta.addEventListener('input', placeEditor);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      CFG.freetext.bold = !editing.style.bold; saveCfg();
      editStyle({ bold: CFG.freetext.bold }); emit('ftstyle');
    }
  });
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
}
function placeEditor() {
  if (!editing) return;
  const { page, a, ta, style } = editing;
  const pv = viewer.getPageView(page);
  if (!pv?.viewport) return;
  const vp = pv.viewport, wrap = ensureLayer(pv), html = wrap.children[2];
  const v = rectToV(vp, a.rect);
  const dl = rotDelta(vp, a), swap = dl === 90 || dl === 270;
  const W = swap ? v[3] - v[1] : v[2] - v[0];
  Object.assign(ta.style, {
    left: v[0] + 'px', top: v[1] + 'px', width: W + 'px',
    fontSize: style.fontSize * vp.scale + 'px', color: style.color, fontWeight: style.bold ? '700' : '',
    padding: 2 * vp.scale + 'px', transformOrigin: '0 0',
    transform: dl ? `rotate(${dl}deg)` : '',
  });
  if (!ta.isConnected || ta.parentNode !== html) html.append(ta);
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}
export function isEditingText() { return !!editing; }
export function editStyle(patch) {
  if (!editing) return false;
  Object.assign(editing.style, patch);
  placeEditor();
  editing.ta.focus();
  return true;
}
function fitRect(page, a, text) {
  const pv = viewer.getPageView(page);
  if (!pv?.viewport || !text || rotDelta(pv.viewport, a)) return a.rect;
  const vp = pv.viewport, v = rectToV(vp, a.rect);
  const h = Math.max(measureHeight(a, text, vp), (a.fontSize || 12) * 1.25 * vp.scale + 4 * vp.scale);
  return rectToPdf(vp, [v[0], v[1], v[2], v[1] + h]);
}
function refitFreetext(page, a) { a.rect = fitRect(page, a, a.text || ''); }
function finishEdit() {
  if (!editing) return;
  const { page, a, isNew, ta, style } = editing;
  const text = ta.value.replace(/\s+$/, '');
  const color = hexToRgb(style.color);
  const styled = { ...a, fontSize: style.fontSize, bold: style.bold };
  const newRect = fitRect(page, styled, text);
  const styleChanged = rgbToHex(a.color).toUpperCase() !== style.color.toUpperCase() || (a.fontSize || 12) !== style.fontSize || !!a.bold !== style.bold;
  editing = null;
  ta.remove();
  if (!text) {
    if (!isNew) commit(() => { S.annots[page] = pageAnns(page).filter((x) => x.id !== a.id); }, page);
    else renderPage(page);
    return;
  }
  if (!isNew && !styleChanged && text === a.text && JSON.stringify(newRect) === JSON.stringify(a.rect)) { renderPage(page); return; }
  commit(() => {
    a.rect = newRect;
    a.color = color; a.fontSize = style.fontSize;
    if (style.bold) a.bold = true; else delete a.bold;
    a.text = text; a.modified = Date.now();
    if (isNew) pageAnns(page).push(a);
  }, page);
}
const measureCanvas = document.createElement('canvas').getContext('2d');
function measureHeight(a, text, vp) {
  const fs = a.fontSize || 12;
  measureCanvas.font = `${a.bold ? '700 ' : ''}${fs}px Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
  const r = a.rect;
  const lines = wrapText(text, (s) => measureCanvas.measureText(s).width, (r[2] - r[0]) - 4);
  return (lines.length * fs * 1.25 + 4) * vp.scale;
}

// ---------------- signature placing ----------------
let pendingSign = null;
export function setPendingSign(sig) { pendingSign = sig; }
function placeSignature(g) {
  if (!pendingSign) { toast('서명을 먼저 선택하세요'); emit('needsign'); return; }
  const imgId = 'img_' + uid();
  S.images[imgId] = pendingSign.dataUrl;
  const sc = g.vp.scale;
  const w = 130 * sc, h = w * (pendingSign.h / pendingSign.w);
  const r = rectToPdf(g.vp, [g.pt[0] - w / 2, g.pt[1] - h / 2, g.pt[0] + w / 2, g.pt[1] + h / 2]);
  const a = newAnn('stamp', { img: imgId, rect: r, rot: g.vp.rotation });
  commit(() => pageAnns(g.p).push(a), g.p);
  emit('settool', 'hand');
  select(g.p, a.id);
}

// ---------------- list for side panel ----------------
export function allAnnotations() {
  const out = [];
  (S.annots || []).forEach((arr, p) => (arr || []).forEach((a) => out.push({ p, a })));
  return out;
}
export function focusAnnotation(p, id) {
  const a = findAnn(p, id);
  if (!a) return;
  const bb = annBBox(a);
  scrollToPoint(p, bb[0] - 20, bb[3] + 40);
  setTimeout(() => select(p, id), 250);
}

/** Add annotations from outside (e.g. Claude). items: [{page, type, ...props}] */
export function addAnnotations(items) {
  const pages = [...new Set(items.map((i) => i.page))];
  commit(() => {
    for (const { page, type, ...props } of items) pageAnns(page).push(newAnn(type, { author: props.author || S.author, ...props }));
  }, pages);
}
