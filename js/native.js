// Android APK (Capacitor) bridge. In the browser every export here is inert.
const cap = window.Capacitor;
export const NATIVE = !!cap?.isNativePlatform?.();
// Windows desktop app (Tauri)
const T = window.__TAURI__;
export const DESKTOP = !!T?.core;
/** no in-app Google sign-in inside the packaged apps */
export const NO_DRIVE = NATIVE || DESKTOP;
const call = (method, opts) => cap.nativePromise('WaveFile', method, opts);

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** PDFs handed to the app by other apps (Drive "open with", file manager, share) */
export function onFileOpened(fn) {
  if (!NATIVE) return;
  cap.addListener('WaveFile', 'fileOpened', async (d) => {
    if (d.error) return fn(null, d.error);
    try {
      const res = await fetch(cap.convertFileSrc(d.path));
      fn({ bytes: new Uint8Array(await res.arrayBuffer()), name: d.name, uri: d.uri, writable: !!d.writable });
    } catch (e) { fn(null, e.message); }
  });
}
export const saveTo = (uri, bytes) => call('save', { uri, data: b64(bytes) });
export const saveAs = (name, bytes) => call('saveAs', { name, data: b64(bytes) });
export const share = (name, bytes) => call('share', { name, data: b64(bytes) });

// ---------- desktop ----------
const hex = (str) => [...new TextEncoder().encode(str)].map((b) => b.toString(16).padStart(2, '0')).join('');
const baseName = (p) => p.split(/[\\/]/).pop();
async function readPath(path) {
  const buf = await T.core.invoke('read_file', { path });
  return { bytes: new Uint8Array(buf), name: baseName(path), path };
}
/** files given on the command line now, and later ones from a second launch */
export async function onDesktopFiles(fn) {
  if (!DESKTOP) return;
  const go = async (paths) => { for (const p of paths || []) { try { await fn(await readPath(p)); } catch (e) { fn(null, e.message || String(e)); } } };
  await T.event.listen('files-opened', (e) => go(e.payload));
  go(await T.core.invoke('take_opened'));
}
export const writePath = (path, bytes) => T.core.invoke('write_file', bytes, { headers: { 'x-path': hex(path) } });

/** desktop: open the app in another window (tab dragged out) */
export async function newWindow(url, { x, y, width, height }) {
  const W = T.webviewWindow.WebviewWindow;
  const w = new W('w' + Date.now().toString(36), { url, title: 'Wave PDF', x, y, width, height, minWidth: 480, minHeight: 400, dragDropEnabled: false });
  await new Promise((res, rej) => { w.once('tauri://created', res); w.once('tauri://error', (e) => rej(e.payload)); });
}
