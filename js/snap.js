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
  p.forEach((q, i) => { const d = dist(p[0], q); if (d > far) { far = d; tip = i; } });
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
