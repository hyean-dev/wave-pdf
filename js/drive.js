// Google Drive integration (Google Identity Services token flow + Drive v3 REST)
import { el, modal, toast, icon, fmtDate, fmtSize, busy } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/drive';
export const DEFAULT_CLIENT_ID = '1282005054-nru77ugk4q3gkrm4st9sob8pt0j84ejg.apps.googleusercontent.com';
export const getClientId = () => (localStorage.getItem('gClientId') || DEFAULT_CLIENT_ID).trim();
export const setClientId = (v) => { localStorage.setItem('gClientId', v.trim()); tokenClient = null; preload(); };

let gisP = null, tokenClient = null, pending = null;
let token = null, tokenExp = 0;
try {
  const t = JSON.parse(localStorage.getItem('gToken') || 'null');
  if (t && t.exp > Date.now() + 60000) { token = t.token; tokenExp = t.exp; }
} catch { /* ignore */ }

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisP) gisP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = res;
    s.onerror = () => { gisP = null; rej(new Error('구글 로그인 스크립트를 불러오지 못했어요 (인터넷 연결 확인)')); };
    document.head.append(s);
  });
  return gisP;
}
function initClient() {
  if (tokenClient || !window.google?.accounts?.oauth2 || !getClientId()) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPE,
    callback: (r) => {
      const p = pending; pending = null;
      if (r.error) return p?.rej(new Error(r.error_description || r.error));
      token = r.access_token;
      tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
      localStorage.setItem('gToken', JSON.stringify({ token, exp: tokenExp }));
      localStorage.setItem('gAuthed', '1');
      p?.res(token);
    },
    error_callback: (err) => { const p = pending; pending = null; p?.rej(new Error(err?.type === 'popup_closed' ? 'CANCELLED' : (err?.message || '로그인 실패'))); },
  });
}
/** call early so the token popup can open synchronously inside a click */
export function preload() {
  if (!getClientId()) return;
  loadGis().then(initClient).catch(() => {});
}
export const isConfigured = () => !!getClientId();
export const isSignedIn = () => !!token && Date.now() < tokenExp - 60000;

/** Must be called directly inside a user gesture (before any await). */
export function ensureToken() {
  if (isSignedIn()) return Promise.resolve(token);
  if (!getClientId()) return Promise.reject(new Error('NO_CLIENT_ID'));
  if (!tokenClient) {
    return loadGis().then(() => { initClient(); return requestToken(); });
  }
  return requestToken();
}
function requestToken() {
  return new Promise((res, rej) => {
    pending = { res, rej };
    tokenClient.requestAccessToken({ prompt: localStorage.getItem('gAuthed') ? '' : 'consent' });
  });
}
export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null; tokenExp = 0;
  localStorage.removeItem('gToken'); localStorage.removeItem('gAuthed');
}

