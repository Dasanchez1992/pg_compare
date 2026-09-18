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
    /** @type {Map<string, Map<string, {ordinal:number, dataType:string, notNull:boolean, default:?string}>>} */
    this.tables = new Map();
    /** @type {Map<string, {table:string, name:string, def:string}>} */
    this.indexes = new Map();
    /** @type {Map<string, {table:string, name:string, type:string, def:string}>} */
    this.constraints = new Map();
  }

  addColumn(table, column, info) {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    this.tables.get(table).set(column, info);
  }

  addIndex(table, name, def) {
    this.indexes.set(key(table, name), { table, name, def });
  }

  addConstraint(table, name, type, def) {
    this.constraints.set(key(table, name), { table, name, type, def });
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
