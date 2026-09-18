'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Desempaqueta la respuesta del proceso principal y propaga los errores. */
async function call(channel, payload) {
  const reply = await ipcRenderer.invoke(channel, payload);
  if (!reply || reply.ok) return reply ? reply.data : undefined;
  throw new Error(reply.error);
}

// Superficie mínima y explícita: la interfaz no ve Node ni el sistema de
// archivos, solo estas operaciones.
contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),

  connections: {
    list: () => call('connections:list'),
    get: (id) => call('connections:get', id),
    save: (payload) => call('connections:save', payload),
    remove: (id) => call('connections:delete', id),
    test: (payload) => call('connections:test', payload),
  },

  projects: {
    list: () => call('projects:list'),
    get: (id) => call('projects:get', id),
    save: (payload) => call('projects:save', payload),
    remove: (id) => call('projects:delete', id),
  },

  runs: {
    list: (filter) => call('runs:list', filter),
    get: (id) => call('runs:get', id),
    remove: (id) => call('runs:delete', id),
    compare: (payload) => call('runs:compare', payload),
    rerun: (id) => call('runs:rerun', id),
    script: (payload) => call('runs:script', payload),
    saveSql: (id) => call('runs:save-sql', id),
  },

  shell: {
    openDataDir: () => call('shell:open-data-dir'),
    openLog: () => call('shell:open-log'),
    showFile: (filePath) => call('shell:show-file', filePath),
  },

  confirm: (payload) => call('dialog:confirm', payload),

  /** Avisos de progreso mientras se lee el catálogo de las bases. */
  onProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('compare:progress', listener);
    return () => ipcRenderer.removeListener('compare:progress', listener);
  },

  /** Navegación pedida desde el menú nativo. */
  onNavigate: (callback) => {
    ipcRenderer.on('navigate', (_event, route) => callback(route));
  },

  /** El menú "Archivo → Guardar script" actúa sobre la vista abierta. */
  onSaveScript: (callback) => {
    ipcRenderer.on('save-script', () => callback());
  },
});
