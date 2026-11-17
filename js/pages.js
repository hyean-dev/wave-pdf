// Page editor: reorder, rotate, delete, insert blank, merge, extract
import { S, emit } from './state.js';
import { el, toast, confirmDialog, busy, uid, icon, modal } from './util.js';
import { pdfjsLib, DOC_OPTS } from './viewer.js';
import { applyPageEdits, buildPdf, prepare } from './pdfio.js';

let open = false;

/** hooks: {pickPdf: () => Promise<{bytes,name}|null>, commitBase: async (newBase, newAnnots), exportBytes(bytes,name), askPassword} */
export async function openPageEditor(hooks, { mergeNow = false } = {}) {
  if (!S.pdfDoc || open) return;
  open = true;
  const srcDocs = { base: S.pdfDoc };
  const merged = {};      // key -> base bytes
  const mergedAnnots = {}; // key -> annots
  let items = Array.from({ length: S.pdfDoc.numPages }, (_, i) => ({ key: uid(), src: 'base', index: i, rot: 0 }));
  const sel = new Set();
  let dirty = false;

  const grid = el('div', { class: 'pe-grid' });
  const count = el('span', { class: 'pe-count' });
  const root = el('div', { class: 'pe' },
    el('header', { class: 'pe-head' },
      el('button', { class: 'icon', title: '닫기', html: icon('back'), onclick: () => close(false) }),
      el('div', { class: 'pe-title' }, '페이지 편집'), count,
      el('button', { class: 'btn small', onclick: () => { if (sel.size === items.length) sel.clear(); else items.forEach((it) => sel.add(it.key)); refreshSel(); } }, '전체선택'),
      el('button', { class: 'btn small primary', onclick: () => close(true) }, '적용')),
    grid,
    el('footer', { class: 'pe-foot' },
      btn('rotL', '왼쪽 회전', () => rotate(-90)),
      btn('rotR', '오른쪽 회전', () => rotate(90)),
      btn('trash', '삭제', del),
      btn('extract', '추출', extract),
      btn('merge', 'PDF 추가', addPdf),
      btn('filePlus', '빈 페이지', addBlank)));
  document.body.append(root);
  document.body.classList.add('pe-open');

  function btn(ic, label, fn) { return el('button', { class: 'pe-btn', onclick: fn }, el('span', { class: 'ico', html: icon(ic) }), el('span', {}, label)); }

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); renderThumb(en.target); }
  }, { root: grid, rootMargin: '300px' });

  function card(it) {
    const c = el('div', { class: 'pe-card', 'data-key': it.key },
      el('div', { class: 'pe-thumb' }, el('canvas')),
      el('div', { class: 'pe-num' }),
      el('div', { class: 'pe-check', html: icon('check') }));
    c.addEventListener('click', () => { sel.has(it.key) ? sel.delete(it.key) : sel.add(it.key); refreshSel(); });
    c._item = it;
    io.observe(c);
    return c;
  }
  async function renderThumb(c) {
    const it = c._item;
    const canvas = c.querySelector('canvas');
    if (it.src === 'blank') { canvas.width = 120; canvas.height = Math.round(120 * it.h / it.w); canvas.getContext('2d').fillStyle = '#fff'; canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height); applyRot(c); return; }
    try {
      const page = await srcDocs[it.src].getPage(it.index + 1);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = (150 * Math.min(2, devicePixelRatio || 1)) / Math.max(vp0.width, vp0.height);
      const vp = page.getViewport({ scale });
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    } catch (e) { console.warn(e); }
    applyRot(c);
  }
  function applyRot(c) { c.querySelector('canvas').style.transform = `rotate(${c._item.rot}deg)`; }
  function renderGrid() {
    grid.replaceChildren(...items.map(card));
    relabel(); refreshSel();
  }
  function relabel() { [...grid.children].forEach((c, i) => (c.querySelector('.pe-num').textContent = i + 1)); }
  function refreshSel() {
    for (const c of grid.children) c.classList.toggle('on', sel.has(c.dataset.key));
    count.textContent = sel.size ? `${sel.size}개 선택` : `${items.length}쪽`;
  }
  const selected = () => items.filter((it) => sel.has(it.key));
  function need() { if (!sel.size) { toast('페이지를 먼저 선택하세요'); return false; } return true; }

  function rotate(d) {
    if (!need()) return;
    for (const it of selected()) it.rot = (it.rot + d + 360) % 360;
    for (const c of grid.children) if (sel.has(c.dataset.key)) applyRot(c);
    dirty = true;
  }
  async function del() {
    if (!need()) return;
    if (sel.size >= items.length) { toast('모든 페이지를 지울 수는 없어요'); return; }
    if (!(await confirmDialog(`${sel.size}개 페이지를 삭제할까요?`, '삭제', true))) return;
    items = items.filter((it) => !sel.has(it.key));
    for (const c of [...grid.children]) if (sel.has(c.dataset.key)) c.remove();
    sel.clear(); relabel(); refreshSel(); dirty = true;
  }
  function insertIndex() { const s = selected(); return s.length ? items.indexOf(s[s.length - 1]) + 1 : items.length; }
  async function addBlank() {
    const at = insertIndex();
    const ref = items[Math.max(0, at - 1)];
    let w = 595.28, h = 841.89;
    if (ref && ref.src !== 'blank') { try { const pg = await srcDocs[ref.src].getPage(ref.index + 1); const [x0, y0, x1, y1] = pg.view; w = x1 - x0; h = y1 - y0; } catch { /* */ } }
    else if (ref) { w = ref.w; h = ref.h; }
    const it = { key: uid(), src: 'blank', w, h, rot: 0 };
    items.splice(at, 0, it);
    grid.insertBefore(card(it), grid.children[at] || null);
    relabel(); refreshSel(); dirty = true;
  }
  async function addPdf() {
    const f = await hooks.pickPdf();
    if (!f) return;
    const b = busy('PDF 불러오는 중…');
    try {
      const prep = await prepare(f.bytes, (m) => { b.close(); return hooks.askPassword(m); });
      const key = 'm' + uid();
      merged[key] = prep.base; mergedAnnots[key] = prep.annots;
      srcDocs[key] = await pdfjsLib.getDocument({ ...DOC_OPTS, data: prep.base.slice() }).promise;
      const at = insertIndex();
      const add = Array.from({ length: srcDocs[key].numPages }, (_, i) => ({ key: uid(), src: key, index: i, rot: 0 }));
      items.splice(at, 0, ...add);
      const ref = grid.children[at] || null;
      for (const it of add) grid.insertBefore(card(it), ref);
      relabel(); refreshSel(); dirty = true;
      toast(`${f.name} ${add.length}쪽을 추가했어요`);
    } catch (e) { if (e.message !== 'CANCELLED') toast('PDF를 열지 못했어요: ' + e.message); }
    finally { b.close(); }
  }
  function annotsFor(list) {
    return list.map((it) => {
      const src = it.src === 'base' ? S.annots[it.index] : it.src === 'blank' ? [] : mergedAnnots[it.src]?.[it.index];
      return JSON.parse(JSON.stringify(src || []));
    });
  }
  async function extract() {
    if (!need()) return;
    const list = selected();
    const b = busy('추출하는 중…');
    try {
      const forms = await hooks.collectForms();
      const base0 = forms.length ? await buildPdf({ base: S.baseBytes, annots: [], forms }) : S.baseBytes;
      const part = await applyPageEdits(base0, list, merged);
      const bytes = await buildPdf({ base: part, annots: annotsFor(list), images: S.images });
      b.close();
      await hooks.exportBytes(bytes, `${(S.fileName || 'document').replace(/\.pdf$/i, '')}_추출.pdf`);
    } catch (e) { toast('추출 실패: ' + e.message); }
    finally { b.close(); }
  }

  async function close(apply) {
    if (!apply && dirty && !(await confirmDialog('변경사항을 버리고 닫을까요?', '버리기', true))) return;
    if (apply && dirty) {
      const b = busy('페이지 적용 중…');
      try {
        const forms = await hooks.collectForms();
        const base0 = forms.length ? await buildPdf({ base: S.baseBytes, annots: [], forms }) : S.baseBytes;
        const newBase = await applyPageEdits(base0, items, merged);
        await hooks.commitBase(newBase, annotsFor(items));
      } catch (e) { b.close(); toast('적용 실패: ' + e.message); console.error(e); return; }
      b.close();
    }
    io.disconnect();
    sortable?.destroy();
    for (const [k, d] of Object.entries(srcDocs)) if (k !== 'base') d.destroy();
    root.remove();
    document.body.classList.remove('pe-open');
    open = false;
  }

  renderGrid();
  const sortable = window.Sortable?.create(grid, {
    animation: 150, delay: 180, delayOnTouchOnly: true, ghostClass: 'pe-ghost', chosenClass: 'pe-chosen',
    onEnd: (ev) => {
      if (ev.oldIndex === ev.newIndex) return;
      const [m] = items.splice(ev.oldIndex, 1);
      items.splice(ev.newIndex, 0, m);
      relabel(); dirty = true;
    },
  });
  if (mergeNow) addPdf();
  void modal; void emit;
}
