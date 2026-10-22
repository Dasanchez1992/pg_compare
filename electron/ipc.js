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
const { app, dialog, ipcMain, net, shell } = require('electron');
const Anthropic = require('@anthropic-ai/sdk');

const { analyze } = require('./core/analyzer');
const { compare, buildScript } = require('./core/diff');
const { parsePrRefs, fetchPullRequest, testGithub } = require('./core/github');
const { introspect, testConnection } = require('./core/introspect');
const { checkForUpdate, repoFromPackage } = require('./core/updates');
const installer = require('./installer');

const REPO = repoFromPackage(require('../package.json'));

// Cada cuánto se vuelve a mirar si hay versión nueva, con la app abierta.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8000;

// Última versión encontrada. La instalación usa esta, nunca una dirección que
// llegue desde la interfaz.
let latestUpdate = null;
let installing = null;

// Análisis con IA en curso, para poder cancelarlo.
let analysisController = null;

// Un análisis grande con esfuerzo alto puede tardar varios minutos.
const AI_TIMEOUT_MS = 15 * 60 * 1000;

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

/**
 * Descarga con la pila de red de Chromium, que respeta la configuración de
 * proxy y los certificados del sistema (lo normal en una red corporativa).
 * Si esa vía falla, se reintenta con el fetch de Node.
 */
async function appFetch(url, options) {
  try {
    return await net.fetch(url, options);
  } catch {
    return fetch(url, options);
  }
}

/** Cliente de la API de Claude, por la misma pila de red que el resto. */
function anthropicClient(apiKey) {
  return new Anthropic({ apiKey, fetch: appFetch, timeout: AI_TIMEOUT_MS });
}

/** Errores de la API de Claude en palabras del usuario. */
function claudeError(error, model) {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic rechazó la clave de Claude: revísala en Configuración.');
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error('La clave de Claude no tiene permiso para usar la API.');
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new Error(`El modelo ${model} no está disponible para esta clave.`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error('Se alcanzó el límite de uso de la API de Claude. Prueba en unos minutos.');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error('No se pudo conectar con la API de Claude. Revisa la conexión o el proxy.');
  }
  if (error instanceof Anthropic.APIError && error.status >= 500) {
    return new Error(`La API de Claude respondió ${error.status}. Prueba de nuevo en un rato.`);
  }
  return error;
}

/**
 * Descarga la versión encontrada y la instala, avisando del progreso a la
 * ventana. Si ya hay una instalación en curso, se reutiliza.
 */
function installUpdate({ logger, getWindow }) {
  if (installing) return installing;
  const update = latestUpdate;
  if (!update || !update.asset) {
    return Promise.reject(new Error('No hay ninguna versión nueva para instalar.'));
  }
  const send = (channel, data) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  installing = (async () => {
    logger.info(`Descargando ${update.asset.name}.`);
    const file = await installer.download(update.asset, {
      fetchImpl: appFetch,
      onProgress: (received, total) => send('update:progress', { received, total }),
    });
    return installer.install(file, installer.installKind(), logger);
  })().finally(() => { installing = null; });
  return installing;
}

/**
 * Busca una versión nueva y avisa a la ventana.
 *
 * @param {boolean} manual  true si lo pidió el usuario desde el menú: entonces
 *   se ignora la versión descartada y se responde también cuando está al día.
 */
