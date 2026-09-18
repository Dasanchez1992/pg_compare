'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const { startBackend } = require('./backend');
const { createLogger } = require('./logger');
const { buildMenu } = require('./menu');
const { createWindowState } = require('./window-state');

// Carpeta de datos propia (la misma que usa el backend por defecto).
app.setName('Comparador de BD');
app.setPath('userData', path.join(app.getPath('appData'), 'pg-compare-desktop'));

const UI_DIR = path.join(__dirname, 'ui');

let mainWindow = null;
let windowState = null;
let logger = null;
let backend = null;
let startupError = null;
let lastSaveDir = null;
let shuttingDown = false;
let downloadsReady = false;

if (!app.requestSingleInstanceLock()) {
  // Ya hay una instancia: la otra recibirá 'second-instance' y se enfocará.
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.whenReady().then(bootstrap).catch(fatal);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootstrap();
    else focusWindow();
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    shutdown();
  });
}

async function bootstrap() {
  const userData = app.getPath('userData');
  logger = logger || createLogger(path.join(userData, 'logs'));
  logger.info(
    `Comparador de BD ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform}`,
  );

  if (!mainWindow || mainWindow.isDestroyed()) createWindow(userData);
  registerMenu();
  await launchBackend();
}

function createWindow(userData) {
  windowState = createWindowState(userData);
  const { bounds, minimum } = windowState;

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
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  windowState.track(mainWindow);
  if (bounds.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  guardNavigation(mainWindow);
  setupDownloads(mainWindow);

  mainWindow.loadFile(path.join(UI_DIR, 'splash.html'));
}

async function launchBackend() {
  // En macOS la app sigue viva al cerrar la ventana: al reabrirla hay que
  // reutilizar el backend que ya está corriendo, no lanzar otro.
  if (backend) {
    await openApp();
    return;
  }

  startupError = null;
  try {
    backend = await startBackend({
      dataDir: app.getPath('userData'),
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      logger,
      onUnexpectedExit: handleBackendCrash,
    });
  } catch (error) {
    backend = null;
    logger.error(error.message);
    await showError(error.message);
    return;
  }

  registerMenu();
  await openApp();
}

/**
 * Muestra la app en la ventana. Si el usuario navega mientras carga, Electron
 * cancela la carga anterior (ERR_ABORTED): eso no es un fallo del backend.
 */
async function openApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = `${backend.url}?token=${encodeURIComponent(backend.token)}`;
  try {
    await mainWindow.loadURL(url);
  } catch (error) {
    if (error.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(error.message)) {
      logger.info('La carga inicial se sustituyó por otra navegación.');
      return;
    }
    logger.error(`No se pudo mostrar la app: ${error.message}`);
    await showError(`No se pudo abrir ${backend.url} — ${error.message}`);
  }
}

/** Pantalla de error con el motivo y las últimas líneas del registro. */
async function showError(message) {
  startupError = { message, log: logger.tail(40), logPath: logger.path };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(path.join(UI_DIR, 'error.html'));
  mainWindow.show();
}

/** El backend se cayó estando la app abierta: ofrecer reintentar. */
async function handleBackendCrash({ code, lastError }) {
  if (shuttingDown) return;
  backend = null;
  const message = `El backend dejó de responder (código ${code}). ${lastError || ''}`.trim();
  logger.error(message);
  registerMenu();
  await showError(message);
}

function registerMenu() {
  buildMenu(() => ({
    win: mainWindow,
    baseUrl: backend ? backend.url : null,
    backendInfo: backend ? { ...backend.info, url: backend.url } : null,
    logPath: logger ? logger.path : null,
  }));
}

/** Todo lo que no sea el backend local o las pantallas internas se abre fuera. */
function guardNavigation(win) {
  const isInternal = (target) => {
    if (target.startsWith('file://')) return true;
    if (!backend) return false;
    try {
      return new URL(target).origin === new URL(backend.url).origin;
    } catch {
      return false;
    }
  };

  win.webContents.on('will-navigate', (event, target) => {
    if (isInternal(target)) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) win.loadURL(url);
    else if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`La vista se cerró inesperadamente: ${details.reason}`);
  });
}

/**
 * Las descargas de Django (`Content-Disposition: attachment`) pasan a ser un
 * diálogo nativo de "Guardar como", que es lo que espera una app de escritorio.
 */
function setupDownloads(win) {
  // La sesión es compartida: si se recrea la ventana no hay que duplicar el
  // manejador (saldrían dos diálogos de guardado por descarga).
  if (downloadsReady) return;
  downloadsReady = true;

  win.webContents.session.on('will-download', (event, item) => {
    const suggested = item.getFilename() || 'script.sql';
    const savePath = dialog.showSaveDialogSync(win, {
      title: 'Guardar script SQL',
      defaultPath: path.join(lastSaveDir || app.getPath('downloads'), suggested),
      filters: [
        { name: 'Script SQL', extensions: ['sql'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });

    if (!savePath) {
      item.cancel();
      return;
    }

    lastSaveDir = path.dirname(savePath);
    item.setSavePath(savePath);

    item.once('done', async (_doneEvent, state) => {
      if (state !== 'completed') {
        if (state === 'cancelled') return;
        logger.error(`Falló la descarga del script (${state}).`);
        dialog.showErrorBox('No se pudo guardar', `El archivo no se guardó (${state}).`);
        return;
      }
      logger.info(`Script guardado en ${savePath}`);
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Script guardado',
        message: 'El script se guardó correctamente.',
        detail: savePath,
        buttons: ['Cerrar', 'Mostrar en carpeta'],
        defaultId: 0,
        cancelId: 0,
      });
      if (response === 1) shell.showItemInFolder(savePath);
    });
  });
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function shutdown() {
  try {
    if (backend) await backend.stop();
  } catch (error) {
    logger?.error(`Error al cerrar el backend: ${error.message}`);
  } finally {
    logger?.info('Aplicación cerrada.');
    logger?.close();
    app.exit(0);
  }
}

function fatal(error) {
  dialog.showErrorBox('Comparador de BD', `No se pudo iniciar la aplicación:\n\n${error.message}`);
  app.exit(1);
}

// --- IPC de las pantallas internas (solo desde archivos locales) ------------

const fromInternalPage = (event) => {
  const url = event.senderFrame ? event.senderFrame.url : '';
  return url.startsWith('file://');
};

ipcMain.handle('pgcompare:startup-error', (event) => (
  fromInternalPage(event) ? startupError : null
));

ipcMain.handle('pgcompare:retry', async (event) => {
  if (!fromInternalPage(event)) return false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadFile(path.join(UI_DIR, 'splash.html'));
  }
  await launchBackend();
  return !startupError;
});

ipcMain.handle('pgcompare:open-log', (event) => {
  if (!fromInternalPage(event) || !logger) return false;
  shell.openPath(logger.path);
  return true;
});

ipcMain.on('pgcompare:quit', (event) => {
  if (fromInternalPage(event)) app.quit();
});
