import { S, CFG, saveCfg, emit, on, PALETTE } from './state.js';
import { $, $$, el, icon, toast, modal, confirmDialog, promptDialog, busy, downloadBlob, debounce, isTouchDevice } from './util.js';
import { idbGet, idbSet, idbDel } from './store.js';
import * as VW from './viewer.js';
import * as AN from './annots.js';
import { prepare, buildPdf, qpdf } from './pdfio.js';
import * as DR from './drive.js';
import { openPageEditor } from './pages.js';
import { pickSignature } from './sign.js';
import { initAI, toggleAI } from './ai.js';

const APP_VERSION = '1.0.0';
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
  ['freetext', 'freetext', '글상자'], ['note', 'note', '메모'], ['shape', 'shapes', '도형'], ['sign', 'sign', '서명'],
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
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === k));
  optsOpen = ['highlight', 'underline', 'strike', 'pen', 'marker', 'freetext', 'shape', 'note', 'eraser'].includes(k);
  renderToolOptions();
}
on('settool', selectTool);
on('needsign', () => onToolClick('sign'));

function swatchRow(colors, cfg) {
  const row = el('div', { class: 'opt-swatches' });
  for (const c of colors) {
    row.append(el('button', { class: `swatch ${cfg.color.toUpperCase() === c.toUpperCase() ? 'on' : ''}`, style: { background: c }, onclick: () => { cfg.color = c; saveCfg(); renderToolOptions(); } }));
  }
  const custom = el('input', { type: 'color', class: 'swatch custom', value: cfg.color, title: '직접 선택' });
  custom.addEventListener('change', () => { cfg.color = custom.value; saveCfg(); renderToolOptions(); });
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
  if (t === 'highlight') parts.push(swatchRow(PALETTE.highlight, CFG.highlight));
  if (t === 'underline' || t === 'strike') parts.push(swatchRow(PALETTE.ink, CFG[t]));
  if (t === 'pen') parts.push(swatchRow(PALETTE.ink, CFG.pen), slider('굵기', CFG.pen, 'width', 0.5, 8, 0.5));
  if (t === 'marker') parts.push(swatchRow(PALETTE.highlight, CFG.marker), slider('굵기', CFG.marker, 'width', 4, 30, 1));
  if (t === 'freetext') {
    const sizes = el('div', { class: 'seg small' });
    for (const s of [8, 10, 12, 14, 18, 24]) sizes.append(el('button', { class: `seg-btn ${CFG.freetext.size === s ? 'on' : ''}`, onclick: () => { CFG.freetext.size = s; saveCfg(); renderToolOptions(); } }, String(s)));
    parts.push(swatchRow(PALETTE.ink, CFG.freetext), sizes);
  }
  if (t === 'shape') {
    const kinds = el('div', { class: 'seg small' });
    for (const [k, ic] of [['square', 'square'], ['circle', 'circle'], ['arrow', 'arrow']]) kinds.append(el('button', { class: `seg-btn ${CFG.shape.kind === k ? 'on' : ''}`, html: icon(ic), onclick: () => { CFG.shape.kind = k; saveCfg(); renderToolOptions(); } }));
    parts.push(kinds, swatchRow(PALETTE.ink, CFG.shape), slider('굵기', CFG.shape, 'width', 0.5, 8, 0.5));
  }
  if (t === 'note') parts.push(swatchRow(PALETTE.note, CFG.note));
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

async function openBytes(bytes, name, source) {
  if (S.dirty && S.pdfDoc && !(await confirmDialog('저장하지 않은 변경사항이 있어요. 새 문서를 열까요?', '열기'))) return false;
  let b = busy('여는 중…');
  try {
    const prep = await prepare(bytes, async (m) => { b.close(); const v = await askPassword(m); b = busy('여는 중…'); return v; });
    AN.setTool('hand'); selectTool('hand');
    S.baseBytes = prep.base;
    S.annots = prep.annots;
    S.images = {};
    S.password = prep.password;
    S.fileName = name || 'document.pdf';
    S.source = source || { type: 'local' };
    S.baseVer = Date.now();
    S.dirty = false;
    AN.resetHistory();
    await VW.openDocument(prep.base);
    while (S.annots.length < S.pdfDoc.numPages) S.annots.push([]);
    showDoc();
    persistBase();
    persistState();
    if (prep.encrypted) toast(prep.password ? '암호를 풀었어요. 저장할 때 같은 암호로 다시 잠가요' : '보안 설정을 해제한 사본으로 열었어요');
    return true;
  } catch (e) {
    if (e.message !== 'CANCELLED') { console.error(e); modal({ title: 'PDF를 열 수 없어요', body: el('div', { class: 'muted' }, e.message || String(e)) }); }
    return false;
  } finally { b.close(); }
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
  $('#docTitle').textContent = S.pdfDoc ? S.fileName : 'Wave PDF';
  $('#dirtyDot').hidden = !S.dirty;
  document.title = S.pdfDoc ? `${S.dirty ? '• ' : ''}${S.fileName} - Wave PDF` : 'Wave PDF';
}

async function openLocal() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const f = await h.getFile();
      return openBytes(new Uint8Array(await f.arrayBuffer()), f.name, { type: 'local', handle: h });
    } catch (e) { if (e.name !== 'AbortError') toast(e.message); return; }
  }
  const input = $('#fileInput');
  input.value = '';
  input.onchange = async () => {
    const f = input.files[0];
    if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name, { type: 'local' });
  };
  input.click();
}
function pickLocalBytes() {
  return new Promise((res) => {
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf' });
    input.onchange = async () => { const f = input.files[0]; res(f ? { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name } : null); };
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
    if (f.convert) {
      if (!(await confirmDialog(`"${f.name}"을(를) PDF로 변환해서 열까요?\n원본은 그대로 두고, 저장은 "드라이브에 새로 저장"으로 해요. 서식이 조금 다를 수 있어요.`, '변환해서 열기'))) return;
      const bytes = await DR.withBusy('PDF로 변환 중…', () => DR.downloadAsPdf(f));
      const name = f.name.replace(/\.[^.]+$/, '') + '.pdf';
      await openBytes(bytes, name, { type: 'converted', parents: f.parents });
      return;
    }
    const bytes = await DR.withBusy('드라이브에서 받는 중…', () => DR.download(f.id));
    await openBytes(bytes, f.name, { type: 'drive', driveId: f.id, parents: f.parents, canEdit: f.canEdit });
  } catch (e) { toast(e.message); }
}
async function pickDriveBytes() {
  if (!driveGuard()) return null;
  const f = await DR.browse({ mode: 'file', title: '추가할 PDF 선택' });
  if (!f) return null;
  const bytes = await DR.withBusy(f.convert ? 'PDF로 변환 중…' : '드라이브에서 받는 중…', () => (f.convert ? DR.downloadAsPdf(f) : DR.download(f.id)));
  return { bytes, name: f.name };
}
async function pickPdfAny() {
  const where = await modal({ title: '어디서 PDF를 가져올까요?', buttons: [{ label: '취소', value: null }, { label: '구글 드라이브', value: 'drive' }, { label: '내 기기', value: 'local', primary: true }] });
  if (where === 'local') return pickLocalBytes();
  if (where === 'drive') return pickDriveBytes();
  return null;
}

// ---------------- save ----------------
async function exportBytes({ quiet = false } = {}) {
  const b = quiet ? { close() {} } : busy('PDF 만드는 중…');
  try {
    const forms = await VW.collectFormValues();
    let bytes = await buildPdf({ base: S.baseBytes, annots: S.annots, images: S.images, forms });
    if (S.password) bytes = await qpdf(bytes, ['--encrypt', S.password, S.password, '256', '--']);
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
    if (src.type === 'converted') return saveToDriveNew();
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
  const rev = S.rev;
  setStatus('저장 중…', true);
  try {
    const bytes = await exportBytes({ quiet: true });
    await DR.updateFile(S.source.driveId, bytes);
    if (S.rev === rev) { S.dirty = false; updateTitle(); persistState(); setStatus('드라이브에 저장됨'); }
    else scheduleAutoSave();
  } catch (e) {
    console.warn('autosave', e);
    setStatus('자동 저장 실패 · 저장 버튼', true);
  } finally { autoBusy = false; }
}
async function saveToDevice() {
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
    const file = new File([bytes], S.fileName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: S.fileName });
    else downloadBlob(file, S.fileName);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
}
/** used by page editor "추출" */
async function exportTo(bytes, name) {
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
    commitBase: async (newBase, newAnnots) => {
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
  const saveHint = src.type === 'drive' ? '드라이브 원본' : src.type === 'converted' ? '드라이브에 새로' : src.handle ? '원본 파일' : '다운로드';
  const sheet = el('div', { class: 'sheet' },
    el('div', { class: 'sheet-title' }, 'Wave PDF'),
    menuItem('device', '내 기기에서 열기', openLocal),
    menuItem('drive', '구글 드라이브에서 열기', openDrive),
    el('div', { class: 'menu-sep' }),
    menuItem('save', '저장', save, { disabled: !has, hint: saveHint }),
    menuItem('download', '기기에 다른 이름으로 저장', () => saveToDevice().catch((e) => toast(e.message)), { disabled: !has }),
    menuItem('drive', '드라이브에 새로 저장', saveToDriveNew, { disabled: !has }),
    navigator.canShare ? menuItem('share', '다른 앱으로 공유', shareFile, { disabled: !has }) : null,
    el('div', { class: 'menu-sep' }),
    menuItem('layers', '페이지 편집 (회전·삭제·순서)', () => pageEditor(), { disabled: !has }),
    menuItem('merge', 'PDF 합치기', () => pageEditor(true), { disabled: !has }),
    menuItem('lock', S.password ? '암호 변경/해제' : '암호 걸기', setPassword, { disabled: !has }),
    el('div', { class: 'menu-sep' }),
    menuItem('settings', '설정', openSettings),
    has ? menuItem('x', '문서 닫기', closeDoc) : null);
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
async function closeDoc() {
  if (S.dirty && !(await confirmDialog('저장하지 않은 변경사항이 있어요. 닫을까요?', '닫기', true))) return;
  VW.closeDocument();
  S.baseBytes = null; S.annots = []; S.dirty = false; S.source = null; S.password = null;
  AN.resetHistory(); AN.deselect(false);
  await idbDel('session'); await idbDel('base');
  showDoc();
  checkResume();
}

async function openSettings() {
  const author = el('input', { class: 'input', value: S.author });
  const penOnly = el('input', { type: 'checkbox', checked: CFG.penOnly });
  const autoDrive = el('input', { type: 'checkbox', checked: autoOn() });
  const signed = DR.isSignedIn();
  const body = el('div', { class: 'settings' },
    el('label', { class: 'field' }, el('span', {}, '주석 작성자 이름'), author),
    el('label', { class: 'check' }, penOnly, ' 그리기 도구는 스타일러스로만 (손가락은 스크롤)'),
    el('label', { class: 'check', style: { marginTop: '8px' } }, autoDrive, ' 드라이브 파일은 변경 후 자동 저장'),
    el('div', { class: 'field' }, el('span', {}, '구글 드라이브'),
      el('div', { class: 'row gap' },
        el('button', { class: 'btn small', onclick: () => DR.setupGuide() }, DR.isConfigured() ? '클라이언트 ID 변경' : '연결 설정'),
        signed ? el('button', { class: 'btn small', onclick: (e) => { DR.signOut(); e.target.remove(); toast('로그아웃했어요'); } }, '로그아웃') : null)),
    el('p', { class: 'muted small' }, `버전 ${APP_VERSION}`));
  const ok = await modal({ title: '설정', body, buttons: [{ label: '닫기', value: false }, { label: '저장', value: true, primary: true }] });
  if (!ok) return;
  S.author = author.value.trim() || '재원';
  localStorage.setItem('author', S.author);
  CFG.penOnly = penOnly.checked; saveCfg();
  localStorage.setItem('autoDrive', autoDrive.checked ? '1' : '0');
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
    const outline = await VW.getOutline();
    if (!outline.length) { body.replaceChildren(el('div', { class: 'muted pad' }, '이 문서에는 목차가 없어요')); return; }
    const build = (items, depth) => el('ul', { class: 'outline' }, items.map((it) => el('li', {},
      el('button', { class: 'ol-item', style: { paddingLeft: 12 + depth * 14 + 'px' }, onclick: () => { if (it.dest) VW.goToDest(it.dest); else if (it.url) window.open(it.url, '_blank'); if (narrow()) togglePanel(false); } }, it.title),
      it.items?.length ? build(it.items, depth + 1) : null)));
    body.replaceChildren(build(outline, 0));
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
on('docloaded', () => { if (!S.dirty) setStatus(''); updatePageInd(); $('#zoomVal').textContent = Math.round(VW.viewer.currentScale * 100) + '%'; });
$('#pageInd').onclick = async () => {
  const v = await promptDialog('이동할 페이지', String(VW.viewer.currentPageNumber), { type: 'number' });
  if (v) VW.goToPage(parseInt(v, 10));
};

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

// ---------------- state persistence ----------------
function persistBase() { if (S.baseBytes) idbSet('base', { bytes: S.baseBytes, ver: S.baseVer }).catch(() => {}); }
const persistState = debounce(() => {
  if (!S.baseBytes) return;
  idbSet('session', {
    name: S.fileName, annots: S.annots, images: S.images, source: S.source, password: S.password,
    dirty: S.dirty, page: VW.viewer.currentPageNumber, ver: S.baseVer, t: Date.now(),
  }).catch((e) => console.warn('persist', e));
}, 700);
on('changed', () => { S.rev++; updateTitle(); persistState(); refreshPanel(); scheduleAutoSave(); });
on('page', () => persistState());

async function restoreSession() {
  const [sess, base] = await Promise.all([idbGet('session'), idbGet('base')]);
  if (!sess || !base || base.ver !== sess.ver) return false;
  const b = busy('이전 문서 복원 중…');
  try {
    S.baseBytes = base.bytes; S.baseVer = base.ver;
    S.annots = sess.annots || []; S.images = sess.images || {};
    S.fileName = sess.name; S.source = sess.source; S.password = sess.password || null;
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
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openLocal(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
  if (typing || document.querySelector('.modal-back')) return;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); AN.undo(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); AN.redo(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) { e.preventDefault(); AN.deleteSelected(); return; }
  if (e.key === 'Escape') { if (S.tool !== 'hand') selectTool('hand'); else AN.deselect(); }
  if (!mod && !e.altKey && e.key === 'd' && S.pdfDoc) { cycleViewMode(); return; }
  const map = { h: 'hand', t: 'text', y: 'highlight', u: 'underline', p: 'pen', m: 'marker', e: 'eraser', x: 'freetext', n: 'note' };
  if (!mod && !e.altKey && map[e.key] && S.pdfDoc) onToolClick(map[e.key]);
});
window.addEventListener('beforeunload', (e) => { if (S.dirty) { persistState.flush(); e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistState.flush(); });

// ---------------- drag & drop ----------------
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name, { type: 'local' });
});

// ---------------- startup ----------------
selectTool('hand');
DR.preload();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});

let incoming = false;
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    incoming = true;
    const h = params.files[0];
    const f = await h.getFile();
    openBytes(new Uint8Array(await f.arrayBuffer()), f.name, { type: 'local', handle: h });
  });
}
(async () => {
  const qs = new URLSearchParams(location.search);
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
window.__wave = { S, VW, AN, openBytes };
window.__waveReady = true;
void emit; void idbGet;
