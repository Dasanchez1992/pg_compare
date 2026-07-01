# Comparador de Bases de Datos PostgreSQL (Django)

App web en Django para comparar la **estructura** de dos bases de datos PostgreSQL
y generar el **script `ALTER`** necesario para igualar BD1 con BD2.

## Qué compara

- **Campos / columnas** (nuevas, faltantes y modificadas: tipo, NOT NULL, DEFAULT)
- **Índices** (nuevos, faltantes y con definición diferente)
- **Constraints** (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, EXCLUSION),
  incluyendo los que existen en ambas bases pero con definición distinta
- **Tablas** completas que existen en una y no en otra

Además puedes **guardar N conexiones** y seleccionarlas para comparar.

## Cómo funciona la dirección de la comparación

- **BD1 = destino** (la que se quiere modificar)
- **BD2 = referencia** (la estructura deseada)

El script generado transforma **BD1** para que quede igual a **BD2**.
Las sentencias destructivas (`DROP TABLE`, `DROP COLUMN`, `DROP INDEX`,
`DROP CONSTRAINT`) se generan **comentadas** por seguridad: revísalas y
descoméntalas si realmente quieres aplicarlas. Los índices y constraints
con definición diferente se recrean (DROP + CREATE sin comentar), ya que
no implican pérdida de datos.

El script va envuelto en `BEGIN; ... COMMIT;` y fija
`SET LOCAL search_path` al esquema de BD1, así las sentencias aplican
sobre el esquema correcto aunque no sea `public`.

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
2. Compara de una de estas dos formas:
   - **Comparar**: selecciona **BD1** (destino) y **BD2** (referencia) para una
     comparación puntual.
   - **Proyectos** (página de inicio): guarda un par BD1/BD2 con nombre y
     ejecuta la comparación con un clic cada vez que la necesites.
3. En el resultado, revisa la grilla de diferencias (filtrable por nombre,
   tipo y estado) y **marca con los checkboxes** los cambios que quieres
   incluir.
4. Pulsa **Generar script** y luego **descarga el `.sql`** o cópialo.

Cada comparación se guarda en el **Historial**: puedes volver a abrirla
(con el script y la selección que dejaste), **re-ejecutarla** sobre las
mismas bases para obtener un resultado fresco, o eliminarla.

## Notas

- La BD interna de la app usa SQLite por defecto (`db.sqlite3`). Puedes
  cambiarla a PostgreSQL en `dbcompare/settings.py` → `DATABASES`.
- Las contraseñas de las conexiones se guardan en texto plano en la BD interna.
  Para producción, considera cifrarlas o usar variables de entorno / un
  gestor de secretos.
- Solo se comparan tablas ordinarias (`relkind = 'r'`) del esquema indicado.
  No se comparan vistas, secuencias, funciones ni triggers.
- La comparación de índices/constraints usa el texto de `pg_get_indexdef` /
  `pg_get_constraintdef`: si las dos bases corren versiones muy distintas de
  PostgreSQL pueden aparecer falsos positivos por diferencias de formato.
- La app no tiene autenticación propia: pensada para uso local o en red
  interna de confianza.
