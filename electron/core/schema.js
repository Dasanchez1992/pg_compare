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
    /**
     * Funciones y procedimientos, con su firma en la clave: una misma función
     * puede estar sobrecargada con distintos argumentos.
     * @type {Map<string, {name:string, args:string, signature:string,
     *   kind:string, definition:string}>}
     */
    this.functions = new Map();
    /** @type {Map<string, {table:string, name:string, definition:string}>} */
    this.triggers = new Map();
    /** Clave de partición de las tablas que la tienen: "RANGE (fecha)". */
    /** @type {Map<string, string>} */
    this.partitionKeys = new Map();
    /**
     * Particiones. No son tablas sueltas: heredan columnas, índices y
     * constraints de su padre, así que se comparan aparte y solo por sus
     * límites.
     * @type {Map<string, {name:string, parent:string, bounds:string,
     *   partitionBy:?string}>}
     */
    this.partitions = new Map();
    /**
     * Tipos definidos por el usuario: enum, dominios y compuestos. Cada uno se
     * crea y se altera de forma distinta, así que llevan su `kind`.
     * @type {Map<string, {name:string, kind:string, values?:string[],
     *   baseType?:string, notNull?:boolean, default?:?string,
     *   checks?:object[], attributes?:object[], dependsOn:Set<string>}>}
     */
    this.types = new Map();
  }

  /** Declara un tipo. `dependsOn` son otros tipos del esquema que necesita. */
  addType(name, info) {
    this.types.set(name, { name, dependsOn: new Set(), ...info });
  }

  /** Declara una tabla (con su clave de partición, si la tiene). */
  addTable(name, partitionBy = null) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    if (partitionBy) this.partitionKeys.set(name, partitionBy);
  }

  addPartition(name, parent, bounds, partitionBy = null) {
    this.partitions.set(name, { name, parent, bounds, partitionBy });
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

  addFunction(name, args, info) {
    const signature = `${name}(${args})`;
    this.functions.set(signature, { name, args, signature, ...info });
  }

  addTrigger(table, name, definition) {
    this.triggers.set(key(table, name), { table, name, definition });
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
