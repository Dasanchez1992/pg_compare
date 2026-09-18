'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, normalizeConnection } = require('../electron/core/store');

let counter = 0;
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgcompare-test-'));
  // Reloj determinista para poder comparar fechas en las pruebas.
  const now = () => `2026-01-01T00:00:${String(counter++).padStart(2, '0')}.000Z`;
  return { store: new Store(dir, { now }), dir };
}

const conexion = (extra = {}) => ({
  name: 'QA', host: 'localhost', port: 5432, dbname: 'app',
  user: 'postgres', password: 'secreta', schema: 'public', ...extra,
});

const resultado = () => ({
  rows: [{ id: 'x', name: 'c', table: 't', type: 'Columna', status: 'Nuevo' }],
  sqlById: { x: 'ALTER TABLE "t" ADD COLUMN "c" text;' },
  totalChanges: 1,
});

test('guarda conexiones y nunca devuelve la contraseña a la interfaz', () => {
  const { store } = newStore();
  const saved = store.saveConnection(conexion());

  assert.equal(saved.name, 'QA');
  assert.equal(saved.password, undefined);
  assert.equal(saved.hasPassword, true);
  assert.equal(store.credentials(saved.id).password, 'secreta');
});

test('al editar sin escribir contraseña se conserva la anterior', () => {
  const { store } = newStore();
  const saved = store.saveConnection(conexion());

  store.saveConnection({ ...conexion({ dbname: 'otra' }), id: saved.id, password: '' });

  const creds = store.credentials(saved.id);
  assert.equal(creds.dbname, 'otra');
  assert.equal(creds.password, 'secreta');
});

test('los nombres de conexión no se repiten', () => {
  const { store } = newStore();
  store.saveConnection(conexion());
  assert.throws(() => store.saveConnection(conexion({ host: 'otro' })), /Ya existe una conexión/);
});

test('los datos sobreviven al reinicio de la app', () => {
  const { store, dir } = newStore();
  const qa = store.saveConnection(conexion());
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  store.saveProject({ name: 'QA vs PROD', db1Id: qa.id, db2Id: prod.id });

  const reabierto = new Store(dir);
  assert.equal(reabierto.listConnections().length, 2);
  assert.equal(reabierto.listProjects()[0].name, 'QA vs PROD');
  assert.equal(reabierto.stats().connections, 2);
});

test('un proyecto necesita dos bases distintas', () => {
  const { store } = newStore();
  const qa = store.saveConnection(conexion());
  assert.throws(() => store.saveProject({ name: 'X', db1Id: qa.id, db2Id: qa.id }), /distintas/);
  assert.throws(() => store.saveProject({ name: '', db1Id: qa.id, db2Id: 2 }), /nombre/);
});

test('borrar una conexión se lleva sus proyectos y desliga el historial', () => {
  const { store } = newStore();
  const qa = store.saveConnection(conexion());
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  const project = store.saveProject({ name: 'QA vs PROD', db1Id: qa.id, db2Id: prod.id });
  const run = store.createRun({
    projectId: project.id,
    db1: store.credentials(qa.id),
    db2: store.credentials(prod.id),
    result: resultado(),
  });

  const { deletedProjects } = store.deleteConnection(qa.id);

  assert.equal(deletedProjects, 1);
  assert.equal(store.listProjects().length, 0);
  const survivor = store.getRun(run.id);
  assert.equal(survivor.db1Id, null);         // la comparación se conserva
  assert.equal(survivor.db1Name, 'QA');       // con el nombre que tenía
  assert.equal(survivor.canRerun, false);     // pero ya no se puede repetir
});

test('borrar un proyecto conserva sus comparaciones como ad hoc', () => {
  const { store } = newStore();
  const qa = store.saveConnection(conexion());
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  const project = store.saveProject({ name: 'P', db1Id: qa.id, db2Id: prod.id });
  const run = store.createRun({
    projectId: project.id,
    db1: store.credentials(qa.id),
    db2: store.credentials(prod.id),
    result: resultado(),
  });

  store.deleteProject(project.id);

  const survivor = store.getRun(run.id);
  assert.equal(survivor.projectId, null);
  assert.equal(survivor.canRerun, true);      // las conexiones siguen ahí
});

test('el historial guarda el resultado y luego el script', () => {
  const { store } = newStore();
  const qa = store.saveConnection(conexion({ schema: 'ventas' }));
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  const run = store.createRun({
    db1: store.credentials(qa.id),
    db2: store.credentials(prod.id),
    result: resultado(),
  });

  assert.equal(run.totalChanges, 1);
  assert.equal(run.db1Schema, 'ventas');
  assert.equal(run.hasScript, false);

  const conScript = store.saveScript(run.id, '-- script', ['x']);
  assert.equal(conScript.script, '-- script');
  assert.deepEqual(conScript.selectedIds, ['x']);
  assert.equal(store.listRuns()[0].hasScript, true);
  assert.equal(store.listRuns()[0].selectedCount, 1);
});

