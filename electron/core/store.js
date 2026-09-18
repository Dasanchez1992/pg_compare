'use strict';

/**
 * Almacén local de la aplicación: conexiones, proyectos e historial.
 *
 * Todo vive en archivos JSON dentro de la carpeta de datos del usuario; no
 * hay servidor ni base de datos intermedia. El índice ligero está en
 * `data.json` y el resultado de cada comparación (que puede ser grande) en
 * `runs/<id>.json`, para no releer megabytes al abrir el historial.
 *
 * Las contraseñas se guardan con el `cipher` que se le inyecta (en la app,
 * el llavero del sistema vía safeStorage).
 */

const fs = require('fs');
const path = require('path');

const VERSION = 1;

/** Cifrador de paso: guarda el texto tal cual. Útil en pruebas. */
const plainCipher = {
  encrypt: (text) => ({ enc: 'plain', value: text }),
  decrypt: (blob) => (blob && blob.enc === 'plain' ? blob.value : ''),
};

function defaultSettings() {
  return {
    // Aviso de versiones nuevas: la única conexión que hace la app fuera de
    // las bases de datos registradas.
    updates: { enabled: true, skippedVersion: null, lastCheck: null },
  };
}

function emptyData() {
  return {
    version: VERSION,
    nextId: { connection: 1, project: 1, run: 1 },
    settings: defaultSettings(),
    connections: [],
    projects: [],
    runs: [],
  };
}

