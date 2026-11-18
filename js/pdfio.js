// PDF read/write with pdf-lib + qpdf (encryption)
import { uid } from './util.js';

const L = () => window.PDFLib;

// ---------------- qpdf (wasm) ----------------
let qpdfFactoryP;
function qpdfFactory() {
  if (!qpdfFactoryP) {
    qpdfFactoryP = new Promise((res, rej) => {
      if (window.QpdfModule) return res(window.QpdfModule);
      const s = document.createElement('script');
      s.src = new URL('../vendor/qpdf.js', import.meta.url).href;
      s.onload = () => res(window.QpdfModule || window.Module);
      s.onerror = () => { qpdfFactoryP = null; rej(new Error('qpdf 로드 실패')); };
      document.head.append(s);
    });
  }
  return qpdfFactoryP;
}
export async function qpdf(bytes, args) {
  const factory = await qpdfFactory();
  const log = [];
  // the wasm module binds console.* at instantiation → capture output by swapping them in
  const oe = console.error, ol = console.log, ow = console.warn;
  console.error = console.log = console.warn = (...a) => log.push(a.join(' '));
  let rc, q;
  try {
    q = await factory({
      locateFile: () => new URL('../vendor/qpdf.wasm', import.meta.url).href,
      print: (t) => log.push(t), printErr: (t) => log.push(t),
    });
    q.FS.writeFile('/in.pdf', bytes);
    try { rc = q.callMain([...args, '/in.pdf', '/out.pdf']); } catch (e) { rc = e?.status ?? 2; }
  } finally { console.error = oe; console.log = ol; console.warn = ow; }
  if (rc !== 0 && rc !== 3) {
    const err = new Error(log.join('\n') || 'qpdf 오류');
    err.log = log.join('\n');
    throw err;
  }
  return q.FS.readFile('/out.pdf');
}

// ---------------- helpers ----------------
const N = (s) => L().PDFName.of(s);
function lk(ctx, v) { return v instanceof L().PDFRef ? ctx.lookup(v) : v; }
function num(ctx, v) { v = lk(ctx, v); return v && typeof v.asNumber === 'function' ? v.asNumber() : undefined; }
function nums(ctx, v) {
  v = lk(ctx, v);
  if (!(v instanceof L().PDFArray)) return null;
  return v.asArray().map((x) => num(ctx, x) ?? 0);
}
function txt(ctx, v) {
  v = lk(ctx, v);
  const { PDFString, PDFHexString } = L();
  if (v instanceof PDFString || v instanceof PDFHexString) { try { return v.decodeText(); } catch { return ''; } }
  return '';
}
function nameOf(v) { return v instanceof L().PDFName ? v.asString().replace(/^\//, '') : ''; }
function normRect(r) { return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]; }
function colorFrom(c) {
  if (!c || !c.length) return null;
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 3) return c.slice();
  if (c.length === 4) { const [C, M, Y, K] = c; return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)]; }
  return null;
}

const TYPE_MAP = {
  Highlight: 'highlight', Underline: 'underline', Squiggly: 'underline', StrikeOut: 'strike',
  Ink: 'ink', FreeText: 'freetext', Text: 'note', Square: 'square', Circle: 'circle', Line: 'arrow',
};

