import psycopg2

from django.db import models


class DatabaseConnection(models.Model):
    """Una conexión a una base de datos PostgreSQL registrada por el usuario.

    Se pueden guardar N conexiones y seleccionarlas para comparar.
    """

    name = models.CharField(
        "Nombre", max_length=100, unique=True,
        help_text="Alias para identificar la conexión, ej: 'Producción' o 'QA'.",
    )
    host = models.CharField("Host", max_length=255, default="localhost")
    port = models.PositiveIntegerField("Puerto", default=5432)
    dbname = models.CharField("Base de datos", max_length=255)
    user = models.CharField("Usuario", max_length=255)
    password = models.CharField("Contraseña", max_length=255, blank=True)
    schema = models.CharField(
        "Esquema", max_length=255, default="public",
        help_text="Esquema de PostgreSQL a comparar (por defecto 'public').",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "Conexión de base de datos"
        verbose_name_plural = "Conexiones de base de datos"

    def __str__(self):
        return f"{self.name} ({self.user}@{self.host}:{self.port}/{self.dbname})"

    def connect(self):
        """Abre una conexión psycopg2 usando estos datos."""
        return psycopg2.connect(
            host=self.host,
            port=self.port,
            dbname=self.dbname,
            user=self.user,
            password=self.password,
            connect_timeout=10,
        )

    def test_connection(self):
        """Devuelve (ok: bool, mensaje: str)."""
        try:
            conn = self.connect()
            conn.close()
            return True, "Conexión exitosa"
        except Exception as exc:  # noqa: BLE001
            return False, str(exc)


class ComparisonProject(models.Model):
    """Par de bases configurado una sola vez para comparar repetidamente."""

    name = models.CharField("Nombre", max_length=120, unique=True)
    db1 = models.ForeignKey(
        DatabaseConnection, on_delete=models.CASCADE,
        related_name="projects_as_db1", verbose_name="BD1 (destino)",
    )
    db2 = models.ForeignKey(
        DatabaseConnection, on_delete=models.CASCADE,
        related_name="projects_as_db2", verbose_name="BD2 (referencia)",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "Proyecto de comparación"
        verbose_name_plural = "Proyectos de comparación"

    def __str__(self):
        return f"{self.name} ({self.db1.name} → {self.db2.name})"


class ComparisonRun(models.Model):
    """Historial: guarda el resultado de una comparación para no perderlo."""

    project = models.ForeignKey(
        ComparisonProject, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="runs", verbose_name="Proyecto",
    )
    db1_conn = models.ForeignKey(
        DatabaseConnection, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="runs_as_db1",
    )
    db2_conn = models.ForeignKey(
        DatabaseConnection, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="runs_as_db2",
    )
    db1_name = models.CharField("BD1 (destino)", max_length=100)
    db2_name = models.CharField("BD2 (referencia)", max_length=100)
    created_at = models.DateTimeField("Fecha", auto_now_add=True)
    total_changes = models.PositiveIntegerField("Diferencias", default=0)

    # Snapshot del resultado del diff.
    rows = models.JSONField("Filas", default=list)
    sql_by_id = models.JSONField("SQL por id", default=dict)

    # Última generación de script y selección.
    script = models.TextField("Script generado", blank=True)
    selected_ids = models.JSONField("Cambios seleccionados", default=list)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Comparación"
        verbose_name_plural = "Historial de comparaciones"

    def __str__(self):
        return f"{self.db1_name} v {self.db2_name} ({self.created_at:%Y-%m-%d %H:%M})"

    def rerun_pair(self):
        """Devuelve (db1_conn, db2_conn) para re-ejecutar, o (None, None)."""
        if self.db1_conn and self.db2_conn:
            return self.db1_conn, self.db2_conn
        if self.project:
            return self.project.db1, self.project.db2
        return None, None

    @property
    def can_rerun(self):
        d1, d2 = self.rerun_pair()
        return bool(d1 and d2)
