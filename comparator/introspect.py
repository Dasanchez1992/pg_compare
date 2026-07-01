"""Introspección del esquema de una base de datos PostgreSQL.

Devuelve estructuras normalizadas de columnas, índices y constraints,
listas para comparar entre dos bases.
"""

# --- Consultas al catálogo de PostgreSQL --------------------------------

COLUMNS_SQL = """
SELECT c.relname                                   AS table_name,
       a.attname                                   AS column_name,
       a.attnum                                    AS ordinal,
       format_type(a.atttypid, a.atttypmod)        AS data_type,
       a.attnotnull                                AS not_null,
       pg_get_expr(d.adbin, d.adrelid)             AS default_value
FROM pg_attribute a
JOIN pg_class c      ON c.oid = a.attrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = %s
  AND c.relkind = 'r'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;
"""

# Índices que NO respaldan un constraint (PK/UNIQUE los maneja la sección
# de constraints, para no duplicarlos).
INDEXES_SQL = """
SELECT c.relname                AS table_name,
       i.relname                AS index_name,
       pg_get_indexdef(i.oid)   AS index_def
FROM pg_index x
JOIN pg_class c      ON c.oid = x.indrelid
JOIN pg_class i      ON i.oid = x.indexrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
WHERE n.nspname = %s
  AND c.relkind = 'r'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid)
ORDER BY c.relname, i.relname;
"""

CONSTRAINTS_SQL = """
SELECT c.relname                       AS table_name,
       con.conname                     AS constraint_name,
       con.contype                     AS constraint_type,
       pg_get_constraintdef(con.oid)   AS definition
FROM pg_constraint con
JOIN pg_class c      ON c.oid = con.conrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
WHERE n.nspname = %s
  AND c.relkind = 'r'
ORDER BY c.relname, con.conname;
"""

CONTYPE_LABEL = {
    "p": "PRIMARY KEY",
    "f": "FOREIGN KEY",
    "u": "UNIQUE",
    "c": "CHECK",
    "x": "EXCLUSION",
}


class Schema:
    """Snapshot del esquema de una base de datos."""

    def __init__(self, schema_name):
        self.schema_name = schema_name
        # tables[table] = {column: {...}}
        self.tables = {}
        # indexes[(table, index_name)] = {"def": ...}
        self.indexes = {}
        # constraints[(table, constraint_name)] = {"type":..., "def":...}
        self.constraints = {}

    @property
    def table_names(self):
        return set(self.tables.keys())


def introspect(connection_obj):
    """Recibe un DatabaseConnection y devuelve un objeto Schema."""
    schema = Schema(connection_obj.schema)
    conn = connection_obj.connect()
    try:
        with conn.cursor() as cur:
            # Columnas
            cur.execute(COLUMNS_SQL, [connection_obj.schema])
            for table, column, ordinal, data_type, not_null, default in cur.fetchall():
                schema.tables.setdefault(table, {})[column] = {
                    "ordinal": ordinal,
                    "data_type": data_type,
                    "not_null": not_null,
                    "default": default,
                }

            # Índices
            cur.execute(INDEXES_SQL, [connection_obj.schema])
            for table, index_name, index_def in cur.fetchall():
                schema.indexes[(table, index_name)] = {"def": index_def}

            # Constraints
            cur.execute(CONSTRAINTS_SQL, [connection_obj.schema])
            for table, name, ctype, definition in cur.fetchall():
                schema.constraints[(table, name)] = {
                    "type": CONTYPE_LABEL.get(ctype, ctype),
                    "def": definition,
                }
    finally:
        conn.close()
    return schema
