'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Schema } = require('../electron/core/schema');
const { compare, buildScript, createTableSql } = require('../electron/core/diff');

const col = (ordinal, dataType, notNull = false, def = null) => ({
  ordinal, dataType, notNull, default: def,
});

/** Par de esquemas sintéticos: source = BD2 (referencia), target = BD1. */
function schemas() {
  const source = new Schema('ventas');
  source.addColumn('clientes', 'id', col(1, 'integer', true, "nextval('clientes_id_seq'::regclass)"));
  source.addColumn('clientes', 'nombre', col(2, 'character varying(100)', true));
  source.addColumn('clientes', 'email', col(3, 'text'));
  source.addIndex('clientes', 'idx_nombre', 'CREATE INDEX idx_nombre ON clientes USING btree (nombre)');
  source.addConstraint('clientes', 'clientes_pkey', 'PRIMARY KEY', 'PRIMARY KEY (id)');
  source.addConstraint('clientes', 'chk_email', 'CHECK', "CHECK (email <> ''::text)");

  const target = new Schema('ventas');
  target.addColumn('clientes', 'id', col(1, 'integer', true, "nextval('clientes_id_seq'::regclass)"));
  target.addColumn('clientes', 'nombre', col(2, 'character varying(100)', true));
  target.addIndex('clientes', 'idx_nombre', 'CREATE INDEX idx_nombre ON clientes USING btree (lower(nombre))');
  target.addConstraint('clientes', 'clientes_pkey', 'PRIMARY KEY', 'PRIMARY KEY (id)');
  target.addConstraint('clientes', 'chk_email', 'CHECK', 'CHECK (length(email) > 3)');
  return { source, target };
}

test('detecta columna nueva e índices y constraints modificados', () => {
  const { source, target } = schemas();
  const result = compare({ source, target, db1Name: 'qa', db2Name: 'prod' });

  assert.equal(result.totalChanges, 3);
  assert.deepEqual(new Set(Object.keys(result.sqlById)), new Set([
    'col_add:clientes:email',
    'idx_alter:clientes:idx_nombre',
    'con_alter:clientes:chk_email',
  ]));
});

test('la columna nueva se agrega con su tipo', () => {
  const { source, target } = schemas();
  const result = compare({ source, target });
  assert.equal(
    result.sqlById['col_add:clientes:email'],
    'ALTER TABLE "clientes" ADD COLUMN "email" text;',
  );
});

test('el índice modificado se recrea', () => {
  const { source, target } = schemas();
  const result = compare({ source, target });
  assert.equal(
    result.sqlById['idx_alter:clientes:idx_nombre'],
    'DROP INDEX "idx_nombre";\nCREATE INDEX idx_nombre ON clientes USING btree (nombre);',
  );
});

test('el constraint modificado se recrea', () => {
  const { source, target } = schemas();
  const result = compare({ source, target });
  assert.equal(
    result.sqlById['con_alter:clientes:chk_email'],
    'ALTER TABLE "clientes" DROP CONSTRAINT "chk_email";\n'
    + 'ALTER TABLE "clientes" ADD CONSTRAINT "chk_email" CHECK (email <> \'\'::text);',
  );
});

test('sin diferencias cuando se compara un esquema consigo mismo', () => {
  const { source } = schemas();
  assert.equal(compare({ source, target: source }).totalChanges, 0);
});

test('las sentencias destructivas se generan comentadas', () => {
  const { source, target } = schemas();
  target.addColumn('clientes', 'obsoleta', col(9, 'text'));
  target.addColumn('vieja', 'id', col(1, 'integer'));
  target.addIndex('clientes', 'idx_viejo', 'CREATE INDEX idx_viejo ON clientes USING btree (id)');
  target.addConstraint('clientes', 'con_viejo', 'UNIQUE', 'UNIQUE (nombre)');

  const result = compare({ source, target });
  const destructivos = result.rows.filter((r) => r.destructive).map((r) => r.id);

  assert.deepEqual(destructivos.sort(), [
    'col_drop:clientes:obsoleta',
    'con_drop:clientes:con_viejo',
    'idx_drop:clientes:idx_viejo',
    'tbl_drop:vieja',
  ]);
  for (const id of destructivos) {
    assert.match(result.sqlById[id], /^-- /, `${id} debería ir comentado`);
  }
});

test('una tabla nueva se crea entera, con constraints e índices, y no se duplica', () => {
  const { source, target } = schemas();
  source.addColumn('pedidos', 'id', col(1, 'integer', true, "nextval('pedidos_id_seq'::regclass)"));
  source.addColumn('pedidos', 'total', col(2, 'numeric(10,2)', true, '0'));
  source.addConstraint('pedidos', 'pedidos_pkey', 'PRIMARY KEY', 'PRIMARY KEY (id)');
  source.addConstraint('pedidos', 'pedidos_total_check', 'CHECK', 'CHECK (total >= 0)');
  source.addIndex('pedidos', 'idx_total', 'CREATE INDEX idx_total ON pedidos USING btree (total)');

  const result = compare({ source, target });
  const ids = Object.keys(result.sqlById);

  assert.ok(ids.includes('tbl_add:pedidos'));
  // Sus índices y constraints ya van dentro del CREATE TABLE.
  assert.ok(!ids.some((id) => id.startsWith('idx_add:pedidos')));
  assert.ok(!ids.some((id) => id.startsWith('con_add:pedidos')));

  assert.equal(result.sqlById['tbl_add:pedidos'], [
    'CREATE TABLE "pedidos" (',
    '\t"id" serial NOT NULL,',              // default nextval -> serial
    '\t"total" numeric(10,2) NOT NULL DEFAULT 0,',
    '\tCONSTRAINT "pedidos_pkey" PRIMARY KEY (id),',
    '\tCONSTRAINT "pedidos_total_check" CHECK (total >= 0)',
    ');',
    'CREATE INDEX idx_total ON pedidos USING btree (total);',
  ].join('\n'));
});

