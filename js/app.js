import { S, CFG, saveCfg, emit, on, PALETTE, savePalette, resetPalette } from './state.js';
import { $, $$, el, icon, toast, modal, confirmDialog, promptDialog, busy, downloadBlob, debounce, isTouchDevice } from './util.js';
import { idbGet, idbSet, idbDel } from './store.js';
import * as VW from './viewer.js';
import * as AN from './annots.js';
import { prepare, buildPdf, qpdf } from './pdfio.js';
import * as DR from './drive.js';
import { openPageEditor } from './pages.js';
import { pickSignature } from './sign.js';
import { initAI, toggleAI, aiBusy } from './ai.js';
import * as OL from './outline.js';
import * as NV from './native.js';

const APP_VERSION = '1.20.1';
const container = $('#viewerContainer');

// ---------------- icons ----------------
const setIcon = (sel, name) => { const e = $(sel); if (e) e.innerHTML = icon(name); };
setIcon('#btnMenu', 'menu'); setIcon('#btnPanel', 'panel'); setIcon('#btnSearch', 'search'); setIcon('#btnAI', 'sparkles'); setIcon('#btnPages', 'layers'); setIcon('#btnSave', 'save');
setIcon('#searchPrev', 'up'); setIcon('#searchNext', 'down'); setIcon('#searchClose', 'x');
setIcon('#zoomOut', 'minus'); setIcon('#zoomIn', 'plus');
$('#btnUndo').innerHTML = `<span class="ico">${icon('undo')}</span><span class="lbl">취소</span>`;
$('#btnRedo').innerHTML = `<span class="ico">${icon('redo')}</span><span class="lbl">다시</span>`;
$('#wlOpen').innerHTML = `${icon('device')} 내 기기에서 열기`;
$('#wlDrive').innerHTML = `${icon('drive')} 구글 드라이브에서 열기`;

// ---------------- init viewer ----------------
VW.initViewer(container);
AN.initAnnots(container);
initAI();

// ---------------- tools ----------------
const TOOLS = [
  ['hand', 'hand', '이동'], ['text', 'text', '텍스트'], ['highlight', 'highlight', '형광펜'], ['underline', 'underline', '밑줄'],
  ['strike', 'strike', '취소선'], ['pen', 'pen', '펜'], ['marker', 'marker', '마커'], ['eraser', 'eraser', '지우개'],
  ['freetext', 'freetext', '글상자'], ['sign', 'sign', '서명'],
];
const toolsEl = $('#tools');
for (const [k, ic, label] of TOOLS) {
  toolsEl.append(el('button', { class: 'tool', 'data-tool': k, title: label, onclick: () => onToolClick(k) },
    el('span', { class: 'ico', html: icon(ic) }), el('span', { class: 'lbl' }, label)));
}
let optsOpen = false;
async function onToolClick(k) {
  if (k === S.tool && k !== 'hand') { optsOpen = !optsOpen; renderToolOptions(); return; }
  if (k === 'sign') {
    const sig = await pickSignature();
    if (!sig) return;
    AN.setPendingSign(sig);
    toast('서명을 넣을 위치를 탭하세요');
  }
  selectTool(k);
}
function selectTool(k) {
  AN.setTool(k);
  if (k !== 'hand') setToolbarHidden(false);
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === k));
  optsOpen = ['highlight', 'underline', 'strike', 'pen', 'marker', 'freetext', 'shape', 'note', 'eraser'].includes(k);
  renderToolOptions();
}
on('settool', selectTool);
on('needsign', () => onToolClick('sign'));
on('ftstyle', () => renderToolOptions());

function swatchRow(group, cfg, onPick) {
  const colors = PALETTE[group];
  const row = el('div', { class: 'opt-swatches', title: '색을 길게 누르거나 오른쪽 클릭하면 팔레트에서 빠져요' });
  const pick = (c) => { cfg.color = c; saveCfg(); renderToolOptions(); onPick?.(c); };
  const remove = (c) => {
    if (colors.length <= 1) return toast('색이 하나는 있어야 해요');
    PALETTE[group] = colors.filter((x) => x.toUpperCase() !== c.toUpperCase());
    savePalette(); renderToolOptions(); toast('팔레트에서 뺐어요');
  };
  for (const c of colors) {
    let timer = null, longPressed = false;
    const b = el('button', { class: `swatch ${cfg.color.toUpperCase() === c.toUpperCase() ? 'on' : ''}`, style: { background: c } });
    b.addEventListener('click', () => { if (longPressed) { longPressed = false; return; } pick(c); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); remove(c); });
    b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; timer = setTimeout(() => { longPressed = true; remove(c); }, 550); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
    row.append(b);
  }
  const custom = el('input', { type: 'color', class: 'swatch custom', value: cfg.color, title: '새 색 고르기 (팔레트에 추가)' });
  custom.addEventListener('change', () => {
    const c = custom.value.toUpperCase();
    if (!PALETTE[group].some((x) => x.toUpperCase() === c)) {
      PALETTE[group] = [...PALETTE[group], c].slice(-12);
      savePalette();
      toast('팔레트에 추가했어요');
    }
    pick(c);
  });
  row.append(custom);
  return row;
}
function slider(label, cfg, key, min, max, step) {
  const val = el('span', { class: 'opt-val' }, String(cfg[key]));
  const inp = el('input', { type: 'range', min, max, step, value: cfg[key] });
  inp.addEventListener('input', () => { cfg[key] = +inp.value; val.textContent = inp.value; saveCfg(); });
  return el('label', { class: 'opt-slider' }, el('span', {}, label), inp, val);
}
function renderToolOptions() {
  const box = $('#toolOptions');
  const t = S.tool;
  box.replaceChildren();
  if (!optsOpen || !S.pdfDoc) { box.hidden = true; document.body.classList.remove('opts-open'); return; }
  const parts = [];
  if (t === 'highlight') parts.push(swatchRow('highlight', CFG.highlight));
  if (t === 'underline' || t === 'strike') parts.push(swatchRow('ink', CFG[t]));
  if (t === 'pen') parts.push(swatchRow('ink', CFG.pen), slider('굵기', CFG.pen, 'width', 0.5, 8, 0.5));
  if (t === 'marker') parts.push(swatchRow('highlight', CFG.marker), slider('굵기', CFG.marker, 'width', 4, 30, 1));
  if (t === 'freetext') {
    const sizes = el('div', { class: 'seg small' });
    const ft = CFG.freetext;
    for (const s of [8, 10, 12, 14, 18, 24]) sizes.append(el('button', { class: `seg-btn ${ft.size === s ? 'on' : ''}`, onclick: () => { ft.size = s; saveCfg(); renderToolOptions(); AN.editStyle({ fontSize: s }); } }, String(s)));
    const bold = el('button', { class: `seg-btn bold-btn ${ft.bold ? 'on' : ''}`, title: '굵게 (Ctrl+B)', html: icon('bold'), onclick: () => { ft.bold = !ft.bold; saveCfg(); renderToolOptions(); AN.editStyle({ bold: ft.bold }); } });
    parts.push(swatchRow('ink', ft, (c) => AN.editStyle({ color: c })), el('div', { class: 'seg small' }, bold), sizes);
  }
  if (t === 'shape') {
    const kinds = el('div', { class: 'seg small' });
    for (const [k, ic] of [['square', 'square'], ['circle', 'circle'], ['arrow', 'arrow']]) kinds.append(el('button', { class: `seg-btn ${CFG.shape.kind === k ? 'on' : ''}`, html: icon(ic), onclick: () => { CFG.shape.kind = k; saveCfg(); renderToolOptions(); } }));
    parts.push(kinds, swatchRow('ink', CFG.shape), slider('굵기', CFG.shape, 'width', 0.5, 8, 0.5));
  }
  if (t === 'note') parts.push(swatchRow('note', CFG.note));
  if (t === 'pen' || t === 'marker') {
    const cb = el('input', { type: 'checkbox', checked: CFG.snap !== false });
    cb.addEventListener('change', () => { CFG.snap = cb.checked; saveCfg(); });
    parts.push(el('label', { class: 'check', title: '반듯하게 그은 선, 동그라미, 화살표를 깔끔한 모양으로 바꿔요. 되돌리기(Ctrl+Z)를 한 번 누르면 손으로 그린 모양으로 돌아가요' }, cb, ' 자동 보정'));
    const stab = el('div', { class: 'seg small', title: '손떨림 보정: 펜이 살짝 흔들려도 선이 매끄럽게 나와요. 강하게 할수록 선이 펜을 조금 늦게 따라와요' });
    ['끔', '약', '강'].forEach((l, i) => stab.append(el('button', { class: `seg-btn ${(CFG.stab ?? 1) === i ? 'on' : ''}`, onclick: () => { CFG.stab = i; saveCfg(); renderToolOptions(); } }, l)));
    parts.push(el('div', { class: 'opt-slider' }, el('span', {}, '손떨림 보정'), stab));
  }
  if (['pen', 'marker', 'shape', 'eraser'].includes(t) && isTouchDevice()) {
    const cb = el('input', { type: 'checkbox', checked: CFG.penOnly });
    cb.addEventListener('change', () => { CFG.penOnly = cb.checked; saveCfg(); });
    parts.push(el('label', { class: 'check' }, cb, ' 스타일러스로만 그리기 (손가락은 스크롤)'));
  }
  if (!parts.length) { box.hidden = true; document.body.classList.remove('opts-open'); return; }
  box.append(...parts);
  box.hidden = false;
  document.body.classList.add('opts-open');
}

