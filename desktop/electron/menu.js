'use strict';

const { Menu, app, dialog, shell } = require('electron');

const isMac = process.platform === 'darwin';

/** Navega a una ruta del backend local (la cookie de sesión ya está puesta). */
function navigate(win, baseUrl, route) {
  if (!win || win.isDestroyed() || !baseUrl) return;
  win.loadURL(new URL(route, baseUrl).toString());
}

function goBack(win) {
  const wc = win.webContents;
  const history = wc.navigationHistory;
  if (history && typeof history.canGoBack === 'function') {
    if (history.canGoBack()) history.goBack();
  } else if (typeof wc.canGoBack === 'function' && wc.canGoBack()) {
    wc.goBack();
  }
}

function goForward(win) {
  const wc = win.webContents;
  const history = wc.navigationHistory;
  if (history && typeof history.canGoForward === 'function') {
    if (history.canGoForward()) history.goForward();
  } else if (typeof wc.canGoForward === 'function' && wc.canGoForward()) {
    wc.goForward();
  }
}

/**
 * Descarga el script de la comparación abierta pulsando su enlace.
 * Así reutilizamos la vista de Django y el diálogo nativo de guardado.
 */
async function saveScript(win) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const link = document.querySelector('a[href*="/descargar/"]');
      if (!link) return false;
      link.click();
      return true;
    })()
  `).catch(() => false);

  if (!clicked) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Guardar script',
      message: 'No hay ningún script para guardar.',
      detail: 'Abre una comparación del historial y genera el script antes de guardarlo.',
      buttons: ['Entendido'],
    });
  }
}

function aboutDialog(win, backendInfo) {
  const detail = [
    `Versión: ${app.getVersion()}`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    backendInfo && `Django: ${backendInfo.django}`,
    backendInfo && `Python: ${backendInfo.python}`,
    backendInfo && `Backend: ${backendInfo.url}`,
  ].filter(Boolean).join('\n');

  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Acerca de Comparador de BD',
    message: 'Comparador de Bases de Datos PostgreSQL',
    detail,
    buttons: ['Cerrar'],
  });
}

/**
 * Menú nativo en español. `getContext()` devuelve la ventana, la URL del
 * backend y la ruta del registro, que cambian cuando el backend se reinicia.
 */
function buildMenu(getContext) {
  const withWindow = (fn) => () => {
    const { win, baseUrl, backendInfo, logPath } = getContext();
    if (!win || win.isDestroyed()) return;
    fn({ win, baseUrl, backendInfo, logPath });
  };

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'Acerca de Comparador de BD', click: withWindow(({ win, backendInfo }) => aboutDialog(win, backendInfo)) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar' },
        { role: 'hideOthers', label: 'Ocultar otros' },
        { role: 'unhide', label: 'Mostrar todo' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' },
      ],
    }] : []),
    {
      label: 'Archivo',
      submenu: [
        {
          label: 'Nueva conexión',
          accelerator: 'CmdOrCtrl+N',
          click: withWindow(({ win, baseUrl }) => navigate(win, baseUrl, '/conexiones/nueva/')),
        },
        {
          label: 'Nuevo proyecto',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: withWindow(({ win, baseUrl }) => navigate(win, baseUrl, '/proyectos/nuevo/')),
        },
        { type: 'separator' },
        {
          label: 'Guardar script .sql…',
          accelerator: 'CmdOrCtrl+S',
          click: withWindow(({ win }) => saveScript(win)),
        },
        { type: 'separator' },
        {
          label: 'Abrir carpeta de datos',
          click: () => shell.openPath(app.getPath('userData')),
        },
        {
          label: 'Ver registro del backend',
          click: withWindow(({ logPath }) => logPath && shell.openPath(logPath)),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ir',
      submenu: [
        {
          label: 'Proyectos',
          accelerator: 'CmdOrCtrl+1',
          click: withWindow(({ win, baseUrl }) => navigate(win, baseUrl, '/')),
        },
        {
          label: 'Comparar (ad hoc)',
          accelerator: 'CmdOrCtrl+2',
          click: withWindow(({ win, baseUrl }) => navigate(win, baseUrl, '/comparar/')),
        },
        {
          label: 'Historial',
          accelerator: 'CmdOrCtrl+3',
          click: withWindow(({ win, baseUrl }) => navigate(win, baseUrl, '/historial/')),
        },
        {
          label: 'Conexiones',
          accelerator: 'CmdOrCtrl+4',
          click: withWindow(({ win, baseUrl }) => navigate(win, baseUrl, '/conexiones/')),
        },
        { type: 'separator' },
        {
          label: 'Atrás',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: withWindow(({ win }) => goBack(win)),
        },
        {
          label: 'Adelante',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: withWindow(({ win }) => goForward(win)),
        },
        { role: 'reload', label: 'Recargar' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'resetZoom', label: 'Tamaño normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'Ventana',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        ...(isMac ? [{ role: 'zoom', label: 'Zoom' }, { type: 'separator' }, { role: 'front', label: 'Traer todo al frente' }] : []),
      ],
    },
    {
      role: 'help',
      label: 'Ayuda',
      submenu: [
        { label: 'Acerca de', click: withWindow(({ win, backendInfo }) => aboutDialog(win, backendInfo)) },
        { label: 'Ver registro del backend', click: withWindow(({ logPath }) => logPath && shell.openPath(logPath)) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, navigate };