function parseAnnot(ctx, d, pageRot) {
  const type = TYPE_MAP[nameOf(d.get(N('Subtype')))];
  if (!type) return null;
  const F = num(ctx, d.get(N('F'))) || 0;
  if (F & 2) return null; // hidden
  const rect = normRect(nums(ctx, d.get(N('Rect'))) || [0, 0, 0, 0]);
  const a = {
    id: txt(ctx, d.get(N('NM'))) || uid(),
    type,
    color: colorFrom(nums(ctx, d.get(N('C')))),
    opacity: num(ctx, d.get(N('CA'))) ?? 1,
    text: txt(ctx, d.get(N('Contents'))),
    author: txt(ctx, d.get(N('T'))),
    modified: Date.now(),
  };
  const quote = txt(ctx, d.get(N('WaveQuote')));
  if (quote) a.quote = quote;
  const bs = lk(ctx, d.get(N('BS')));
  let w = bs instanceof L().PDFDict ? num(ctx, bs.get(N('W'))) : undefined;
  if (w == null) { const b = nums(ctx, d.get(N('Border'))); if (b && b.length >= 3) w = b[2]; }
  if (!w) w = 1;
  switch (type) {
    case 'highlight': case 'underline': case 'strike': {
      const q = nums(ctx, d.get(N('QuadPoints')));
      a.rects = [];
      if (q && q.length >= 8) {
        for (let i = 0; i + 7 < q.length; i += 8) {
          const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]], ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
          a.rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
      } else a.rects = [rect];
      a.color ||= type === 'highlight' ? [1, 0.945, 0.463] : [0.898, 0.224, 0.208];
      break;
    }
    case 'ink': {
      const il = lk(ctx, d.get(N('InkList')));
      a.paths = il instanceof L().PDFArray ? il.asArray().map((p) => nums(ctx, p) || []).filter((p) => p.length >= 2) : [];
      if (!a.paths.length) return null;
      a.width = w;
      a.color ||= [0, 0, 0];
      a.marker = !!lk(ctx, d.get(N('WaveMarker'))) || a.opacity < 0.7;
      if (a.marker && !lk(ctx, d.get(N('WaveMarker')))) a.opacity = Math.max(a.opacity, 0.5);
      break;
    }
    case 'freetext': {
      const da = txt(ctx, d.get(N('DA')));
      const fs = da.match(/([\d.]+)\s+Tf/);
      a.fontSize = fs ? parseFloat(fs[1]) || 12 : 12;
      const c3 = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
      const c1 = da.match(/([\d.]+)\s+g(\s|$)/);
      a.color = c3 ? [+c3[1], +c3[2], +c3[3]] : c1 ? [+c1[1], +c1[1], +c1[1]] : [0, 0, 0];
      a.rect = rect;
      if (lk(ctx, d.get(N('WaveBold'))) || /bold|font-weight:\s*[6-9]00/i.test(txt(ctx, d.get(N('DS'))) + txt(ctx, d.get(N('RC'))))) a.bold = true;
      const wr = num(ctx, d.get(N('WaveRot')));
      a.rot = wr ?? pageRot;
      a.opacity = 1;
      break;
    }
    case 'note':
      a.rect = rect;
      a.color ||= [1, 0.835, 0.31];
      break;
    case 'square': case 'circle':
      a.rect = rect; a.width = w; a.color ||= [0.898, 0.224, 0.208];
      break;
    case 'arrow': {
      const l = nums(ctx, d.get(N('L')));
      if (!l || l.length < 4) return null;
      a.line = l.slice(0, 4);
      const le = lk(ctx, d.get(N('LE')));
      a.head = le instanceof L().PDFArray && le.size() > 1 && nameOf(lk(ctx, le.get(1))) !== 'None';
      a.width = w; a.color ||= [0.898, 0.224, 0.208];
      break;
    }
  }
  return a;
}

function extractAnnots(doc) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const out = pages.map(() => []);
  let changed = false;
  pages.forEach((page, i) => {
    const arr = page.node.Annots();
    if (!arr) return;
    const entries = arr.asArray();
    const removed = new Set(), popups = new Set();
    for (const e of entries) {
      const d = lk(ctx, e);
      if (!(d instanceof L().PDFDict)) continue;
      let a = null;
      try { a = parseAnnot(ctx, d, page.getRotation().angle); } catch (err) { console.warn(err); }
      if (!a) continue;
      out[i].push(a);
      removed.add(e);
      const pp = d.get(N('Popup'));
      if (pp) popups.add(pp);
    }
    if (!removed.size) return;
    changed = true;
    const keep = entries.filter((e) => {
      if (removed.has(e) || popups.has(e)) return false;
      const d = lk(ctx, e);
      if (d instanceof L().PDFDict && nameOf(d.get(N('Subtype'))) === 'Popup') {
        const par = d.get(N('Parent'));
        if (par && removed.has(par)) return false;
      }
      return true;
    });
    page.node.set(N('Annots'), ctx.obj(keep));
    for (const r of [...removed, ...popups]) if (r instanceof L().PDFRef) ctx.delete(r);
  });
  return { annots: out, changed };
}

