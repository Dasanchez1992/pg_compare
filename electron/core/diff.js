'use strict';

/**
 * Compara dos esquemas y genera diferencias individuales seleccionables.
 *
 * Dirección: transforma la BD destino (target, "BD1") para que quede igual a
 * la BD de referencia (source, "BD2").
 *
 * `compare()` devuelve la lista plana de cambios para la grilla y el SQL de
 * cada uno; el script final se arma con `buildScript()` usando solo los
 * cambios que marcó el usuario.
 *
 * Las tablas nuevas se emiten con su definición completa (columnas +
 * constraints inline + índices). Las sentencias destructivas (DROP) se
 * generan comentadas.
 */

const { byText, byTableAndName, key } = require('./schema');

const NEXTVAL_RE = /nextval\(/;

// Tipos con default nextval(...) se muestran como serial en CREATE TABLE.
const SERIAL_MAP = {
  integer: 'serial',
  bigint: 'bigserial',
  smallint: 'smallserial',
};

// Orden de los constraints dentro del CREATE TABLE.
const CONSTRAINT_PRIORITY = {
  'PRIMARY KEY': 0,
  UNIQUE: 1,
  CHECK: 2,
  'FOREIGN KEY': 3,
  EXCLUSION: 4,
};

// Grupos en el orden en que se emiten al script.
const GROUP_ORDER = [
  // Las secuencias van primero: una columna puede tener DEFAULT nextval(...).
  'sequences_create',
  'sequences_alter',
  'tables_create',
  'tables_drop',
  'columns_add',
  'columns_alter',
  'columns_drop',
  'indexes_add',
  'indexes_alter',
  'indexes_drop',
  'constraints_add',
  'constraints_alter',
  'constraints_drop',
  // Las vistas, al final: leen de las tablas que se acaban de crear o cambiar.
  'views_create',
  'views_alter',
  'views_drop',
  'sequences_drop',
];

const DESTRUCTIVE_GROUPS = new Set([
  'tables_drop', 'columns_drop', 'indexes_drop', 'constraints_drop',
  'views_drop', 'sequences_drop',
]);

// Metadatos por grupo para la grilla: [tipo, estado, clase del badge].
const GROUP_META = {
  tables_create: ['Tabla', 'Nuevo', 'b-add'],
  tables_drop: ['Tabla', 'Sobra', 'b-del'],
  columns_add: ['Columna', 'Nuevo', 'b-add'],
  columns_alter: ['Columna', 'Diferente', 'b-chg'],
  columns_drop: ['Columna', 'Sobra', 'b-del'],
  indexes_add: ['Índice', 'Nuevo', 'b-add'],
  indexes_alter: ['Índice', 'Diferente', 'b-chg'],
  indexes_drop: ['Índice', 'Sobra', 'b-del'],
  constraints_add: ['Constraint', 'Nuevo', 'b-add'],
  constraints_alter: ['Constraint', 'Diferente', 'b-chg'],
  constraints_drop: ['Constraint', 'Sobra', 'b-del'],
  views_create: ['Vista', 'Nuevo', 'b-add'],
  views_alter: ['Vista', 'Diferente', 'b-chg'],
  views_drop: ['Vista', 'Sobra', 'b-del'],
  sequences_create: ['Secuencia', 'Nuevo', 'b-add'],
  sequences_alter: ['Secuencia', 'Diferente', 'b-chg'],
  sequences_drop: ['Secuencia', 'Sobra', 'b-del'],
};

// Atributos de una secuencia: clave, etiqueta para el detalle y cómo se
// escriben en SQL.
const SEQUENCE_ATTRS = [
  ['dataType', 'tipo', (v) => `AS ${v}`],
  ['increment', 'incremento', (v) => `INCREMENT BY ${v}`],
  ['min', 'mínimo', (v) => `MINVALUE ${v}`],
  ['max', 'máximo', (v) => `MAXVALUE ${v}`],
  ['start', 'inicio', (v) => `START WITH ${v}`],
  ['cache', 'caché', (v) => `CACHE ${v}`],
  ['cycle', 'ciclo', (v) => (v ? 'CYCLE' : 'NO CYCLE')],
];

/** Cita un identificador de PostgreSQL entre comillas dobles. */
function q(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/** Literal de texto de PostgreSQL, con las comillas simples escapadas. */
function literal(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * Comentario de una columna. `null` borra el que hubiera: en PostgreSQL no
 * existe "quitar el comentario", se asigna NULL.
 */
function commentSql(table, column, comment) {
  const value = comment === null || comment === undefined ? 'NULL' : literal(comment);
  return `COMMENT ON COLUMN ${q(table)}.${q(column)} IS ${value};`;
}

/** Texto legible para los valores que se muestran en la columna "Detalle". */
const yesNo = (value) => (value ? 'sí' : 'no');
const orNone = (value) => (value === null || value === undefined ? '(ninguno)' : value);

/**
 * Fragmento DDL de una columna. Dentro de un CREATE TABLE, una columna con
 * default nextval(...) se emite como serial.
 */
function columnDdl(colname, col, { forCreate = false } = {}) {
  const { dataType, notNull } = col;
  const def = col.default;

  if (forCreate && def && NEXTVAL_RE.test(def) && SERIAL_MAP[dataType]) {
    const parts = [q(colname), SERIAL_MAP[dataType]];
    if (notNull) parts.push('NOT NULL');
    return parts.join(' ');
  }

  const parts = [q(colname), dataType];
  if (notNull) parts.push('NOT NULL');
  if (def !== null && def !== undefined) parts.push(`DEFAULT ${def}`);
  return parts.join(' ');
}

/** Objetos de un mapa (índices/constraints) que pertenecen a una tabla. */
function itemsOfTable(map, table) {
  return [...map.values()].filter((item) => item.table === table);
}

/**
 * Definición completa de una tabla: columnas + constraints inline + índices.
 * `deferred` lleva los constraints que hay que dejar fuera (los que cierran
 * un ciclo de claves foráneas y se emiten después, por separado).
 */
function createTableSql(table, source, deferred = new Set()) {
  const cols = source.columns(table);
  const lines = [...cols.entries()]
    .sort((a, b) => a[1].ordinal - b[1].ordinal)
    .map(([name, col]) => `\t${columnDdl(name, col, { forCreate: true })}`);

  // Constraints de la tabla, ordenados PK, UNIQUE, CHECK, FK...
  const cons = itemsOfTable(source.constraints, table)
    .filter((con) => !deferred.has(key(con.table, con.name)))
    .sort((a, b) => {
      const pa = CONSTRAINT_PRIORITY[a.type] ?? 9;
      const pb = CONSTRAINT_PRIORITY[b.type] ?? 9;
      return pa - pb || byText(a.name, b.name);
    });
  for (const con of cons) {
    lines.push(`\tCONSTRAINT ${q(con.name)} ${con.def}`);
  }

  let sql = `CREATE TABLE ${q(table)} (\n${lines.join(',\n')}\n);`;

  // Índices que no respaldan constraints.
  const indexes = itemsOfTable(source.indexes, table)
    .sort((a, b) => byText(a.name, b.name));
  if (indexes.length) {
    sql += `\n${indexes.map((idx) => `${idx.def};`).join('\n')}`;
  }

  // Los comentarios de columna no caben dentro del CREATE TABLE.
  const comments = [...cols.entries()]
    .filter(([, col]) => col.comment)
    .sort((a, b) => a[1].ordinal - b[1].ordinal)
    .map(([name, col]) => commentSql(table, name, col.comment));
  if (comments.length) sql += `\n${comments.join('\n')}`;

  return sql;
}

/**
 * Claves foráneas de una tabla que apuntan a otra tabla del mismo conjunto.
 * Devuelve Map(tablaDestino -> [nombres de constraint]).
 */
function foreignKeysWithin(table, source, within) {
  const edges = new Map();
  for (const con of itemsOfTable(source.constraints, table)) {
    const ref = con.references;
    if (con.type !== 'FOREIGN KEY' || !ref) continue;
    if (ref.schema !== source.schemaName) continue;   // apunta a otro esquema
    if (ref.table === table) continue;                // autorreferencia: válida en el CREATE
    if (!within.has(ref.table)) continue;             // la otra tabla ya existe en el destino
    if (!edges.has(ref.table)) edges.set(ref.table, []);
    edges.get(ref.table).push(con.name);
  }
  return edges;
}

/**
 * Orden topológico estable: cada nodo va después de aquellos de los que
 * depende, y a igualdad de dependencias, por nombre.
 *
 * @param {string[]} nodes
 * @param {Map<string, Map<string, *>>} dependencies  nodo -> dependencias suyas
 * @param {function} breakCycle  recibe (atascados, dependencies, pendientes) y
 *   debe quitar al menos una arista; solo se llama si queda un ciclo.
 */
function topologicalOrder(nodes, dependencies, breakCycle) {
  const pending = new Set(nodes);
  const ordered = [];

  while (pending.size) {
    const ready = [...pending]
      .filter((node) => ![...dependencies.get(node).keys()].some((dep) => pending.has(dep)))
      .sort(byText);

    if (ready.length) {
      for (const node of ready) {
        ordered.push(node);
        pending.delete(node);
      }
      continue;
    }
    breakCycle([...pending].sort(byText), dependencies, pending);
  }

  return ordered;
}

/**
 * Ordena las vistas nuevas: si una lee de otra, la leída va primero.
 * PostgreSQL no permite vistas mutuamente dependientes, pero el corte está
 * puesto por si acaso, para no quedarse dando vueltas.
 */
function orderNewViews(views, source) {
  const within = new Set(views);
  const dependencies = new Map(views.map((view) => {
    const deps = new Map();
    for (const dep of source.viewDependencies.get(view) || []) {
      if (within.has(dep)) deps.set(dep, true);
    }
    return [view, deps];
  }));

  return topologicalOrder(views, dependencies, (stuck, deps) => deps.get(stuck[0]).clear());
}

/** Sentencia CREATE de una secuencia independiente. */
function createSequenceSql(seq) {
  return [
    `CREATE SEQUENCE ${q(seq.name)}`,
    ...SEQUENCE_ATTRS.map(([field, , render]) => `    ${render(seq[field])}`),
  ].join('\n') + ';';
}

/** Atributos en los que difieren dos secuencias. */
function sequenceChanges(source, target) {
  return SEQUENCE_ATTRS.filter(([field]) => String(source[field]) !== String(target[field]));
}

/**
 * Ordena las tablas nuevas para que cada una se cree después de aquellas a las
 * que apunta por clave foránea; a igualdad de dependencias, por nombre.
 *
 * Si dos tablas se referencian entre sí no hay orden posible: se devuelven en
 * `deferred` los constraints que cierran el ciclo, para sacarlos del CREATE
 * TABLE y emitirlos como ALTER después de crear todas las tablas.
 *
 * @returns {{ordered: string[], deferred: Set<string>}}
 */
function orderNewTables(tables, source) {
  const within = new Set(tables);
  const dependencies = new Map(
    tables.map((table) => [table, foreignKeysWithin(table, source, within)]),
  );
  const deferred = new Set();

  // Lo que queda atascado forma uno o más ciclos. Se rompe el de una sola
  // tabla —la primera por nombre— y se vuelve a intentar: así se aplazan las
  // menos claves foráneas posibles y el script queda más limpio.
  const ordered = topologicalOrder(tables, dependencies, (stuck, deps, pending) => {
    const [table] = stuck;
    for (const [dep, names] of [...deps.get(table)]) {
      if (!pending.has(dep)) continue;
      names.forEach((name) => deferred.add(key(table, name)));
      deps.get(table).delete(dep);
    }
  });

  return { ordered, deferred };
}

/**
 * Compara dos esquemas.
 *
 * @param {object} options
 * @param {Schema} options.source  BD2, la estructura de referencia.
 * @param {Schema} options.target  BD1, la que se va a modificar.
 * @param {string} options.db1Name Nombre de BD1 (para los textos).
 * @param {string} options.db2Name Nombre de BD2 (para los textos).
 * @returns {{rows: object[], sqlById: object, totalChanges: number}}
 */
function compare({ source, target, db1Name = 'BD1', db2Name = 'BD2' }) {
  const rows = [];
  const sqlById = {};

  const add = (group, id, table, name, detail, sql) => {
    const [type, status, statusClass] = GROUP_META[group];
    rows.push({
      id, group, table, name, detail, type, status,
      statusClass,
      destructive: DESTRUCTIVE_GROUPS.has(group),
    });
    sqlById[id] = sql;
  };

  const srcTables = new Set(source.tableNames());
  const tgtTables = new Set(target.tableNames());
  const newTables = [...srcTables].filter((t) => !tgtTables.has(t)).sort(byText);
  // Las tablas nuevas se crean en orden de dependencias, no alfabético: si una
  // apunta a otra por clave foránea, la referenciada va primero.
  const { ordered: newTablesOrdered, deferred } = orderNewTables(newTables, source);
  const onlyTarget = [...tgtTables].filter((t) => !srcTables.has(t)).sort(byText);
  const common = [...srcTables].filter((t) => tgtTables.has(t)).sort(byText);
  const isNewTable = new Set(newTables);

  // --- Secuencias independientes -------------------------------------
  const srcSequences = source.sequences;
  const tgtSequences = target.sequences;

  for (const [name, seq] of [...srcSequences].sort(([a], [b]) => byText(a, b))) {
    if (tgtSequences.has(name)) continue;
    add('sequences_create', `seq_add:${name}`, name, name,
      `${seq.dataType}, incremento ${seq.increment} · solo existe en ${db2Name}`,
      createSequenceSql(seq));
  }

  for (const [name, seq] of [...srcSequences].sort(([a], [b]) => byText(a, b))) {
    const current = tgtSequences.get(name);
    if (!current) continue;
    const changes = sequenceChanges(seq, current);
    if (!changes.length) continue;

    add('sequences_alter', `seq_alter:${name}`, name, name,
      changes.map(([field, label]) => `${label}: ${current[field]} → ${seq[field]}`).join(' · '),
      `ALTER SEQUENCE ${q(name)} ${changes.map(([field, , render]) => render(seq[field])).join(' ')};`);
  }

  for (const [name] of [...tgtSequences].sort(([a], [b]) => byText(a, b))) {
    if (srcSequences.has(name)) continue;
    add('sequences_drop', `seq_drop:${name}`, name, name,
      `solo existe en ${db1Name}`, `-- DROP SEQUENCE ${q(name)};`);
  }

  // --- Tablas nuevas: CREATE TABLE completo --------------------------
  for (const table of newTablesOrdered) {
    const nCols = source.columns(table).size;
    const nCons = itemsOfTable(source.constraints, table).length;
    const nIdx = itemsOfTable(source.indexes, table).length;
    add('tables_create', `tbl_add:${table}`, table, table,
      `${nCols} columnas, ${nCons} constraints, ${nIdx} índices · solo existe en ${db2Name}`,
      createTableSql(table, source, deferred));
  }

  // --- Tablas que sobran: DROP TABLE (comentado) ---------------------
  for (const table of onlyTarget) {
    add('tables_drop', `tbl_drop:${table}`, table, table,
      `solo existe en ${db1Name}`, `-- DROP TABLE ${q(table)};`);
  }

  // --- Columnas (solo en las tablas que existen en ambas) ------------
  for (const table of common) {
    const srcCols = source.columns(table);
    const tgtCols = target.columns(table);
    const srcNames = [...srcCols.keys()].sort(byText);
    const tgtNames = [...tgtCols.keys()].sort(byText);

    for (const col of srcNames.filter((c) => !tgtCols.has(c))) {
      const info = srcCols.get(col);
      let sql = `ALTER TABLE ${q(table)} ADD COLUMN ${columnDdl(col, info)};`;
      if (info.comment) sql += `\n${commentSql(table, col, info.comment)}`;
      add('columns_add', `col_add:${table}:${col}`, table, col,
        `${info.dataType} · solo existe en ${db2Name}`, sql);
    }

    for (const col of tgtNames.filter((c) => !srcCols.has(c))) {
      add('columns_drop', `col_drop:${table}:${col}`, table, col,
        `${tgtCols.get(col).dataType} · solo existe en ${db1Name}`,
        `-- ALTER TABLE ${q(table)} DROP COLUMN ${q(col)};`);
    }

    for (const col of srcNames.filter((c) => tgtCols.has(c))) {
      const s = srcCols.get(col);
      const t = tgtCols.get(col);

      if (s.dataType !== t.dataType) {
        add('columns_alter', `col_type:${table}:${col}`, table, col,
          `tipo: ${t.dataType} → ${s.dataType}`,
          `ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} `
          + `TYPE ${s.dataType} USING ${q(col)}::${s.dataType};`);
      }
      if (s.notNull !== t.notNull) {
        const action = s.notNull ? 'SET NOT NULL' : 'DROP NOT NULL';
        add('columns_alter', `col_null:${table}:${col}`, table, col,
          `NOT NULL: ${yesNo(t.notNull)} → ${yesNo(s.notNull)}`,
          `ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} ${action};`);
      }
      const sDefault = s.default || null;
      const tDefault = t.default || null;
      if (sDefault !== tDefault) {
        const stmt = sDefault === null
          ? `ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} DROP DEFAULT;`
          : `ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} SET DEFAULT ${sDefault};`;
        add('columns_alter', `col_def:${table}:${col}`, table, col,
          `default: ${orNone(tDefault)} → ${orNone(sDefault)}`, stmt);
      }
      const sComment = s.comment || null;
      const tComment = t.comment || null;
      if (sComment !== tComment) {
        add('columns_alter', `col_comment:${table}:${col}`, table, col,
          `comentario: ${orNone(tComment)} → ${orNone(sComment)}`,
          commentSql(table, col, sComment));
      }
    }
  }

  // --- Índices (los de tablas nuevas ya van en su CREATE TABLE) ------
  for (const idx of missing(source.indexes, target.indexes)) {
    if (isNewTable.has(idx.table)) continue;
    add('indexes_add', `idx_add:${idx.table}:${idx.name}`, idx.table, idx.name,
      `${idx.def} · solo existe en ${db2Name}`, `${idx.def};`);
  }
  for (const [s, t] of shared(source.indexes, target.indexes)) {
    if (s.def === t.def) continue;
    add('indexes_alter', `idx_alter:${s.table}:${s.name}`, s.table, s.name,
      `definición: ${t.def} → ${s.def}`,
      `DROP INDEX ${q(s.name)};\n${s.def};`);
  }
  for (const idx of missing(target.indexes, source.indexes)) {
    add('indexes_drop', `idx_drop:${idx.table}:${idx.name}`, idx.table, idx.name,
      `${idx.def} · solo existe en ${db1Name}`, `-- DROP INDEX ${q(idx.name)};`);
  }

  // --- Constraints (idem: los de tablas nuevas van inline) -----------
  for (const con of missing(source.constraints, target.constraints)) {
    // Los de las tablas nuevas ya van dentro de su CREATE TABLE, salvo los
    // aplazados para romper un ciclo de claves foráneas.
    if (isNewTable.has(con.table) && !deferred.has(key(con.table, con.name))) continue;
    add('constraints_add', `con_add:${con.table}:${con.name}`, con.table, con.name,
      `${con.type} — ${con.def} · solo existe en ${db2Name}`,
      `ALTER TABLE ${q(con.table)} ADD CONSTRAINT ${q(con.name)} ${con.def};`);
  }
  for (const [s, t] of shared(source.constraints, target.constraints)) {
    if (s.def === t.def) continue;
    add('constraints_alter', `con_alter:${s.table}:${s.name}`, s.table, s.name,
      `${s.type} — definición: ${t.def} → ${s.def}`,
      `ALTER TABLE ${q(s.table)} DROP CONSTRAINT ${q(s.name)};\n`
      + `ALTER TABLE ${q(s.table)} ADD CONSTRAINT ${q(s.name)} ${s.def};`);
  }
  for (const con of missing(target.constraints, source.constraints)) {
    add('constraints_drop', `con_drop:${con.table}:${con.name}`, con.table, con.name,
      `${con.type} — ${con.def} · solo existe en ${db1Name}`,
      `-- ALTER TABLE ${q(con.table)} DROP CONSTRAINT ${q(con.name)};`);
  }

  // --- Vistas ---------------------------------------------------------
  const srcViews = source.views;
  const tgtViews = target.views;

  const newViews = [...srcViews.keys()].filter((name) => !tgtViews.has(name)).sort(byText);
  for (const name of orderNewViews(newViews, source)) {
    const view = srcViews.get(name);
    add('views_create', `view_add:${name}`, name, name,
      `${lineCount(view.definition)} · solo existe en ${db2Name}`,
      `CREATE VIEW ${q(name)} AS\n${view.definition}`);
  }

  for (const [name, view] of [...srcViews].sort(([a], [b]) => byText(a, b))) {
    const current = tgtViews.get(name);
    if (!current || current.definition === view.definition) continue;
    // CREATE OR REPLACE no es destructivo y mantiene los permisos. Si cambió
    // la lista de columnas PostgreSQL lo rechaza, y como el script va dentro
    // de una transacción no queda nada a medias.
    add('views_alter', `view_alter:${name}`, name, name,
      `definición distinta (${lineCount(current.definition)} → ${lineCount(view.definition)})`,
      `CREATE OR REPLACE VIEW ${q(name)} AS\n${view.definition}`);
  }

  for (const [name] of [...tgtViews].sort(([a], [b]) => byText(a, b))) {
    if (srcViews.has(name)) continue;
    add('views_drop', `view_drop:${name}`, name, name,
      `solo existe en ${db1Name}`, `-- DROP VIEW ${q(name)};`);
  }

  return { rows, sqlById, totalChanges: rows.length };
}

/** "3 líneas" — para describir una definición sin volcarla en la grilla. */
function lineCount(text) {
  const lines = String(text).trim().split('\n').length;
  return `${lines} ${lines === 1 ? 'línea' : 'líneas'}`;
}

/** Objetos de `a` que no están en `b`, ordenados por (tabla, nombre). */
function missing(a, b) {
  return [...a.entries()]
    .filter(([id]) => !b.has(id))
    .map(([, item]) => item)
    .sort(byTableAndName);
}

/** Pares [origen, destino] de los objetos presentes en ambos mapas. */
function shared(a, b) {
  return [...a.entries()]
    .filter(([id]) => b.has(id))
    .map(([id, item]) => [item, b.get(id)])
    .sort(([x], [y]) => byTableAndName(x, y));
}

/**
 * Arma el script SQL con solo los cambios seleccionados, respetando el orden
 * canónico de `sqlById`. `schema` es el esquema de BD1: el script fija el
 * search_path para que las sentencias (sin calificar) apliquen ahí.
 */
function buildScript({ db1Name, db2Name, sqlById, selectedIds, schema = 'public' }) {
  const selected = new Set(selectedIds);
  const lines = [
    '-- ============================================================',
    '-- Script ALTER generado por Comparador de BD',
    `-- Referencia (BD2): ${db2Name}`,
    `-- A modificar (BD1): ${db1Name}`,
    `-- Esquema: ${schema}`,
    '-- Solo se incluyen los cambios seleccionados.',
    '-- Las sentencias DROP van comentadas por seguridad.',
    '-- ============================================================',
    'BEGIN;',
    '',
    `SET LOCAL search_path TO ${q(schema)};`,
    '',
  ];

  let included = 0;
  for (const [id, sql] of Object.entries(sqlById)) {
    if (selected.has(id)) {
      lines.push(sql);
      included += 1;
    }
  }
  if (included === 0) lines.push('-- (No se seleccionó ningún cambio)');

  lines.push('', 'COMMIT;');
  return lines.join('\n');
}

module.exports = {
  compare,
  buildScript,
  createTableSql,
  createSequenceSql,
  orderNewTables,
  orderNewViews,
  columnDdl,
  commentSql,
  literal,
  q,
  GROUP_ORDER,
  GROUP_META,
};