on('history', ({ canUndo, canRedo }) => { $('#btnUndo').disabled = !canUndo; $('#btnRedo').disabled = !canRedo; });
$('#btnUndo').onclick = () => AN.undo();
$('#btnRedo').onclick = () => AN.redo();

// ---------------- open documents ----------------
const askPassword = (msg) => promptDialog(msg, '', { type: 'password', placeholder: 'PDF 암호' });

/** where to open another PDF: 'tab' | 'window' | null (cancelled) */
async function openTarget(force) {
  if (!S.pdfDoc) return 'here';
  if (force) return force;
  const mode = openMode();
  if (mode !== 'ask') return mode;
  return modal({ title: 'PDF를 어디에 열까요?', buttons: [{ label: '취소', value: null }, { label: '새 창', value: 'window' }, { label: '새 탭', value: 'tab', primary: true }] });
}
async function openBytes(bytes, name, source, { target: force } = {}) {
  const target = await openTarget(force);
  if (!target) return false;
  if (target === 'window') return openInWindow({ kind: 'bytes', bytes, name, source });
  let b = busy('여는 중…'), newTab = null;
  try {
    const prep = await prepare(bytes, async (m) => { b.close(); const v = await askPassword(m); b = busy('여는 중…'); return v; });
    newTab = await beginTab();
    AN.setTool('hand'); selectTool('hand');
    S.baseBytes = prep.base;
    S.annots = prep.annots;
    S.images = {};
    S.password = prep.password;
    S.fileName = name || 'document.pdf';
    S.source = source || { type: 'local' };
    S.baseVer = Date.now();
    S.dirty = false;
    S.outline = null; S.outlineDirty = false; S.outlineAuto = false; S.prevOutline = undefined;
    AN.resetHistory();
    await VW.openDocument(prep.base);
    while (S.annots.length < S.pdfDoc.numPages) S.annots.push([]);
    showDoc();
    persistBase();
    persistState();
    if (prep.encrypted) toast(prep.password ? '암호를 풀었어요. 저장할 때 같은 암호로 다시 잠가요' : '보안 설정을 해제한 사본으로 열었어요');
    return true;
  } catch (e) {
    if (newTab) await dropTab(newTab);
    if (e.message !== 'CANCELLED') { console.error(e); modal({ title: 'PDF를 열 수 없어요', body: el('div', { class: 'muted' }, e.message || String(e)) }); }
    return false;
  } finally { b.close(); }
}

// ---------------- tabs ----------------
const DOC_KEYS = ['pdfDoc', 'baseBytes', 'baseVer', 'fileName', 'source', 'annots', 'images', 'password', 'dirty', 'outline', 'outlineDirty', 'outlineAuto', 'outlineDoc', 'prevOutline', 'rev'];
const emptyDoc = () => ({ pdfDoc: null, baseBytes: null, baseVer: 0, fileName: '', source: null, annots: [], images: {}, password: null, dirty: false, outline: null, outlineDirty: false, outlineAuto: false, outlineDoc: null, prevOutline: undefined, rev: 0 });
const tabs = [];
let activeTab = null, tabSeq = 0, switching = false;
const openMode = () => (NV.NO_DRIVE ? 'tab' : localStorage.getItem('openMode') || 'tab');
const pickDoc = (src) => Object.fromEntries(DOC_KEYS.map((k) => [k, src[k]]));
const stOf = (t) => (t === activeTab ? S : t.st);
/** save the active tab's document state out of S */
function stashActive() {
  if (!activeTab) return;
  AN.endEdit(); AN.deselect(false);
  activeTab.st = pickDoc(S);
  activeTab.hist = AN.getHistory();
  activeTab.view = S.pdfDoc ? VW.getView() : null;
  clearTimeout(autoTimer);
  if (S.dirty && autoOn() && isDriveDoc()) bgAutoSave(activeTab);
}
/** make a fresh active tab (stashing the current one). Returns the new tab. */
async function beginTab() {
  if (activeTab && !S.pdfDoc) return null; // reuse the empty tab
  stashActive();
  const t = { id: ++tabSeq };
  tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length, 0, t);
  const prev = activeTab;
  activeTab = t; t.prev = prev;
  Object.assign(S, emptyDoc());
  AN.resetHistory();
  if (VW.viewer.pdfDocument) { VW.viewer.setDocument(null); VW.linkService.setDocument(null, null); }
  VW.clearFind?.();
  return t;
}
/** undo beginTab after a failed open */
async function dropTab(t) {
  const prev = t.prev;
  tabs.splice(tabs.indexOf(t), 1);
  if (S.pdfDoc) S.pdfDoc.destroy().catch(() => {});
  activeTab = null;
  Object.assign(S, emptyDoc());
  if (prev && tabs.includes(prev)) await activate(prev);
  else { showDoc(); renderTabs(); }
}
async function activate(t) {
  activeTab = t;
  Object.assign(S, t.st);
  AN.setHistory(t.hist);
  setStatus('');
  closeSearch?.();
  await VW.attachDocument(S.pdfDoc, t.view);
  showDoc();
  persistBase(); persistState();
  scheduleAutoSave();
}
async function switchTab(t) {
  if (!t || t === activeTab || switching) return;
  if (document.querySelector('.busy')) return;
  switching = true;
  try { stashActive(); await activate(t); }
  catch (e) { console.error(e); toast('탭 전환 실패: ' + e.message); }
  finally { switching = false; }
}
function cycleTab(d) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(activeTab);
  switchTab(tabs[(i + d + tabs.length) % tabs.length]);
}
async function closeTab(t, { force = false } = {}) {
  if (!t || switching) return false;
  const st = stOf(t);
  if (!force && st.dirty && !(await confirmDialog(`"${st.fileName}"에 저장하지 않은 변경사항이 있어요. 닫을까요?`, '닫기', true))) return false;
  const i = tabs.indexOf(t);
  if (i < 0) return false;
  tabs.splice(i, 1);
  if (t !== activeTab) { st.pdfDoc?.destroy().catch(() => {}); renderTabs(); return true; }
  AN.endEdit(); AN.deselect(false);
  clearTimeout(autoTimer);
  VW.closeDocument();
  activeTab = null;
  Object.assign(S, emptyDoc());
  AN.resetHistory();
  const next = tabs[Math.min(i, tabs.length - 1)];
  if (next) { switching = true; try { await activate(next); } finally { switching = false; } return true; }
  await idbDel('session'); await idbDel('base');
  showDoc(); renderTabs();
  checkResume();
  return true;
}
async function bgAutoSave(t) {
  const st = t.st;
  if (!DR.isSignedIn()) return;
  const rev = st.rev;
  try {
    const bytes = await exportBytes({ quiet: true, st });
    await DR.updateFile(st.source.driveId, bytes);
    if (!tabs.includes(t)) return;
    const cur = stOf(t);
    if (cur.rev === rev) { cur.dirty = false; if (t === activeTab) { updateTitle(); persistState(); } else renderTabs(); }
  } catch (e) { console.warn('bg autosave', e); toast(`"${st.fileName}" 자동 저장 실패 — 그 탭에서 저장 버튼을 눌러주세요`); }
}
function renderTabs() {
  const bar = $('#tabBar');
  const show = tabs.length > 0 && !!stOf(tabs[0]).baseBytes;
  bar.hidden = !show;
  document.body.classList.toggle('has-tabs', show);
  if (!show) { bar.replaceChildren(); return; }
  const items = tabs.map((t) => {
    const st = stOf(t);
    const x = el('button', { class: 'tab-x', title: '탭 닫기', html: icon('x'), onclick: (e) => { e.stopPropagation(); closeTab(t); } });
    const b = el('div', { class: `tab ${t === activeTab ? 'on' : ''}`, title: st.fileName, role: 'tab', 'data-id': t.id },
      st.dirty ? el('span', { class: 'tab-dot' }) : null, el('span', { class: 'tab-name' }, st.fileName || '문서'), x);
    b.addEventListener('click', () => { if (dragJustEnded) return; switchTab(t); });
    b.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(t, b); });
    let lp = null;
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') { if (e.button === 0 && !e.target.closest('.tab-x')) tabDrag(t, b, e); return; }
      lp = setTimeout(() => { lp = 'done'; tabMenu(t, b); }, 550);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { if (lp !== 'done') clearTimeout(lp); lp = null; });
    return b;
  });
  const add = el('button', { class: 'tab-add', title: '다른 PDF 열기', html: icon('plus'), onclick: openAnother });
  bar.replaceChildren(...items, add);
  bar.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
