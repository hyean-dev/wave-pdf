// Pen stroke auto-correction: straight line, ellipse, arrow. All coordinates are PDF points ([[x,y],...]).
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLen = (p) => { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; };
function maxDev(p, a, b) {
  const d = dist(a, b) || 1;
  let m = 0;
  for (const q of p) m = Math.max(m, Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) / d);
  return m;
}
function isStraight(p, minLen) {
  if (p.length < 2) return false;
  const a = p[0], b = p[p.length - 1], D = dist(a, b);
  return D >= minLen && D / pathLen(p) >= 0.9 && maxDev(p, a, b) <= Math.max(2.5, 0.05 * D);
}
/** snap nearly horizontal / vertical lines to the axis */
function axisSnap(a, b) {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), t = Math.tan((7 * Math.PI) / 180);
  if (dy <= dx * t) { const y = (a[1] + b[1]) / 2; return [[a[0], y], [b[0], y]]; }
  if (dx <= dy * t) { const x = (a[0] + b[0]) / 2; return [[x, a[1]], [x, b[1]]]; }
  return [a, b];
}

export function recognize(p) {
  if (p.length < 2) return null;
  // --- line ---
  if (isStraight(p, 28)) { const [a, b] = axisSnap(p[0], p[p.length - 1]); return { kind: 'line', a, b }; }
  // --- arrow in one stroke: straight shaft, then the pen comes back to draw the head ---
  let tip = 0, far = 0;
  for (const q of p) far = Math.max(far, dist(p[0], q));
  // the pen may pass the tip again while drawing the head: take the first time it gets there
  tip = p.findIndex((q) => dist(p[0], q) >= far - Math.max(1, 0.02 * far));
  if (tip < p.length - 1 && far >= 24) {
    const shaft = p.slice(0, tip + 1), rest = p.slice(tip);
    const rl = pathLen(rest);
    if (isStraight(shaft, 24) && rl >= Math.max(6, 0.15 * far) && rl <= 1.2 * far
      && rest.every((q) => dist(q, p[tip]) <= Math.max(10, 0.45 * far))
      && maxDev(rest, p[0], p[tip]) >= Math.max(3, 0.06 * far)) {
      const [a, b] = axisSnap(p[0], p[tip]);
      return { kind: 'arrow', a, b };
    }
  }
  // --- rectangle: closed stroke with four clear corners (each turning ~90°), so a quickly drawn box with
  //     slightly rounded or uneven corners still counts; a round shape has no corners and stays an ellipse ---
  const box = rectFromCorners(p);
  if (box === false) return null; // four corners but not a level box (diamond, tilted): leave it hand-drawn
  if (box) return box;
  // --- ellipse ---
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  const w = x2 - x1, h = y2 - y1, big = Math.max(w, h);
  if (big >= 20 && Math.min(w, h) >= 6 && dist(p[0], p[p.length - 1]) <= 0.35 * big && pathLen(p) >= 1.8 * big) {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = w / 2, ry = h / 2;
    let dev = 0; const sect = new Set();
    for (const q of p) {
      const nx = (q[0] - cx) / rx, ny = (q[1] - cy) / ry;
      dev += Math.abs(Math.hypot(nx, ny) - 1);
      sect.add(Math.floor(((Math.atan2(ny, nx) + Math.PI) / (2 * Math.PI)) * 12) % 12);
    }
    if (dev / p.length < 0.2 && sect.size >= 11) return { kind: 'ellipse', cx, cy, rx, ry };
  }
  return null;
}

export function ellipsePoints({ cx, cy, rx, ry }, n = 48) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = (i / n) * 2 * Math.PI; out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  return out;
}

/** a small stroke drawn right at one end of a line just drawn → which end gets the arrow head ('a' | 'b' | null) */
export function headAt(p, line) {
  const len = dist(line.a, line.b);
  const r = Math.max(8, Math.min(0.35 * len, 30));
  if (pathLen(p) > Math.max(0.6 * len, 14)) return null;
  for (const k of ['b', 'a']) if (p.every((q) => dist(q, line[k]) <= r)) return k;
  return null;
}

/**
 * Hand-shake smoothing for a pen stroke (screen px). Looks at both sides of every point, so the line doesn't lag
 * behind the pen, and it never smooths across a sharp corner, so small handwriting keeps its shape.
 */
