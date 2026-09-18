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

// --- Comentarios de las columnas (COMMENT ON COLUMN) ----------------------

test('detecta un comentario nuevo, uno cambiado y uno quitado', () => {
  const source = new Schema('public');
  source.addColumn('t', 'nuevo', { ...col(1, 'text'), comment: 'documentada' });
  source.addColumn('t', 'cambiado', { ...col(2, 'text'), comment: 'texto nuevo' });
  source.addColumn('t', 'quitado', col(3, 'text'));

  const target = new Schema('public');
  target.addColumn('t', 'nuevo', col(1, 'text'));
  target.addColumn('t', 'cambiado', { ...col(2, 'text'), comment: 'texto viejo' });
  target.addColumn('t', 'quitado', { ...col(3, 'text'), comment: 'sobra' });

  const result = compare({ source, target });

  assert.deepEqual(Object.keys(result.sqlById), [
    'col_comment:t:cambiado', 'col_comment:t:nuevo', 'col_comment:t:quitado',
  ]);
  assert.equal(result.sqlById['col_comment:t:nuevo'],
    'COMMENT ON COLUMN "t"."nuevo" IS \'documentada\';');
  assert.equal(result.sqlById['col_comment:t:cambiado'],
    'COMMENT ON COLUMN "t"."cambiado" IS \'texto nuevo\';');
  // Quitar un comentario en PostgreSQL es asignarle NULL.
  assert.equal(result.sqlById['col_comment:t:quitado'],
    'COMMENT ON COLUMN "t"."quitado" IS NULL;');
});

test('un comentario igual no genera diferencia', () => {
  const source = new Schema('public');
  source.addColumn('t', 'c', { ...col(1, 'text'), comment: 'misma' });
  const target = new Schema('public');
  target.addColumn('t', 'c', { ...col(1, 'text'), comment: 'misma' });

  assert.equal(compare({ source, target }).totalChanges, 0);
});

test('las comillas dentro de un comentario se escapan', () => {
  const source = new Schema('public');
  source.addColumn('t', 'c', { ...col(1, 'text'), comment: "el 'código' del cliente" });
  const target = new Schema('public');
  target.addColumn('t', 'c', col(1, 'text'));

  assert.equal(compare({ source, target }).sqlById['col_comment:t:c'],
    'COMMENT ON COLUMN "t"."c" IS \'el \'\'código\'\' del cliente\';');
});

test('una columna nueva se crea con su comentario en la misma sentencia', () => {
  const source = new Schema('public');
  source.addColumn('t', 'vieja', col(1, 'text'));
  source.addColumn('t', 'nueva', { ...col(2, 'text'), comment: 'recién documentada' });
  const target = new Schema('public');
  target.addColumn('t', 'vieja', col(1, 'text'));

  assert.equal(compare({ source, target }).sqlById['col_add:t:nueva'], [
    'ALTER TABLE "t" ADD COLUMN "nueva" text;',
    'COMMENT ON COLUMN "t"."nueva" IS \'recién documentada\';',
  ].join('\n'));
});

test('una tabla nueva arrastra los comentarios de sus columnas', () => {
  const source = new Schema('public');
  source.addColumn('nueva', 'id', { ...col(1, 'integer', true), comment: 'clave' });
  source.addColumn('nueva', 'sin_doc', col(2, 'text'));
  source.addColumn('nueva', 'dato', { ...col(3, 'text'), comment: 'el dato' });
  const target = new Schema('public');

  assert.equal(compare({ source, target }).sqlById['tbl_add:nueva'], [
    'CREATE TABLE "nueva" (',
    '\t"id" integer NOT NULL,',
    '\t"sin_doc" text,',
    '\t"dato" text',
    ');',
    'COMMENT ON COLUMN "nueva"."id" IS \'clave\';',
    'COMMENT ON COLUMN "nueva"."dato" IS \'el dato\';',
  ].join('\n'));
});

test('el comentario se compara junto al resto de atributos de la columna', () => {
  const source = new Schema('public');
  source.addColumn('t', 'c', { ...col(1, 'text', true), comment: 'nueva doc' });
  const target = new Schema('public');
  target.addColumn('t', 'c', col(1, 'integer'));

  // Orden dentro del grupo: tipo, NOT NULL, default y por último el comentario.
  assert.deepEqual(Object.keys(compare({ source, target }).sqlById), [
    'col_type:t:c', 'col_null:t:c', 'col_comment:t:c',
  ]);
});