// drag a tab: along the bar = reorder, out of the window (or well below the bar) = open it in a new window
let dragJustEnded = false;
const CAN_TEAR = !NV.NATIVE;
function tabDrag(t, b, e0) {
  const bar = $('#tabBar');
  let moved = false, ghost = null, out = false;
  const isOut = (e) => {
    if (!CAN_TEAR || tabs.length < 1) return false;
    const r = bar.getBoundingClientRect();
    return e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight || e.clientY > r.bottom + 70;
  };
  const move = (e) => {
    if (!moved && Math.hypot(e.clientX - e0.clientX, e.clientY - e0.clientY) < 6) return;
    if (!moved) {
      moved = true;
      // (listening on window: the first move may already be outside the bar)
  // capture only once it is a drag (a plain click must still reach the tab); on the bar, because the tab
      // element itself moves in the DOM while reordering, which would drop the capture
      try { bar.setPointerCapture(e0.pointerId); } catch {}
      b.classList.add('dragging');
      ghost = el('div', { class: 'tab-ghost' }, stOf(t).fileName || '문서');
      document.body.append(ghost);
    }
    out = isOut(e);
    ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
    ghost.classList.toggle('out', out);
    ghost.dataset.hint = out ? '놓으면 새 창으로' : '';
    // live reorder while over the bar
    if (!out && tabs.length > 1) {
      const others = [...bar.querySelectorAll('.tab')];
      const rest0 = others.filter((o) => o !== b);
      let to = rest0.findIndex((o) => { const r = o.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
      if (to < 0) to = rest0.length;
      const from = tabs.indexOf(t);
      if (to !== from) {
        // move the element itself (re-rendering would drop the pointer capture)
        tabs.splice(from, 1); tabs.splice(to, 0, t);
        const rest = others.filter((o) => o !== b);
        bar.insertBefore(b, rest[to] || bar.querySelector('.tab-add'));
      }
    }
  };
  const end = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    bar.releasePointerCapture?.(e0.pointerId);
    ghost?.remove();
    bar.querySelectorAll('.tab.dragging').forEach((x) => x.classList.remove('dragging'));
    if (!moved) return;
    dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 0);
    if (e.type === 'pointerup' && isOut(e)) moveTabToWindow(t, { x: e.screenX - 80, y: e.screenY - 20 });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
async function openAnother() {
  if (NV.NO_DRIVE) return openLocal();
  const where = await modal({ title: '다른 PDF 열기', buttons: [{ label: '취소', value: null }, { label: '구글 드라이브', value: 'drive' }, { label: '내 기기', value: 'local', primary: true }] });
  if (where === 'local') openLocal();
  if (where === 'drive') openDrive();
}
function tabMenu(t, anchor) {
  document.querySelector('.bm-menu')?.remove();
  const go = (fn) => () => { menu.remove(); fn(); };
  const menu = el('div', { class: 'ctx-menu bm-menu' }, el('div', { class: 'bm-menu-list' },
    NV.NATIVE ? null : el('button', { class: 'menu-item', onclick: go(() => moveTabToWindow(t)) }, '새 창으로 옮기기'),
    el('button', { class: 'menu-item', onclick: go(() => closeTab(t)) }, '이 탭 닫기'),
    el('button', { class: 'menu-item', disabled: tabs.length < 2, onclick: go(async () => { for (const o of [...tabs]) if (o !== t && !(await closeTab(o))) break; }) }, '다른 탭 모두 닫기')));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, innerWidth - 200) + 'px';
  menu.style.top = Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off, true); } }, true), 0);
}

// ---------------- new window ----------------
/** hand a file (or a whole tab's state) to a new app window through IndexedDB */
async function openInWindow(payload, pos) {
  const id = Math.random().toString(36).slice(2, 10);
  await idbSet('xfer:' + id, payload);
  const url = `${location.pathname}?xfer=${id}`;
  const W = Math.min(1280, screen.availWidth), H = Math.min(900, screen.availHeight);
  const x = Math.max(0, Math.min((pos?.x ?? window.screenX + 40), screen.availWidth - W));
  const y = Math.max(0, Math.min((pos?.y ?? window.screenY + 40), screen.availHeight - H));
  if (NV.DESKTOP) {
    try { await NV.newWindow(url, { x, y, width: W, height: H }); return true; }
    catch (e) { idbDel('xfer:' + id); toast('새 창을 열지 못했어요: ' + e); return false; }
  }
  let w = window.open(url, '_blank', pos ? `popup,left=${x},top=${y},width=${W},height=${H}` : '');
  if (!w) {
    // popup blocked (no recent click) → ask for a click
    const go = await modal({ title: '새 창 열기', body: el('div', { class: 'muted' }, `"${payload.name || payload.st?.fileName || 'PDF'}"을(를) 새 창에서 열어요.`), buttons: [{ label: '취소', value: false }, { label: '새 창 열기', value: true, primary: true }] });
    if (go) w = window.open(url, '_blank');
    if (!w) { idbDel('xfer:' + id); if (go) toast('브라우저가 새 창을 막았어요. 팝업을 허용해 주세요'); return false; }
  }
  return true;
}
async function moveTabToWindow(t, pos) {
  if (t === activeTab) stashActive();
  const st = t.st;
  if (st.dirty && st.pdfDoc?.annotationStorage?.serializable?.map?.size) toast('양식에 입력한 값은 새 창으로 옮겨지지 않아요. 먼저 저장하세요');
  const ok = await openInWindow({ kind: 'state', st: { ...pickDoc(st), pdfDoc: null, outlineDoc: null }, page: t.view?.page || 1 }, pos);
  if (ok) await closeTab(t, { force: true });
}
/** open a document state (from another window) as a tab */
async function openState(st, page) {
  const b = busy('여는 중…');
  try {
    await beginTab();
    Object.assign(S, emptyDoc(), st, { pdfDoc: null });
    await VW.openDocument(S.baseBytes);
    while (S.annots.length < S.pdfDoc.numPages) S.annots.push([]);
    if (page) VW.goToPage(page);
    showDoc(); persistBase(); persistState();
    if (S.dirty) emit('changed', {});
  } catch (e) { toast('열지 못했어요: ' + e.message); }
  finally { b.close(); }
}

function showDoc() {
  $('#welcome').hidden = !!S.pdfDoc;
  $('#zoomCtl').hidden = !S.pdfDoc;
  document.body.classList.toggle('has-doc', !!S.pdfDoc);
  updateTitle();
  renderToolOptions();
  if (panelOpen) renderPanel();
}
function updateTitle() {
  renderTabs();
  $('#docTitle').textContent = S.pdfDoc ? S.fileName : 'Wave PDF';
  $('#dirtyDot').hidden = !S.dirty;
  document.title = S.pdfDoc ? `${S.dirty ? '• ' : ''}${S.fileName} - Wave PDF` : 'Wave PDF';
}


const OPEN_ACCEPT = 'application/pdf,.pdf';
const isPdfFile = (f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
/** Local PDF file → {bytes, name}. null if it isn't a PDF. */
async function localFileAsPdf(f) {
  if (!isPdfFile(f)) { toast('PDF 파일만 열 수 있어요'); return null; }
  return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, pdf: true };
}
async function openLocalFile(f, handle, opts) {
  const r = await localFileAsPdf(f);
  if (!r) return;
  return openBytes(r.bytes, r.name, r.pdf && handle ? { type: 'local', handle } : { type: 'local' }, opts);
}
/** several files: the first follows the open setting, the rest go to the same place */
async function openLocalFiles(list) {
  let target;
  for (const { file, handle } of list) {
    if (target === undefined && S.pdfDoc) { target = await openTarget(); if (!target) return; }
    await openLocalFile(file, handle, target ? { target } : undefined);
    if (target === undefined) target = openMode() === 'window' ? 'window' : 'tab';
  }
}
async function openLocal() {
  if (window.showOpenFilePicker) {
    try {
      const hs = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }], excludeAcceptAllOption: true });
      return openLocalFiles(await Promise.all(hs.map(async (h) => ({ file: await h.getFile(), handle: h }))));
    } catch (e) { if (e.name !== 'AbortError') toast(e.message); return; }
  }
  const input = $('#fileInput');
  input.value = '';
  input.multiple = true;
  input.onchange = () => { if (input.files.length) openLocalFiles([...input.files].map((file) => ({ file }))); };
  input.click();
}
function pickLocalBytes() {
  return new Promise((res) => {
    const input = el('input', { type: 'file', accept: OPEN_ACCEPT });
    input.onchange = async () => { const f = input.files[0]; res(f ? await localFileAsPdf(f) : null); };
    input.click();
  });
}

