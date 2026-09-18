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

const { byText, byTableAndName } = require('./schema');

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
];

const DESTRUCTIVE_GROUPS = new Set([
  'tables_drop', 'columns_drop', 'indexes_drop', 'constraints_drop',
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
};

/** Cita un identificador de PostgreSQL entre comillas dobles. */
function q(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
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

/** Definición completa de una tabla: columnas + constraints inline + índices. */
function createTableSql(table, source) {
  const cols = source.columns(table);
  const lines = [...cols.entries()]
    .sort((a, b) => a[1].ordinal - b[1].ordinal)
    .map(([name, col]) => `\t${columnDdl(name, col, { forCreate: true })}`);

  // Constraints de la tabla, ordenados PK, UNIQUE, CHECK, FK...
  const cons = itemsOfTable(source.constraints, table).sort((a, b) => {
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
  return sql;
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
  const onlyTarget = [...tgtTables].filter((t) => !srcTables.has(t)).sort(byText);
  const common = [...srcTables].filter((t) => tgtTables.has(t)).sort(byText);
  const isNewTable = new Set(newTables);

  // --- Tablas nuevas: CREATE TABLE completo --------------------------
  for (const table of newTables) {
    const nCols = source.columns(table).size;
    const nCons = itemsOfTable(source.constraints, table).length;
    const nIdx = itemsOfTable(source.indexes, table).length;
    add('tables_create', `tbl_add:${table}`, table, table,
      `${nCols} columnas, ${nCons} constraints, ${nIdx} índices · solo existe en ${db2Name}`,
      createTableSql(table, source));
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
      add('columns_add', `col_add:${table}:${col}`, table, col,
        `${srcCols.get(col).dataType} · solo existe en ${db2Name}`,
        `ALTER TABLE ${q(table)} ADD COLUMN ${columnDdl(col, srcCols.get(col))};`);
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
    if (isNewTable.has(con.table)) continue;
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

  return { rows, sqlById, totalChanges: rows.length };
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
  columnDdl,
  q,
  GROUP_ORDER,
  GROUP_META,
};
