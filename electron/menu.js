'use strict';

const { Menu, app, dialog, shell } = require('electron');

const isMac = process.platform === 'darwin';

const AUTHOR = {
  name: 'Danilo Sánchez',
  url: 'https://www.linkedin.com/in/danilo-s%C3%A1nchez-34a391126/',
};

/** Pide a la interfaz que cambie de vista (las rutas son hashes). */
function navigate(win, route) {
  if (win && !win.isDestroyed()) win.webContents.send('navigate', route);
}

async function aboutDialog(win) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Acerca de Comparador de BD',
    message: 'Comparador de Bases de Datos PostgreSQL',
    detail: [
      `Versión: ${app.getVersion()}`,
      `Autor: ${AUTHOR.name}`,
      '',
      `Electron: ${process.versions.electron}`,
      `Chromium: ${process.versions.chrome}`,
      `Node: ${process.versions.node}`,
      '',
      'Aplicación local: no envía nada a internet y solo se conecta a las',
      'bases de datos que registres.',
      '',
      `Datos: ${app.getPath('userData')}`,
    ].join('\n'),
    buttons: ['Cerrar', 'Perfil del autor'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) shell.openExternal(AUTHOR.url);
}

/**
 * Menú nativo en español. `getWindow()` devuelve la ventana activa, que
 * puede haberse recreado (macOS permite cerrarla sin salir de la app).
 */
function buildMenu(getWindow) {
  const withWindow = (fn) => () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) fn(win);
  };
  const go = (route) => withWindow((win) => navigate(win, route));

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'Acerca de Comparador de BD', click: withWindow(aboutDialog) },
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
        { label: 'Nueva conexión', accelerator: 'CmdOrCtrl+N', click: go('#/conexiones/nueva') },
        { label: 'Nuevo proyecto', accelerator: 'CmdOrCtrl+Shift+N', click: go('#/proyectos/nuevo') },
        { label: 'Nueva comparación', accelerator: 'CmdOrCtrl+D', click: go('#/comparar') },
        { type: 'separator' },
        {
          label: 'Guardar script .sql…',
          accelerator: 'CmdOrCtrl+S',
          click: withWindow((win) => win.webContents.send('save-script')),
        },
        { type: 'separator' },
        { label: 'Abrir carpeta de datos', click: () => shell.openPath(app.getPath('userData')) },
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
        { label: 'Proyectos', accelerator: 'CmdOrCtrl+1', click: go('#/') },
        { label: 'Comparar (ad hoc)', accelerator: 'CmdOrCtrl+2', click: go('#/comparar') },
        { label: 'Historial', accelerator: 'CmdOrCtrl+3', click: go('#/historial') },
        { label: 'Conexiones', accelerator: 'CmdOrCtrl+4', click: go('#/conexiones') },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { type: 'separator' },
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
        ...(isMac
          ? [{ role: 'zoom', label: 'Zoom' }, { type: 'separator' }, { role: 'front', label: 'Traer todo al frente' }]
          : []),
      ],
    },
    {
      role: 'help',
      label: 'Ayuda',
      submenu: [
        { label: 'Acerca de', click: withWindow(aboutDialog) },
        { label: 'Abrir carpeta de datos', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
