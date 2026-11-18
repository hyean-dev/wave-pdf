// Bookmarks (PDF outline): read, edit, auto-generate. Model: flat list [{title, page (0-based), top|null, level}]
import { S, emit } from './state.js';

/** Read the PDF's own outline into the flat model */
export async function readOutline(doc) {
  const out = [];
  let raw;
  try { raw = (await doc.getOutline()) || []; } catch { raw = []; }
  async function resolve(dest) {
    try {
      let arr = dest;
      if (typeof dest === 'string') arr = await doc.getDestination(dest);
      if (!Array.isArray(arr)) return null;
      const ref = arr[0];
      const page = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
      const top = arr[1]?.name === 'XYZ' && typeof arr[3] === 'number' ? arr[3] : null;
      return { page, top };
    } catch { return null; }
  }
  async function walk(items, level) {
    for (const it of items) {
      const r = it.dest ? await resolve(it.dest) : null;
      if (r) out.push({ title: (it.title || '').trim() || `${r.page + 1}쪽`, page: r.page, top: r.top, level });
      if (it.items?.length) await walk(it.items, r ? level + 1 : level);
    }
  }
  await walk(raw, 0);
  return out;
}

export function markOutlineChanged() {
  S.outlineDirty = true;
  S.dirty = true;
  emit('changed', { outline: true });
  emit('outline');
}

/** Normalize levels so each item is at most one deeper than the previous */
export function normalizeLevels(list) {
  let prev = -1;
  for (const it of list) { it.level = Math.max(0, Math.min(it.level, prev + 1)); prev = it.level; }
  return list;
}

/** Sort by position in the document (page, then top-down) */
export function sortOutline(list) {
  return list.sort((a, b) => a.page - b.page || (b.top ?? 1e9) - (a.top ?? 1e9));
}

// ---------------- auto-generation ----------------
const NUMBERED = /^(제\s*\d+\s*[장절편부관조]|[IVX]+\s*[.)]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]\s*[.)]?|\d{1,2}(\.\d{1,2}){0,3}\s*[.)]?\s|[가나다라마바사아자차카타파하]\s*[.)]\s|[①-⑳]|\(\d{1,2}\)\s|\d{1,2}\s+[A-Za-z가-힣])/;
const JUNK = /^[\s\d\-–—.·•|/()[\]]+$/;