function driveGuard() {
  if (DR.isConfigured()) return true;
  DR.setupGuide();
  return false;
}
async function openDrive() {
  if (!driveGuard()) return;
  const f = await DR.browse({ mode: 'file' });
  if (!f) return;
  try {
    const bytes = await DR.withBusy('드라이브에서 받는 중…', () => DR.download(f.id));
    await openBytes(bytes, f.name, { type: 'drive', driveId: f.id, parents: f.parents, canEdit: f.canEdit });
  } catch (e) {
    console.error(e);
    modal({ title: '파일을 열지 못했어요', body: el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, e.message || String(e)) });
  }
}
async function pickDriveBytes() {
  if (!driveGuard()) return null;
  const f = await DR.browse({ mode: 'file', title: '추가할 PDF 선택' });
  if (!f) return null;
  const bytes = await DR.withBusy('드라이브에서 받는 중…', () => DR.download(f.id));
  return { bytes, name: f.name };
}
async function pickPdfAny() {
  if (NV.NO_DRIVE) return pickLocalBytes();
  const where = await modal({ title: '어디서 PDF를 가져올까요?', buttons: [{ label: '취소', value: null }, { label: '구글 드라이브', value: 'drive' }, { label: '내 기기', value: 'local', primary: true }] });
  if (where === 'local') return pickLocalBytes();
  if (where === 'drive') return pickDriveBytes();
  return null;
}

// ---------------- save ----------------
async function exportBytes({ quiet = false, st = pickDoc(S), encrypt = true, annots = true } = {}) {
  const b = quiet ? { close() {} } : busy('PDF 만드는 중…');
  try {
    const forms = await VW.collectFormValues(st.pdfDoc);
    const outline = st.outline && (st.outlineDirty || st.outlineAuto) ? st.outline : null;
    let bytes = await buildPdf({ base: st.baseBytes, annots: annots ? st.annots : st.annots.map(() => []), images: st.images, forms, outline });
    if (st.password && encrypt) bytes = await qpdf(bytes, ['--encrypt', st.password, st.password, '256', '--']);
    return bytes;
  } finally { b.close(); }
}
function markSaved(msg) {
  S.dirty = false;
  updateTitle();
  persistState();
  toast(msg);
}
async function save() {
  if (!S.pdfDoc) return;
  const src = S.source || {};
  try {
    if (src.type === 'drive' && src.driveId && src.canEdit !== false && DR.isConfigured()) {
      const tokP = DR.ensureToken().catch((e) => e);
      if (!autoOn() && !(await confirmDialog('구글 드라이브 원본에 덮어쓸까요? (드라이브 버전 기록에서 이전 버전을 되돌릴 수 있어요)', '덮어쓰기'))) return;
      const t = await tokP;
      if (t instanceof Error) throw t;
      clearTimeout(autoTimer);
      const rev = S.rev;
      const bytes = await exportBytes();
      await DR.withBusy('드라이브에 저장 중…', () => DR.updateFile(src.driveId, bytes));
      if (S.rev !== rev) { scheduleAutoSave(); return; }
      setStatus('저장됨');
      return markSaved('드라이브에 저장했어요');
    }
    if (src.type === 'path' && NV.DESKTOP) {
      const bytes = await exportBytes();
      await NV.writePath(src.path, bytes);
      return markSaved('저장했어요');
    }
    if (src.type === 'native') {
      const bytes = await exportBytes();
      if (src.writable) {
        try { await NV.saveTo(src.uri, bytes); return markSaved('원본에 저장했어요'); }
        catch (e) { console.warn(e); }
      }
      toast('원본에는 직접 저장할 수 없어서 저장 위치를 골라주세요');
      return saveToDevice(bytes);
    }
    if (src.handle?.createWritable) {
      const permP = src.handle.requestPermission ? src.handle.requestPermission({ mode: 'readwrite' }) : Promise.resolve('granted');
      if ((await permP) !== 'granted') throw new Error('파일에 쓸 권한이 없어요');
      const bytes = await exportBytes();
      const w = await src.handle.createWritable();
      await w.write(bytes); await w.close();
      return markSaved('저장했어요');
    }
    await saveToDevice();
  } catch (e) { if (e?.message !== 'CANCELLED') toast('저장 실패: ' + e.message); console.error(e); }
}

// ---------------- Drive auto-save ----------------
S.rev = 0;
const autoOn = () => localStorage.getItem('autoDrive') !== '0';
let autoTimer = null, autoBusy = false, statusTimer = null;
function setStatus(t, sticky = false) {
  const e = $('#saveStatus');
  e.textContent = t || ''; e.hidden = !t;
  clearTimeout(statusTimer);
  if (t && !sticky) statusTimer = setTimeout(() => { e.hidden = true; }, 4000);
}
const isDriveDoc = () => { const s = S.source || {}; return s.type === 'drive' && s.driveId && s.canEdit !== false && DR.isConfigured(); };
function scheduleAutoSave() {
  if (!autoOn() || !isDriveDoc() || !S.dirty) return;
  clearTimeout(autoTimer);
  setStatus('변경됨', true);
  autoTimer = setTimeout(autoSave, 4000);
}
async function autoSave() {
  if (autoBusy) { autoTimer = setTimeout(autoSave, 2000); return; }
  if (!isDriveDoc() || !S.dirty) return;
  if (!DR.isSignedIn()) { setStatus('로그인 필요 · 저장 버튼', true); return; }
  autoBusy = true;
  const rev = S.rev, tab = activeTab, st = pickDoc(S);
  setStatus('저장 중…', true);
  try {
    const bytes = await exportBytes({ quiet: true, st });
    await DR.updateFile(st.source.driveId, bytes);
    if (tab !== activeTab) { const cur = tabs.includes(tab) && stOf(tab); if (cur && cur.rev === rev) { cur.dirty = false; renderTabs(); } return; }
    if (S.rev === rev) { S.dirty = false; updateTitle(); persistState(); setStatus('드라이브에 저장됨'); }
    else scheduleAutoSave();
  } catch (e) {
    console.warn('autosave', e);
    setStatus('자동 저장 실패 · 저장 버튼', true);
  } finally { autoBusy = false; }
}
async function saveToDevice(pre) {
  if (NV.NATIVE) {
    const bytes = pre instanceof Uint8Array ? pre : await exportBytes();
    try {
      const r = await NV.saveAs(S.fileName, bytes);
      S.source = { type: 'native', uri: r.uri, writable: true };
      if (r.name) S.fileName = r.name;
      return markSaved('저장했어요');
    } catch (e) { if (e.message === 'CANCELLED') return; throw e; }
  }
  if (window.showSaveFilePicker) {
    let h;
    try { h = await window.showSaveFilePicker({ suggestedName: S.fileName, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] }); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
    const bytes = await exportBytes();
    const w = await h.createWritable(); await w.write(bytes); await w.close();
    S.source = { type: 'local', handle: h };
    S.fileName = h.name;
    return markSaved('저장했어요');
  }
  const bytes = await exportBytes();
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), S.fileName);
  markSaved('다운로드했어요');
}
async function saveToDriveNew() {
  if (!driveGuard()) return;
  const folder = await DR.browse({ mode: 'folder' });
  if (!folder) return;
  const name = await promptDialog('드라이브에 저장할 이름', S.fileName);
  if (!name) return;
  try {
    const bytes = await exportBytes();
    const f = await DR.withBusy('드라이브에 업로드 중…', () => DR.createFile(/\.pdf$/i.test(name) ? name : name + '.pdf', folder.id === 'root' ? null : folder.id, bytes));
    S.source = { type: 'drive', driveId: f.id, parents: f.parents, canEdit: true };
    S.fileName = f.name;
    markSaved(`드라이브 "${folder.name}"에 저장했어요`);
  } catch (e) { toast(e.message); }
}
async function shareFile() {
  try {
    const bytes = await exportBytes();
    if (NV.NATIVE) return void (await NV.share(S.fileName, bytes));
    const file = new File([bytes], S.fileName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: S.fileName });
    else downloadBlob(file, S.fileName);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
}
/** used by page editor "추출" */
async function exportTo(bytes, name) {
  if (NV.NO_DRIVE) return downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
  const where = await modal({ title: '추출한 PDF를 어디에 저장할까요?', buttons: [{ label: '취소', value: null }, { label: '구글 드라이브', value: 'drive' }, { label: '내 기기', value: 'local', primary: true }] });
  if (where === 'local') downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
  if (where === 'drive') {
    if (!driveGuard()) return;
    const folder = await DR.browse({ mode: 'folder' });
    if (!folder) return;
    await DR.withBusy('업로드 중…', () => DR.createFile(name, folder.id === 'root' ? null : folder.id, bytes));
    toast('드라이브에 저장했어요');
  }
}

// ---------------- page editor ----------------
function pageEditor(mergeNow = false) {
  if (!S.pdfDoc) return toast('먼저 PDF를 여세요');
  AN.setTool('hand'); selectTool('hand');
  openPageEditor({
    pickPdf: pickPdfAny,
    askPassword,
    collectForms: () => VW.collectFormValues(),
    exportBytes: exportTo,
    commitBase: async (newBase, newAnnots, items) => {
      if (S.outline && (S.outlineDirty || S.outlineAuto)) {
        const map = new Map();
        items.forEach((it, i) => { if (it.src === 'base') map.set(it.index, i); });
        S.outline = OL.normalizeLevels(S.outline.filter((o) => map.has(o.page)).map((o) => ({ ...o, page: map.get(o.page) })));
        S.outlineDirty = true;
      }
      S.baseBytes = newBase;
      S.annots = newAnnots;
      S.baseVer = Date.now();
      AN.resetHistory();
      await VW.openDocument(newBase, { keepView: true });
      S.dirty = true;
      updateTitle();
      persistBase();
      emit('changed', {});
      if (panelOpen) renderPanel();
      toast('페이지 편집을 적용했어요');
    },
  }, { mergeNow });
}

