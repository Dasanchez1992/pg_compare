'use strict';

/**
 * Snapshot de la estructura de una base de datos.
 *
 * Índices y constraints se guardan en mapas cuya clave identifica el par
 * (tabla, nombre), que es como los identifica el catálogo de PostgreSQL.
 */

/** Clave interna de un objeto que pertenece a una tabla. */
function key(table, name) {
  return JSON.stringify([table, name]);
}

/** Comparador de cadenas estable (por punto de código, sin locale). */
function byText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Ordena objetos {table, name} por tabla y después por nombre. */
function byTableAndName(a, b) {
  return byText(a.table, b.table) || byText(a.name, b.name);
}

class Schema {
  constructor(schemaName) {
    this.schemaName = schemaName;
    /** @type {Map<string, Map<string, {ordinal:number, dataType:string,
     *   notNull:boolean, default:?string, comment:?string}>>} */
    this.tables = new Map();
    /** @type {Map<string, {table:string, name:string, def:string}>} */
    this.indexes = new Map();
    /**
     * @type {Map<string, {table:string, name:string, type:string, def:string,
     *   references:?{schema:string, table:string}}>}
     */
    this.constraints = new Map();
    /** @type {Map<string, {name:string, definition:string}>} */
    this.views = new Map();
    /** De qué tablas y vistas lee cada vista, para poder ordenarlas. */
    /** @type {Map<string, Set<string>>} */
    this.viewDependencies = new Map();
    /**
     * Secuencias independientes. Las que crea un `serial` no entran: se
     * generan solas con su tabla.
     * @type {Map<string, {name:string, dataType:string, start:string,
     *   min:string, max:string, increment:string, cycle:boolean, cache:string}>}
     */
    this.sequences = new Map();
  }

  addColumn(table, column, info) {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    this.tables.get(table).set(column, info);
  }

  addIndex(table, name, def) {
    this.indexes.set(key(table, name), { table, name, def });
  }

  /** `references` solo viene en las claves foráneas: a qué tabla apuntan. */
  addConstraint(table, name, type, def, references = null) {
    this.constraints.set(key(table, name), {
      table, name, type, def, references,
    });
  }

  addView(name, definition) {
    this.views.set(name, { name, definition });
  }

  /** Registra que `view` lee de `dependsOn` (tabla o vista del mismo esquema). */
  addViewDependency(view, dependsOn) {
    if (!this.viewDependencies.has(view)) this.viewDependencies.set(view, new Set());
    this.viewDependencies.get(view).add(dependsOn);
  }

  addSequence(name, info) {
    this.sequences.set(name, { name, ...info });
  }

  /** Columnas de una tabla, o un mapa vacío si no existe. */
  columns(table) {
    return this.tables.get(table) || new Map();
  }

  tableNames() {
    return [...this.tables.keys()];
  }
}

module.exports = { Schema, key, byText, byTableAndName };
