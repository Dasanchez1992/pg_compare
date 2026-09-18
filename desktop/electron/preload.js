'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Puente mínimo para las pantallas internas (carga y error). Las páginas de
// Django no lo necesitan: se sirven desde el backend local y navegan solas.
contextBridge.exposeInMainWorld('pgcompare', {
  startupError: () => ipcRenderer.invoke('pgcompare:startup-error'),
  retry: () => ipcRenderer.invoke('pgcompare:retry'),
  openLog: () => ipcRenderer.invoke('pgcompare:open-log'),
  quit: () => ipcRenderer.send('pgcompare:quit'),
});
