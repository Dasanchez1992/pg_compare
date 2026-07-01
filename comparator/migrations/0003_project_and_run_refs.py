import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("comparator", "0002_comparisonrun"),
    ]

    operations = [
        migrations.CreateModel(
            name="ComparisonProject",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120, unique=True, verbose_name="Nombre")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("db1", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="projects_as_db1", to="comparator.databaseconnection", verbose_name="BD1 (destino)")),
                ("db2", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="projects_as_db2", to="comparator.databaseconnection", verbose_name="BD2 (referencia)")),
            ],
            options={
                "verbose_name": "Proyecto de comparación",
                "verbose_name_plural": "Proyectos de comparación",
                "ordering": ["name"],
            },
        ),
        migrations.AddField(
            model_name="comparisonrun",
            name="project",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="runs", to="comparator.comparisonproject", verbose_name="Proyecto"),
        ),
        migrations.AddField(
            model_name="comparisonrun",
            name="db1_conn",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="runs_as_db1", to="comparator.databaseconnection"),
        ),
        migrations.AddField(
            model_name="comparisonrun",
            name="db2_conn",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="runs_as_db2", to="comparator.databaseconnection"),
        ),
    ]
