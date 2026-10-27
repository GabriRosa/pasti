import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

test('Cloudflare build exposes only public assets and changes only its own auth config and privacy', async () => {
  const root = new URL('../', import.meta.url);
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], { cwd: root });
  assert.match(await readFile(new URL('src/google-health-config.js', root), 'utf8'), /PERSISTENT = false;/);
  assert.match(await readFile(new URL('dist/src/google-health-config.js', root), 'utf8'), /PERSISTENT = true;/);
  const all = await readdir(new URL('dist/', root), { recursive: true });
  assert.ok(all.includes('src/vendor/zxing-browser-0.2.1.min.js'));
  assert.ok(all.includes('src/vendor/ZXING-LICENSE'));
  assert.ok(!all.some(p => /(^|\/)(server|tests|docs|work|\.git|\.env|\.dev.vars|wrangler)/.test(p)));
  for (const file of all.filter(p => /\.js$/.test(p))) {
    const source = await readFile(new URL(`dist/${file}`, root), 'utf8');
    assert.ok(!source.includes('GOOGLE_CLIENT_SECRET'), `${file} must not contain backend secret configuration`);
  }
  const privacy = await readFile(new URL('dist/privacy.html', root), 'utf8');
  assert.match(privacy, /HttpOnly/); assert.match(privacy, /Cloudflare/);
  assert.doesNotMatch(privacy, /Pasti non dispone di un server|Ricaricare o chiudere la pagina termina la sessione/);
  assert.match(await readFile(new URL('privacy.html', root), 'utf8'), /Ricaricare o chiudere la pagina termina la sessione/);
});
