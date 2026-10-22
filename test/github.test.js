'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePrRefs, fetchPullRequest, testGithub } = require('../electron/core/github');

/** Respuesta mínima con la forma de `fetch`. */
const respuesta = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

test('reconoce las formas de escribir un PR y quita los repetidos', () => {
  const refs = parsePrRefs(`
    https://github.com/acme/odoo-int/pull/12/files
    acme/odoo-int#13, acme/odoo-int/pull/14
    #15  16
    acme/odoo-int#12
  `, 'acme/odoo-int');

  assert.deepEqual(refs.map((r) => r.ref), [
    'acme/odoo-int#12', 'acme/odoo-int#13', 'acme/odoo-int#14',
    'acme/odoo-int#15', 'acme/odoo-int#16',
  ]);
  assert.deepEqual(refs[0], { repo: 'acme/odoo-int', number: 12, ref: 'acme/odoo-int#12' });
});

test('un número suelto sin repositorio por defecto es un error que lo explica', () => {
  assert.throws(() => parsePrRefs('#15'), /falta el repositorio/);
  assert.throws(() => parsePrRefs('acme/odoo-int#1 cualquier-cosa'), /cualquier-cosa/);
});

test('lee el PR con todos sus archivos, página a página, con el token', async () => {
  const urls = [];
  const auth = [];
  const archivos = (n, desde) => Array.from({ length: n }, (_, i) => ({
    filename: `models/f${desde + i}.py`, status: 'modified', additions: 1, deletions: 0, patch: '+x',
  }));
  const fetchImpl = async (url, { headers }) => {
    urls.push(url);
    auth.push(headers.Authorization);
    if (url.endsWith('/pulls/7')) {
      return respuesta(200, {
        title: 'SII', body: 'Integra el SII', state: 'closed', merged_at: '2026-01-01',
        html_url: 'https://github.com/acme/odoo-int/pull/7', user: { login: 'ana' },
        base: { ref: '17.0' }, head: { ref: 'sii' },
      });
    }
    return respuesta(200, /page=1$/.test(url) ? archivos(100, 0) : archivos(5, 100));
  };

  const pr = await fetchPullRequest({ repo: 'acme/odoo-int', number: 7, ref: 'acme/odoo-int#7' },
    { token: 'tok', fetchImpl });

  assert.equal(pr.state, 'merged');
  assert.equal(pr.files.length, 105);
  assert.equal(pr.files[104].filename, 'models/f104.py');
  assert.equal(urls.length, 3);
  assert.ok(auth.every((h) => h === 'Bearer tok'));
});

test('los errores de GitHub dicen qué pasó', async () => {
  const ref = { repo: 'acme/privado', number: 1, ref: 'acme/privado#1' };
  await assert.rejects(
    fetchPullRequest(ref, { fetchImpl: async () => respuesta(404, {}) }),
    /acme\/privado#1: no existe o el token no tiene acceso/,
  );
  await assert.rejects(
    fetchPullRequest(ref, { token: 'x', fetchImpl: async () => respuesta(401, {}) }),
    /rechazó el token/,
  );
  await assert.rejects(
    fetchPullRequest(ref, {
      fetchImpl: async () => respuesta(403, {}, { 'x-ratelimit-remaining': '0' }),
    }),
    /límite de consultas/,
  );
});

test('avisa si el token es de otra cuenta', async () => {
  const fetchImpl = async () => respuesta(200, { login: 'pedro' });
  const otro = await testGithub({ user: 'ana', token: 't', fetchImpl });
  assert.equal(otro.ok, false);
  assert.match(otro.message, /"pedro"/);

  const mismo = await testGithub({ user: 'Pedro', token: 't', fetchImpl });
  assert.equal(mismo.ok, true);
});