// ---------------- menu ----------------
function menuItem(ic, label, fn, opts = {}) {
  return el('button', { class: `menu-item ${opts.disabled ? 'disabled' : ''}`, disabled: !!opts.disabled, onclick: () => { closeSheet(); fn(); } },
    el('span', { class: 'ico', html: icon(ic) }), el('span', {}, label), opts.hint ? el('span', { class: 'menu-hint' }, opts.hint) : null);
}
let sheetEl = null;
function closeSheet() { sheetEl?.remove(); sheetEl = null; }
function openMenu() {
  closeSheet();
  const has = !!S.pdfDoc;
  const src = S.source || {};
  const saveHint = src.type === 'drive' ? '드라이브 원본' : src.handle || src.type === 'native' || src.type === 'path' ? '원본 파일' : '다운로드';
  const sheet = el('div', { class: 'sheet' },
    el('div', { class: 'sheet-title' }, 'Wave PDF'),
    menuItem('device', '내 기기에서 열기', openLocal),
    NV.NO_DRIVE ? null : menuItem('drive', '구글 드라이브에서 열기', openDrive),
    el('div', { class: 'menu-sep' }),
    menuItem('save', '저장', save, { disabled: !has, hint: saveHint }),
    menuItem('download', '기기에 다른 이름으로 저장', () => saveToDevice().catch((e) => toast(e.message)), { disabled: !has }),
    NV.NO_DRIVE ? null : menuItem('drive', '드라이브에 새로 저장', saveToDriveNew, { disabled: !has }),
    NV.NATIVE || navigator.canShare ? menuItem('share', NV.NATIVE ? '다른 앱으로 보내기 (드라이브에 올리기 등)' : '다른 앱으로 공유', shareFile, { disabled: !has }) : null,
    el('div', { class: 'menu-sep' }),
    NV.NATIVE ? null : menuItem('printer', '인쇄', printDoc, { disabled: !has, hint: 'Ctrl+P' }),
    menuItem('layers', '페이지 편집 (회전·삭제·순서)', () => pageEditor(), { disabled: !has }),
    menuItem('merge', 'PDF 합치기', () => pageEditor(true), { disabled: !has }),
    menuItem('lock', S.password ? '암호 변경/해제' : '암호 걸기', setPassword, { disabled: !has }),
    el('div', { class: 'menu-sep' }),
    menuItem('info', '단축키', showShortcuts),
    menuItem('settings', '설정', openSettings),
    has ? menuItem('x', tabs.length > 1 ? '이 탭 닫기' : '문서 닫기', closeDoc) : null);
  const back = el('div', { class: 'sheet-back', onpointerdown: (e) => { if (e.target === back) closeSheet(); } }, sheet);
  document.body.append(back);
  sheetEl = back;
}
async function setPassword() {
  const v = await promptDialog(S.password ? '새 암호 (비우면 암호 해제)' : '저장할 때 걸 암호', '', { type: 'password', placeholder: '암호' });
  if (v == null) return;
  S.password = v || null;
  S.dirty = true; emit('changed', {});
  toast(v ? '저장할 때 암호가 걸려요' : '암호를 해제했어요 (저장 시 적용)');
}
async function closeDoc() { return closeTab(activeTab); }

// ---------------- print ----------------
/** "1-3, 5, 8-" → sorted 0-based page indexes (null if invalid) */
function parseRange(txt, n) {
  const out = new Set();
  for (const part of txt.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-~]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) return null;
    const a = +(m[1] || 1), b = m.length > 2 ? +(m[2] || n) : a;
    if (!a || !b || a > b || b > n) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}
