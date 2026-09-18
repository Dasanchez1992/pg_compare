# Comparador de BD — app de escritorio (Electron)

Empaqueta la app Django de este repositorio como aplicación de escritorio para
Windows, macOS y Linux. **No es una reescritura**: Electron arranca el mismo
backend Django en `127.0.0.1` con un puerto libre y muestra sus páginas en una
ventana nativa, así que vistas, plantillas y lógica de comparación son las
mismas que en modo web.

```
┌─ Electron (proceso principal) ──────────────────────────────┐
│  · elige carpeta de datos y genera un token de sesión       │
│  · lanza el backend y espera su línea "PGCOMPARE_READY"     │
│  · menús nativos, diálogo "Guardar como", registro, cierre  │
│                                                             │
│   ┌─ BrowserWindow ─────────┐   ┌─ backend (Python) ──────┐ │
│   │ http://127.0.0.1:<libre>│──▶│ Django + waitress       │ │
│   └─────────────────────────┘   │ SQLite en userData      │ │
└─────────────────────────────────┴─────────────────────────┴─┘
```

## Qué aporta frente a abrirlo en el navegador

- **Un solo icono**: no hay que activar el entorno virtual ni recordar la URL.
- **Sin Python en la máquina del usuario**: el backend se empaqueta con
  PyInstaller dentro de la app.
- **Datos del usuario donde toca**: la BD interna, la clave secreta, los
  estáticos y el registro viven en la carpeta de datos del sistema operativo,
  no junto al código.
- **Puerto dinámico + token**: el backend solo responde a la ventana que lo
  inició, aunque escuche en loopback.
- **Integración nativa**: menús en español con atajos, "Guardar script .sql…"
  con diálogo del sistema y "Mostrar en carpeta", tamaño de ventana recordado,
  una sola instancia, y los enlaces externos se abren en el navegador.
- **Funciona sin internet**: highlight.js se sirve desde la propia app.

## Desarrollo

Requisitos: Node.js 20+ y Python 3.10+.

```bash
# 1) Dependencias del backend (desde la raíz del repositorio)
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-desktop.txt

# 2) Dependencias de Electron
cd desktop
npm install

# 3) Arrancar
npm start
```

`npm start` detecta el intérprete en este orden: `PGCOMPARE_PYTHON`,
`.venv/` del repositorio, `venv/`, y por último `python3`/`python` del PATH.

```bash
PGCOMPARE_PYTHON=/ruta/a/python npm start   # forzar un intérprete concreto
```

En desarrollo el backend se ejecuta como `python -m dbcompare.desktop_server`,
así que cualquier cambio en Django se ve recargando la ventana (`Ctrl/Cmd+R`).

## Construir los instaladores

```bash
cd desktop
npm run dist          # backend con PyInstaller + instalador del SO actual
npm run pack          # solo la carpeta de la app, sin instalador (más rápido)
npm run build:backend # solo el binario del backend
```

`npm run dist` hace dos cosas: `scripts/build-backend.js` congela el backend en
`desktop/dist-backend/pgcompare-backend/` con PyInstaller
(receta en `build/backend.spec`), y después electron-builder copia esa carpeta
dentro de la app como `resources/backend/` y genera el instalador en
`desktop/dist/`.

Salidas por plataforma: `.dmg`/`.zip` (macOS), `.exe` NSIS y portable
(Windows), `.AppImage` y `.deb` (Linux).

> Cada instalador hay que construirlo en su propio sistema operativo: PyInstaller
> no hace compilación cruzada. Para macOS, además, conviene firmar y notarizar
> (`build/entitlements.mac.plist` ya trae los permisos que necesita el backend).

El icono se genera sin dependencias con `python3 build/make-icon.py`
(escribe `build/icon.png`, 1024×1024); electron-builder deriva de ahí el
`.icns` y el `.ico`.

## Dónde se guardan los datos

| Sistema | Carpeta |
| --- | --- |
| Windows | `%APPDATA%\pg-compare-desktop` |
| macOS | `~/Library/Application Support/pg-compare-desktop` |
| Linux | `~/.config/pg-compare-desktop` |

Contiene `db.sqlite3` (conexiones, proyectos e historial), `secret_key.txt`,
`static/`, `window-state.json` y `logs/backend.log`. Se abre desde el menú
**Archivo → Abrir carpeta de datos**. Desinstalar la app no la borra: las
comparaciones guardadas sobreviven a una reinstalación.

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `PGCOMPARE_PYTHON` | Intérprete a usar en desarrollo (ruta o comando del PATH). |
| `PGCOMPARE_DESKTOP` | `1` activa el modo escritorio en Django (lo pone el backend). |
| `PGCOMPARE_DATA_DIR` | Carpeta de datos alternativa. |
| `PGCOMPARE_TOKEN` | Token de acceso; lo genera Electron en cada arranque. |
| `PGCOMPARE_DEBUG` | `1` deja `DEBUG=True` para depurar (muestra los errores de Django). |

## Notas de seguridad

- El backend escucha **solo en loopback**, en un puerto que elige el sistema.
- Cada arranque genera un token nuevo; sin él, el backend responde `403`. La
  ventana lo recibe una vez por la URL y lo conserva en una cookie `HttpOnly`.
- La ventana corre con `contextIsolation`, `sandbox` y sin integración de Node;
  el puente `preload` solo existe para las pantallas de carga y de error.
- Las contraseñas de las conexiones **siguen guardándose en texto plano** en
  `db.sqlite3`, igual que en la versión web. Cifrarlas (por ejemplo con
  `safeStorage` de Electron o el llavero del sistema) es el siguiente paso
  natural si la app va a usarse en equipos compartidos.

## Si algo falla

La ventana de error muestra el motivo y las últimas líneas del registro, con
botones para reintentar, abrir el registro completo o salir. El registro está
siempre en `<carpeta de datos>/logs/backend.log`.

| Síntoma | Causa habitual |
| --- | --- |
| `No module named 'django'` | Faltan las dependencias: `pip install -r requirements-desktop.txt`. |
| `No se pudo ejecutar "python3"` | No hay Python en el PATH; usa `PGCOMPARE_PYTHON`. |
| `No se encontró el backend empaquetado` | Falta `npm run build:backend` antes de empaquetar. |
| La ventana se queda en "Iniciando…" | Mira el registro: suele ser una migración fallida. |
