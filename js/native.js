// Android APK (Capacitor) bridge. In the browser every export here is inert.
const cap = window.Capacitor;
export const NATIVE = !!cap?.isNativePlatform?.();
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