async function runUpdateCheck({ store, logger, getWindow, manual = false }) {
  const settings = store.settings().updates;
  if (!manual && !settings.enabled) return null;

  try {
    const update = await checkForUpdate({
      repo: REPO,
      currentVersion: app.getVersion(),
      install: installer.installKind(),
      fetchImpl: appFetch,
    });
    store.updateSettings('updates', { lastCheck: new Date().toISOString() });

    if (!update) {
      logger.info('No hay versiones nuevas.');
      return { upToDate: true, version: app.getVersion() };
    }
    if (!manual && update.version === settings.skippedVersion) {
      logger.info(`Versión ${update.version} disponible, pero el usuario la descartó.`);
      return null;
    }

    update.canInstall = Boolean(update.asset) && installer.canInstall();
    latestUpdate = update;
    logger.info(`Versión ${update.version} disponible.`);
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:available', update);
    return update;
  } catch (error) {
    // Sin internet o GitHub caído: se registra y no se molesta al usuario,
    // salvo que la comprobación la haya pedido él.
    logger.error(`No se pudo comprobar si hay versiones nuevas: ${error.message}`);
    if (manual) throw error;
    return null;
  }
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
    updates: store.settings().updates,
    repo: REPO,
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
      // Si hubo análisis con IA, lo que eligió conserva su porqué.
      commentsById: run.analysis ? Object.fromEntries(run.analysis.included
        .map((item) => [item.id, `${item.pr}: ${item.reason}`])) : {},
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

  // --- Configuración de IA y GitHub ----------------------------------

  on('settings:get', () => store.integrations());
  on('settings:save', (payload) => store.saveIntegrations(payload));

  /**
   * Prueba la clave de Claude pidiendo los datos del modelo, que no gasta
   * tokens. Si el campo se dejó vacío, usa la clave guardada.
   */
  on('settings:test-ai', async ({ apiKey, model } = {}) => {
    const stored = store.aiConfig();
    const key = String(apiKey || '').trim() || stored.apiKey;
    const modelId = String(model || '').trim() || stored.model;
    if (!key) return { ok: false, message: 'Escribe la clave de la API de Claude.' };
    try {
      const info = await anthropicClient(key).models.retrieve(modelId);
      return { ok: true, message: `Clave válida · ${info.display_name || modelId} disponible.` };
    } catch (error) {
      return { ok: false, message: claudeError(error, modelId).message };
    }
  });

  on('settings:test-github', ({ user, token } = {}) => {
    const stored = store.githubConfig();
    return testGithub({
      user: String(user ?? stored.user).trim(),
      token: String(token || '').trim() || stored.token,
      fetchImpl: appFetch,
    });
  });

  // --- Análisis con IA ------------------------------------------------

  /**
   * Lee los PRs, le pide a Claude que filtre las diferencias y deja el script
   * armado con lo que eligió. Devuelve la comparación actualizada.
   */
  on('ai:analyze', async ({ id, prsText }, event) => {
    if (analysisController) throw new Error('Ya hay un análisis en curso.');
    const run = store.getRun(id);
    if (!run) throw new Error('Esa comparación ya no existe.');
    const ai = store.aiConfig();
    if (!ai.apiKey) {
      throw new Error('Falta la clave de Claude: configúrala en Configuración.');
    }
    const github = store.githubConfig();
    const refs = parsePrRefs(prsText, github.defaultRepo);
    if (!refs.length) throw new Error('Indica al menos un PR.');

    const say = (message) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:progress', message);
    };

    analysisController = new AbortController();
    try {
      const prs = [];
      for (const ref of refs) {
        say(`Leyendo ${ref.ref} en GitHub…`);
        prs.push(await fetchPullRequest(ref, { token: github.token, fetchImpl: appFetch }));
      }

      logger.info(`Análisis con IA de la comparación ${run.id} contra ${refs.map((r) => r.ref).join(', ')}.`);
      const analysis = await analyze({
        client: anthropicClient(ai.apiKey),
        model: ai.model,
        run,
        prs,
        signal: analysisController.signal,
        onProgress: say,
      });
      analysis.prsText = prsText;
      const { usage } = analysis;
      logger.info(`Análisis listo: ${analysis.included.length} a aplicar, `
        + `${analysis.review.length} a revisar · tokens: ${usage.input} entrada, `
        + `${usage.cacheRead} de caché, ${usage.output} salida.`);

      store.saveAnalysis(run.id, analysis);
      const selectedIds = analysis.included.map((item) => item.id);
      const script = buildScript({
        db1Name: run.db1Name,
        db2Name: run.db2Name,
        sqlById: run.sqlById,
        selectedIds,
        schema: run.db1Schema,
        notes: [
          `Selección hecha con IA (${ai.model}) a partir de: ${refs.map((r) => r.ref).join(', ')}.`,
          `Incluye ${selectedIds.length} de ${run.totalChanges} diferencias. `
            + 'Revisa el análisis en la aplicación antes de aplicarlo.',
          ...analysis.warnings.map((warning) => `AVISO: ${warning}`),
        ],
        // Cada sentencia lleva delante el PR y el motivo por el que entró.
        commentsById: Object.fromEntries(analysis.included
          .map((item) => [item.id, `${item.pr}: ${item.reason}`])),
      });
      return store.saveScript(run.id, script, selectedIds);
    } catch (error) {
      if (analysisController.signal.aborted) throw new Error('Análisis cancelado.');
      throw claudeError(error, ai.model);
    } finally {
      analysisController = null;
    }
  });

  on('ai:cancel', () => {
    if (analysisController) analysisController.abort();
  });

  /** Abre la carpeta del archivo recién guardado. */
  on('shell:show-file', (filePath) => shell.showItemInFolder(filePath));

  // --- Versiones nuevas -----------------------------------------------

  on('updates:check', () => runUpdateCheck({ store, logger, getWindow, manual: true }));

  /** "Ahora no": no volver a avisar de esta versión concreta. */
  on('updates:skip', (version) => store.updateSettings('updates', { skippedVersion: version }));

  /** Descarga e instala la versión que se encontró en la última comprobación. */
  on('updates:install', () => installUpdate({ logger, getWindow }));

  /** Abre la página de la release o el archivo que toca en el navegador. */
  on('updates:download', (url) => shell.openExternal(url));

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

module.exports = {
  registerIpc, runUpdateCheck, REPO, CHECK_EVERY_MS, FIRST_CHECK_DELAY_MS,
};