// --- Orden por dependencias entre tablas nuevas ----------------------------

/** Tabla nueva con su PK y, opcionalmente, claves foráneas a otras tablas. */
function tablaNueva(schema, nombre, referencias = []) {
  schema.addColumn(nombre, 'id', col(1, 'integer', true));
  schema.addConstraint(nombre, `${nombre}_pkey`, 'PRIMARY KEY', 'PRIMARY KEY (id)');
  referencias.forEach((destino, i) => {
    schema.addColumn(nombre, `${destino}_id`, col(i + 2, 'integer'));
    schema.addConstraint(
      nombre, `fk_${nombre}_${destino}`, 'FOREIGN KEY',
      `FOREIGN KEY (${destino}_id) REFERENCES ${destino}(id)`,
      { schema: schema.schemaName, table: destino },
    );
  });
}

/** Orden en que el script crea las tablas nuevas. */
function ordenDeCreacion(source, target = new Schema(source.schemaName)) {
  return Object.keys(compare({ source, target }).sqlById)
    .filter((id) => id.startsWith('tbl_add:'))
    .map((id) => id.slice('tbl_add:'.length));
}

test('la tabla referenciada se crea antes que la que la referencia', () => {
  const source = new Schema('ventas');
  tablaNueva(source, 'a_hijo', ['z_padre']);   // alfabéticamente iría primero
  tablaNueva(source, 'z_padre');

  assert.deepEqual(ordenDeCreacion(source), ['z_padre', 'a_hijo']);
});

test('ordena cadenas de dependencias de varios niveles', () => {
  const source = new Schema('ventas');
  tablaNueva(source, 'a_factura', ['m_pedido']);
  tablaNueva(source, 'm_pedido', ['z_cliente']);
  tablaNueva(source, 'z_cliente');

  assert.deepEqual(ordenDeCreacion(source), ['z_cliente', 'm_pedido', 'a_factura']);
});

test('las tablas independientes conservan el orden alfabético', () => {
  const source = new Schema('ventas');
  tablaNueva(source, 'c_uno');
  tablaNueva(source, 'a_dos');
  tablaNueva(source, 'b_tres');

  assert.deepEqual(ordenDeCreacion(source), ['a_dos', 'b_tres', 'c_uno']);
});

test('una autorreferencia no es un ciclo: se queda dentro del CREATE TABLE', () => {
  const source = new Schema('ventas');
  source.addColumn('empleados', 'id', col(1, 'integer', true));
  source.addColumn('empleados', 'jefe_id', col(2, 'integer'));
  source.addConstraint('empleados', 'empleados_pkey', 'PRIMARY KEY', 'PRIMARY KEY (id)');
  source.addConstraint('empleados', 'fk_jefe', 'FOREIGN KEY',
    'FOREIGN KEY (jefe_id) REFERENCES empleados(id)', { schema: 'ventas', table: 'empleados' });

  const result = compare({ source, target: new Schema('ventas') });
  assert.match(result.sqlById['tbl_add:empleados'], /CONSTRAINT "fk_jefe" FOREIGN KEY/);
  assert.ok(!Object.keys(result.sqlById).some((id) => id.startsWith('con_add:')));
});

test('dos tablas que se referencian entre sí: se crean y las FK van después', () => {
  const source = new Schema('ventas');
  tablaNueva(source, 'a_uno', ['b_dos']);
  tablaNueva(source, 'b_dos', ['a_uno']);

  const result = compare({ source, target: new Schema('ventas') });
  const ids = Object.keys(result.sqlById);

  // Las dos tablas se crean antes que cualquier ALTER que añada una FK.
  const ultimoCreate = Math.max(ids.indexOf('tbl_add:a_uno'), ids.indexOf('tbl_add:b_dos'));
  const primerFk = ids.findIndex((id) => id.startsWith('con_add:'));
  assert.ok(primerFk > ultimoCreate, 'las claves foráneas deben ir tras los CREATE TABLE');

  // Al menos una de las dos sale del CREATE para romper el ciclo.
  const fks = ids.filter((id) => id.startsWith('con_add:'));
  assert.equal(fks.length, 1);
  assert.match(result.sqlById[fks[0]], /ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY/);
  // Y esa ya no aparece dentro de su CREATE TABLE.
  const [, tabla, nombre] = fks[0].split(':');
  assert.ok(!result.sqlById[`tbl_add:${tabla}`].includes(nombre));
});

