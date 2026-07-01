"""Compara dos esquemas y genera diferencias individuales seleccionables.

Dirección: transforma la BD destino (target, "BD1") para que quede igual a
la BD origen/referencia (source, "BD2").

`compare()` devuelve una lista de cambios agrupados; cada cambio tiene un `id`
único y su `sql`. El script final se arma con `build_script()` usando solo los
cambios seleccionados por el usuario.

Las tablas nuevas se emiten con su definición completa (columnas + constraints
inline + índices). Las sentencias destructivas (DROP) se generan comentadas.
"""

import re

_NEXTVAL_RE = re.compile(r"nextval\(")

# Tipos con default nextval(...) se muestran como serial en CREATE TABLE.
SERIAL_MAP = {
    "integer": "serial",
    "bigint": "bigserial",
    "smallint": "smallserial",
}

# Orden de constraints dentro del CREATE TABLE.
CONSTRAINT_PRIORITY = {
    "PRIMARY KEY": 0,
    "UNIQUE": 1,
    "CHECK": 2,
    "FOREIGN KEY": 3,
    "EXCLUSION": 4,
}


def _q(identifier):
    """Cita un identificador de PostgreSQL entre comillas dobles."""
    return '"' + identifier.replace('"', '""') + '"'


def _column_ddl(colname, col, for_create=False):
    """Fragmento DDL para definir una columna.

    En CREATE TABLE, una columna con default nextval(...) se emite como serial.
    """
    dtype = col["data_type"]
    default = col["default"]
    not_null = col["not_null"]

    if for_create and default and _NEXTVAL_RE.search(default) and dtype in SERIAL_MAP:
        parts = [_q(colname), SERIAL_MAP[dtype]]
        if not_null:
            parts.append("NOT NULL")
        return " ".join(parts)

    parts = [_q(colname), dtype]
    if not_null:
        parts.append("NOT NULL")
    if default is not None:
        parts.append(f"DEFAULT {default}")
    return " ".join(parts)


def _create_table_sql(table, source):
    """Definición completa: columnas + constraints inline + índices."""
    cols = source.tables[table]
    lines = [
        "\t" + _column_ddl(c, cols[c], for_create=True)
        for c in sorted(cols, key=lambda x: cols[x]["ordinal"])
    ]

    # Constraints de la tabla, ordenadas PK, UNIQUE, CHECK, FK...
    tbl_cons = [(k[1], v) for k, v in source.constraints.items() if k[0] == table]
    tbl_cons.sort(key=lambda kv: (CONSTRAINT_PRIORITY.get(kv[1]["type"], 9), kv[0]))
    for name, c in tbl_cons:
        lines.append(f"\tCONSTRAINT {_q(name)} {c['def']}")

    sql = f"CREATE TABLE {_q(table)} (\n" + ",\n".join(lines) + "\n);"

    # Índices que no respaldan constraints.
    tbl_idx = sorted((k[1], v) for k, v in source.indexes.items() if k[0] == table)
    if tbl_idx:
        sql += "\n" + "\n".join(f"{v['def']};" for _, v in tbl_idx)

    return sql


# Grupos en el orden en que se emiten al script.
GROUP_ORDER = [
    "tables_create",
    "tables_drop",
    "columns_add",
    "columns_alter",
    "columns_drop",
    "indexes_add",
    "indexes_alter",
    "indexes_drop",
    "constraints_add",
    "constraints_alter",
    "constraints_drop",
]

GROUP_LABELS = {
    "tables_create": "Tablas nuevas (crear en BD1, con constraints e índices)",
    "tables_drop": "Tablas que sobran en BD1 (DROP)",
    "columns_add": "Columnas nuevas (agregar)",
    "columns_alter": "Columnas modificadas (alterar)",
    "columns_drop": "Columnas que sobran en BD1 (DROP)",
    "indexes_add": "Índices a crear",
    "indexes_alter": "Índices con definición diferente (recrear)",
    "indexes_drop": "Índices que sobran (DROP)",
    "constraints_add": "Constraints a agregar",
    "constraints_alter": "Constraints con definición diferente (recrear)",
    "constraints_drop": "Constraints que sobran (DROP)",
}

DESTRUCTIVE_GROUPS = {"tables_drop", "columns_drop", "indexes_drop", "constraints_drop"}