test('el historial va del más reciente al más viejo y se filtra por proyecto', () => {
  const { store } = newStore();
  const qa = store.saveConnection(conexion());
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  const project = store.saveProject({ name: 'P', db1Id: qa.id, db2Id: prod.id });
  const pair = { db1: store.credentials(qa.id), db2: store.credentials(prod.id) };

  const primera = store.createRun({ ...pair, result: resultado() });
  const segunda = store.createRun({ ...pair, projectId: project.id, result: resultado() });

  assert.deepEqual(store.listRuns().map((r) => r.id), [segunda.id, primera.id]);
  assert.deepEqual(store.listRuns({ projectId: project.id }).map((r) => r.id), [segunda.id]);
  assert.equal(store.listRuns({ projectId: project.id })[0].projectName, 'P');
});

test('borrar una comparación borra también su archivo pesado', () => {
  const { store, dir } = newStore();
  const qa = store.saveConnection(conexion());
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  const run = store.createRun({
    db1: store.credentials(qa.id),
    db2: store.credentials(prod.id),
    result: resultado(),
  });
  const file = path.join(dir, 'runs', `${run.id}.json`);
  assert.ok(fs.existsSync(file));

  store.deleteRun(run.id);

  assert.equal(store.listRuns().length, 0);
  assert.equal(fs.existsSync(file), false);
});

test('repetir una comparación usa las conexiones del proyecto si las suyas ya no están', () => {
  const { store } = newStore();
  const qa = store.saveConnection(conexion());
  const prod = store.saveConnection(conexion({ name: 'PROD' }));
  const project = store.saveProject({ name: 'P', db1Id: qa.id, db2Id: prod.id });
  const run = store.createRun({
    projectId: project.id,
    db1: { id: 999, name: 'vieja', schema: 'public' },
    db2: { id: 998, name: 'otra', schema: 'public' },
    result: resultado(),
  });

  const pair = store.rerunPair(store.getRun(run.id));
  assert.deepEqual([pair.db1Id, pair.db2Id], [qa.id, prod.id]);
});

test('un data.json corrupto se aparta en vez de romper la app', () => {
  const { store, dir } = newStore();
  store.saveConnection(conexion());
  fs.writeFileSync(path.join(dir, 'data.json'), '{ esto no es json', 'utf8');

  const recuperado = new Store(dir);

  assert.equal(recuperado.listConnections().length, 0);
  assert.match(recuperado.loadError, /No se pudo leer/);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('corrupto')));
});

test('normalizeConnection valida los datos del formulario', () => {
  assert.throws(() => normalizeConnection({ ...conexion(), name: '  ' }), /Nombre/);
  assert.throws(() => normalizeConnection({ ...conexion(), port: 'abc' }), /puerto/);
  assert.throws(() => normalizeConnection({ ...conexion(), port: 99999 }), /puerto/);

  const limpio = normalizeConnection({ ...conexion({ schema: '  ' }), name: ' QA ' });
  assert.equal(limpio.name, 'QA');
  assert.equal(limpio.schema, 'public');
  assert.equal(limpio.ssl, false);
});

// --- Ajustes ---------------------------------------------------------------

test('los ajustes tienen valores por defecto y se guardan', () => {
  const { store, dir } = newStore();

  assert.deepEqual(store.settings().updates,
    { enabled: true, skippedVersion: null, lastCheck: null });

  store.updateSettings('updates', { enabled: false, skippedVersion: '2.2.0' });

  const reabierto = new Store(dir);
  assert.equal(reabierto.settings().updates.enabled, false);
  assert.equal(reabierto.settings().updates.skippedVersion, '2.2.0');
  assert.equal(reabierto.settings().updates.lastCheck, null);   // lo no tocado se conserva
});

test('un ajuste desconocido no se guarda a lo loco', () => {
  const { store } = newStore();
  assert.throws(() => store.updateSettings('inventado', { x: 1 }), /Ajuste desconocido/);
});

test('un data.json viejo, sin ajustes, sigue funcionando', () => {
  const { store, dir } = newStore();
  store.saveConnection(conexion());
  const crudo = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  delete crudo.settings;                       // como lo escribía la versión anterior
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(crudo), 'utf8');

  const reabierto = new Store(dir);
  assert.equal(reabierto.settings().updates.enabled, true);
  assert.equal(reabierto.listConnections().length, 1);
});