const isEncErr = (e) => /encrypt/i.test(e?.message || '');
const isPwErr = (e) => /password/i.test(e?.log || e?.message || '');

/** Open bytes: decrypt if needed, strip editable annotations → {base, annots, password, encrypted} */
export async function prepare(bytes, askPassword) {
  const { PDFDocument } = L();
  let password = null, data = bytes, encrypted = false, doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (isEncErr(e)) {
      encrypted = true;
      try {
        data = await qpdf(bytes, ['--decrypt']);
      } catch (e2) {
        if (!isPwErr(e2)) throw e2;
        let msg = '암호로 보호된 PDF예요. 암호를 입력해 주세요.';
        for (;;) {
          const pw = await askPassword(msg);
          if (pw == null) throw new Error('CANCELLED');
          try { data = await qpdf(bytes, ['--password=' + pw, '--decrypt']); password = pw; break; }
          catch (e3) { if (isPwErr(e3)) { msg = '암호가 맞지 않아요. 다시 입력해 주세요.'; continue; } throw e3; }
        }
      }
    } else {
      // try to repair with qpdf
      data = await qpdf(bytes, []);
    }
    doc = await PDFDocument.load(data, { updateMetadata: false });
  }
  const { annots, changed } = extractAnnots(doc);
  const base = changed ? await doc.save({ updateFieldAppearances: false }) : data;
  return { base, annots, password, encrypted };
}

// ---------------- writing ----------------
let fontBytesP;
export function loadFontBytes() {
  return (fontBytesP ||= fetch(new URL('../fonts/Pretendard-KR.ttf', import.meta.url))
    .then((r) => { if (!r.ok) throw new Error('글꼴을 불러오지 못했어요'); return r.arrayBuffer(); })
    .catch((e) => { fontBytesP = null; throw e; }));
}

