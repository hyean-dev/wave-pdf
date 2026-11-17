const DB = 'wavepdf', ST = 'kv';
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(ST, mode);
    const req = fn(t.objectStore(ST));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
export const idbGet = (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined);
export const idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const idbDel = (k) => tx('readwrite', (s) => s.delete(k));
