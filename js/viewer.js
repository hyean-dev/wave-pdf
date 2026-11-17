import * as pdfjsLib from '../vendor/pdfjs-5.7.284/pdf.min.mjs';
import { S, emit } from './state.js';
import { withTimeout } from './util.js';

globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs-5.7.284/pdf.worker.min.mjs', import.meta.url).href;
const V = await import('../vendor/pdfjs-5.7.284/pdf_viewer.mjs');

const BASE = new URL('../vendor/pdfjs-5.7.284/', import.meta.url).href;
export const DOC_OPTS = {
  cMapUrl: BASE + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: BASE + 'standard_fonts/',
  wasmUrl: BASE + 'wasm/',
  iccUrl: BASE + 'iccs/',
  isEvalSupported: false,
};
export { pdfjsLib };

export let eventBus, linkService, findController, viewer, container;

export function initViewer(containerEl) {
  container = containerEl;
  eventBus = new V.EventBus();
  linkService = new V.PDFLinkService({ eventBus, externalLinkTarget: 2 });
  findController = new V.PDFFindController({ eventBus, linkService });
  viewer = new V.PDFViewer({
    container,
    viewer: container.querySelector('.pdfViewer'),
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    removePageBorders: true,
    imageResourcesPath: BASE + 'images/',
  });
  linkService.setViewer(viewer);
  eventBus.on('pagechanging', ({ pageNumber }) => emit('page', pageNumber));
  eventBus.on('scalechanging', ({ scale }) => emit('scale', scale));
  setupGestures();
}

export async function openDocument(bytes, { keepView = false } = {}) {
  const prev = keepView && viewer.pdfDocument
    ? { page: viewer.currentPageNumber, scale: viewer.currentScaleValue }
    : null;
  const task = pdfjsLib.getDocument({ ...DOC_OPTS, data: bytes.slice() });
  const doc = await withTimeout(task.promise, 45000, 'PDF 엔진이 응답하지 않아요 (네트워크 확인 후 다시 시도)');
  const old = S.pdfDoc;
  const inited = new Promise((r) => eventBus.on('pagesinit', r, { once: true }));
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  S.pdfDoc = doc;
  doc.annotationStorage.onSetModified = () => { S.dirty = true; emit('changed', { forms: true }); };
  if (old) old.destroy().catch(() => {});
  await withTimeout(inited, 20000, '화면 준비가 끝나지 않았어요');
  if (prev) {
    viewer.currentScaleValue = prev.scale;
    viewer.currentPageNumber = Math.min(prev.page, doc.numPages);
  } else {
    viewer.currentScaleValue = window.innerWidth < 900 ? 'page-width' : 'auto';
  }
  emit('docloaded', doc);
  return doc;
}

export function closeDocument() {
  viewer.setDocument(null);
  linkService.setDocument(null, null);
  if (S.pdfDoc) S.pdfDoc.destroy().catch(() => {});
  S.pdfDoc = null;
}

/** pdf.js form edits → [{name,type,exportValue,value}] */
export async function collectFormValues() {
  const doc = S.pdfDoc;
  if (!doc) return [];
  const map = doc.annotationStorage.serializable?.map;
  if (!map || !map.size) return [];
  const fo = await doc.getFieldObjects();
  if (!fo) return [];
  const byId = {};
  for (const [name, arr] of Object.entries(fo)) for (const o of arr) if (o.id) byId[o.id] = { name, type: o.type, exportValue: o.exportValues };
  const out = [];
  for (const [id, v] of map) {
    const info = byId[id];
    if (!info || !v || !('value' in v)) continue;
    if (info.type === 'radiobutton' && v.value !== true) continue;
    out.push({ ...info, value: v.value });
  }
  return out;
}

// ---------- zoom ----------
export function zoomBy(factor, origin) {
  if (!viewer.pdfDocument) return;
  viewer.updateScale({ scaleFactor: factor, origin, drawingDelay: origin ? 250 : -1 });
}
export function setScaleValue(v) { if (viewer.pdfDocument) viewer.currentScaleValue = v; }

function setScaleAround(target, origin) {
  target = Math.max(0.25, Math.min(6, target));
  const cur = viewer.currentScale;
  if (Math.abs(target - cur) < 0.01) return;
  viewer.updateScale({ scaleFactor: target / cur, origin, drawingDelay: 250 });
}

function setupGestures() {
  let pinch = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && viewer.pdfDocument) {
      const [a, b] = e.touches;
      pinch = { d0: dist(a, b), s0: viewer.currentScale, m: mid(a, b) };
      emit('pinchstart');
    }
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const [a, b] = e.touches;
    const m = mid(a, b);
    setScaleAround(pinch.s0 * (dist(a, b) / pinch.d0), m);
    container.scrollLeft -= m[0] - pinch.m[0];
    container.scrollTop -= m[1] - pinch.m[1];
    pinch.m = m;
  }, { passive: false });
  const end = (e) => { if (e.touches.length < 2) pinch = null; };
  container.addEventListener('touchend', end);
  container.addEventListener('touchcancel', end);

  let wheelTarget = null, wheelTimer;
  container.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !viewer.pdfDocument) return;
    e.preventDefault();
    wheelTarget = (wheelTarget ?? viewer.currentScale) * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025));
    wheelTarget = Math.max(0.25, Math.min(6, wheelTarget));
    setScaleAround(wheelTarget, [e.clientX, e.clientY]);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => (wheelTarget = null), 300);
  }, { passive: false });
}

export const isPinching = () => false;

// ---------- search ----------
export function find(query, { again = false, prev = false } = {}) {
  eventBus.dispatch('find', {
    source: null, type: again ? 'again' : '', query,
    caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: prev, matchDiacritics: false,
  });
}
export function clearFind() { eventBus.dispatch('findbarclose', { source: null }); }

export async function getOutline() {
  if (!S.pdfDoc) return [];
  return (await S.pdfDoc.getOutline()) || [];
}
export function goToDest(dest) { linkService.goToDestination(dest); }
export function goToPage(n) { viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, n)); }
export function scrollToPoint(pageIdx, x, y) {
  viewer.scrollPageIntoView({ pageNumber: pageIdx + 1, destArray: [null, { name: 'XYZ' }, x, y, null], allowNegativeOffset: true });
}