test('detecta cambios de tipo, NOT NULL y default en una misma columna', () => {
  const source = new Schema('public');
  source.addColumn('t', 'c', col(1, 'text', true, "'x'::text"));
  const target = new Schema('public');
  target.addColumn('t', 'c', col(1, 'integer', false, null));

  const result = compare({ source, target });
  assert.deepEqual(Object.keys(result.sqlById), [
    'col_type:t:c', 'col_null:t:c', 'col_def:t:c',
  ]);
  assert.equal(result.sqlById['col_type:t:c'],
    'ALTER TABLE "t" ALTER COLUMN "c" TYPE text USING "c"::text;');
  assert.equal(result.sqlById['col_null:t:c'],
    'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;');
  assert.equal(result.sqlById['col_def:t:c'],
    'ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT \'x\'::text;');

  const detalles = Object.fromEntries(result.rows.map((r) => [r.id, r.detail]));
  assert.equal(detalles['col_null:t:c'], 'NOT NULL: no → sí');
  assert.equal(detalles['col_def:t:c'], "default: (ninguno) → 'x'::text");
});

test('quitar el default genera DROP DEFAULT', () => {
  const source = new Schema('public');
  source.addColumn('t', 'c', col(1, 'text'));
  const target = new Schema('public');
  target.addColumn('t', 'c', col(1, 'text', false, "'x'::text"));

  const result = compare({ source, target });
  assert.equal(result.sqlById['col_def:t:c'],
    'ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;');
});

test('los identificadores con comillas se escapan', () => {
  const source = new Schema('public');
  const target = new Schema('public');
  target.addColumn('ra"ra', 'id', col(1, 'integer'));

  const result = compare({ source, target });
  assert.equal(result.sqlById['tbl_drop:ra"ra'], '-- DROP TABLE "ra""ra";');
});

test('el orden de las filas es estable y agrupado', () => {
  const source = new Schema('public');
  source.addColumn('b', 'x', col(1, 'text'));
  source.addColumn('a', 'y', col(1, 'text'));
  source.addColumn('a', 'z', col(2, 'text'));
  const target = new Schema('public');
  target.addColumn('a', 'y', col(1, 'text'));

  const result = compare({ source, target });
  // Primero la tabla nueva, después las columnas de las tablas comunes.
  assert.deepEqual(Object.keys(result.sqlById), ['tbl_add:b', 'col_add:a:z']);
});

test('buildScript fija el search_path y filtra la selección', () => {
  const { source, target } = schemas();
  const result = compare({ source, target });
  const script = buildScript({
    db1Name: 'qa',
    db2Name: 'prod',
    sqlById: result.sqlById,
    selectedIds: ['idx_alter:clientes:idx_nombre'],
    schema: 'ventas',
  });

  assert.match(script, /SET LOCAL search_path TO "ventas";/);
  assert.match(script, /BEGIN;/);
  assert.match(script, /COMMIT;/);
  assert.match(script, /DROP INDEX "idx_nombre";/);
  assert.doesNotMatch(script, /chk_email/);
});

test('buildScript sin selección deja constancia', () => {
  const script = buildScript({
    db1Name: 'qa', db2Name: 'prod', sqlById: { x: 'ALTER;' }, selectedIds: [],
  });
  assert.match(script, /-- \(No se seleccionó ningún cambio\)/);
  assert.doesNotMatch(script, /^ALTER;$/m);
});

test('buildScript respeta el orden canónico, no el de la selección', () => {
  const sqlById = { a: 'A;', b: 'B;', c: 'C;' };
  const script = buildScript({
    db1Name: '1', db2Name: '2', sqlById, selectedIds: ['c', 'a'],
  });
  assert.ok(script.indexOf('A;') < script.indexOf('C;'));
  assert.doesNotMatch(script, /B;/);
});

test('createTableSql ordena las columnas por posición y los constraints por tipo', () => {
  const source = new Schema('public');
  source.addColumn('t', 'segunda', col(2, 'text'));
  source.addColumn('t', 'primera', col(1, 'integer'));
  source.addConstraint('t', 'fk', 'FOREIGN KEY', 'FOREIGN KEY (primera) REFERENCES otra(id)');
  source.addConstraint('t', 'pk', 'PRIMARY KEY', 'PRIMARY KEY (primera)');

  assert.equal(createTableSql('t', source), [
    'CREATE TABLE "t" (',
    '\t"primera" integer,',
    '\t"segunda" text,',
    '\tCONSTRAINT "pk" PRIMARY KEY (primera),',
    '\tCONSTRAINT "fk" FOREIGN KEY (primera) REFERENCES otra(id)',
    ');',
  ].join('\n'));
});