# Metadatos por grupo para la grilla: (tipo, estado, clase-badge)
GROUP_META = {
    "tables_create":     ("Tabla",      "Nuevo",     "b-add"),
    "tables_drop":       ("Tabla",      "Sobra",     "b-del"),
    "columns_add":       ("Columna",    "Nuevo",     "b-add"),
    "columns_alter":     ("Columna",    "Diferente", "b-chg"),
    "columns_drop":      ("Columna",    "Sobra",     "b-del"),
    "indexes_add":       ("Índice",     "Nuevo",     "b-add"),
    "indexes_alter":     ("Índice",     "Diferente", "b-chg"),
    "indexes_drop":      ("Índice",     "Sobra",     "b-del"),
    "constraints_add":   ("Constraint", "Nuevo",     "b-add"),
    "constraints_alter": ("Constraint", "Diferente", "b-chg"),
    "constraints_drop":  ("Constraint", "Sobra",     "b-del"),
}


def compare(source, target, db1_name="BD1", db2_name="BD2"):
    """source = BD2 (referencia), target = BD1 (a modificar).

    db1_name/db2_name son los nombres de las conexiones, usados en los mensajes.

    Devuelve dict con:
      - groups: {group_key: [ {id, table, name, detail, sql, destructive}, ... ]}
      - sql_by_id: {id: sql}
      - total_changes: int
    """
    groups = {g: [] for g in GROUP_ORDER}
    sql_by_id = {}

    rows = []  # lista plana para la grilla

    def add(group, cid, table, name, detail, sql):
        type_label, status_label, status_class = GROUP_META[group]
        item = {
            "id": cid,
            "group": group,
            "table": table,
            "name": name,
            "detail": detail,
            "sql": sql,
            "type": type_label,
            "status": status_label,
            "status_class": status_class,
            "destructive": group in DESTRUCTIVE_GROUPS,
        }
        groups[group].append(item)
        rows.append(item)
        sql_by_id[cid] = sql

    src_tables = source.table_names
    tgt_tables = target.table_names
    new_tables = src_tables - tgt_tables       # crear completas
    only_target = sorted(tgt_tables - src_tables)
    common = sorted(src_tables & tgt_tables)

    # --- Tablas nuevas: CREATE TABLE completo --------------------------
    for table in sorted(new_tables):
        cols = source.tables[table]
        n_con = sum(1 for k in source.constraints if k[0] == table)
        n_idx = sum(1 for k in source.indexes if k[0] == table)
        detail = (f"{len(cols)} columnas, {n_con} constraints, {n_idx} índices "
                  f"· solo existe en {db2_name}")
        add("tables_create", f"tbl_add:{table}", table, table, detail,
            _create_table_sql(table, source))

    # --- Tablas que sobran: DROP TABLE (comentado) ---------------------
    for table in only_target:
        add("tables_drop", f"tbl_drop:{table}", table, table,
            f"solo existe en {db1_name}", f"-- DROP TABLE {_q(table)};")

    # --- Columnas (tablas comunes) -------------------------------------
    for table in common:
        src_cols = source.tables[table]
        tgt_cols = target.tables[table]

        for col in sorted(set(src_cols) - set(tgt_cols)):
            add("columns_add", f"col_add:{table}:{col}", table, col,
                f"{src_cols[col]['data_type']} · solo existe en {db2_name}",
                f"ALTER TABLE {_q(table)} ADD COLUMN {_column_ddl(col, src_cols[col])};")

        for col in sorted(set(tgt_cols) - set(src_cols)):
            add("columns_drop", f"col_drop:{table}:{col}", table, col,
                f"{tgt_cols[col]['data_type']} · solo existe en {db1_name}",
                f"-- ALTER TABLE {_q(table)} DROP COLUMN {_q(col)};")

        for col in sorted(set(src_cols) & set(tgt_cols)):
            s = src_cols[col]
            t = tgt_cols[col]
            if s["data_type"] != t["data_type"]:
                add("columns_alter", f"col_type:{table}:{col}", table, col,
                    f"tipo: {t['data_type']} → {s['data_type']}",
                    f"ALTER TABLE {_q(table)} ALTER COLUMN {_q(col)} "
                    f"TYPE {s['data_type']} USING {_q(col)}::{s['data_type']};")
            if s["not_null"] != t["not_null"]:
                action = "SET NOT NULL" if s["not_null"] else "DROP NOT NULL"
                add("columns_alter", f"col_null:{table}:{col}", table, col,
                    f"NOT NULL: {t['not_null']} → {s['not_null']}",
                    f"ALTER TABLE {_q(table)} ALTER COLUMN {_q(col)} {action};")
            if (s["default"] or None) != (t["default"] or None):
                if s["default"] is None:
                    stmt = f"ALTER TABLE {_q(table)} ALTER COLUMN {_q(col)} DROP DEFAULT;"
                else:
                    stmt = f"ALTER TABLE {_q(table)} ALTER COLUMN {_q(col)} SET DEFAULT {s['default']};"
                add("columns_alter", f"col_def:{table}:{col}", table, col,
                    f"default: {t['default']} → {s['default']}", stmt)

    # --- Índices (excluye los de tablas nuevas: ya van en su CREATE) ---
    for key in sorted(set(source.indexes) - set(target.indexes)):
        table, name = key
        if table in new_tables:
            continue
        add("indexes_add", f"idx_add:{table}:{name}", table, name,
            f"{source.indexes[key]['def']} · solo existe en {db2_name}",
            f"{source.indexes[key]['def']};")
    for key in sorted(set(source.indexes) & set(target.indexes)):
        table, name = key
        s_def = source.indexes[key]["def"]
        t_def = target.indexes[key]["def"]
        if s_def != t_def:
            add("indexes_alter", f"idx_alter:{table}:{name}", table, name,
                f"definición: {t_def} → {s_def}",
                f"DROP INDEX {_q(name)};\n{s_def};")
    for key in sorted(set(target.indexes) - set(source.indexes)):
        table, name = key
        add("indexes_drop", f"idx_drop:{table}:{name}", table, name,
            f"{target.indexes[key]['def']} · solo existe en {db1_name}",
            f"-- DROP INDEX {_q(name)};")

    # --- Constraints (excluye los de tablas nuevas) --------------------
    for key in sorted(set(source.constraints) - set(target.constraints)):
        table, name = key
        if table in new_tables:
            continue
        c = source.constraints[key]
        add("constraints_add", f"con_add:{table}:{name}", table, name,
            f"{c['type']} — {c['def']} · solo existe en {db2_name}",
            f"ALTER TABLE {_q(table)} ADD CONSTRAINT {_q(name)} {c['def']};")
    for key in sorted(set(source.constraints) & set(target.constraints)):
        table, name = key
        s = source.constraints[key]
        t = target.constraints[key]
        if s["def"] != t["def"]:
            add("constraints_alter", f"con_alter:{table}:{name}", table, name,
                f"{s['type']} — definición: {t['def']} → {s['def']}",
                f"ALTER TABLE {_q(table)} DROP CONSTRAINT {_q(name)};\n"
                f"ALTER TABLE {_q(table)} ADD CONSTRAINT {_q(name)} {s['def']};")
    for key in sorted(set(target.constraints) - set(source.constraints)):
        table, name = key
        c = target.constraints[key]
        add("constraints_drop", f"con_drop:{table}:{name}", table, name,
            f"{c['type']} — {c['def']} · solo existe en {db1_name}",
            f"-- ALTER TABLE {_q(table)} DROP CONSTRAINT {_q(name)};")

    total = sum(len(v) for v in groups.values())
    return {"groups": groups, "rows": rows, "sql_by_id": sql_by_id, "total_changes": total}


def build_script(db1_name, db2_name, sql_by_id, selected_ids, schema="public"):
    """Arma el script SQL con solo los cambios seleccionados.

    `selected_ids` se filtra respetando el orden canónico de `sql_by_id`.
    `schema` es el esquema de BD1: el script fija el search_path para que
    las sentencias (que van sin calificar) apliquen sobre ese esquema.
    """
    selected = set(selected_ids)
    lines = [
        "-- ============================================================",
        "-- Script ALTER generado por Comparador de BD",
        f"-- Referencia (BD2): {db2_name}",
        f"-- A modificar (BD1): {db1_name}",
        f"-- Esquema: {schema}",
        "-- Solo se incluyen los cambios seleccionados.",
        "-- Las sentencias DROP van comentadas por seguridad.",
        "-- ============================================================",
        "BEGIN;",
        "",
        f"SET LOCAL search_path TO {_q(schema)};",
        "",
    ]
    included = 0
    for cid, sql in sql_by_id.items():
        if cid in selected:
            lines.append(sql)
            included += 1
    if included == 0:
        lines.append("-- (No se seleccionó ningún cambio)")
    lines += ["", "COMMIT;"]
    return "\n".join(lines)