/** Escritura atómica: primero a un temporal, luego rename. */
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class Store {
  constructor(dataDir, { cipher = plainCipher, now = () => new Date().toISOString() } = {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'data.json');
    this.runsDir = path.join(dataDir, 'runs');
    this.cipher = cipher;
    this.now = now;

    fs.mkdirSync(this.runsDir, { recursive: true });
    this.data = this.#load();
  }

  #load() {
    try {
      const data = readJson(this.file);
      return { ...emptyData(), ...data };
    } catch (error) {
      if (error.code === 'ENOENT') return emptyData();
      // Un archivo corrupto no debe dejar la app inservible: se aparta y
      // se empieza de cero, avisando en el registro.
      const backup = `${this.file}.corrupto-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
      } catch { /* si tampoco se puede mover, seguimos igualmente */ }
      const fresh = emptyData();
      fresh.loadError = `No se pudo leer ${this.file} (${error.message}). Copia en ${backup}.`;
      return fresh;
    }
  }

  #save() {
    writeJson(this.file, this.data);
  }

  #nextId(kind) {
    const id = this.data.nextId[kind] || 1;
    this.data.nextId[kind] = id + 1;
    return id;
  }

  /** Aviso si el archivo de datos estaba corrupto al arrancar. */
  get loadError() {
    return this.data.loadError || null;
  }

  // --- Ajustes --------------------------------------------------------

  /** Ajustes guardados, completados con los valores por defecto. */
  settings() {
    const stored = this.data.settings || {};
    const defaults = defaultSettings();
    return { updates: { ...defaults.updates, ...(stored.updates || {}) } };
  }

  /** Cambia parte de los ajustes de una sección y devuelve el resultado. */
  updateSettings(section, patch) {
    const current = this.settings();
    if (!current[section]) throw new Error(`Ajuste desconocido: ${section}`);
    this.data.settings = { ...current, [section]: { ...current[section], ...patch } };
    this.#save();
    return this.settings();
  }

  // --- Conexiones ----------------------------------------------------

  /** Conexiones sin la contraseña (lo que se manda a la interfaz). */
  listConnections() {
    return this.data.connections.map((conn) => this.#publicConnection(conn));
  }

  getConnection(id) {
    const conn = this.data.connections.find((c) => c.id === Number(id));
    return conn ? this.#publicConnection(conn) : null;
  }

  /** Conexión con la contraseña descifrada, para hablar con PostgreSQL. */
  credentials(id) {
    const conn = this.data.connections.find((c) => c.id === Number(id));
    if (!conn) throw new Error(`La conexión ${id} ya no existe.`);
    return { ...this.#publicConnection(conn), password: this.#password(conn) };
  }

  /**
   * Crea o actualiza una conexión.
   * Si `password` viene vacío al editar, se conserva la que ya estaba.
   */
  saveConnection(payload) {
    const clean = normalizeConnection(payload);
    const existing = payload.id
      ? this.data.connections.find((c) => c.id === Number(payload.id))
      : null;

    if (this.data.connections.some((c) => c.name === clean.name && c !== existing)) {
      throw new Error(`Ya existe una conexión llamada "${clean.name}".`);
    }

    const password = payload.password
      ? this.cipher.encrypt(payload.password)
      : (existing ? existing.password : this.cipher.encrypt(''));

    if (existing) {
      Object.assign(existing, clean, { password });
      this.#sortConnections();
      this.#refreshRunNames();
      this.#save();
      return this.#publicConnection(existing);
    }

    const conn = {
      id: this.#nextId('connection'),
      ...clean,
      password,
      createdAt: this.now(),
    };
    this.data.connections.push(conn);
    this.#sortConnections();
    this.#save();
    return this.#publicConnection(conn);
  }

  /** Borra la conexión, los proyectos que la usan y desliga el historial. */
  deleteConnection(id) {
    const numericId = Number(id);
    this.data.connections = this.data.connections.filter((c) => c.id !== numericId);

    const orphanProjects = this.data.projects
      .filter((p) => p.db1Id === numericId || p.db2Id === numericId)
      .map((p) => p.id);
    this.data.projects = this.data.projects.filter((p) => !orphanProjects.includes(p.id));

    for (const run of this.data.runs) {
      if (run.db1Id === numericId) run.db1Id = null;
      if (run.db2Id === numericId) run.db2Id = null;
      if (orphanProjects.includes(run.projectId)) run.projectId = null;
    }
    this.#save();
    return { deletedProjects: orphanProjects.length };
  }

  #publicConnection(conn) {
    const { password, ...rest } = conn;
    return { ...rest, hasPassword: Boolean(this.#password(conn)) };
  }

  #password(conn) {
    try {
      return this.cipher.decrypt(conn.password) || '';
    } catch {
      return '';
    }
  }

  #sortConnections() {
    this.data.connections.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // --- Proyectos -----------------------------------------------------

  listProjects() {
    return this.data.projects
      .map((project) => {
        const runs = this.data.runs.filter((r) => r.projectId === project.id);
        return {
          ...project,
          db1Name: this.#connectionName(project.db1Id),
          db2Name: this.#connectionName(project.db2Id),
          runCount: runs.length,
          lastRun: runs[0] ? runs[0].createdAt : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  getProject(id) {
    return this.data.projects.find((p) => p.id === Number(id)) || null;
  }

  saveProject(payload) {
    const name = String(payload.name || '').trim();
    const db1Id = Number(payload.db1Id);
    const db2Id = Number(payload.db2Id);

    if (!name) throw new Error('El proyecto necesita un nombre.');
    if (!db1Id || !db2Id) throw new Error('Selecciona las dos bases de datos.');
    if (db1Id === db2Id) throw new Error('Selecciona dos bases de datos distintas.');

    const existing = payload.id ? this.getProject(payload.id) : null;
    if (this.data.projects.some((p) => p.name === name && p !== existing)) {
      throw new Error(`Ya existe un proyecto llamado "${name}".`);
    }

    if (existing) {
      Object.assign(existing, { name, db1Id, db2Id });
      this.#save();
      return existing;
    }

    const project = { id: this.#nextId('project'), name, db1Id, db2Id, createdAt: this.now() };
    this.data.projects.push(project);
    this.#save();
    return project;
  }

  /** Borra el proyecto; sus comparaciones quedan en el historial como ad hoc. */
  deleteProject(id) {
    const numericId = Number(id);
    this.data.projects = this.data.projects.filter((p) => p.id !== numericId);
    for (const run of this.data.runs) {
      if (run.projectId === numericId) run.projectId = null;
    }
    this.#save();
  }

  #connectionName(id) {
    const conn = this.data.connections.find((c) => c.id === id);
    return conn ? conn.name : null;
  }

  // --- Historial de comparaciones ------------------------------------

  /** Índice del historial, más reciente primero. */
  listRuns({ projectId = null } = {}) {
    const runs = projectId
      ? this.data.runs.filter((r) => r.projectId === Number(projectId))
      : this.data.runs;
    return runs.map((run) => ({
      ...run,
      projectName: run.projectId ? (this.getProject(run.projectId) || {}).name || null : null,
      canRerun: this.#canRerun(run),
    }));
  }

  /** Índice + resultado completo de una comparación. */
  getRun(id) {
    const run = this.data.runs.find((r) => r.id === Number(id));
    if (!run) return null;
    let payload = { rows: [], sqlById: {}, script: '', selectedIds: [] };
    try {
      payload = { ...payload, ...readJson(this.#runFile(run.id)) };
    } catch { /* el archivo pesado se perdió: se muestra el índice igualmente */ }
    return {
      ...run,
      projectName: run.projectId ? (this.getProject(run.projectId) || {}).name || null : null,
      canRerun: this.#canRerun(run),
      ...payload,
    };
  }

  /** Guarda el resultado de una comparación recién ejecutada. */
  createRun({ projectId = null, db1, db2, result }) {
    const run = {
      id: this.#nextId('run'),
      projectId: projectId ? Number(projectId) : null,
      db1Id: db1.id ?? null,
      db2Id: db2.id ?? null,
      db1Name: db1.name,
      db2Name: db2.name,
      db1Schema: db1.schema || 'public',
      createdAt: this.now(),
      totalChanges: result.totalChanges,
      hasScript: false,
      selectedCount: 0,
    };
    writeJson(this.#runFile(run.id), {
      rows: result.rows,
      sqlById: result.sqlById,
      script: '',
      selectedIds: [],
    });
    this.data.runs.unshift(run);   // el historial va del más reciente al más viejo
    this.#save();
    return this.getRun(run.id);
  }

  /** Guarda el script generado y la selección que lo produjo. */
  saveScript(id, script, selectedIds) {
    const run = this.data.runs.find((r) => r.id === Number(id));
    if (!run) throw new Error('Esa comparación ya no existe.');

    const payload = readJson(this.#runFile(run.id));
    payload.script = script;
    payload.selectedIds = selectedIds;
    writeJson(this.#runFile(run.id), payload);

    run.hasScript = Boolean(script);
    run.selectedCount = selectedIds.length;
    this.#save();
    return this.getRun(run.id);
  }

  deleteRun(id) {
    const numericId = Number(id);
    this.data.runs = this.data.runs.filter((r) => r.id !== numericId);
    try {
      fs.unlinkSync(this.#runFile(numericId));
    } catch { /* ya no estaba */ }
    this.#save();
  }

  /** Cifras del panel de inicio. */
  stats() {
    return {
      connections: this.data.connections.length,
      projects: this.data.projects.length,
      runs: this.data.runs.length,
    };
  }

  #runFile(id) {
    return path.join(this.runsDir, `${id}.json`);
  }

  /** Solo se puede repetir si las dos conexiones originales siguen existiendo. */
  #canRerun(run) {
    const pair = this.rerunPair(run);
    return Boolean(pair.db1Id && pair.db2Id);
  }

  /** Conexiones con las que repetir una comparación (las suyas o las del proyecto). */
  rerunPair(run) {
    const exists = (id) => this.data.connections.some((c) => c.id === id);
    if (exists(run.db1Id) && exists(run.db2Id)) {
      return { db1Id: run.db1Id, db2Id: run.db2Id, projectId: run.projectId };
    }
    const project = run.projectId ? this.getProject(run.projectId) : null;
    if (project && exists(project.db1Id) && exists(project.db2Id)) {
      return { db1Id: project.db1Id, db2Id: project.db2Id, projectId: project.id };
    }
    return { db1Id: null, db2Id: null, projectId: run.projectId };
  }

  /** Mantiene al día el nombre de las bases en el índice del historial. */
  #refreshRunNames() {
    for (const run of this.data.runs) {
      const db1 = this.data.connections.find((c) => c.id === run.db1Id);
      const db2 = this.data.connections.find((c) => c.id === run.db2Id);
      if (db1) run.db1Name = db1.name;
      if (db2) run.db2Name = db2.name;
    }
  }
}

/** Valida y normaliza los datos del formulario de conexión. */
function normalizeConnection(payload) {
  const text = (value, field) => {
    const clean = String(value ?? '').trim();
    if (!clean) throw new Error(`El campo "${field}" es obligatorio.`);
    return clean;
  };

  const port = Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('El puerto debe ser un número entre 1 y 65535.');
  }

  return {
    name: text(payload.name, 'Nombre'),
    host: text(payload.host, 'Host'),
    port,
    dbname: text(payload.dbname, 'Base de datos'),
    user: text(payload.user, 'Usuario'),
    schema: String(payload.schema || '').trim() || 'public',
    ssl: Boolean(payload.ssl),
  };
}

module.exports = { Store, plainCipher, normalizeConnection };
