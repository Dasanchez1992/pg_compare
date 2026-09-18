'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkForUpdate, compareVersions, parseVersion, pickAsset, repoFromPackage,
} = require('../electron/core/updates');

/** Respuesta de la API de GitHub, recortada a lo que usa la app. */
function release(tag, assets = []) {
  return {
    tag_name: tag,
    name: `Comparador de BD ${tag}`,
    html_url: `https://github.com/acme/app/releases/tag/${tag}`,
    body: 'Novedades de la versión.',
    published_at: '2026-02-01T10:00:00Z',
    draft: false,
    prerelease: false,
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.com/acme/app/releases/download/${tag}/${name}`,
      size: 1024,
    })),
  };
}

/** `fetch` de mentira que devuelve lo que se le diga. */
function fakeFetch(body, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

const ASSETS = [
  'Comparador.de.BD.Setup.2.1.0.exe',
  'Comparador.de.BD.Setup.2.1.0.exe.blockmap',
  'Comparador.de.BD.2.1.0.exe',
  'Comparador.de.BD-2.1.0.AppImage',
  'pg-compare_2.1.0_amd64.deb',
];

test('compara versiones por número, no por texto', () => {
  assert.equal(compareVersions('2.1.0', '2.2.0'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);      // 10 > 9, aunque "10" < "9"
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  assert.equal(compareVersions('v2.1.0', '2.1.0'), 0);      // la "v" de la etiqueta da igual
  assert.equal(compareVersions('2.0.9', '2.1.0'), -1);
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
});

test('una versión con sufijo va antes que la definitiva', () => {
  assert.equal(compareVersions('2.1.0-beta.1', '2.1.0'), -1);
  assert.equal(compareVersions('2.1.0', '2.1.0-beta.1'), 1);
  assert.equal(compareVersions('2.1.0-beta.1', '2.1.0-beta.2'), -1);
});

test('un texto que no es una versión no hace comparaciones absurdas', () => {
  assert.equal(parseVersion('no-soy-una-version'), null);
  assert.equal(compareVersions('2.1.0', 'ultima'), 0);
});

test('elige el archivo que le toca a cada sistema', () => {
  // En Windows, el instalador antes que el portable.
  assert.equal(pickAsset(release('v2.1.0', ASSETS).assets, 'win32').name,
    'Comparador.de.BD.Setup.2.1.0.exe');
  assert.equal(pickAsset(release('v2.1.0', ASSETS).assets, 'linux').name,
    'Comparador.de.BD-2.1.0.AppImage');
  assert.equal(pickAsset(release('v2.1.0', ['app-2.1.0.dmg']).assets, 'darwin').name,
    'app-2.1.0.dmg');
});

test('los archivos auxiliares nunca se ofrecen como descarga', () => {
  const assets = release('v2.1.0', ['latest.yml', 'app.exe.blockmap']).assets;
  assert.equal(pickAsset(assets, 'win32'), null);
});

test('sin archivo para ese sistema devuelve null, no uno de otro', () => {
  const assets = release('v2.1.0', ['pg-compare_2.1.0_amd64.deb']).assets;
  assert.equal(pickAsset(assets, 'darwin'), null);
});

test('detecta que hay una versión nueva', async () => {
  const update = await checkForUpdate({
    repo: 'acme/app',
    currentVersion: '2.0.0',
    platform: 'win32',
    fetchImpl: fakeFetch(release('v2.1.0', ASSETS)),
  });

  assert.equal(update.version, '2.1.0');
  assert.equal(update.url, 'https://github.com/acme/app/releases/tag/v2.1.0');
  assert.equal(update.asset.name, 'Comparador.de.BD.Setup.2.1.0.exe');
  assert.match(update.notes, /Novedades/);
});

test('no avisa si ya está al día ni si la release es más vieja', async () => {
  const base = { repo: 'acme/app', platform: 'linux' };
  assert.equal(await checkForUpdate({
    ...base, currentVersion: '2.1.0', fetchImpl: fakeFetch(release('v2.1.0', ASSETS)),
  }), null);
  assert.equal(await checkForUpdate({
    ...base, currentVersion: '2.2.0', fetchImpl: fakeFetch(release('v2.1.0', ASSETS)),
  }), null);
});

test('ignora borradores y versiones de prueba', async () => {
  const borrador = { ...release('v3.0.0', ASSETS), draft: true };
  const prueba = { ...release('v3.0.0', ASSETS), prerelease: true };

  assert.equal(await checkForUpdate({
    repo: 'acme/app', currentVersion: '2.0.0', fetchImpl: fakeFetch(borrador),
  }), null);
  assert.equal(await checkForUpdate({
    repo: 'acme/app', currentVersion: '2.0.0', fetchImpl: fakeFetch(prueba),
  }), null);
});

test('un repositorio sin releases no es un error', async () => {
  assert.equal(await checkForUpdate({
    repo: 'acme/app', currentVersion: '2.0.0', fetchImpl: fakeFetch(null, { status: 404 }),
  }), null);
});

test('un fallo de GitHub se reporta como error entendible', async () => {
  await assert.rejects(
    () => checkForUpdate({
      repo: 'acme/app', currentVersion: '2.0.0', fetchImpl: fakeFetch(null, { status: 503 }),
    }),
    /GitHub respondió 503/,
  );
});

test('una etiqueta con formato raro no dispara el aviso', async () => {
  assert.equal(await checkForUpdate({
    repo: 'acme/app', currentVersion: '2.0.0', fetchImpl: fakeFetch(release('produccion')),
  }), null);
});

test('deduce el repositorio del package.json', () => {
  assert.equal(repoFromPackage({
    repository: { type: 'git', url: 'https://github.com/Dasanchez1992/pg_compare.git' },
  }), 'Dasanchez1992/pg_compare');
  assert.equal(repoFromPackage({ repository: 'git@github.com:acme/app.git' }), 'acme/app');
  assert.equal(repoFromPackage({}), null);
});