test('una clave foránea a una tabla que ya existe no altera el orden', () => {
  const source = new Schema('ventas');
  tablaNueva(source, 'a_nueva', ['z_existente']);
  tablaNueva(source, 'z_existente');
  const target = new Schema('ventas');
  tablaNueva(target, 'z_existente');            // esta ya está en el destino

  assert.deepEqual(ordenDeCreacion(source, target), ['a_nueva']);
  const result = compare({ source, target });
  assert.match(result.sqlById['tbl_add:a_nueva'], /CONSTRAINT "fk_a_nueva_z_existente"/);
});

test('una clave foránea a otro esquema no cuenta como dependencia', () => {
  const source = new Schema('ventas');
  tablaNueva(source, 'a_hijo');
  source.addConstraint('a_hijo', 'fk_externa', 'FOREIGN KEY',
    'FOREIGN KEY (id) REFERENCES publico.otra(id)', { schema: 'publico', table: 'z_padre' });
  tablaNueva(source, 'z_padre');

  // Apunta a "z_padre" pero de otro esquema: no debe reordenar nada.
  assert.deepEqual(ordenDeCreacion(source), ['a_hijo', 'z_padre']);
});

// --- Vistas ----------------------------------------------------------------

const VISTA = 'SELECT id,\n    nombre\n   FROM clientes\n  WHERE activo;';

test('una vista nueva se crea entera', () => {
  const source = new Schema('ventas');
  source.addView('clientes_activos', VISTA);
  const result = compare({ source, target: new Schema('ventas'), db2Name: 'prod' });

  assert.equal(result.sqlById['view_add:clientes_activos'],
    `CREATE VIEW "clientes_activos" AS\n${VISTA}`);
  const fila = result.rows.find((r) => r.id === 'view_add:clientes_activos');
  assert.equal(fila.type, 'Vista');
  assert.equal(fila.detail, '4 líneas · solo existe en prod');
});

test('una vista con otra definición se reemplaza sin borrarla', () => {
  const source = new Schema('ventas');
  source.addView('v', 'SELECT 1;');
  const target = new Schema('ventas');
  target.addView('v', 'SELECT 2;');

  const result = compare({ source, target });
  assert.equal(result.sqlById['view_alter:v'], 'CREATE OR REPLACE VIEW "v" AS\nSELECT 1;');
});

test('una vista igual no genera diferencia', () => {
  const source = new Schema('ventas');
  source.addView('v', VISTA);
  const target = new Schema('ventas');
  target.addView('v', VISTA);
  assert.equal(compare({ source, target }).totalChanges, 0);
});

test('la vista que sobra se borra comentada', () => {
  const target = new Schema('ventas');
  target.addView('vieja', 'SELECT 1;');
  const result = compare({ source: new Schema('ventas'), target });

  assert.equal(result.sqlById['view_drop:vieja'], '-- DROP VIEW "vieja";');
  assert.equal(result.rows[0].destructive, true);
});

test('las vistas se crean después de las tablas que leen', () => {
  const source = new Schema('ventas');
  source.addColumn('clientes', 'id', col(1, 'integer'));
  source.addView('a_vista', 'SELECT id FROM clientes;');
  source.addViewDependency('a_vista', 'clientes');

  const ids = Object.keys(compare({ source, target: new Schema('ventas') }).sqlById);
  assert.ok(ids.indexOf('tbl_add:clientes') < ids.indexOf('view_add:a_vista'));
});

test('una vista que lee de otra va después de esa otra', () => {
  const source = new Schema('ventas');
  source.addView('a_encima', 'SELECT * FROM z_base;');
  source.addView('z_base', 'SELECT 1;');
  source.addViewDependency('a_encima', 'z_base');

  const ids = Object.keys(compare({ source, target: new Schema('ventas') }).sqlById);
  assert.deepEqual(ids, ['view_add:z_base', 'view_add:a_encima']);
});

// --- Secuencias ------------------------------------------------------------