export function stabilize(pts, sigma) {
  if (!sigma || pts.length < 4) return pts;
  // 1) resample at 1px steps
  const P = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = dist(a, b);
    if (!d) continue;
    let t = 1 - carry;
    for (; t <= d; t += 1) P.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d]);
    carry = d - (t - 1);
  }
  const n = P.length;
  if (n < 6) return pts;
  // 2) corners: direction change over ±W px
  const W = 6, turn = new Float32Array(n);
  for (let i = W; i < n - W; i++) {
    const ax = P[i][0] - P[i - W][0], ay = P[i][1] - P[i - W][1], bx = P[i + W][0] - P[i][0], by = P[i + W][1] - P[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 1 && lb > 1) turn[i] = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
  }
  const cuts = [0];
  for (let i = W; i < n - W; i++) {
    if (turn[i] < 1.2) continue; // ~70°
    let peak = true;
    for (let j = i - W; j <= i + W; j++) if (turn[j] > turn[i] || (turn[j] === turn[i] && j < i)) { peak = false; break; }
    if (peak) cuts.push(i);
  }
  cuts.push(n - 1);
  // 3) gaussian average inside each piece; the ends of a piece stay where they are
  const out = [];
  for (let c = 0; c < cuts.length - 1; c++) {
    const s = cuts[c], e = cuts[c + 1];
    for (let i = s; i <= e; i++) {
      if (i === s && c > 0) continue; // shared corner point already added
      const sg = Math.min(sigma, Math.min(i - s, e - i) / 1.3);
      if (sg < 0.4) { out.push(P[i]); continue; }
      const r = Math.ceil(sg * 2.5);
      let x = 0, y = 0, w = 0;
      for (let j = Math.max(s, i - r); j <= Math.min(e, i + r); j++) {
        const k = Math.exp(-((j - i) * (j - i)) / (2 * sg * sg));
        x += P[j][0] * k; y += P[j][1] * k; w += k;
      }
      out.push([x / w, y / w]);
    }
  }
  // 4) thin out to ~2px, always keeping corners and ends
  const keep = new Set(cuts), res = [];
  let idx = 0;
  for (let c = 0; c < cuts.length - 1; c++) for (let i = cuts[c] + (c ? 1 : 0); i <= cuts[c + 1]; i++, idx++) if (keep.has(i) || i % 2 === 0) res.push(out[idx]);
  return res;
}

/** closed stroke → 4 corner peaks in turning angle → axis-aligned box (null if it isn't box-like) */
function rectFromCorners(p) {
  // the pen often runs a bit past the start when closing: cut that overlap
  const half = Math.floor(p.length / 2);
  let k = p.length - 1, kd = dist(p[0], p[k]);
  for (let i = half; i < p.length; i++) { const d = dist(p[0], p[i]); if (d < kd) { kd = d; k = i; } }
  p = p.slice(0, k + 1);
  const L = pathLen(p);
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  const w = x2 - x1, h = y2 - y1;
  if (Math.max(w, h) < 20 || Math.min(w, h) < 8 || dist(p[0], p[p.length - 1]) > 0.3 * Math.max(w, h)) return null;
  if (L < 0.8 * 2 * (w + h) || L > 1.4 * 2 * (w + h)) return null;
  // resample the closed loop into N even steps
  const N = 96, step = L / N, R = [p[0]];
  let acc = 0;
  for (let i = 1; i < p.length && R.length < N; i++) {
    let a = p[i - 1];
    const b = p[i];
    let d = dist(a, b);
    while (acc + d >= step && R.length < N) {
      const t = (step - acc) / d;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      R.push(a); d = dist(a, b); acc = 0;
    }
    acc += d;
  }
  const n = R.length, W = 6, at = (i) => R[((i % n) + n) % n];
  const turn = [], sign = [];
  for (let i = 0; i < n; i++) {
    const a = at(i - W), b = at(i), c = at(i + W);
    const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - b[0], by = c[1] - b[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    turn.push(la && lb ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) : 0);
    sign.push(Math.sign(ax * by - ay * bx));
  }
  // corner = local max of turning above ~45°, at least 1/12 of the loop apart
  const peaks = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < 0.8) continue;
    let top = true;
    for (let k = -6; k <= 6; k++) if (k && (turn[(i + k + n) % n] > turn[i] || (turn[(i + k + n) % n] === turn[i] && k < 0))) { top = false; break; }
    if (top) peaks.push(i);
  }
  if (peaks.length !== 4 || new Set(peaks.map((i) => sign[i])).size !== 1) return null;
  // a level box passes close by all four of its bounding-box corners (a rounded corner by ~0.4·radius);
  // a diamond or tilted box leaves at least one of them far away
  const lim = 0.15 * Math.min(w, h) + 4;
  const level = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].every((c) => R.some((q) => dist(q, c) <= lim));
  // the 4 sides between corners must be fairly straight
  for (let k = 0; k < 4; k++) {
    const s0 = peaks[k], s1 = peaks[(k + 1) % 4];
    const side = [];
    for (let i = s0; i !== s1; i = (i + 1) % n) side.push(R[i]);
    side.push(R[s1]);
    const D = dist(R[s0], R[s1]);
    if (D < 6 || maxDev(side, R[s0], R[s1]) > Math.max(4, 0.2 * D)) return null;
  }
  // the corners should sit near the box corners (rules out diamonds and tilted boxes)
  if (!level) return false;
  return { kind: 'rect', x1, y1, x2, y2 };
}