async function printDoc() {
  if (!S.pdfDoc) return;
  const n = S.pdfDoc.numPages, cur = VW.viewer.currentPageNumber;
  const radio = (v, label, checked) => el('label', { class: 'check' }, el('input', { type: 'radio', name: 'prRange', value: v, checked }), ' ' + label);
  const custom = el('input', { class: 'input', placeholder: '예: 1-3, 5, 8', style: { marginTop: '6px' } });
  const withAnn = el('input', { type: 'checkbox', checked: true });
  const hasAnn = S.annots.some((l) => l?.length);
  custom.addEventListener('focus', () => { body.querySelector('input[value=custom]').checked = true; });
  const body = el('div', { class: 'print-opts' },
    el('div', { class: 'field' }, el('span', {}, '인쇄 범위'),
      el('div', { class: 'print-range' }, radio('all', `전체 (${n}쪽)`, true), radio('cur', `현재 쪽 (${cur}쪽)`), radio('custom', '쪽 지정'))),
    custom,
    hasAnn ? el('label', { class: 'check', style: { marginTop: '12px' } }, withAnn, ' 하이라이트·주석 함께 인쇄') : null,
    el('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12.5px' } }, '다음 화면에서 프린터, 매수, 용지, 양면을 고를 수 있어요.'));
  let pages;
  for (;;) {
    const ok = await modal({ title: '인쇄', body, buttons: [{ label: '취소', value: false }, { label: '인쇄', value: true, primary: true }] });
    if (!ok) return;
    const mode = body.querySelector('input[name=prRange]:checked').value;
    pages = mode === 'all' ? [...Array(n).keys()] : mode === 'cur' ? [cur - 1] : parseRange(custom.value, n);
    if (pages) break;
    toast(`쪽 번호를 확인해 주세요 (1~${n})`);
  }
  const b = busy('인쇄 준비 중…');
  let doc = null;
  const root = el('div', { id: 'printRoot' });
  try {
    const bytes = await exportBytes({ quiet: true, encrypt: false, annots: !hasAnn || withAnn.checked });
    doc = await VW.pdfjsLib.getDocument({ ...VW.DOC_OPTS, data: bytes }).promise;
    let land = 0;
    for (const [k, i] of pages.entries()) {
      b.set(`인쇄 준비 중… ${k + 1}/${pages.length}`);
      const page = await doc.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      if (vp1.width > vp1.height) land++;
      // ~200 dpi, capped so huge pages don't run out of memory
      const scale = Math.min(200 / 72, 3600 / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: VW.pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      c.width = c.height = 0;
      const img = el('img', { src: URL.createObjectURL(blob) });
      root.append(el('div', { class: `print-page ${vp1.width > vp1.height ? 'land' : ''}` }, img));
      page.cleanup();
    }
    await Promise.all([...root.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
    const st = el('style', { id: 'printPageStyle' }, `@page { size: ${land > pages.length / 2 ? 'landscape' : 'portrait'}; margin: 0; }`);
    document.head.append(st);
    document.body.append(root);
    document.body.classList.add('printing');
    b.close();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.print();
  } catch (e) {
    console.error(e);
    toast('인쇄 준비 실패: ' + e.message);
  } finally {
    b.close();
    // print() blocks until the dialog closes on desktop; on mobile it returns at once, so clean up after printing
    const done = () => {
      document.body.classList.remove('printing');
      root.querySelectorAll('img').forEach((im) => URL.revokeObjectURL(im.src));
      root.remove(); document.getElementById('printPageStyle')?.remove();
      doc?.destroy();
    };
    if (matchMedia('(pointer: coarse)').matches) window.addEventListener('afterprint', done, { once: true }), setTimeout(done, 120000);
    else done();
  }
}
function showShortcuts() {
  const groups = [
    ['파일·탭', [['Ctrl+O', '열기'], ['Ctrl+S', '저장'], ['Ctrl+P', '인쇄'], ['Ctrl+1 ~ Ctrl+9', '1~9번째 탭으로'], ['Ctrl+W / Ctrl+F4', '지금 탭 닫기'], ['Ctrl+Tab / Ctrl+PgDn', '다음 탭'], ['Ctrl+Shift+Tab / Ctrl+PgUp', '이전 탭']]],
    ['보기', [['D', '화면 모드 (기본 → 흑백 반전 → 세피아)'], ['Ctrl+F', '검색'], ['Ctrl+휠', '확대·축소']]],
    ['도구', [['H', '이동(손)'], ['T', '텍스트 선택'], ['Y', '형광펜'], ['U', '밑줄'], ['P', '펜'], ['M', '마커'], ['E', '지우개'], ['X', '글상자'], ['Esc', '이동 도구로 / 선택 해제']]],
    ['편집', [['Ctrl+Z', '되돌리기'], ['Ctrl+Y / Ctrl+Shift+Z', '다시 실행'], ['Delete', '선택한 주석 삭제'], ['Ctrl+B', '글상자 굵게 (입력 중)']]],
  ];
  const body = el('div', { class: 'keys' }, ...groups.flatMap(([g, rows]) => [el('div', { class: 'keys-h' }, g),
    ...rows.map(([k, d]) => el('div', { class: 'keys-row' }, el('span', { class: 'keys-d' }, d), el('span', { class: 'keys-k' }, ...k.split(' / ').map((x) => el('kbd', {}, x)))))]));
  modal({ title: '단축키', body, buttons: [{ label: '닫기', value: null, primary: true }] });
}
async function openSettings() {
  const author = el('input', { class: 'input', value: S.author });
  const penOnly = el('input', { type: 'checkbox', checked: CFG.penOnly });
  const autoDrive = el('input', { type: 'checkbox', checked: autoOn() });
  const autoHide = el('input', { type: 'checkbox', checked: autoHideOn() });
  const autoBm = el('input', { type: 'checkbox', checked: autoBmOn() });
  const om = el('select', { class: 'input' },
    ...[['tab', '새 탭으로 열기'], ['window', '새 창으로 열기'], ['ask', '열 때마다 묻기']].map(([v, l]) => el('option', { value: v, selected: openMode() === v }, l)));
  const signed = DR.isSignedIn();
  const body = el('div', { class: 'settings' },
    el('label', { class: 'field' }, el('span', {}, '주석 작성자 이름'), author),
    NV.NO_DRIVE ? null : el('label', { class: 'field' }, el('span', {}, 'PDF를 하나 더 열 때'), om),
    el('label', { class: 'check' }, penOnly, ' 그리기 도구는 스타일러스로만 (손가락은 스크롤)'),
    NV.NO_DRIVE ? null : el('label', { class: 'check', style: { marginTop: '8px' } }, autoDrive, ' 드라이브 파일은 변경 후 자동 저장'),
    el('label', { class: 'check', style: { marginTop: '8px' } }, autoHide, ' 스크롤하면 아래 도구 막대 자동 숨김'),
    el('label', { class: 'check', style: { marginTop: '8px' } }, autoBm, ' 책갈피 없는 PDF는 열 때 자동으로 만들기'),
    NV.NO_DRIVE ? null : el('div', { class: 'field' }, el('span', {}, '구글 드라이브'),
      el('div', { class: 'row gap' },
        el('button', { class: 'btn small', onclick: () => DR.setupGuide() }, DR.isConfigured() ? '클라이언트 ID 변경' : '연결 설정'),
        signed ? el('button', { class: 'btn small', onclick: (e) => { DR.signOut(); e.target.remove(); toast('로그아웃했어요'); } }, '로그아웃') : null)),
    el('div', { class: 'field' }, el('span', {}, '색 팔레트'),
      el('div', { class: 'row gap' }, el('button', { class: 'btn small', onclick: () => { resetPalette(); renderToolOptions(); toast('팔레트를 기본값으로 돌렸어요'); } }, '기본 색으로 되돌리기'))),
    el('p', { class: 'muted small' }, `버전 ${APP_VERSION}`));
  const ok = await modal({ title: '설정', body, buttons: [{ label: '닫기', value: false }, { label: '저장', value: true, primary: true }] });
  if (!ok) return;
  S.author = author.value.trim() || '재원';
  localStorage.setItem('author', S.author);
  CFG.penOnly = penOnly.checked; saveCfg();
  localStorage.setItem('autoDrive', autoDrive.checked ? '1' : '0');
  localStorage.setItem('autoHideToolbar', autoHide.checked ? '1' : '0');
  localStorage.setItem('autoBookmarks', autoBm.checked ? '1' : '0');
  localStorage.setItem('openMode', om.value);
  if (!autoHide.checked) setToolbarHidden(false);
  renderToolOptions();
}

// ---------------- side panel ----------------
let panelOpen = false, panelTab = 'outline';
function togglePanel(force) {
  panelOpen = force ?? !panelOpen;
  $('#sidePanel').hidden = !panelOpen;
  document.body.classList.toggle('panel-open', panelOpen);
  if (panelOpen) renderPanel();
  setTimeout(() => { if (S.pdfDoc && VW.viewer.currentScaleValue && isNaN(+VW.viewer.currentScaleValue)) VW.viewer.currentScaleValue = VW.viewer.currentScaleValue; }, 220);
}
$$('#panelTabs .seg-btn').forEach((b) => b.addEventListener('click', () => {
  panelTab = b.dataset.tab;
  $$('#panelTabs .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
  renderPanel();
}));
const narrow = () => innerWidth < 1100;
async function renderPanel() {
  const body = $('#panelBody');
  if (!S.pdfDoc) { body.replaceChildren(el('div', { class: 'muted pad' }, '열린 문서가 없어요')); return; }
  if (panelTab === 'outline') {
    renderBookmarks(body);
  } else {
    const all = AN.allAnnotations();
    if (!all.length) { body.replaceChildren(el('div', { class: 'muted pad' }, '아직 주석이 없어요. 아래 도구로 하이라이트·메모를 남겨 보세요.')); return; }
    const list = el('div', { class: 'an-list' });
    list.append(el('div', { class: 'an-tools' },
      el('span', { class: 'muted small' }, `주석 ${all.length}개`),
      el('button', { class: 'btn small', onclick: copyAllComments }, '목록 복사')));
    let lastP = -1;
    for (const { p, a } of all) {
      if (p !== lastP) { list.append(el('div', { class: 'an-page' }, `${p + 1}쪽`)); lastP = p; }
      const col = a.color ? `rgb(${a.color.map((v) => Math.round(v * 255)).join(',')})` : '#999';
      const excerpt = a.type === 'freetext' ? a.text : a.quote || '';
      list.append(el('button', { class: 'an-item', onclick: () => { AN.focusAnnotation(p, a.id); if (narrow()) togglePanel(false); } },
        el('span', { class: 'an-dot', style: { background: col } }),
        el('span', { class: 'an-main' },
          el('span', { class: 'an-type' }, AN.typeLabel(a)),
          excerpt ? el('span', { class: 'an-quote' }, excerpt) : null,
          a.text && a.type !== 'freetext' ? el('span', { class: 'an-text' }, a.text) : null)));
    }
    body.replaceChildren(list);
  }
}

// ---------------- bookmarks ----------------
const autoBmOn = () => localStorage.getItem('autoBookmarks') !== '0';
let bmLoading = false;
async function loadBookmarks(doc) {
  if (S.outlineDirty && S.outline) return;
  if (S.outline && S.outlineDoc === doc) return; // tab switch: already loaded
  bmLoading = true;
  S.outline = null; S.outlineAuto = false;
  if (panelOpen && panelTab === 'outline') renderPanel();
  let list = await OL.readOutline(doc);
  if (S.pdfDoc !== doc) return;
  if (!list.length && autoBmOn() && doc.numPages <= 400) {
    try { list = await OL.autoOutline(doc); S.outlineAuto = list.length > 0; } catch (e) { console.warn(e); list = []; }
    if (S.pdfDoc !== doc) return;
  }
  S.outline = list; S.outlineDoc = doc;
  bmLoading = false;
  if (panelOpen && panelTab === 'outline') renderPanel();
}
on('outline', () => { persistState(); if (panelOpen && panelTab === 'outline') renderPanel(); });

function goBookmark(it) {
  if (it.top != null) VW.scrollToPoint(it.page, null, it.top); else VW.goToPage(it.page + 1);
  if (narrow()) togglePanel(false);
}
function visibleTop(pageIdx) {
  const pv = VW.viewer.getPageView(pageIdx);
  if (!pv?.viewport) return null;
  const off = container.scrollTop - pv.div.offsetTop;
  return off > 0 ? Math.round(pv.viewport.convertToPdfPoint(0, off)[1]) : null;
}
async function addBookmark() {
  if (!S.pdfDoc) return;
  const page = VW.viewer.currentPageNumber - 1;
  let guess = '';
  try { const tc = await (await S.pdfDoc.getPage(page + 1)).getTextContent(); guess = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 40); } catch { /* */ }
  const title = await promptDialog(`${page + 1}쪽에 책갈피 추가`, guess || `${page + 1}쪽`, { placeholder: '책갈피 이름' });
  if (!title || !title.trim()) return;
  const list = S.outline || [];
  let at = list.length, level = 0;
  for (let i = 0; i < list.length; i++) if (list[i].page <= page) { at = i + 1; level = list[i].level; } else break;
  if (at === 0) level = 0;
  list.splice(at, 0, { title: title.trim(), page, top: visibleTop(page), level });
  S.outline = OL.normalizeLevels(list);
  OL.markOutlineChanged();
  toast('책갈피를 추가했어요');
}
async function autoBookmarks() {
  if (!S.pdfDoc) return;
  if (S.outline?.length && !(await confirmDialog('지금 책갈피를 지우고 자동으로 새로 만들까요?', '새로 만들기'))) return;
  const b = busy('제목을 찾는 중…');
  let list;
  try { list = await OL.autoOutline(S.pdfDoc, (d, t) => b.set(`제목을 찾는 중… ${d}/${t}쪽`)); }
  finally { b.close(); }
  if (!list.length) {
    if (!(await confirmDialog('제목으로 보이는 줄을 찾지 못했어요. 쪽마다 책갈피를 만들까요?', '쪽마다 만들기'))) return;
    list = await OL.pageOutline(S.pdfDoc);
  }
  S.prevOutline = S.outline;
  S.outline = list;
  OL.markOutlineChanged();
  toast(`책갈피 ${list.length}개를 만들었어요`);
}
function bookmarkMenu(i, anchor) {
  document.querySelector('.bm-menu')?.remove();
  const list = S.outline;
  const it = list[i];
  const act = (fn) => () => { menu.remove(); fn(); OL.normalizeLevels(list); OL.markOutlineChanged(); };
  const menu = el('div', { class: 'ctx-menu bm-menu' }, el('div', { class: 'bm-menu-list' },
    el('button', { class: 'menu-item', onclick: async () => { menu.remove(); const v = await promptDialog('책갈피 이름', it.title); if (v && v.trim()) { it.title = v.trim(); OL.markOutlineChanged(); } } }, '이름 바꾸기'),
    el('button', { class: 'menu-item', onclick: act(() => { it.page = VW.viewer.currentPageNumber - 1; it.top = visibleTop(it.page); }) }, '지금 보는 위치로 바꾸기'),
    el('button', { class: 'menu-item', disabled: i === 0, onclick: act(() => { it.level += 1; }) }, '하위로 (들여쓰기)'),
    el('button', { class: 'menu-item', disabled: it.level === 0, onclick: act(() => { it.level = Math.max(0, it.level - 1); }) }, '상위로 (내어쓰기)'),
    el('button', { class: 'menu-item', disabled: i === 0, onclick: act(() => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; }) }, '위로 이동'),
    el('button', { class: 'menu-item', disabled: i === list.length - 1, onclick: act(() => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; }) }, '아래로 이동'),
    el('button', { class: 'menu-item danger', onclick: act(() => { list.splice(i, 1); }) }, '삭제')));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, innerWidth - 200) + 'px';
  menu.style.top = Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off, true); } }, true), 0);
}
function renderBookmarks(body) {
  const list = S.outline;
  const tb = (ic, title, fn) => el('button', { class: 'bm-tb', title, 'aria-label': title, html: icon(ic), onclick: fn });
  const head = el('div', { class: 'bm-head' },
    el('span', { class: 'bm-count' }, list?.length ? `책갈피 ${list.length}` : '책갈피'),
    S.prevOutline !== undefined ? tb('undo', '자동 생성 전으로 되돌리기', () => { S.outline = S.prevOutline || []; S.prevOutline = undefined; OL.markOutlineChanged(); }) : null,
    tb('sparkles', '제목을 찾아 자동 생성', autoBookmarks),
    tb('plus', '지금 보는 위치에 추가', addBookmark));
  const parts = [head];
  if (list == null) parts.push(el('div', { class: 'bm-empty' }, bmLoading ? '책갈피를 불러오는 중…' : ''));
  else if (!list.length) parts.push(el('div', { class: 'bm-empty' }, '책갈피가 없어요. ✨ 버튼을 누르면 제목을 찾아 만들어 줘요.'));
  else {
    if (S.outlineAuto && !S.outlineDirty) parts.push(el('div', { class: 'bm-note' }, '자동으로 만든 책갈피예요 · 저장하면 PDF에 들어가요'));
    // current section = last bookmark at or before the page being read
    const cur = VW.viewer.currentPageNumber - 1;
    let curIdx = -1;
    list.forEach((it, i) => { if (it.page <= cur) curIdx = i; });
    const rows = list.map((it, i) => el('div', { class: `bm-row lv${Math.min(it.level, 2)} ${i === curIdx ? 'cur' : ''}`, style: { paddingLeft: 8 + it.level * 14 + 'px' } },
      el('button', { class: 'bm-title', title: it.title, onclick: () => goBookmark(it) }, it.title),
      el('span', { class: 'bm-page' }, String(it.page + 1)),
      el('button', { class: 'bm-more', title: '편집', 'aria-label': '편집', html: icon('more'), onclick: (e) => bookmarkMenu(i, e.currentTarget) })));
    parts.push(el('div', { class: 'bm-list' }, rows));
  }
  body.replaceChildren(...parts);
}