const secuencia = (extra = {}) => ({
  dataType: 'bigint', start: '1', min: '1', max: '9223372036854775807',
  increment: '1', cycle: false, cache: '1', ...extra,
});

test('una secuencia nueva se crea con todos sus atributos', () => {
  const source = new Schema('ventas');
  source.addSequence('numeracion', secuencia({ start: '1000' }));

  assert.equal(compare({ source, target: new Schema('ventas') }).sqlById['seq_add:numeracion'], [
    'CREATE SEQUENCE "numeracion"',
    '    AS bigint',
    '    INCREMENT BY 1',
    '    MINVALUE 1',
    '    MAXVALUE 9223372036854775807',
    '    START WITH 1000',
    '    CACHE 1',
    '    NO CYCLE;',
  ].join('\n'));
});

test('solo se alteran los atributos que cambiaron', () => {
  const source = new Schema('ventas');
  source.addSequence('s', secuencia({ increment: '2', start: '100' }));
  const target = new Schema('ventas');
  target.addSequence('s', secuencia());

  const result = compare({ source, target });
  assert.equal(result.sqlById['seq_alter:s'],
    'ALTER SEQUENCE "s" INCREMENT BY 2 START WITH 100;');
  assert.equal(result.rows[0].detail, 'incremento: 1 → 2 · inicio: 1 → 100');
});

test('activar y desactivar el ciclo', () => {
  const source = new Schema('ventas');
  source.addSequence('s', secuencia({ cycle: true }));
  const target = new Schema('ventas');
  target.addSequence('s', secuencia({ cycle: false }));

  assert.equal(compare({ source, target }).sqlById['seq_alter:s'],
    'ALTER SEQUENCE "s" CYCLE;');
  assert.equal(compare({ source: target, target: source }).sqlById['seq_alter:s'],
    'ALTER SEQUENCE "s" NO CYCLE;');
});

test('una secuencia igual no genera diferencia y la que sobra va comentada', () => {
  const source = new Schema('ventas');
  source.addSequence('igual', secuencia());
  const target = new Schema('ventas');
  target.addSequence('igual', secuencia());
  target.addSequence('sobra', secuencia());

  const result = compare({ source, target });
  assert.equal(result.totalChanges, 1);
  assert.equal(result.sqlById['seq_drop:sobra'], '-- DROP SEQUENCE "sobra";');
});

test('las secuencias se crean antes que las tablas, y las vistas al final', () => {
  const source = new Schema('ventas');
  source.addSequence('s', secuencia());
  source.addColumn('t', 'id', col(1, 'integer', false, "nextval('s'::regclass)"));
  source.addView('v', 'SELECT id FROM t;');

  assert.deepEqual(Object.keys(compare({ source, target: new Schema('ventas') }).sqlById),
    ['seq_add:s', 'tbl_add:t', 'view_add:v']);
});

// --- Funciones y procedimientos --------------------------------------------

const FUNCION = 'CREATE OR REPLACE FUNCTION ventas.saludo(quien text)\n'
  + ' RETURNS text\n LANGUAGE sql\nAS $function$ SELECT \'hola \' || quien $function$';

test('una función nueva se crea con la definición del catálogo', () => {
  const source = new Schema('ventas');
  source.addFunction('saludo', 'quien text', { kind: 'FUNCTION', definition: FUNCION });

  const result = compare({ source, target: new Schema('ventas'), db2Name: 'prod' });
  assert.equal(result.sqlById['fn_add:saludo(quien text)'], `${FUNCION};`);
  const fila = result.rows[0];
  assert.equal(fila.type, 'Función');
  assert.equal(fila.name, 'saludo(quien text)');
  assert.equal(fila.detail, 'función · solo existe en prod');
});

test('las sobrecargas se tratan como funciones distintas', () => {
  const source = new Schema('ventas');
  source.addFunction('saludo', 'quien text', { kind: 'FUNCTION', definition: 'A' });
  source.addFunction('saludo', 'quien integer', { kind: 'FUNCTION', definition: 'B' });
  const target = new Schema('ventas');
  target.addFunction('saludo', 'quien text', { kind: 'FUNCTION', definition: 'A' });

  const result = compare({ source, target });
  assert.deepEqual(Object.keys(result.sqlById), ['fn_add:saludo(quien integer)']);
});

