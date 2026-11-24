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

  // laws, rules, agreements: 편·장·절·조 structure decides the outline, not font size
  // (running headers repeat word for word, so only exact repeats are dropped here)
  const exact = new Map();
  for (const l of lines) exact.set(l.text, (exact.get(l.text) || new Set()).add(l.page));
  const legal = legalOutline(lines.filter((l) => (exact.get(l.text)?.size || 0) < repeatLimit));
  if (legal) return legal;

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
  // body-size numbered lines that are everywhere are list items (1. 가. (1)…), not headings
  const plainNum = cands.filter((c) => c.size < body * 1.18);
  if (plainNum.length > Math.max(12, n * 2.5)) {
    const big = cands.filter((c) => c.size >= body * 1.18);
    // keep only numbering styles that stay rare (e.g. "1." chapters), drop the frequent ones
    const style = (t) => (/^\d+\.\d/.test(t) ? 'dd' : /^\d/.test(t) ? 'd' : /^[가-하]/.test(t) ? 'k' : /^\(/.test(t) ? 'p' : /^[①-⑳]/.test(t) ? 'c' : 'o');
    const per = new Map();
    for (const c of plainNum) per.set(style(c.text), (per.get(style(c.text)) || 0) + 1);
    cands = [...big, ...plainNum.filter((c) => per.get(style(c.text)) <= Math.max(8, n * 0.8))].sort((a, b) => a.page - b.page || b.y - a.y);
  }
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

// ---------- legal documents (법령·규약·약정서) ----------
const sp = (t) => t.replace(/\s+/g, ' ').trim();
const ART = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?=\s|[\(（【\[「<]|$)/;
const ART_TITLE = /^\s*([\(（【\[「<])\s*([^\)）】\]」>]{1,40}?)\s*[\)）】\]」>]/;
const PART = /^제\s*(\d+)\s*(편|장|절|관)(?=\s|$|[\(（【\[·])/;
const ANNEX = /^[\[［<〈【(]?\s*(별\s*표|별\s*첨|별\s*지|부\s*표|서\s*식|첨\s*부)\s*(제?\s*\d+\s*호?)?/;
const SUPP = /^부\s*칙(\s|$|[<〈(（])/;
const TOC_LINE = /(\.{3,}|…{2,}|·{3,}|\s{2,})\s*\d{1,3}\s*$/;

// "제3조 및 제5조에 따른 …", "제2조에 따라 …": a sentence that happens to start a line, not an article heading
const REF = /^\s*(및|또는|부터|내지|ㆍ|·|,|，|에|의|를|은|는|이|가|와|과|제\s*\d+\s*(항|호|조))/;
const isArt = (t) => { const m = t.match(ART); if (!m) return false; const rest = t.slice(m[0].length); return !REF.test(rest) && !/^\S{0,12}(따른|따라|의하여|의한)/.test(rest.trim()); };

function legalOutline(lines) {
  const arts = lines.filter((l) => isArt(sp(l.text)) && !TOC_LINE.test(l.text));
  if (arts.length < 3) return null;
  // most articles carry a title in brackets → then a line without one is just a sentence starting with "제3조 …"
  const titled = arts.filter((l) => ART_TITLE.test(l.text.replace(ART, ''))).length;
  const needTitle = titled >= arts.length * 0.6;
  const items = [];
  for (const l of lines) {
    const t = sp(l.text);
    if (TOC_LINE.test(t)) continue;
    let m;
    if ((m = t.match(ART)) && isArt(t)) {
      const rest = t.slice(m[0].length);
      const tm = rest.match(ART_TITLE);
      if (needTitle && !tm) continue;
      const num = `제${m[1]}조${m[2] ? '의' + m[2] : ''}`;
      const title = tm ? `${num}(${sp(tm[2])})` : `${num} ${sp(rest).slice(0, 24)}`.trim();
      items.push({ kind: '조', title, l });
    } else if ((m = t.match(PART))) {
      if (t.length > 50) continue;
      items.push({ kind: m[2], title: sp(`제${m[1]}${m[2]} ${t.slice(m[0].length)}`).slice(0, 60), l });
    } else if (SUPP.test(t) && t.length <= 40) {
      items.push({ kind: '부칙', title: sp(t).replace(/^부\s*칙/, '부칙'), l });
    } else if (ANNEX.test(t) && t.length <= 60 && !/에\s*(따른|의한|따라)/.test(t)) {
      items.push({ kind: '별표', title: sp(t).slice(0, 60), l });
    }
  }
  // depth by which kinds are present: 편 > 장 > 절·관 > 조; 부칙·별표 sit at the top
  const order = ['편', '장', '절', '관', '조'].filter((k) => items.some((i) => i.kind === k));
  const rank = (k) => (k === '부칙' || k === '별표' ? 0 : Math.min(3, order.indexOf(k)));
  // articles inside 부칙 hang under it
  let inSupp = false;
  const out = items.map((i) => {
    if (i.kind === '부칙' || i.kind === '별표') inSupp = i.kind === '부칙';
    else if (i.kind !== '조') inSupp = false;
    const level = i.kind === '조' && inSupp ? 1 : rank(i.kind);
    return { title: i.title, page: i.l.page, top: Math.round(i.l.y + i.l.size * 1.1), level };
  });
  return normalizeLevels(out);
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