const f2 = (n) => String(Math.round(n * 1000) / 1000);
const rg = (c) => `${f2(c[0])} ${f2(c[1])} ${f2(c[2])}`;
const pad = (r, p) => [r[0] - p, r[1] - p, r[2] + p, r[3] + p];
function union(rects) {
  return rects.reduce((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity]);
}
function bboxOfPoints(arr) {
  const xs = [], ys = [];
  for (let i = 0; i < arr.length; i += 2) { xs.push(arr[i]); ys.push(arr[i + 1]); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export function rotMatrix(rot, r) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [0, 1, -1, 0, r[2], r[1]];
    case 180: return [-1, 0, 0, -1, r[2], r[3]];
    case 270: return [0, -1, 1, 0, r[0], r[3]];
    default: return [1, 0, 0, 1, r[0], r[1]];
  }
}
/** smooth path ops (quadratic midpoints → cubic) */
function pathOps(p) {
  const n = p.length / 2;
  if (n === 1) return `${f2(p[0])} ${f2(p[1])} m ${f2(p[0] + 0.01)} ${f2(p[1])} l S`;
  let s = `${f2(p[0])} ${f2(p[1])} m`;
  let cx = p[0], cy = p[1];
  for (let i = 1; i < n - 1; i++) {
    const qx = p[i * 2], qy = p[i * 2 + 1];
    const ex = (qx + p[i * 2 + 2]) / 2, ey = (qy + p[i * 2 + 3]) / 2;
    s += ` ${f2(cx + (2 / 3) * (qx - cx))} ${f2(cy + (2 / 3) * (qy - cy))} ${f2(ex + (2 / 3) * (qx - ex))} ${f2(ey + (2 / 3) * (qy - ey))} ${f2(ex)} ${f2(ey)} c`;
    cx = ex; cy = ey;
  }
  s += ` ${f2(p[n * 2 - 2])} ${f2(p[n * 2 - 1])} l S`;
  return s;
}
export function underlineRect(r, type) {
  const h = r[3] - r[1];
  const t = Math.max(0.5, h * 0.07);
  const y = type === 'underline' ? r[1] + h * 0.1 : r[1] + h * 0.42;
  return [r[0], y, r[2], y + t];
}
export function arrowHead(line, w) {
  const [x1, y1, x2, y2] = line;
  const hl = 6 + w * 3, ang = Math.atan2(y2 - y1, x2 - x1);
  return [x2 - hl * Math.cos(ang - 0.45), y2 - hl * Math.sin(ang - 0.45), x2, y2, x2 - hl * Math.cos(ang + 0.45), y2 - hl * Math.sin(ang + 0.45)];
}
export function wrapText(text, measure, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    const tokens = para.match(/[A-Za-z0-9À-ɏ'’.,:;!?%()\-]+\s*|\s+|./gu) || [];
    let line = '';
    for (const tok of tokens) {
      if (measure(line + tok) <= maxW || !line) {
        if (!line && measure(tok) > maxW) {
          for (const ch of tok) { if (measure(line + ch) > maxW && line) { out.push(line); line = ch; } else line += ch; }
        } else line += tok;
      } else { out.push(line.trimEnd()); line = tok.trimStart(); }
    }
    out.push(line.trimEnd());
  }
  return out;
}
function dataUrlBytes(u) {
  const b64 = u.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function makeAP(doc, bbox, content, resources) {
  const ctx = doc.context;
  return ctx.register(ctx.flateStream(content, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox.map((v) => +f2(v)), Resources: resources || {} }));
}
function gs(ctx, op, multiply) {
  return { ExtGState: { GS0: ctx.obj({ Type: 'ExtGState', CA: op, ca: op, ...(multiply ? { BM: 'Multiply' } : {}) }) } };
}
function annotDict(doc, page, a, subtype, rect, extra = {}) {
  const { PDFString, PDFHexString } = L();
  const ctx = doc.context;
  const d = {
    Type: 'Annot', Subtype: subtype, Rect: rect.map((v) => +f2(v)), F: 4, P: page.ref,
    NM: PDFString.of(String(a.id).replace(/[^\w-]/g, '')),
    M: PDFString.fromDate(new Date(a.modified || Date.now())),
  };
  if (a.author) d.T = PDFHexString.fromText(a.author);
  if (a.text) d.Contents = PDFHexString.fromText(a.text);
  if (a.quote) d.WaveQuote = PDFHexString.fromText(a.quote);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) d[k] = v;
  const ref = ctx.register(ctx.obj(d));
  page.node.addAnnot(ref);
  return ref;
}

