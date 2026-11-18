// Shared application state
export const S = {
  pdfDoc: null,        // pdf.js document (base, annotations stripped)
  baseBytes: null,     // Uint8Array of base PDF
  fileName: '',
  source: null,        // {type:'local'|'drive'|'new', handle?, driveId?, parents?, canEdit?}
  annots: [],          // per page: [annotation]
  images: {},          // imgId -> dataURL (signatures/stamps)
  password: null,      // original open password (to re-encrypt on save)
  dirty: false,
  tool: 'hand',
  selected: null,      // {page, id}
  author: localStorage.getItem('author') || '재원',
};

const DEFAULT_CFG = {
  highlight: { color: '#FFF176' },
  underline: { color: '#E53935' },
  strike: { color: '#E53935' },
  pen: { color: '#212121', width: 1.5 },
  marker: { color: '#FFF176', width: 12 },
  freetext: { color: '#212121', size: 12 },
  shape: { color: '#E53935', width: 1.5, kind: 'square' },
  note: { color: '#FFD54F' },
  penOnly: false,
};
export const CFG = (() => {
  try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem('toolCfg') || '{}') }; } catch { return { ...DEFAULT_CFG }; }
})();
export const saveCfg = () => localStorage.setItem('toolCfg', JSON.stringify(CFG));

const bus = new EventTarget();
export const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));
export const on = (n, f) => bus.addEventListener(n, (e) => f(e.detail));

const PAL_DEFAULT = {
  highlight: ['#FFF176', '#A5D6A7', '#90CAF9', '#F48FB1', '#FFCC80', '#CE93D8'],
  ink: ['#212121', '#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA'],
  note: ['#FFD54F', '#A5D6A7', '#90CAF9', '#F48FB1'],
};
/** user-editable palettes (persisted) */
export const PALETTE = (() => {
  const base = JSON.parse(JSON.stringify(PAL_DEFAULT));
  try { const saved = JSON.parse(localStorage.getItem('palettes') || 'null'); if (saved) for (const k of Object.keys(base)) if (Array.isArray(saved[k]) && saved[k].length) base[k] = saved[k]; } catch { /* */ }
  return base;
})();
export const savePalette = () => localStorage.setItem('palettes', JSON.stringify(PALETTE));
export function resetPalette() { for (const k of Object.keys(PAL_DEFAULT)) PALETTE[k] = [...PAL_DEFAULT[k]]; savePalette(); }