test('una función con otro cuerpo se reemplaza', () => {
  const source = new Schema('ventas');
  source.addFunction('f', '', { kind: 'FUNCTION', definition: 'CREATE OR REPLACE FUNCTION f()\nnueva' });
  const target = new Schema('ventas');
  target.addFunction('f', '', { kind: 'FUNCTION', definition: 'CREATE OR REPLACE FUNCTION f()\nvieja' });

  const result = compare({ source, target });
  assert.equal(result.sqlById['fn_alter:f()'], 'CREATE OR REPLACE FUNCTION f()\nnueva;');
  assert.equal(result.rows[0].detail, 'definición distinta (2 líneas → 2 líneas)');
});

test('la función que sobra se borra comentada, con su firma', () => {
  const target = new Schema('ventas');
  target.addFunction('vieja', 'a integer, b text', { kind: 'FUNCTION', definition: 'X' });
  target.addFunction('proc', '', { kind: 'PROCEDURE', definition: 'Y' });

  const result = compare({ source: new Schema('ventas'), target });
  assert.equal(result.sqlById['fn_drop:vieja(a integer, b text)'],
    '-- DROP FUNCTION "vieja"(a integer, b text);');
  assert.equal(result.sqlById['fn_drop:proc()'], '-- DROP PROCEDURE "proc"();');
  assert.equal(result.rows.every((r) => r.destructive), true);
});

// --- Triggers --------------------------------------------------------------

const TRIGGER = 'CREATE TRIGGER t_clientes BEFORE UPDATE ON clientes '
  + 'FOR EACH ROW EXECUTE FUNCTION trg_touch()';

test('un trigger nuevo se crea tal cual', () => {
  const source = new Schema('ventas');
  source.addTrigger('clientes', 't_clientes', TRIGGER);

  const result = compare({ source, target: new Schema('ventas') });
  assert.equal(result.sqlById['trg_add:clientes:t_clientes'], `${TRIGGER};`);
  assert.equal(result.rows[0].type, 'Trigger');
  assert.equal(result.rows[0].table, 'clientes');
});

test('un trigger distinto se recrea (no hay CREATE OR REPLACE portable)', () => {
  const source = new Schema('ventas');
  source.addTrigger('clientes', 't', 'CREATE TRIGGER t BEFORE UPDATE ON clientes nuevo');
  const target = new Schema('ventas');
  target.addTrigger('clientes', 't', 'CREATE TRIGGER t BEFORE INSERT ON clientes viejo');

  assert.equal(compare({ source, target }).sqlById['trg_alter:clientes:t'],
    'DROP TRIGGER "t" ON "clientes";\nCREATE TRIGGER t BEFORE UPDATE ON clientes nuevo;');
});

test('el trigger que sobra se borra comentado', () => {
  const target = new Schema('ventas');
  target.addTrigger('clientes', 'viejo', 'CREATE TRIGGER viejo ...');

  const result = compare({ source: new Schema('ventas'), target });
  assert.equal(result.sqlById['trg_drop:clientes:viejo'],
    '-- DROP TRIGGER "viejo" ON "clientes";');
});

test('el orden del script: función, tabla, trigger y vista', () => {
  const source = new Schema('ventas');
  source.addFunction('trg_touch', '', { kind: 'FUNCTION', definition: 'CREATE FUNCTION trg_touch()' });
  source.addColumn('t', 'id', col(1, 'integer'));
  source.addTrigger('t', 'tr', 'CREATE TRIGGER tr ...');
  source.addView('v', 'SELECT id FROM t;');

  assert.deepEqual(Object.keys(compare({ source, target: new Schema('ventas') }).sqlById), [
    'fn_add:trg_touch()', 'tbl_add:t', 'trg_add:t:tr', 'view_add:v',
  ]);
});

// --- Tablas particionadas --------------------------------------------------

test('una tabla particionada se crea con su PARTITION BY', () => {
  const source = new Schema('ventas');
  source.addTable('facturas', 'RANGE (fecha)');
  source.addColumn('facturas', 'id', col(1, 'bigint', true));
  source.addColumn('facturas', 'fecha', col(2, 'date', true));

  const result = compare({ source, target: new Schema('ventas'), db2Name: 'prod' });
  assert.equal(result.sqlById['tbl_add:facturas'], [
    'CREATE TABLE "facturas" (',
    '\t"id" bigint NOT NULL,',
    '\t"fecha" date NOT NULL',
    ')',
    'PARTITION BY RANGE (fecha);',
  ].join('\n'));
  assert.match(result.rows[0].detail, /^particionada por RANGE \(fecha\) · /);
});

