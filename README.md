# Comparador de Bases de Datos PostgreSQL (Django)

App web en Django para comparar la **estructura** de dos bases de datos PostgreSQL
y generar el **script `ALTER`** necesario para igualar BD1 con BD2.

## Qué compara

- **Campos / columnas** (nuevas, faltantes y modificadas: tipo, NOT NULL, DEFAULT)
- **Índices**
- **Constraints** (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, EXCLUSION)
- **Tablas** completas que existen en una y no en otra

Además puedes **guardar N conexiones** y seleccionarlas para comparar.

## Cómo funciona la dirección de la comparación

- **BD1 = destino** (la que se quiere modificar)
- **BD2 = referencia** (la estructura deseada)

El script generado transforma **BD1** para que quede igual a **BD2**.
Las sentencias destructivas (`DROP TABLE`, `DROP COLUMN`, `DROP INDEX`,
`DROP CONSTRAINT`) se generan **comentadas** por seguridad: revísalas y
descoméntalas si realmente quieres aplicarlas.

## Instalación

```bash
cd db_comparator
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Prepara la BD interna (guarda las conexiones registradas)
python manage.py migrate

# (Opcional) crea un usuario admin para /admin/
python manage.py createsuperuser

# Arranca el servidor
python manage.py runserver
```

Abre http://127.0.0.1:8000/

## Uso

1. Ve a **Conexiones → Nueva conexión** y registra tus bases (host, puerto,
   base, usuario, contraseña, esquema). Usa **Probar** para validar.
2. Ve a **Comparar**, selecciona **BD1** (destino) y **BD2** (referencia).
3. Revisa el reporte de diferencias y **descarga el script `.sql`**.

## Notas

- La BD interna de la app usa SQLite por defecto (`db.sqlite3`). Puedes
  cambiarla a PostgreSQL en `dbcompare/settings.py` → `DATABASES`.
- Las contraseñas de las conexiones se guardan en texto plano en la BD interna.
  Para producción, considera cifrarlas o usar variables de entorno / un
  gestor de secretos.
- Solo se comparan tablas ordinarias (`relkind = 'r'`) del esquema indicado.