async function copyAllComments() {
  const lines = [`[${S.fileName}] 주석 목록`];
  for (const { p, a } of AN.allAnnotations()) {
    const q = a.type === 'freetext' ? a.text : a.quote;
    let s = `- ${p + 1}쪽 [${AN.typeLabel(a)}]`;
    if (q) s += ` "${q.replace(/\n/g, ' ')}"`;
    if (a.text && a.type !== 'freetext') s += ` → ${a.text}`;
    lines.push(s);
  }
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('주석 목록을 복사했어요'); } catch { toast('복사하지 못했어요'); }
}
const refreshPanel = debounce(() => { if (panelOpen && panelTab === 'annots') renderPanel(); }, 300);

// ---------------- search ----------------
let lastQuery = '';
function openSearch() {
  if (!S.pdfDoc) return;
  $('#searchBar').hidden = false;
  document.body.classList.add('search-open');
  const i = $('#searchInput'); i.focus(); i.select();
}
function closeSearch() {
  $('#searchBar').hidden = true;
  document.body.classList.remove('search-open');
  VW.clearFind(); lastQuery = ''; $('#searchCount').textContent = '';
}
function doFind(prev = false) {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  VW.find(q, { again: q === lastQuery, prev });
  lastQuery = q;
}
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doFind(e.shiftKey); } if (e.key === 'Escape') closeSearch(); });
$('#searchNext').onclick = () => doFind(false);
$('#searchPrev').onclick = () => doFind(true);
$('#searchClose').onclick = closeSearch;
const setCount = (mc) => { $('#searchCount').textContent = mc && mc.total ? `${mc.current}/${mc.total}` : lastQuery ? '0건' : ''; };
VW.eventBus.on('updatefindmatchescount', ({ matchesCount }) => setCount(matchesCount));
VW.eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => { if (state === 1) $('#searchCount').textContent = '없음'; else setCount(matchesCount); });

// ---------------- zoom & page ----------------
$('#zoomIn').onclick = () => VW.zoomBy(1.2);
$('#zoomOut').onclick = () => VW.zoomBy(1 / 1.2);
$('#zoomVal').onclick = () => VW.setScaleValue(VW.viewer.currentScaleValue === 'page-width' ? 'page-fit' : 'page-width');
on('scale', (s) => ($('#zoomVal').textContent = Math.round(s * 100) + '%'));
const updatePageInd = () => { if (S.pdfDoc) $('#pageInd').textContent = `${VW.viewer.currentPageNumber} / ${S.pdfDoc.numPages}`; };
on('page', updatePageInd);
on('docloaded', (doc) => { loadBookmarks(doc); if (!S.dirty) setStatus(''); updatePageInd(); $('#zoomVal').textContent = Math.round(VW.viewer.currentScale * 100) + '%'; });
$('#pageInd').onclick = async () => {
  const v = await promptDialog('이동할 페이지', String(VW.viewer.currentPageNumber), { type: 'number' });
  if (v) VW.goToPage(parseInt(v, 10));
};

// ---------------- auto-hide bottom toolbar ----------------
const autoHideOn = () => localStorage.getItem('autoHideToolbar') !== '0';
let tbHidden = false, lastTop = 0;
function setToolbarHidden(h) {
  if (h && (!autoHideOn() || S.tool !== 'hand' || !S.pdfDoc || !$('#toolOptions').hidden)) h = false;
  if (h === tbHidden) return;
  tbHidden = h;
  document.body.classList.toggle('tb-hidden', h);
}
container.addEventListener('scroll', () => {
  const t = container.scrollTop, d = t - lastTop;
  lastTop = t;
  if (d > 14) setToolbarHidden(true);
  else if (d < -14) setToolbarHidden(false);
}, { passive: true });
document.addEventListener('mousemove', (e) => { if (tbHidden && e.clientY > window.innerHeight - 90) setToolbarHidden(false); }, { passive: true });
{ // tap on the page (touch) toggles the toolbar
  let down = null;
  container.addEventListener('pointerdown', (e) => { down = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, t: Date.now() } : null; }, { passive: true });
  container.addEventListener('pointerup', (e) => {
    if (!down || S.tool !== 'hand') return;
    const quick = Date.now() - down.t < 300 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
    down = null;
    if (!quick || e.target.closest?.('.ann, .sel-box, .annotationLayer a, .annotationLayer input, .annotationLayer select, .annotationLayer textarea')) return;
    setToolbarHidden(!tbHidden);
  });
}

