from django.test import SimpleTestCase, TestCase
from django.urls import reverse

from . import diff
from .introspect import Schema
from .models import ComparisonRun


def _col(ordinal, dtype, not_null=False, default=None):
    return {"ordinal": ordinal, "data_type": dtype, "not_null": not_null, "default": default}


def _schemas():
    """Par de esquemas sintéticos: source = BD2 (referencia), target = BD1."""
    source = Schema("ventas")
    source.tables["clientes"] = {
        "id": _col(1, "integer", True, "nextval('clientes_id_seq'::regclass)"),
        "nombre": _col(2, "character varying(100)", True),
        "email": _col(3, "text"),
    }
    source.indexes[("clientes", "idx_nombre")] = {
        "def": "CREATE INDEX idx_nombre ON clientes USING btree (nombre)",
    }
    source.constraints[("clientes", "clientes_pkey")] = {"type": "PRIMARY KEY", "def": "PRIMARY KEY (id)"}
    source.constraints[("clientes", "chk_email")] = {"type": "CHECK", "def": "CHECK (email <> ''::text)"}

    target = Schema("ventas")
    target.tables["clientes"] = {
        "id": _col(1, "integer", True, "nextval('clientes_id_seq'::regclass)"),
        "nombre": _col(2, "character varying(100)", True),
    }
    target.indexes[("clientes", "idx_nombre")] = {
        "def": "CREATE INDEX idx_nombre ON clientes USING btree (lower(nombre))",
    }
    target.constraints[("clientes", "clientes_pkey")] = {"type": "PRIMARY KEY", "def": "PRIMARY KEY (id)"}
    target.constraints[("clientes", "chk_email")] = {"type": "CHECK", "def": "CHECK (length(email) > 3)"}
    return source, target


class DiffTests(SimpleTestCase):
    def test_detecta_columna_nueva_e_indices_y_constraints_modificados(self):
        source, target = _schemas()
        result = diff.compare(source, target, db1_name="qa", db2_name="prod")

        self.assertEqual(result["total_changes"], 3)
        self.assertEqual(
            set(result["sql_by_id"]),
            {"col_add:clientes:email", "idx_alter:clientes:idx_nombre", "con_alter:clientes:chk_email"},
        )

    def test_indice_modificado_se_recrea(self):
        source, target = _schemas()
        result = diff.compare(source, target)
        sql = result["sql_by_id"]["idx_alter:clientes:idx_nombre"]
        self.assertEqual(
            sql,
            'DROP INDEX "idx_nombre";\n'
            "CREATE INDEX idx_nombre ON clientes USING btree (nombre);",
        )

    def test_constraint_modificado_se_recrea(self):
        source, target = _schemas()
        result = diff.compare(source, target)
        sql = result["sql_by_id"]["con_alter:clientes:chk_email"]
        self.assertEqual(
            sql,
            'ALTER TABLE "clientes" DROP CONSTRAINT "chk_email";\n'
            'ALTER TABLE "clientes" ADD CONSTRAINT "chk_email" CHECK (email <> \'\'::text);',
        )

    def test_sin_diferencias(self):
        source, _ = _schemas()
        result = diff.compare(source, source)
        self.assertEqual(result["total_changes"], 0)

    def test_build_script_fija_search_path_y_filtra_seleccion(self):
        source, target = _schemas()
        result = diff.compare(source, target)
        script = diff.build_script(
            "qa", "prod", result["sql_by_id"],
            ["idx_alter:clientes:idx_nombre"], schema="ventas",
        )
        self.assertIn('SET LOCAL search_path TO "ventas";', script)
        self.assertIn("BEGIN;", script)
        self.assertIn("COMMIT;", script)
        self.assertIn('DROP INDEX "idx_nombre";', script)
        self.assertNotIn("chk_email", script)

    def test_build_script_sin_seleccion(self):
        script = diff.build_script("qa", "prod", {"x": "ALTER;"}, [])
        self.assertIn("-- (No se seleccionó ningún cambio)", script)
        self.assertNotIn("ALTER;", script)


class GenerateScriptViewTests(TestCase):
    def _run(self, **extra):
        return ComparisonRun.objects.create(
            db1_name="qa", db2_name="prod", db1_schema="ventas",
            total_changes=1, rows=[], sql_by_id={"x": "ALTER TABLE \"t\" ADD COLUMN \"c\" text;"},
            **extra,
        )

    def test_get_no_permitido_y_no_borra_script_previo(self):
        run = self._run(script="-- script previo", selected_ids=["x"])
        resp = self.client.get(reverse("generate_script", args=[run.pk]))
        self.assertEqual(resp.status_code, 405)
        run.refresh_from_db()
        self.assertEqual(run.script, "-- script previo")
        self.assertEqual(run.selected_ids, ["x"])

    def test_post_genera_script_con_esquema_del_run(self):
        run = self._run()
        resp = self.client.post(
            reverse("generate_script", args=[run.pk]), {"changes": ["x"]},
        )
        self.assertEqual(resp.status_code, 200)
        run.refresh_from_db()
        self.assertIn('SET LOCAL search_path TO "ventas";', run.script)
        self.assertIn('ADD COLUMN "c" text;', run.script)
        self.assertEqual(run.selected_ids, ["x"])
