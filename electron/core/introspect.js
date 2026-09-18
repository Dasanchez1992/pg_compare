'use strict';

/**
 * Introspección del esquema de una base de datos PostgreSQL.
 *
 * Consulta el catálogo con el driver `pg` (JavaScript puro, sin binarios
 * nativos) y devuelve un `Schema` normalizado listo para comparar.
 */

const { Client } = require('pg');

const { Schema } = require('./schema');

const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 120000;

const COLUMNS_SQL = `
SELECT c.relname                                   AS table_name,
       a.attname                                   AS column_name,
       a.attnum                                    AS ordinal,
       format_type(a.atttypid, a.atttypmod)        AS data_type,
       a.attnotnull                                AS not_null,
       pg_get_expr(d.adbin, d.adrelid)             AS default_value,
       col_description(c.oid, a.attnum)            AS column_comment
FROM pg_attribute a
JOIN pg_class c      ON c.oid = a.attrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = $1
  AND c.relkind = 'r'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;
`;

// Índices que NO respaldan un constraint (PK/UNIQUE los maneja la sección
// de constraints, para no duplicarlos).
const INDEXES_SQL = `
SELECT c.relname                AS table_name,
       i.relname                AS index_name,
       pg_get_indexdef(i.oid)   AS index_def
FROM pg_index x
JOIN pg_class c      ON c.oid = x.indrelid
JOIN pg_class i      ON i.oid = x.indexrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relkind = 'r'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid)
ORDER BY c.relname, i.relname;
`;

const CONSTRAINTS_SQL = `
SELECT c.relname                       AS table_name,
       con.conname                     AS constraint_name,
       con.contype                     AS constraint_type,
       pg_get_constraintdef(con.oid)   AS definition
FROM pg_constraint con
JOIN pg_class c      ON c.oid = con.conrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relkind = 'r'
ORDER BY c.relname, con.conname;
`;

const CONTYPE_LABEL = {
  p: 'PRIMARY KEY',
  f: 'FOREIGN KEY',
  u: 'UNIQUE',
  c: 'CHECK',
  x: 'EXCLUSION',
};

/** Configuración del cliente `pg` a partir de una conexión guardada. */
function clientConfig(conn) {
  return {
    host: conn.host,
    port: Number(conn.port) || 5432,
    database: conn.dbname,
    user: conn.user,
    password: conn.password || '',
    ssl: conn.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    application_name: 'Comparador de BD',
  };
}

/** Abre una conexión, ejecuta `fn` y la cierra pase lo que pase. */
async function withClient(conn, fn) {
  const client = new Client(clientConfig(conn));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* la conexión ya se fue */ });
  }
}

/** Lee la estructura del esquema configurado en la conexión. */
async function introspect(conn) {
  const schemaName = conn.schema || 'public';
  return withClient(conn, async (client) => {
    const schema = new Schema(schemaName);

    const columns = await client.query(COLUMNS_SQL, [schemaName]);
    for (const row of columns.rows) {
      schema.addColumn(row.table_name, row.column_name, {
        ordinal: row.ordinal,
        dataType: row.data_type,
        notNull: row.not_null,
        default: row.default_value,
        comment: row.column_comment,
      });
    }

    const indexes = await client.query(INDEXES_SQL, [schemaName]);
    for (const row of indexes.rows) {
      schema.addIndex(row.table_name, row.index_name, row.index_def);
    }

    const constraints = await client.query(CONSTRAINTS_SQL, [schemaName]);
    for (const row of constraints.rows) {
      schema.addConstraint(
        row.table_name,
        row.constraint_name,
        CONTYPE_LABEL[row.constraint_type] || row.constraint_type,
        row.definition,
      );
    }

    return schema;
  });
}

/**
 * Prueba la conexión y comprueba que el esquema existe.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testConnection(conn) {
  const schemaName = conn.schema || 'public';
  try {
    return await withClient(conn, async (client) => {
      const { rows } = await client.query(
        `SELECT current_setting('server_version') AS version,
                EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists`,
        [schemaName],
      );
      const { version, schema_exists: schemaExists } = rows[0];
      if (!schemaExists) {
        return {
          ok: false,
          message: `Conecta con PostgreSQL ${version}, pero el esquema "${schemaName}" no existe.`,
        };
      }
      return { ok: true, message: `Conexión exitosa · PostgreSQL ${version}` };
    });
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

module.exports = { introspect, testConnection, clientConfig, CONTYPE_LABEL };
