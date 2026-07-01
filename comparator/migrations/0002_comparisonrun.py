from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("comparator", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="ComparisonRun",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("db1_name", models.CharField(max_length=100, verbose_name="BD1 (destino)")),
                ("db2_name", models.CharField(max_length=100, verbose_name="BD2 (referencia)")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Fecha")),
                ("total_changes", models.PositiveIntegerField(default=0, verbose_name="Diferencias")),
                ("rows", models.JSONField(default=list, verbose_name="Filas")),
                ("sql_by_id", models.JSONField(default=dict, verbose_name="SQL por id")),
                ("script", models.TextField(blank=True, verbose_name="Script generado")),
                ("selected_ids", models.JSONField(default=list, verbose_name="Cambios seleccionados")),
            ],
            options={
                "verbose_name": "Comparación",
                "verbose_name_plural": "Historial de comparaciones",
                "ordering": ["-created_at"],
            },
        ),
    ]
