from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="DatabaseConnection",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(help_text="Alias para identificar la conexión, ej: 'Producción' o 'QA'.", max_length=100, unique=True, verbose_name="Nombre")),
                ("host", models.CharField(default="localhost", max_length=255, verbose_name="Host")),
                ("port", models.PositiveIntegerField(default=5432, verbose_name="Puerto")),
                ("dbname", models.CharField(max_length=255, verbose_name="Base de datos")),
                ("user", models.CharField(max_length=255, verbose_name="Usuario")),
                ("password", models.CharField(blank=True, max_length=255, verbose_name="Contraseña")),
                ("schema", models.CharField(default="public", help_text="Esquema de PostgreSQL a comparar (por defecto 'public').", max_length=255, verbose_name="Esquema")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "verbose_name": "Conexión de base de datos",
                "verbose_name_plural": "Conexiones de base de datos",
                "ordering": ["name"],
            },
        ),
    ]