async function api(url, opts = {}, retry = true) {
  const t = await ensureToken();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  if (r.status === 401 && retry) { token = null; localStorage.removeItem('gToken'); return api(url, opts, false); }
  if (!r.ok) {
    let msg = r.status + '';
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* */ }
    throw new Error('드라이브 오류: ' + msg);
  }
  return r;
}
const D = 'https://www.googleapis.com/drive/v3/';
const U = 'https://www.googleapis.com/upload/drive/v3/';
const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,capabilities/canEdit)';
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function listFiles({ q, orderBy = 'folder,name', pageToken, extra = {} }) {
  const u = new URL(D + 'files');
  const params = { q, orderBy, pageSize: 100, fields: FIELDS, supportsAllDrives: true, includeItemsFromAllDrives: true, ...extra };
  if (pageToken) params.pageToken = pageToken;
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return (await api(u)).json();
}
export async function getMeta(id) {
  return (await api(`${D}files/${id}?fields=id,name,parents,mimeType,capabilities/canEdit&supportsAllDrives=true`)).json();
}
export async function download(id) {
  const r = await api(`${D}files/${id}?alt=media&supportsAllDrives=true`);
  return new Uint8Array(await r.arrayBuffer());
}
export async function updateFile(id, bytes) {
  await api(`${U}files/${id}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: new Blob([bytes], { type: 'application/pdf' }) });
}
export async function createFile(name, parentId, bytes) {
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify({ name, mimeType: 'application/pdf', parents: parentId ? [parentId] : undefined })], { type: 'application/json' }));
  fd.append('file', new Blob([bytes], { type: 'application/pdf' }));
  return (await api(`${U}files?uploadType=multipart&supportsAllDrives=true&fields=id,name,parents,capabilities/canEdit`, { method: 'POST', body: fd })).json();
}


// ---------------- file types ----------------
const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = { doc: 'application/vnd.google-apps.document', sheet: 'application/vnd.google-apps.spreadsheet', slide: 'application/vnd.google-apps.presentation' };
const OFFICE = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': GDOC.doc,
  'application/msword': GDOC.doc,
  'application/rtf': GDOC.doc,
  'text/plain': GDOC.doc,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': GDOC.sheet,
  'application/vnd.ms-excel': GDOC.sheet,
  'text/csv': GDOC.sheet,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': GDOC.slide,
  'application/vnd.ms-powerpoint': GDOC.slide,
};
export function fileKind(f) {
  const m = f.mimeType || '', n = (f.name || '').toLowerCase();
  if (m === FOLDER) return { k: 'folder', label: '폴더' };
  if (m === 'application/pdf' || n.endsWith('.pdf')) return { k: 'pdf', label: 'PDF' };
  if (m === GDOC.doc || OFFICE[m] === GDOC.doc) return { k: 'word', label: m === GDOC.doc ? 'Google 문서' : '워드', convert: true };
  if (m === GDOC.sheet || OFFICE[m] === GDOC.sheet) return { k: 'excel', label: m === GDOC.sheet ? 'Google 시트' : '엑셀', convert: true };
  if (m === GDOC.slide || OFFICE[m] === GDOC.slide) return { k: 'ppt', label: m === GDOC.slide ? 'Google 슬라이드' : '파워포인트', convert: true };
  if (/\.hwpx?$/.test(n)) return { k: 'other', label: '한글(열 수 없음)' };
  return { k: 'other', label: '열 수 없는 형식' };
}


// ---------------- docx pre-processing for Google's converter ----------------
// Google Docs drops dotted/dashed/double table borders when importing Word files,
// so table lines vanish. Rewrite those borders as plain single lines before uploading.
let jszipP;
function loadJSZip() {
  return (jszipP ||= new Promise((res, rej) => {
    if (window.JSZip) return res(window.JSZip);
    const sc = document.createElement('script');
    sc.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
    sc.onload = () => res(window.JSZip);
    sc.onerror = () => { jszipP = null; rej(new Error('JSZip 로드 실패')); };
    document.head.append(sc);
  }));
}
const FANCY_BORDER = /w:val="(dotted|dashed|dashSmallGap|dotDash|dotDotDash|double|triple|thinThick[A-Za-z]*|thickThin[A-Za-z]*|thinThickThin[A-Za-z]*|wave|doubleWave|dashDotStroked|threeDEmboss|threeDEngrave|outset|inset)"/g;
export async function prepareDocx(blob) {
  try {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(blob);
    let changed = false;
    for (const name of Object.keys(zip.files)) {
      if (!/^word\/(document|styles|header\d*|footer\d*)\.xml$/.test(name)) continue;
      const xml = await zip.file(name).async('string');
      const out = xml.replace(/<w:(tcBorders|tblBorders)>[\s\S]*?<\/w:\1>/g, (blk) => blk.replace(FANCY_BORDER, 'w:val="single"'));
      if (out !== xml) { zip.file(name, out); changed = true; }
    }
    if (!changed) return blob;
    return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
  } catch (e) { console.warn('docx prepare skipped', e); return blob; }
}
const isDocx = (name, mime) => /\.docx$/i.test(name || '') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Export a Google Docs/Sheets/Slides file as PDF. files.export caps at 10MB, so fall back to the export link. */
async function exportPdf(id) {
  try {
    const r = await api(`${D}files/${id}/export?mimeType=application/pdf`);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    if (!/too large|exportSizeLimit|size limit/i.test(e.message)) throw e;
  }
  const meta = await (await api(`${D}files/${id}?fields=exportLinks&supportsAllDrives=true`)).json();
  const link = meta.exportLinks?.['application/pdf'];
  if (!link) throw new Error('큰 파일 내보내기 주소를 받지 못했어요');
  try {
    const r = await api(link);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    console.warn('exportLinks failed', e);
    throw new Error('변환된 PDF가 커서(10MB 초과) 드라이브가 내보내기를 거부했어요. 워드에서 PDF로 저장해서 열어주세요.');
  }
}

/** PDF bytes for a Google/Office document (Office files are converted via a temporary Google copy) */
export async function downloadAsPdf(f, onStep = () => {}) {
  let id = f.id, temp = null;
  const tempName = `[Wave PDF 변환중] ${f.name}`;
  try {
    if (OFFICE[f.mimeType]) {
      onStep('구글 문서 형식으로 바꾸는 중…');
      try {
        if (isDocx(f.name, f.mimeType)) throw new Error('docx → upload path (fix table borders)');
        const r = await api(`${D}files/${f.id}/copy?supportsAllDrives=true&fields=id,mimeType`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tempName, mimeType: OFFICE[f.mimeType] }),
        });
        const j = await r.json();
        temp = j.id;
        // the copy may come back as a plain .docx copy (not converted) → can't export; use upload conversion instead
        if (j.mimeType !== OFFICE[f.mimeType]) throw new Error('copy did not convert');
      } catch (e1) {
        if (temp) { api(`${D}files/${temp}?supportsAllDrives=true`, { method: 'DELETE' }).catch(() => {}); temp = null; }
        console.warn('copy-convert failed, trying upload-convert', e1);
        onStep('원본을 받아서 변환하는 중…');
        const bytes = await download(f.id);
        let blob = new Blob([bytes], { type: f.mimeType });
        if (isDocx(f.name, f.mimeType)) blob = await prepareDocx(blob);
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ name: tempName, mimeType: OFFICE[f.mimeType] })], { type: 'application/json' }));
        fd.append('file', blob);
        const r = await api(`${U}files?uploadType=multipart&fields=id`, { method: 'POST', body: fd });
        temp = (await r.json()).id;
      }
      id = temp;
    }
    onStep('PDF로 내보내는 중…');
    return await exportPdf(id);
  } finally {
    if (temp) api(`${D}files/${temp}?supportsAllDrives=true`, { method: 'DELETE' }).catch(() => {});
  }
}

const EXT_TYPE = {
  docx: GDOC.doc, doc: GDOC.doc, rtf: GDOC.doc, txt: GDOC.doc, odt: GDOC.doc,
  xlsx: GDOC.sheet, xls: GDOC.sheet, csv: GDOC.sheet, ods: GDOC.sheet,
  pptx: GDOC.slide, ppt: GDOC.slide, odp: GDOC.slide,
};
/** Google Docs target type for a local file name, or null */
export function convertTarget(name) { return EXT_TYPE[(name.split('.').pop() || '').toLowerCase()] || null; }

/** Convert a local Office file to PDF via a temporary Drive upload (deleted right after) */
export async function convertLocalToPdf(file, onStep = () => {}) {
  const target = convertTarget(file.name);
  if (!target) throw new Error('변환할 수 없는 형식이에요');
  let temp = null;
  try {
    onStep('드라이브에 임시로 올리는 중…');
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({ name: `[Wave PDF 변환중] ${file.name}`, mimeType: target })], { type: 'application/json' }));
    fd.append('file', isDocx(file.name, file.type) ? await prepareDocx(file) : file);
    const r = await api(`${U}files?uploadType=multipart&fields=id,mimeType`, { method: 'POST', body: fd });
    temp = (await r.json()).id;
    onStep('PDF로 내보내는 중… (큰 파일은 1분까지 걸려요)');
    return await exportPdf(temp);
  } finally {
    if (temp) api(`${D}files/${temp}?supportsAllDrives=true`, { method: 'DELETE' }).catch(() => {});
  }
}

// ---------------- name search (substring, like Windows Explorer) ----------------
let index = null, indexP = null;
const normName = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/[\s_\-()[\]{}【】「」·,]+/g, '');
async function buildIndex() {
  if (index && Date.now() - index.t < 10 * 60 * 1000) return index.files;
  if (!indexP) {
    indexP = (async () => {
      const files = [];
      let pageToken = null;
      for (let i = 0; i < 25; i++) {
        const r = await listFiles({ q: `trashed=false and mimeType != '${FOLDER}'`, orderBy: 'modifiedTime desc', pageToken, extra: { pageSize: 1000 } });
        files.push(...(r.files || []));
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
      index = { t: Date.now(), files };
      return files;
    })().finally(() => { indexP = null; });
  }
  return indexP;
}
export async function searchFiles(query) {
  const terms = query.split(/\s+/).map(normName).filter(Boolean);
  if (!terms.length) return [];
  const longest = query.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  const [all, full] = await Promise.all([
    buildIndex(),
    listFiles({ q: `fullText contains '${esc(longest)}' and trashed=false and mimeType != '${FOLDER}'`, orderBy: 'modifiedTime desc', extra: { pageSize: 30 } }).then((r) => r.files || []).catch(() => []),
  ]);
  const byName = all.filter((f) => { const n = normName(f.name); return terms.every((t) => n.includes(t)); });
  const seen = new Set(byName.map((f) => f.id));
  const byContent = full.filter((f) => !seen.has(f.id)).map((f) => ({ ...f, _content: true }));
  const rank = (f) => ({ pdf: 0, word: 1, excel: 1, ppt: 1 }[fileKind(f).k] ?? 2);
  byName.sort((a, b) => rank(a) - rank(b) || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  return [...byName.slice(0, 200), ...byContent];
}


// ---------------- sorting ----------------
const SORTS = [
  ['name', '이름 (가→하)', 'folder,name_natural'],
  ['name_desc', '이름 (하→가)', 'folder,name_natural desc'],
  ['modified', '수정한 날짜 (최신순)', 'folder,modifiedTime desc'],
  ['modified_asc', '수정한 날짜 (오래된순)', 'folder,modifiedTime'],
  ['size', '크기 (큰 순)', 'folder,quotaBytesUsed desc'],
  ['type', '유형', 'folder,name_natural'],
];
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const KIND_ORDER = { folder: 0, pdf: 1, word: 2, excel: 3, ppt: 4, other: 5 };
function sortFiles(arr, key) {
  const t = (f) => f.modifiedTime || '';
  const cmp = {
    name: (a, b) => collator.compare(a.name, b.name),
    name_desc: (a, b) => collator.compare(b.name, a.name),
    modified: (a, b) => t(b).localeCompare(t(a)),
    modified_asc: (a, b) => t(a).localeCompare(t(b)),
    size: (a, b) => (+b.size || 0) - (+a.size || 0),
    type: (a, b) => KIND_ORDER[fileKind(a).k] - KIND_ORDER[fileKind(b).k] || collator.compare(a.name, b.name),
  }[key] || (() => 0);
  return [...arr].sort((a, b) => (fileKind(a).k === 'folder' ? 0 : 1) - (fileKind(b).k === 'folder' ? 0 : 1) || cmp(a, b));
}

/** Drive browser. mode: 'file' (pick a PDF) | 'folder' (pick a folder). Returns {id,name,parents,canEdit} or null */
export function browse({ mode = 'file', title } = {}) {
  return new Promise((resolve) => {
    let closeFn;
    const stack = [{ id: 'root', name: '내 드라이브' }];
    let tab = 'mine', query = '', nextToken = null, loaded = [];
    let sortKey = localStorage.getItem('driveSort') || 'name';
    const sortSel = el('select', { class: 'drv-sort', title: '정렬 기준', onchange: (e) => { sortKey = e.target.value; localStorage.setItem('driveSort', sortKey); load(); } },
      SORTS.map(([v, l]) => el('option', { value: v, selected: v === sortKey }, l)));
    const list = el('div', { class: 'drv-list' });
    const crumbs = el('div', { class: 'drv-crumbs' });
    const more = el('button', { class: 'btn small drv-more', onclick: () => load(true) }, '더 보기');
    const search = el('input', { class: 'input', type: 'search', placeholder: mode === 'file' ? '파일 이름 검색 (띄어쓰기로 여러 단어)' : '폴더 이름 검색' });
    const tabs = el('div', { class: 'seg' });
    const tabDefs = mode === 'file' ? [['mine', '내 드라이브'], ['recent', '최근'], ['shared', '공유됨']] : [['mine', '내 드라이브'], ['shared', '공유됨']];
    for (const [k, label] of tabDefs) {
      tabs.append(el('button', { class: `seg-btn ${k === tab ? 'on' : ''}`, 'data-k': k, onclick: () => { tab = k; query = ''; search.value = ''; tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); if (k === 'mine') stack.splice(1); load(); } }, label));
    }
    let st;
    search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { query = search.value.trim(); load(); }, 350); });

    function renderCrumbs() {
      crumbs.replaceChildren();
      if (tab !== 'mine' || query) { crumbs.hidden = true; return; }
      crumbs.hidden = false;
      stack.forEach((f, i) => {
        if (i) crumbs.append(el('span', { class: 'sep' }, '›'));
        crumbs.append(el('button', { class: 'crumb', onclick: () => { stack.splice(i + 1); load(); } }, f.name));
      });
    }
    async function load(append = false) {
      renderCrumbs();
      if (!append) { list.replaceChildren(el('div', { class: 'muted pad' }, '불러오는 중…')); nextToken = null; }
      const pdfQ = mode === 'file' ? "mimeType != 'application/vnd.google-apps.shortcut'" : "mimeType='application/vnd.google-apps.folder'";
      let q, orderBy = (SORTS.find((x) => x[0] === sortKey) || SORTS[0])[2];
      if (query && mode === 'file') {
        if (!append) list.replaceChildren(el('div', { class: 'muted pad' }, '드라이브에서 찾는 중… (처음 한 번은 목록을 불러와서 조금 걸려요)'));
        try {
          const found = await searchFiles(query);
          const res = [...sortFiles(found.filter((f) => !f._content), sortKey), ...found.filter((f) => f._content)];
          list.replaceChildren();
          let shownContent = false;
          for (const f of res) {
            if (f._content && !shownContent) { list.append(el('div', { class: 'drv-sep' }, '내용에 검색어가 들어 있는 파일')); shownContent = true; }
            list.append(item(f));
          }
          if (!res.length) list.append(el('div', { class: 'muted pad' }, '찾는 파일이 없어요'));
          more.hidden = true;
        } catch (e) { list.replaceChildren(el('div', { class: 'muted pad' }, e.message === 'CANCELLED' ? '로그인이 취소됐어요' : e.message)); }
        return;
      }
      if (query) { q = `name contains '${esc(query)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`; orderBy = 'modifiedTime desc'; }
      else if (tab === 'recent') { q = `mimeType != '${FOLDER}' and trashed=false`; orderBy = 'viewedByMeTime desc'; }
      else if (tab === 'shared' && stack.length === 1) { q = `sharedWithMe and ${pdfQ} and trashed=false`; }
      else q = `'${stack[stack.length - 1].id}' in parents and ${pdfQ} and trashed=false`;
      try {
        const r = await listFiles({ q, orderBy, pageToken: append ? nextToken : null });
        loaded = append ? [...loaded, ...(r.files || [])] : (r.files || []);
        nextToken = r.nextPageToken || null;
        list.replaceChildren(...sortFiles(loaded, sortKey).map(item));
        if (!list.children.length) list.append(el('div', { class: 'muted pad' }, '항목이 없어요'));
        more.hidden = !nextToken;
      } catch (e) {
        list.replaceChildren(el('div', { class: 'muted pad' }, e.message === 'CANCELLED' ? '로그인이 취소됐어요' : e.message));
      }
    }
    function item(f) {
      const kind = fileKind(f);
      const folder = kind.k === 'folder';
      const openable = folder || kind.k === 'pdf' || kind.convert;
      const icons = { folder: 'folder', pdf: 'file', word: 'file', excel: 'table', ppt: 'file', other: 'file' };
      return el('button', { class: `drv-item ${openable ? '' : 'disabled'}`, onclick: async () => {
        if (folder) { if (tab !== 'mine') { tab = 'mine'; stack.splice(1); tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.k === 'mine')); } query = ''; search.value = ''; stack.push({ id: f.id, name: f.name }); load(); return; }
        if (mode !== 'file') return;
        if (!openable) { toast('PDF·워드·엑셀·파워포인트·구글 문서만 열 수 있어요'); return; }
        closeFn({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType, convert: !!kind.convert, canEdit: f.capabilities?.canEdit !== false });
      } },
      el('span', { class: `drv-ico ${kind.k}`, html: icon(icons[kind.k]) }),
      el('span', { class: 'drv-name' }, f.name),
      el('span', { class: 'drv-meta' }, folder ? '' : `${kind.k === 'pdf' ? '' : kind.label + ' · '}${fmtDate(f.modifiedTime)}${f.size ? ' · ' + fmtSize(+f.size) : ''}`));
    }
    const body = el('div', { class: 'drv' }, tabs, search, el('div', { class: 'drv-bar' }, crumbs, sortSel), list, more);
    const buttons = [{ label: '취소', value: null }];
    if (mode === 'folder') buttons.push({ label: '이 폴더에 저장', primary: true, value: () => { const f = stack[stack.length - 1]; return { id: f.id, name: f.name }; } });
    buttons.push({ label: '로그아웃', value: 'logout' });
    modal({ title: title || (mode === 'file' ? '구글 드라이브에서 열기' : '저장할 폴더 선택'), body, buttons, wide: true, className: 'drv-modal', onOpen: (c) => (closeFn = c) })
      .then((v) => { if (v === 'logout') { signOut(); toast('로그아웃했어요'); resolve(null); } else resolve(v); });
    load();
  });
}

