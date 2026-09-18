# Comparador de Bases de Datos PostgreSQL

Aplicación de **escritorio** (Windows, macOS y Linux) que compara la
**estructura** de dos bases de datos PostgreSQL y genera el **script `ALTER`**
necesario para igualar BD1 con BD2.

Todo se ejecuta en la máquina de quien compara: no hay servidor, ni servicio
web, ni nada que instalar aparte de la propia aplicación. Las únicas
conexiones de red que abre son las que van a las bases de datos que registres.

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

Descarga el instalador de tu sistema (`.exe`, `.dmg`, `.AppImage` o `.deb`)
y ábrelo. No hace falta Python, ni Node, ni un servidor local.

Para trabajar sobre el código:

```bash
npm install
npm start          # abre la aplicación
npm test           # pruebas del comparador y del almacén
```

Requisitos de desarrollo: Node.js 20 o superior.

## Uso

1. Ve a **Conexiones → Nueva conexión** y registra tus bases (host, puerto,
   base, usuario, contraseña, esquema). Usa **Probar** para validar.
2. Compara de una de estas dos formas:
   - **Comparar (ad hoc)**: selecciona **BD1** (destino) y **BD2** (referencia)
     para una comparación puntual.
   - **Proyectos** (página de inicio): guarda un par BD1/BD2 con nombre y
     ejecuta la comparación con un clic cada vez que la necesites.
3. En el resultado, revisa la grilla de diferencias (filtrable por nombre,
   tipo y estado) y **marca con los checkboxes** los cambios que quieres
   incluir. Vienen todos marcados.
4. Pulsa **Generar script** y luego **guárdalo como `.sql`** o cópialo.

Cada comparación se guarda en el **Historial**: puedes volver a abrirla
(con el script y la selección que dejaste), **re-ejecutarla** sobre las
mismas bases para obtener un resultado fresco, o eliminarla.

Atajos: `Ctrl/Cmd+N` nueva conexión, `Ctrl/Cmd+D` nueva comparación,
`Ctrl/Cmd+S` guardar el script, `Ctrl/Cmd+1..4` para moverse entre secciones.

## Cómo está hecha

```
electron/            proceso principal (Node): ventana, menú y acceso a datos
  core/diff.js       comparación de esquemas y generación del script ALTER
  core/introspect.js lectura del catálogo de PostgreSQL (driver `pg`)
  core/store.js      almacén local en JSON (conexiones, proyectos, historial)
  core/secrets.js    cifrado de contraseñas con el llavero del sistema
  ipc.js             operaciones que la interfaz puede pedir
renderer/            interfaz (HTML/CSS/JS sin dependencias ni compilación)
test/                pruebas con el runner de Node
build/               icono y recursos de empaquetado
```

La interfaz corre aislada: sin acceso a Node ni al sistema de archivos, y
solo puede pedir las operaciones declaradas en `electron/preload.js`. El
acceso a PostgreSQL y al disco ocurre siempre en el proceso principal.

## Dónde se guardan los datos

| Sistema | Carpeta |
| --- | --- |
| Windows | `%APPDATA%\pg-compare-desktop` |
| macOS | `~/Library/Application Support/pg-compare-desktop` |
| Linux | `~/.config/pg-compare-desktop` |

Contiene `data.json` (conexiones, proyectos e índice del historial),
`runs/<id>.json` (el resultado de cada comparación), `window-state.json` y
`logs/app.log`. Se abre desde **Archivo → Abrir carpeta de datos**.
Desinstalar la aplicación no borra esa carpeta.

## Construir los instaladores

```bash
npm run dist          # instalador del sistema actual
npm run pack          # solo la carpeta de la app, sin instalador
npm run icon          # regenera build/icon.png
```

Salidas: `.dmg`/`.zip` (macOS), `.exe` NSIS y portable (Windows),
`.AppImage` y `.deb` (Linux), en `dist/`. Cada instalador se construye en su
propio sistema operativo; para macOS conviene además firmar y notarizar.

## Notas

- Las contraseñas se guardan cifradas con el llavero del sistema (Keychain,
  DPAPI, libsecret/kwallet). Si el sistema no ofrece llavero, la aplicación
  lo avisa en la barra inferior y las guarda en texto plano.
- Marca **Conectar con SSL** en la conexión si el servidor exige cifrado.
- Solo se comparan tablas ordinarias (`relkind = 'r'`) del esquema indicado.
  No se comparan vistas, secuencias, funciones ni triggers.
- La comparación de índices/constraints usa el texto de `pg_get_indexdef` /
  `pg_get_constraintdef`: si las dos bases corren versiones muy distintas de
  PostgreSQL pueden aparecer falsos positivos por diferencias de formato.
- Versiones anteriores de este proyecto eran una app web en Django. El
  comparador es el mismo, portado a JavaScript; el historial de git conserva
  aquella versión.