async function addAnnot(doc, page, a, getFont, images, imgCache) {
  const ctx = doc.context;
  const col = a.color || [0, 0, 0];
  const op = a.opacity ?? 1;
  switch (a.type) {
    case 'highlight': case 'underline': case 'strike': {
      if (!a.rects?.length) return;
      const quads = [];
      for (const r of a.rects) quads.push(r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]);
      const bb = pad(union(a.rects), 1);
      let content, res;
      if (a.type === 'highlight') {
        res = gs(ctx, op, true);
        content = `/GS0 gs ${rg(col)} rg\n` + a.rects.map((r) => `${f2(r[0])} ${f2(r[1])} ${f2(r[2] - r[0])} ${f2(r[3] - r[1])} re f`).join('\n');
      } else {
        content = `${rg(col)} rg\n` + a.rects.map((r) => { const u = underlineRect(r, a.type); return `${f2(u[0])} ${f2(u[1])} ${f2(u[2] - u[0])} ${f2(u[3] - u[1])} re f`; }).join('\n');
      }
      const ap = makeAP(doc, bb, content, res);
      annotDict(doc, page, a, { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }[a.type], bb, {
        QuadPoints: quads.map((v) => +f2(v)), C: col, CA: a.type === 'highlight' && op < 1 ? op : undefined, AP: { N: ap },
      });
      break;
    }
    case 'ink': {
      if (!a.paths?.length) return;
      const w = a.width || 1;
      const bb = pad(bboxOfPoints(a.paths.flat()), w + 1);
      const useGs = a.marker || op < 1;
      const content = `${useGs ? '/GS0 gs ' : ''}${f2(w)} w 1 J 1 j ${rg(col)} RG\n` + a.paths.map(pathOps).join('\n');
      const ap = makeAP(doc, bb, content, useGs ? gs(ctx, op, !!a.marker) : undefined);
      annotDict(doc, page, a, 'Ink', bb, {
        InkList: a.paths.map((p) => p.map((v) => +f2(v))), BS: { W: w }, C: col, CA: op < 1 ? op : undefined,
        WaveMarker: a.marker ? true : undefined, AP: { N: ap },
      });
      break;
    }
    case 'square': case 'circle': {
      const w = a.width || 1, r = a.rect;
      const bb = pad(r, w / 2 + 1);
      let content = `${f2(w)} w ${rg(col)} RG `;
      if (a.type === 'square') content += `${f2(r[0])} ${f2(r[1])} ${f2(r[2] - r[0])} ${f2(r[3] - r[1])} re S`;
      else {
        const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = (r[2] - r[0]) / 2, ry = (r[3] - r[1]) / 2, k = 0.5523;
        content += `${f2(cx + rx)} ${f2(cy)} m ${f2(cx + rx)} ${f2(cy + ry * k)} ${f2(cx + rx * k)} ${f2(cy + ry)} ${f2(cx)} ${f2(cy + ry)} c `
          + `${f2(cx - rx * k)} ${f2(cy + ry)} ${f2(cx - rx)} ${f2(cy + ry * k)} ${f2(cx - rx)} ${f2(cy)} c `
          + `${f2(cx - rx)} ${f2(cy - ry * k)} ${f2(cx - rx * k)} ${f2(cy - ry)} ${f2(cx)} ${f2(cy - ry)} c `
          + `${f2(cx + rx * k)} ${f2(cy - ry)} ${f2(cx + rx)} ${f2(cy - ry * k)} ${f2(cx + rx)} ${f2(cy)} c S`;
      }
      const ap = makeAP(doc, bb, content);
      annotDict(doc, page, a, a.type === 'square' ? 'Square' : 'Circle', bb, { BS: { W: w }, C: col, AP: { N: ap } });
      break;
    }
    case 'arrow': {
      const w = a.width || 1, l = a.line;
      const head = a.head !== false ? arrowHead(l, w) : null;
      const bb = pad(bboxOfPoints(head ? [...l, ...head] : l), w + 1);
      let content = `${f2(w)} w 1 J 1 j ${rg(col)} RG ${f2(l[0])} ${f2(l[1])} m ${f2(l[2])} ${f2(l[3])} l S`;
      if (head) content += ` ${f2(head[0])} ${f2(head[1])} m ${f2(head[2])} ${f2(head[3])} l ${f2(head[4])} ${f2(head[5])} l S`;
      const ap = makeAP(doc, bb, content);
      annotDict(doc, page, a, 'Line', bb, { L: l.map((v) => +f2(v)), LE: ['None', head ? 'OpenArrow' : 'None'], BS: { W: w }, C: col, AP: { N: ap } });
      break;
    }
    case 'freetext': {
      const { PDFString } = L();
      const font = await getFont();
      const fs = a.fontSize || 12, lh = fs * 1.25, pd = 2, r = a.rect;
      const rot = (((a.rot || 0) % 360) + 360) % 360;
      const swap = rot === 90 || rot === 270;
      const bw = swap ? r[3] - r[1] : r[2] - r[0];
      const bh = swap ? r[2] - r[0] : r[3] - r[1];
      const bk = a.bold ? 1.04 : 1;
      const lines = wrapText(a.text || '', (s) => font.widthOfTextAtSize(s, fs) * bk, bw - pd * 2);
      const boldOps = a.bold ? `${rg(col)} RG ${f2(fs * 0.045)} w 1 j 2 Tr ` : '';
      let content = `q ${rotMatrix(rot, r).map(f2).join(' ')} cm ${boldOps}BT /F1 ${f2(fs)} Tf ${rg(col)} rg ${f2(lh)} TL ${f2(pd)} ${f2(bh - pd - fs * 0.93)} Td\n`;
      lines.forEach((ln, i) => { content += `${i ? 'T* ' : ''}${font.encodeText(ln).toString()} Tj\n`; });
      content += 'ET Q';
      const ap = makeAP(doc, r, content, { Font: { F1: font.ref } });
      annotDict(doc, page, { ...a, text: a.text }, 'FreeText', r, {
        DA: PDFString.of(`/Helv ${f2(fs)} Tf ${rg(col)} rg`), WaveRot: rot, AP: { N: ap },
        WaveBold: a.bold ? true : undefined, DS: a.bold ? PDFString.of(`font-weight:bold; font-size:${f2(fs)}pt`) : undefined,
      });
      break;
    }
    case 'note': {
      const r = a.rect, w = r[2] - r[0], h = r[3] - r[1];
      let content = `${rg(col)} rg 0.3 0.3 0.3 RG 0.6 w ${f2(r[0] + 0.5)} ${f2(r[1] + 0.5)} ${f2(w - 1)} ${f2(h - 1)} re B 0.25 0.25 0.25 RG 1 w`;
      for (const t of [0.72, 0.52, 0.32]) content += ` ${f2(r[0] + w * 0.2)} ${f2(r[1] + h * t)} m ${f2(r[2] - w * 0.2)} ${f2(r[1] + h * t)} l S`;
      const ap = makeAP(doc, r, content);
      annotDict(doc, page, a, 'Text', r, { Name: 'Comment', Open: false, C: col, AP: { N: ap } });
      break;
    }
    case 'stamp': {
      const src = images[a.img];
      if (!src) return;
      let img = imgCache.get(a.img);
      if (!img) { img = await doc.embedPng(dataUrlBytes(src)); imgCache.set(a.img, img); }
      const r = a.rect, rot = (((a.rot || 0) % 360) + 360) % 360;
      const swap = rot === 90 || rot === 270;
      const bw = swap ? r[3] - r[1] : r[2] - r[0], bh = swap ? r[2] - r[0] : r[3] - r[1];
      const content = `q ${rotMatrix(rot, r).map(f2).join(' ')} cm ${f2(bw)} 0 0 ${f2(bh)} 0 0 cm /Im0 Do Q`;
      const ap = makeAP(doc, r, content, { XObject: { Im0: img.ref } });
      annotDict(doc, page, { ...a, text: a.text }, 'Stamp', r, { Name: 'WaveSign', AP: { N: ap } });
      break;
    }
  }
}

