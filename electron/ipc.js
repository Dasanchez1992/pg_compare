'use strict';

/**
 * Puente entre la interfaz y el núcleo de la aplicación.
 *
 * La interfaz corre aislada (sin Node) y solo puede pedir estas operaciones;
 * todo el acceso a PostgreSQL y al disco ocurre aquí, en el proceso
 * principal. Cada handler responde `{ok:true, data}` o `{ok:false, error}`
 * para que el error llegue al usuario como un mensaje y no como un fallo
 * interno de Electron.
 */

const fs = require('fs/promises');
const path = require('path');
const { app, dialog, ipcMain, shell } = require('electron');

const { compare, buildScript } = require('./core/diff');
const { introspect, testConnection } = require('./core/introspect');

/** Envuelve un handler para que nunca reviente el canal IPC. */
function handler(fn, logger) {
  return async (event, payload) => {
    try {
      return { ok: true, data: await fn(payload, event) };
    } catch (error) {
      logger.error(`${error.message}\n${error.stack || ''}`);
      return { ok: false, error: error.message };
    }
  };
}

function registerIpc({ store, cipher, logger, getWindow }) {
  const on = (channel, fn) => ipcMain.handle(channel, handler(fn, logger));

  /** Progreso de la comparación, para que la interfaz no parezca colgada. */
  const progress = (event, message) => {
    if (!event.sender.isDestroyed()) event.sender.send('compare:progress', message);
  };

  // --- Información general -------------------------------------------

  on('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir: app.getPath('userData'),
    logPath: logger.path,
    encryption: cipher.available,
    loadError: store.loadError,
    stats: store.stats(),
  }));

  on('shell:open-data-dir', () => shell.openPath(app.getPath('userData')));
  on('shell:open-log', () => shell.openPath(logger.path));

  // --- Conexiones -----------------------------------------------------

  on('connections:list', () => store.listConnections());
  on('connections:get', (id) => store.getConnection(id));
  on('connections:save', (payload) => store.saveConnection(payload));
  on('connections:delete', (id) => store.deleteConnection(id));

  /**
   * Prueba los datos del formulario sin guardarlos. Si se está editando y el
   * campo de contraseña se dejó vacío, usa la que ya estaba guardada.
   */
  on('connections:test', (payload) => {
    const conn = { ...payload };
    if (!conn.password && conn.id) {
      conn.password = store.credentials(conn.id).password;
    }
    return testConnection(conn);
  });

  // --- Proyectos ------------------------------------------------------

  on('projects:list', () => store.listProjects());
  on('projects:get', (id) => store.getProject(id));
  on('projects:save', (payload) => store.saveProject(payload));
  on('projects:delete', (id) => store.deleteProject(id));

  // --- Comparaciones --------------------------------------------------

  /** Lee las dos bases, calcula el diff y lo guarda en el historial. */
  const runComparison = async ({ db1Id, db2Id, projectId = null }, event) => {
    const db1 = store.credentials(db1Id);   // destino
    const db2 = store.credentials(db2Id);   // referencia
    if (db1.id === db2.id) throw new Error('Selecciona dos bases de datos distintas.');

    logger.info(`Comparando ${db1.name} (destino) con ${db2.name} (referencia).`);

    progress(event, `Leyendo la estructura de ${db1.name}…`);
    const target = await read(db1, 'BD1');
    progress(event, `Leyendo la estructura de ${db2.name}…`);
    const source = await read(db2, 'BD2');

    progress(event, 'Comparando…');
    const result = compare({ source, target, db1Name: db1.name, db2Name: db2.name });
    logger.info(`Diferencias encontradas: ${result.totalChanges}.`);

    return store.createRun({ projectId, db1, db2, result });
  };

  /** Introspección con un mensaje de error que dice qué base falló. */
  const read = async (conn, label) => {
    try {
      return await introspect(conn);
    } catch (error) {
      throw new Error(`${label} (${conn.name}): ${error.message}`);
    }
  };

  on('runs:list', (filter) => store.listRuns(filter || {}));
  on('runs:get', (id) => store.getRun(id));
  on('runs:delete', (id) => store.deleteRun(id));
  on('runs:compare', runComparison);

  on('runs:rerun', async (id, event) => {
    const run = store.getRun(id);
    if (!run) throw new Error('Esa comparación ya no existe.');
    const { db1Id, db2Id, projectId } = store.rerunPair(run);
    if (!db1Id || !db2Id) {
      throw new Error('No se puede repetir: las conexiones originales ya no existen.');
    }
    return runComparison({ db1Id, db2Id, projectId }, event);
  });

  /** Arma el script con los cambios marcados y lo guarda en el historial. */
  on('runs:script', ({ id, selectedIds }) => {
    const run = store.getRun(id);
    if (!run) throw new Error('Esa comparación ya no existe.');
    const script = buildScript({
      db1Name: run.db1Name,
      db2Name: run.db2Name,
      sqlById: run.sqlById,
      selectedIds,
      schema: run.db1Schema,
    });
    return store.saveScript(id, script, selectedIds);
  });

  /** Guarda el script en disco con el diálogo del sistema. */
  on('runs:save-sql', async (id) => {
    const run = store.getRun(id);
    if (!run || !run.script) {
      throw new Error('Esta comparación aún no tiene un script generado.');
    }

    const suggested = `alter_${run.db1Name}_${run.createdAt.slice(0, 10)}.sql`
      .replace(/[\\/:*?"<>|]/g, '_');

    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'Guardar script SQL',
      defaultPath: path.join(app.getPath('downloads'), suggested),
      filters: [
        { name: 'Script SQL', extensions: ['sql'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { saved: false };

    await fs.writeFile(filePath, run.script, 'utf8');
    logger.info(`Script guardado en ${filePath}`);
    return { saved: true, path: filePath };
  });

  /** Abre la carpeta del archivo recién guardado. */
  on('shell:show-file', (filePath) => shell.showItemInFolder(filePath));

  /** Confirmación nativa para las acciones destructivas. */
  on('dialog:confirm', async ({ title, message, detail, confirmLabel = 'Eliminar' }) => {
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'warning',
      title,
      message,
      detail,
      buttons: ['Cancelar', confirmLabel],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  });
}

module.exports = { registerIpc };
