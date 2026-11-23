// copies the web app (repo root) into www/ for the desktop build
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), out = fileURLToPath(new URL('./www/', import.meta.url));
rmSync(out, { recursive: true, force: true }); mkdirSync(out);
for (const f of ['index.html', 'manifest.webmanifest', 'js', 'css', 'vendor', 'fonts', 'icons']) cpSync(root + f, out + f, { recursive: true });
console.log('web copied');