async function applyForms(doc, list, getFont) {
  if (!list?.length) return;
  const P = L();
  let form;
  try { form = doc.getForm(); } catch { return; }
  let touched = false;
  for (const f of list) {
    let field;
    try { field = form.getField(f.name); } catch { continue; }
    try {
      const on = f.value === true || (typeof f.value === 'string' && f.value !== 'Off' && f.value !== '');
      if (field instanceof P.PDFTextField) { field.setText(f.value == null ? '' : String(f.value)); touched = true; }
      else if (field instanceof P.PDFCheckBox) { on ? field.check() : field.uncheck(); touched = true; }
      else if (field instanceof P.PDFRadioGroup) { if (on) { field.select(typeof f.value === 'string' ? f.value : f.exportValue); touched = true; } }
      else if (field instanceof P.PDFDropdown || field instanceof P.PDFOptionList) {
        const v = Array.isArray(f.value) ? f.value : [f.value];
        field.select(v.length === 1 ? v[0] : v); touched = true;
      }
    } catch (e) { console.warn('form field', f.name, e); }
  }
  if (touched) {
    try { form.updateFieldAppearances(await getFont()); } catch (e) { console.warn(e); }
  }
}

let hbP;
function hb() {
  return (hbP ||= fetch(new URL('../vendor/harfbuzz-subset.wasm', import.meta.url))
    .then((r) => r.arrayBuffer()).then((b) => WebAssembly.instantiate(b)).then((r) => r.instance.exports)
    .catch((e) => { hbP = null; throw e; }));
}
/** Subset a TTF to the given characters with HarfBuzz (pdf-lib's own subsetter breaks Hangul glyphs) */
async function subsetFont(fontBuf, chars) {
  const E = await hb();
  const font = new Uint8Array(fontBuf);
  const ptr = E.malloc(font.length);
  new Uint8Array(E.memory.buffer).set(font, ptr);
  const blob = E.hb_blob_create(ptr, font.length, 2, 0, 0);
  const face = E.hb_face_create(blob, 0);
  E.hb_blob_destroy(blob);
  const input = E.hb_subset_input_create_or_fail();
  const us = E.hb_subset_input_unicode_set(input);
  for (const ch of chars) E.hb_set_add(us, ch.codePointAt(0));
  const sub = E.hb_subset_or_fail(face, input);
  E.hb_subset_input_destroy(input);
  if (!sub) { E.hb_face_destroy(face); E.free(ptr); throw new Error('subset failed'); }
  const res = E.hb_face_reference_blob(sub);
  const off = E.hb_blob_get_data(res, 0), len = E.hb_blob_get_length(res);
  const out = new Uint8Array(E.memory.buffer).slice(off, off + len);
  E.hb_blob_destroy(res); E.hb_face_destroy(sub); E.hb_face_destroy(face); E.free(ptr);
  if (!len) throw new Error('empty subset');
  return out;
}
const BASE_CHARS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·…‘’“”○●□■△▲※';