/** Guide shown when no Client ID configured */
export async function setupGuide() {
  const input = el('input', { class: 'input', placeholder: '예: 1234-abcd.apps.googleusercontent.com' });
  input.value = getClientId();
  const origin = location.origin;
  const body = el('div', { class: 'guide' },
    el('p', {}, '구글 드라이브를 쓰려면 한 번만 OAuth 클라이언트 ID를 등록하면 돼요.'),
    el('ol', {},
      el('li', {}, 'Google Cloud Console에서 프로젝트 생성 → "Google Drive API" 사용 설정'),
      el('li', {}, 'OAuth 동의 화면: 외부 / 테스트 사용자에 본인 Gmail 추가'),
      el('li', {}, '사용자 인증 정보 → OAuth 클라이언트 ID → 웹 애플리케이션'),
      el('li', {}, '승인된 JavaScript 원본에 ', el('code', {}, origin), ' 추가'),
      el('li', {}, '발급된 클라이언트 ID를 아래에 붙여넣기')),
    input);
  const v = await modal({ title: '구글 드라이브 연결 설정', body, wide: true, buttons: [{ label: '취소', value: null }, { label: '저장', primary: true, value: () => input.value }] });
  if (v != null && v.trim()) { setClientId(v); toast('저장했어요. 다시 시도해 주세요'); return true; }
  return false;
}

export async function withBusy(msg, fn) {
  const b = busy(msg);
  try { return await fn(); } finally { b.close(); }
}