test('una partición se crea colgando de su padre, no como tabla suelta', () => {
  const source = new Schema('ventas');
  source.addTable('facturas', 'RANGE (fecha)');
  source.addColumn('facturas', 'fecha', col(1, 'date', true));
  source.addPartition('facturas_2026', 'facturas', "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')");

  const result = compare({ source, target: new Schema('ventas') });
  assert.equal(result.sqlById['part_add:facturas_2026'],
    'CREATE TABLE "facturas_2026" PARTITION OF "facturas" '
    + "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');");

  const fila = result.rows.find((r) => r.id === 'part_add:facturas_2026');
  assert.equal(fila.type, 'Partición');
  assert.equal(fila.table, 'facturas');    // se agrupa bajo su padre
});

test('la partición por defecto y la de lista salen con sus límites', () => {
  const source = new Schema('ventas');
  source.addTable('t', 'LIST (region)');
  source.addColumn('t', 'region', col(1, 'text'));
  source.addPartition('t_norte', 't', "FOR VALUES IN ('norte')");
  source.addPartition('t_resto', 't', 'DEFAULT');

  const result = compare({ source, target: new Schema('ventas') });
  assert.match(result.sqlById['part_add:t_norte'], /FOR VALUES IN \('norte'\);$/);
  assert.match(result.sqlById['part_add:t_resto'], /PARTITION OF "t" DEFAULT;$/);
});

test('la partición se crea después de su tabla, y la subpartición después de ella', () => {
  const source = new Schema('ventas');
  source.addTable('t', 'LIST (region)');
  source.addColumn('t', 'region', col(1, 'text'));
  source.addPartition('z_norte', 't', "FOR VALUES IN ('norte')", 'RANGE (fecha)');
  source.addPartition('a_norte_2026', 'z_norte', "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')");

  // Alfabéticamente a_norte_2026 iría primero; debe ir detrás de su padre.
  assert.deepEqual(Object.keys(compare({ source, target: new Schema('ventas') }).sqlById),
    ['tbl_add:t', 'part_add:z_norte', 'part_add:a_norte_2026']);
});

test('una subpartición lleva su propio PARTITION BY', () => {
  const source = new Schema('ventas');
  source.addTable('t', 'LIST (region)');
  source.addPartition('t_norte', 't', "FOR VALUES IN ('norte')", 'RANGE (fecha)');

  assert.equal(compare({ source, target: new Schema('ventas') }).sqlById['part_add:t_norte'],
    'CREATE TABLE "t_norte" PARTITION OF "t" FOR VALUES IN (\'norte\')\n'
    + '    PARTITION BY RANGE (fecha);');
});

test('cambiar los límites suelta la partición y la vuelve a enganchar', () => {
  const source = new Schema('ventas');
  source.addTable('t', 'RANGE (fecha)');
  source.addPartition('p', 't', "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')");
  const target = new Schema('ventas');
  target.addTable('t', 'RANGE (fecha)');
  target.addPartition('p', 't', "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')");

  const result = compare({ source, target });
  assert.equal(result.sqlById['part_alter:p'],
    'ALTER TABLE "t" DETACH PARTITION "p";\n'
    + 'ALTER TABLE "t" ATTACH PARTITION "p" '
    + "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');");
  assert.equal(result.rows[0].destructive, false);   // DETACH no pierde datos
});

test('una partición igual no genera diferencia y la que sobra va comentada', () => {
  const source = new Schema('ventas');
  source.addTable('t', 'LIST (region)');
  source.addPartition('igual', 't', "FOR VALUES IN ('a')");
  const target = new Schema('ventas');
  target.addTable('t', 'LIST (region)');
  target.addPartition('igual', 't', "FOR VALUES IN ('a')");
  target.addPartition('sobra', 't', "FOR VALUES IN ('b')");

  const result = compare({ source, target });
  assert.equal(result.totalChanges, 1);
  assert.equal(result.sqlById['part_drop:sobra'], '-- DROP TABLE "sobra";');
  assert.equal(result.rows[0].destructive, true);
});
