// copies the web app (repo root) into www/ for the APK
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url).pathname, out = new URL('./www/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true }); mkdirSync(out);
for (const f of ['index.html', 'manifest.webmanifest', 'js', 'css', 'vendor', 'fonts', 'icons']) cpSync(root + f, out + f, { recursive: true });
console.log('web copied');