/** Find headings by font size / numbering. onProgress(done,total) */
export async function autoOutline(doc, onProgress = () => {}) {
  const lines = [];
  const sizeChars = new Map();
  const n = doc.numPages;
  for (let p = 0; p < n; p++) {
    const tc = await (await doc.getPage(p + 1)).getTextContent();
    let cur = null;
    const pageLines = [];
    for (const it of tc.items) {
      const s = it.str;
      if (!s || !s.trim()) { if (it.hasEOL && cur) { pageLines.push(cur); cur = null; } continue; }
      const t = it.transform;
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // skip rotated text
      const size = Math.round(Math.abs(t[3]) * 2) / 2;
      const y = t[5];
      if (cur && Math.abs(cur.y - y) < Math.max(cur.size, size) * 0.5) {
        const gap = t[4] - cur.endX;
        cur.text += (gap > size * 0.25 ? ' ' : '') + s;
        if (gap > cur.maxGap) cur.maxGap = gap;
        cur.size = Math.max(cur.size, size);
        cur.endX = t[4] + it.width;
      } else {
        if (cur) pageLines.push(cur);
        cur = { page: p, y, size, text: s, endX: t[4] + it.width, maxGap: 0 };
      }
      sizeChars.set(size, (sizeChars.get(size) || 0) + s.length);
      if (it.hasEOL) { pageLines.push(cur); cur = null; }
    }
    if (cur) pageLines.push(cur);
    for (const l of pageLines) { l.text = l.text.replace(/\s+/g, ' ').trim(); if (l.text) lines.push(l); }
    if (p % 5 === 4) onProgress(p + 1, n);
  }
  onProgress(n, n);
  if (!lines.length) return [];

  // body text size = size with the most characters
  let body = 10, best = -1;
  for (const [s, c] of sizeChars) if (c > best) { best = c; body = s; }

  // repeated lines (running headers/footers) appear on many pages
  const freq = new Map();
  for (const l of lines) { const k = l.text.replace(/\d+/g, '#'); freq.set(k, (freq.get(k) || new Set()).add(l.page)); }
  const repeatLimit = Math.max(3, n * 0.3);

  // exact duplicates across pages (table headers etc.)
  const dup = new Map();
  for (const l of lines) dup.set(l.text, (dup.get(l.text) || new Set()).add(l.page));

  let cands = lines.filter((l) => {
    const len = l.text.length;
    if (len < 2 || len > 80 || JUNK.test(l.text)) return false;
    if ((freq.get(l.text.replace(/\d+/g, '#'))?.size || 0) >= repeatLimit) return false;
    if ((dup.get(l.text)?.size || 0) >= 2) return false;
    const tabular = l.maxGap > l.size * 1.5; // columns of a table row
    if (l.size >= body * 1.18) return !tabular || l.size >= body * 1.5;
    return !tabular && l.size >= body * 0.98 && len <= 45 && NUMBERED.test(l.text);
  });
  // sizes used on a single page only (cover page) are not section headings
  if (n >= 5) {
    const pagesBySize = new Map();
    for (const c of cands) pagesBySize.set(c.size, (pagesBySize.get(c.size) || new Set()).add(c.page));
    const multi = cands.filter((c) => (pagesBySize.get(c.size)?.size || 0) >= 2);
    if (multi.length >= 3) cands = multi;
  }

  // join multi-line titles (same page, same size, directly below)
  const joined = [];
  for (const c of cands) {
    const last = joined[joined.length - 1];
    if (last && last.page === c.page && Math.abs(last.size - c.size) < 0.6 && last.y - c.y > 0 && last.y - c.y < c.size * 1.7 && (last.text + c.text).length <= 90 && !NUMBERED.test(c.text)) {
      last.text += ' ' + c.text; last.y2 = c.y;
    } else joined.push({ ...c });
  }
  cands = joined;
  if (!cands.length) return [];

  // levels: cluster sizes among candidates (bigger = higher)
  const sizes = [...new Set(cands.map((c) => c.size))].sort((a, b) => b - a);
  const clusters = [];
  for (const s of sizes) { const c = clusters[clusters.length - 1]; if (c && c[c.length - 1] - s < 0.8) c.push(s); else clusters.push([s]); }
  const levelOf = (size) => Math.min(2, clusters.findIndex((c) => c.includes(size)));
  // too many headings → keep only the two largest clusters
  if (cands.length > Math.max(60, n * 4) && clusters.length > 2) cands = cands.filter((c) => levelOf(c.size) < 2);

  return normalizeLevels(cands.map((c) => {
    let level = levelOf(c.size);
    const m = c.text.match(/^(\d{1,2}(?:\.\d{1,2}){1,3})/); // 1.2 / 1.2.3 → deeper
    if (m && clusters.length < 2) level = Math.min(2, m[1].split('.').length - 1);
    return { title: c.text.slice(0, 120), page: c.page, top: Math.round(c.y + c.size * 1.1), level };
  }));
}

/** One bookmark per page (fallback) */
export async function pageOutline(doc) {
  const out = [];
  for (let p = 0; p < doc.numPages; p++) {
    let first = '';
    try {
      const tc = await (await doc.getPage(p + 1)).getTextContent();
      first = tc.items.map((i) => i.str).join('').replace(/\s+/g, ' ').trim().slice(0, 40);
    } catch { /* */ }
    out.push({ title: `${p + 1}쪽${first ? ' · ' + first : ''}`, page: p, top: null, level: 0 });
  }
  return out;
}