// ---------------- view mode (normal / dark / sepia) ----------------
const VIEW_MODES = [['normal', 'sun', '기본'], ['dark', 'moon', '흑백 반전'], ['sepia', 'coffee', '세피아']];
function applyViewMode(m) {
  document.body.classList.remove('view-dark', 'view-sepia');
  if (m !== 'normal') document.body.classList.add('view-' + m);
  const cur = VIEW_MODES.find((v) => v[0] === m) || VIEW_MODES[0];
  $('#viewMode').innerHTML = icon(cur[1]);
  localStorage.setItem('viewMode', m);
}
function cycleViewMode() {
  const cur = localStorage.getItem('viewMode') || 'normal';
  const i = VIEW_MODES.findIndex((v) => v[0] === cur);
  const next = VIEW_MODES[(i + 1) % VIEW_MODES.length];
  applyViewMode(next[0]);
  toast(`보기 모드: ${next[2]}`);
}
applyViewMode(localStorage.getItem('viewMode') || 'normal');
$('#viewMode').onclick = cycleViewMode;

// ---------------- header buttons ----------------
$('#btnMenu').onclick = openMenu;
$('#btnPanel').onclick = () => togglePanel();
// don't leave chrome buttons focused after a mouse/touch click (keyboard shortcuts would re-trigger them and draw a focus ring)
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button, input[type=checkbox], label.check');
  if (b && e.detail > 0 && b.closest('#topbar, #toolbar, #zoomCtl, #tabBar, #toolOptions, #panelTabs, #sidePanel')) b.blur();
}, true);
$('#btnAI').onclick = () => toggleAI();
$('#btnSearch').onclick = () => ($('#searchBar').hidden ? openSearch() : closeSearch());
$('#btnPages').onclick = () => pageEditor();
$('#btnSave').onclick = () => (S.pdfDoc ? save() : openMenu());
$('#docTitle').onclick = async () => {
  if (!S.pdfDoc) return;
  const v = await promptDialog('파일 이름', S.fileName);
  if (v && v.trim()) { S.fileName = /\.pdf$/i.test(v.trim()) ? v.trim() : v.trim() + '.pdf'; updateTitle(); persistState(); }
};
$('#wlOpen').onclick = openLocal;
$('#wlDrive').onclick = openDrive;
if (NV.DESKTOP) {
  $('#wlDrive').remove();
  document.body.classList.add('desktop');
  NV.onDesktopFiles((f, err) => {
    if (!f) return toast('파일을 열 수 없어요: ' + err);
    openBytes(f.bytes, f.name, { type: 'path', path: f.path }, { target: S.pdfDoc ? 'tab' : undefined });
  });
}
if (NV.NATIVE) {
  $('#wlDrive').remove();
  document.body.classList.add('native');
  NV.onFileOpened((f, err) => {
    if (!f) return toast('파일을 열 수 없어요: ' + err);
    openBytes(f.bytes, f.name, { type: 'native', uri: f.uri, writable: f.writable });
  });
}

// ---------------- state persistence ----------------
function persistBase() { if (S.baseBytes) idbSet('base', { bytes: S.baseBytes, ver: S.baseVer }).catch(() => {}); }
const persistState = debounce(() => {
  if (!S.baseBytes) return;
  idbSet('session', {
    name: S.fileName, annots: S.annots, images: S.images, source: S.source, password: S.password,
    dirty: S.dirty, page: VW.viewer.currentPageNumber, ver: S.baseVer, t: Date.now(),
    outline: S.outlineDirty ? S.outline : null, outlineDirty: !!S.outlineDirty,
  }).catch((e) => console.warn('persist', e));
}, 700);
on('changed', () => { S.rev++; updateTitle(); persistState(); refreshPanel(); scheduleAutoSave(); });
on('page', () => { persistState(); if (panelOpen && panelTab === 'outline' && S.outline?.length) renderPanel(); });

async function restoreSession() {
  const [sess, base] = await Promise.all([idbGet('session'), idbGet('base')]);
  if (!sess || !base || base.ver !== sess.ver) return false;
  const b = busy('이전 문서 복원 중…');
  try {
    await beginTab();
    S.baseBytes = base.bytes; S.baseVer = base.ver;
    S.annots = sess.annots || []; S.images = sess.images || {};
    S.fileName = sess.name; S.source = sess.source; S.password = sess.password || null;
    S.outlineDirty = !!sess.outlineDirty; S.outline = sess.outlineDirty ? sess.outline : null; S.prevOutline = undefined;
    await VW.openDocument(S.baseBytes);
    while (S.annots.length < S.pdfDoc.numPages) S.annots.push([]);
    S.dirty = !!sess.dirty;
    AN.resetHistory();
    if (sess.page) VW.goToPage(sess.page);
    showDoc();
    return true;
  } catch (e) { console.warn(e); S.baseBytes = null; S.pdfDoc = null; toast('복원 실패: ' + e.message); showDoc(); return false; }
  finally { b.close(); }
}
async function checkResume() {
  const sess = await idbGet('session');
  const btn = $('#wlResume');
  if (sess && !S.pdfDoc) {
    btn.hidden = false;
    btn.innerHTML = `${icon('history')} 이어서 보기: ${sess.name}`;
    btn.onclick = restoreSession;
  } else btn.hidden = true;
}

// ---------------- keyboard ----------------
document.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  // checkboxes, sliders and colour pickers don't take text, so they must not swallow shortcuts
  const typing = (ae?.tagName === 'INPUT' && !/^(checkbox|radio|range|color|button)$/.test(ae.type)) || /TEXTAREA|SELECT/.test(ae?.tagName) || ae?.isContentEditable;
  // letter keys by physical key, so they work with the Korean IME on (ㅛ → Y)
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && key === 's') { e.preventDefault(); save(); return; }
  if ((mod && key === 'w') || (mod && e.key === 'F4')) { e.preventDefault(); if (activeTab) closeTab(activeTab); return; }
  if (mod && key === 'p' && !NV.NATIVE) { e.preventDefault(); if (S.pdfDoc) printDoc(); return; }
  if (mod && key === 'o') { e.preventDefault(); openLocal(); return; }
  if (mod && key === 'f') { e.preventDefault(); openSearch(); return; }
  if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && tabs.length) { e.preventDefault(); switchTab(tabs[+e.key - 1]); return; }
  if (mod && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
  if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); cycleTab(e.key === 'PageDown' ? 1 : -1); return; }
  if (typing || document.querySelector('.modal-back')) return;
  if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); AN.undo(); return; }
  if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); AN.redo(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) { e.preventDefault(); AN.deleteSelected(); return; }
  if (e.key === 'Escape') { if (S.tool !== 'hand') selectTool('hand'); else AN.deselect(); }
  if (!mod && !e.altKey && key === 'd' && S.pdfDoc) { cycleViewMode(); return; }
  if (!mod && !e.altKey && e.key === '?') { showShortcuts(); return; }
  const map = { h: 'hand', t: 'text', y: 'highlight', u: 'underline', p: 'pen', m: 'marker', e: 'eraser', x: 'freetext' };
  if (!mod && !e.altKey && !e.shiftKey && map[key] && S.pdfDoc) { e.preventDefault(); onToolClick(map[key]); }
});
window.addEventListener('beforeunload', (e) => { if (S.dirty || tabs.some((t) => stOf(t).dirty)) { persistState.flush(); e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistState.flush(); });

// ---------------- drag & drop ----------------
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  const pdfs = files.filter(isPdfFile);
  if (pdfs.length) openLocalFiles(pdfs.map((file) => ({ file })));
  else if (files[0]) openLocalFile(files[0]);
});

// ---------------- startup ----------------
selectTool('hand');
DR.preload();
if (!NV.NO_DRIVE && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});

let incoming = false;
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    incoming = true;
    const list = await Promise.all(params.files.map(async (h) => ({ file: await h.getFile(), handle: h })));
    openLocalFiles(list);
  });
}
(async () => {
  const qs = new URLSearchParams(location.search);
  if (qs.has('xfer')) {
    const key = 'xfer:' + qs.get('xfer');
    history.replaceState(null, '', location.pathname);
    const x = await idbGet(key);
    await idbDel(key).catch(() => {});
    if (x) {
      incoming = true;
      if (x.kind === 'state') await openState(x.st, x.page);
      else await openBytes(x.bytes, x.name, x.source);
      return;
    }
  }
  if (qs.has('shared')) {
    history.replaceState(null, '', location.pathname);
    try {
      const c = await caches.open('wavepdf-share');
      const r = await c.match('shared-file');
      if (r) {
        incoming = true;
        const name = decodeURIComponent(r.headers.get('X-Name') || 'shared.pdf');
        const buf = new Uint8Array(await r.arrayBuffer());
        await c.delete('shared-file');
        await openBytes(buf, name, { type: 'local' });
        return;
      }
    } catch (e) { console.warn(e); }
  }
  await new Promise((r) => setTimeout(r, 250));
  if (incoming || S.pdfDoc) return;
  // don't auto-restore (a stuck restore would block the app); offer it on the welcome screen
  showDoc(); checkResume();
})();
showDoc();

// expose for debugging
window.__wave = { S, VW, AN, openBytes, tabs, switchTab, closeTab, get activeTab() { return activeTab; } };
window.__waveReady = true;
void emit; void idbGet;
