'use strict';

const path = require('path');
const {
  app, BrowserWindow, dialog, safeStorage, shell,
} = require('electron');

const { createCipher } = require('./core/secrets');
const { createLogger } = require('./logger');
const { createWindowState } = require('./window-state');
const { registerIpc } = require('./ipc');
const { Store } = require('./core/store');
const { buildMenu } = require('./menu');

// Carpeta de datos propia, dentro de la del usuario del sistema.
app.setName('Comparador de BD');
app.setPath('userData', path.join(app.getPath('appData'), 'pg-compare-desktop'));

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');

let mainWindow = null;
let logger = null;

if (!app.requestSingleInstanceLock()) {
  // Ya hay una instancia abierta: la otra se enfocará sola.
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.whenReady().then(start).catch(fatal);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusWindow();
  });

  app.on('quit', () => logger && logger.close());
}

function start() {
  const userData = app.getPath('userData');
  logger = createLogger(path.join(userData, 'logs'));
  logger.info(
    `Comparador de BD ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform}`,
  );

  const cipher = createCipher(safeStorage, logger);
  const store = new Store(userData, { cipher });
  if (store.loadError) logger.error(store.loadError);

  registerIpc({ store, cipher, logger, getWindow: () => mainWindow });
  buildMenu(() => mainWindow);
  createWindow();
}

function createWindow() {
  const state = createWindowState(app.getPath('userData'));
  const { bounds, minimum } = state;

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: minimum.width,
    minHeight: minimum.height,
    show: false,
    backgroundColor: '#0b1120',
    title: 'Comparador de BD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  state.track(mainWindow);
  if (bounds.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  guardNavigation(mainWindow);
  mainWindow.loadFile(RENDERER);
}

/**
 * La interfaz vive en disco y no navega a ningún sitio: cualquier enlace
 * externo se abre en el navegador del sistema, nunca dentro de la app.
 */
function guardNavigation(win) {
  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`La interfaz se cerró inesperadamente: ${details.reason}`);
  });
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function fatal(error) {
  if (logger) logger.error(`${error.message}\n${error.stack || ''}`);
  dialog.showErrorBox('Comparador de BD', `No se pudo iniciar la aplicación:\n\n${error.message}`);
  app.exit(1);
}