function collectFormChars(doc, chars) {
  let form;
  try { form = doc.getForm(); } catch { return; }
  const P = L();
  for (const f of form.getFields()) {
    try {
      if (f instanceof P.PDFTextField) for (const ch of f.getText() || '') chars.add(ch);
      else if (f instanceof P.PDFDropdown || f instanceof P.PDFOptionList) for (const o of [...f.getOptions(), ...f.getSelected()]) for (const ch of o) chars.add(ch);
    } catch { /* */ }
  }
}


/** Replace the document outline (bookmarks) with a flat list [{title,page,top,level}] */
function writeOutline(doc, flat) {
  const { PDFName, PDFHexString, PDFNumber, PDFNull } = L();
  const ctx = doc.context, pages = doc.getPages();
  const catalog = doc.catalog;
  if (!flat || !flat.length) { catalog.delete(PDFName.of('Outlines')); return; }
  const root = { children: [] };
  const stack = [{ level: -1, node: root }];
  for (const it of flat) {
    while (stack.length > 1 && stack[stack.length - 1].level >= it.level) stack.pop();
    const node = { ...it, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level: it.level, node });
  }
  const countAll = (nodes) => nodes.reduce((n, x) => n + 1 + countAll(x.children), 0);
  const outlinesRef = ctx.nextRef();
  function build(nodes, parentRef) {
    const refs = nodes.map(() => ctx.nextRef());
    nodes.forEach((nd, i) => {
      const page = pages[Math.max(0, Math.min(pages.length - 1, nd.page))];
      const dest = [page.ref, PDFName.of('XYZ'), PDFNull, nd.top == null ? PDFNull : PDFNumber.of(nd.top), PDFNull];
      const d = { Title: PDFHexString.fromText(nd.title || ''), Parent: parentRef, Dest: ctx.obj(dest) };
      if (i > 0) d.Prev = refs[i - 1];
      if (i < refs.length - 1) d.Next = refs[i + 1];
      if (nd.children.length) {
        const sub = build(nd.children, refs[i]);
        d.First = sub[0]; d.Last = sub[1]; d.Count = countAll(nd.children);
      }
      ctx.assign(refs[i], ctx.obj(d));
    });
    return [refs[0], refs[refs.length - 1]];
  }
  const [first, last] = build(root.children, outlinesRef);
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: countAll(root.children) }));
  catalog.set(PDFName.of('Outlines'), outlinesRef);
  catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Bake annotations (+form values) into the base PDF */
