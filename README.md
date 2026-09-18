# Comparador de Bases de Datos PostgreSQL

Aplicación de **escritorio** (Windows, macOS y Linux) que compara la
**estructura** de dos bases de datos PostgreSQL y genera el **script `ALTER`**
necesario para igualar BD1 con BD2.

Todo se ejecuta en la máquina de quien compara: no hay servidor, ni servicio
web, ni nada que instalar aparte de la propia aplicación. Las únicas
conexiones de red que abre son las que van a las bases de datos que registres.

## Qué compara

- **Campos / columnas** (nuevas, faltantes y modificadas: tipo, NOT NULL, DEFAULT)
- **Comentarios de las columnas** (`COMMENT ON COLUMN`): los que faltan, los que
  cambiaron y los que sobran en BD1
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
`.AppImage` y `.deb` (Linux), en `dist/`. macOS hay que construirlo en macOS
(y conviene firmar y notarizar); Windows se puede construir desde Linux o WSL
si hay `wine` instalado.

## Ejecutarlo en Windows con WSL

Dos caminos, según dónde estén las bases de datos.

### 1. Dentro de WSL (rápido para desarrollar)

Windows 11 muestra la ventana con WSLg sin configurar nada; en Windows 10
hace falta un servidor X (VcXsrv) y exportar `DISPLAY`.

```bash
npm install
npm start
```

Si la ventana no abre, casi siempre faltan librerías del sistema. Este
comando dice exactamente cuáles:

```bash
ldd node_modules/electron/dist/electron | grep "not found"
```

En Ubuntu 24.04 suele bastar con:

```bash
sudo apt install -y libnss3 libgbm1 libxshmfence1 libgtk-3-0t64 \
  libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64
```

(en Ubuntu 22.04 los mismos paquetes van sin el sufijo `t64`). Si el sandbox
de Chromium se queja, arranca con `npm start -- --no-sandbox`.

> **Ojo con la red:** desde WSL2, `localhost` es la propia WSL, no Windows.
> Si PostgreSQL corre en Windows o solo es accesible desde allí, usa la IP del
> host (`ip route show default | awk '{print $3}'`) en vez de `localhost`, o
> mejor usa el ejecutable nativo del punto 2.

### 2. Ejecutable nativo de Windows (para usarlo de verdad)

**Sin wine** — genera la aplicación lista para usar, sin instalador:

```bash
npm run pack:win
```

Deja `dist/win-unpacked/` con `Comparador de BD.exe` dentro. Esa carpeta se
copia a donde quieras en Windows (`/mnt/c/...`) y se abre con doble clic:
no necesita WSL, ni wine, ni Node instalados.

**Con instalador** — electron-builder usa NSIS, que son binarios de 32 bits,
así que wine necesita soporte i386 (no basta con `wine64`):

```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install -y wine32 wine64
npm run dist:win
```

Produce `dist/Comparador de BD Setup <versión>.exe` y la versión portable.
Si `npm run dist:win` falla con `failed to load ... ntdll.dll` o
`syswow64`, es exactamente eso: falta el wine de 32 bits.

La tercera opción es instalar Node.js en Windows y ejecutar `npm install` y
`npm run dist:win` desde PowerShell, sin wine de por medio.

### 3. Sin compilar nada: dejar que lo haga GitHub

El repositorio trae un flujo de trabajo (`.github/workflows/build.yml`) que
compila en Windows y en Linux:

- **A demanda**: pestaña *Actions* → *Compilar aplicación* → *Run workflow*.
  Al terminar, los ejecutables quedan descargables como *artifacts* de esa
  ejecución.
- **Como release**: al empujar una etiqueta se publica una release con los
  instaladores adjuntos.

  ```bash
  git tag v2.0.0 && git push origin v2.0.0
  ```

> Ejecutar el `.exe` **dentro de wine** no funciona bien (Chromium necesita
> DirectComposition, que wine no implementa). No importa: en Windows corre
> de forma nativa. Wine aquí solo sirve para *construir* el instalador.

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

## Autor

**Danilo Sánchez** — [perfil en LinkedIn](https://www.linkedin.com/in/danilo-s%C3%A1nchez-34a391126/)