export async function buildPdf({ base, annots, images = {}, forms = [], outline = null }) {
  const { PDFDocument } = L();
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  doc.registerFontkit(window.fontkit);
  const chars = new Set(BASE_CHARS);
  for (const arr of annots || []) for (const a of arr || []) if (a.type === 'freetext') for (const ch of a.text || '') chars.add(ch);
  if (forms.length) {
    for (const f of forms) for (const ch of (Array.isArray(f.value) ? f.value.join('') : typeof f.value === 'string' ? f.value : '')) chars.add(ch);
    collectFormChars(doc, chars);
  }
  let fontP = null;
  const getFont = () => (fontP ||= loadFontBytes().then(async (b) => {
    let bytes;
    try { bytes = await subsetFont(b, chars); } catch (e) { console.warn('subset fallback', e); bytes = b; }
    return doc.embedFont(bytes, { subset: false });
  }));
  await applyForms(doc, forms, getFont);
  const pages = doc.getPages();
  const imgCache = new Map();
  for (let i = 0; i < pages.length; i++) {
    for (const a of annots[i] || []) {
      try { await addAnnot(doc, pages[i], a, getFont, images, imgCache); }
      catch (e) { console.error('annotation save failed', a, e); }
    }
  }
  if (outline) { try { writeOutline(doc, outline); } catch (e) { console.error('outline save failed', e); } }
  return doc.save({ updateFieldAppearances: false });
}

/** Apply page edits. items: [{src:'base'|key|'blank', index, rot, w, h}] */
export async function applyPageEdits(base, items, merged) {
  const { PDFDocument, degrees } = L();
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const orig = doc.getPages();
  const copied = {};
  for (const [key, bytes] of Object.entries(merged || {})) {
    const idxs = [...new Set(items.filter((it) => it.src === key).map((it) => it.index))];
    if (!idxs.length) continue;
    const m = await PDFDocument.load(bytes, { updateMetadata: false });
    const cps = await doc.copyPages(m, idxs);
    copied[key] = Object.fromEntries(idxs.map((ix, k) => [ix, cps[k]]));
  }
  for (let i = orig.length - 1; i >= 0; i--) doc.removePage(i);
  for (const it of items) {
    let p;
    if (it.src === 'blank') p = doc.addPage([it.w || 595.28, it.h || 841.89]);
    else { p = it.src === 'base' ? orig[it.index] : copied[it.src][it.index]; doc.addPage(p); }
    if (it.rot) p.setRotation(degrees((((p.getRotation().angle + it.rot) % 360) + 360) % 360));
  }
  return doc.save({ updateFieldAppearances: false });
}

export async function extractPages(bytes, indices) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}
