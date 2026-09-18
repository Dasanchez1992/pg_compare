'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const READY_PREFIX = 'PGCOMPARE_READY';
const ERROR_PREFIX = 'PGCOMPARE_ERROR';
const START_TIMEOUT_MS = 120000; // el primer arranque migra la BD y copia estáticos
const STOP_TIMEOUT_MS = 6000;

const isWindows = process.platform === 'win32';

/** Raíz del repositorio cuando se ejecuta sin empaquetar (desktop/electron -> ..). */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Decide qué se ejecuta para levantar el backend.
 *
 * - Empaquetado: el binario que produce PyInstaller, en
 *   `<resources>/backend/pgcompare-backend`.
 * - Desarrollo: un intérprete Python con `-m dbcompare.desktop_server`,
 *   preferentemente el del entorno virtual del repositorio.
 */
function resolveCommand(isPackaged) {
  if (isPackaged) {
    const exe = path.join(
      process.resourcesPath,
      'backend',
      isWindows ? 'pgcompare-backend.exe' : 'pgcompare-backend',
    );
    if (!fs.existsSync(exe)) {
      throw new Error(
        `No se encontró el backend empaquetado en ${exe}. ` +
        'Reconstruye la app con "npm run dist" (genera el backend con PyInstaller).',
      );
    }
    return { command: exe, args: [], cwd: path.dirname(exe) };
  }

  // Si el usuario fija PGCOMPARE_PYTHON mandamos eso tal cual: puede ser una
  // ruta o un comando del PATH ("python3.12"), y si falla el error lo dirá.
  const candidates = [
    path.join(REPO_ROOT, '.venv', isWindows ? 'Scripts/python.exe' : 'bin/python'),
    path.join(REPO_ROOT, 'venv', isWindows ? 'Scripts/python.exe' : 'bin/python'),
  ];

  const python = process.env.PGCOMPARE_PYTHON
    || candidates.find((candidate) => fs.existsSync(candidate))
    || (isWindows ? 'python' : 'python3');

  return {
    command: python,
    args: ['-m', 'dbcompare.desktop_server'],
    cwd: REPO_ROOT,
  };
}

/**
 * Lanza el backend y resuelve cuando anuncia que está escuchando.
 *
 * @returns {Promise<{url:string, token:string, port:number, info:object, stop:function}>}
 */
function startBackend({ dataDir, isPackaged, appVersion, logger, onUnexpectedExit }) {
  const { command, args, cwd } = resolveCommand(isPackaged);
  const token = crypto.randomBytes(32).toString('hex');

  const fullArgs = [...args, '--data-dir', dataDir, '--watch-stdin'];
  if (!isPackaged) {
    // En desarrollo los estáticos cambian a menudo: recolectarlos siempre.
    fullArgs.push('--force-collectstatic');
  }

  logger.info(`Iniciando backend: ${command} ${fullArgs.join(' ')}`);

  const child = spawn(command, fullArgs, {
    cwd,
    env: {
      ...process.env,
      PGCOMPARE_TOKEN: token,
      PGCOMPARE_APP_VERSION: appVersion,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  /** En desarrollo casi siempre falta instalar las dependencias de Python. */
  const withHint = (message) => (isPackaged ? message : `${message}

Comprueba las dependencias del backend:
  ${command} -m pip install -r requirements-desktop.txt`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    let lastError = '';

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      logger.error('El backend no respondió a tiempo; se cancela el arranque.');
      killNow(child);
      finish(reject, new Error(
        'El backend tardó demasiado en arrancar. Revisa el registro para ver el detalle.',
      ));
    }, START_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf('\n');
      while (index !== -1) {
        handleLine(stdoutBuffer.slice(0, index).trim());
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        index = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      lastError = String(chunk).trim().split('\n').pop() || lastError;
      logger.raw(chunk);
    });

    child.on('error', (err) => {
      logger.error(`No se pudo ejecutar el backend: ${err.message}`);
      finish(reject, new Error(
        `No se pudo ejecutar "${command}". ` +
        (isPackaged
          ? 'El backend empaquetado parece dañado; reinstala la aplicación.'
          : 'Instala Python 3.10+ y las dependencias (pip install -r requirements-desktop.txt), ' +
            'o indica el intérprete con la variable PGCOMPARE_PYTHON.'),
      ));
    });

    child.on('exit', (code, signal) => {
      logger.info(`El backend terminó (código ${code}, señal ${signal || 'ninguna'}).`);
      if (settled) {
        // Ya estaba sirviendo: si no lo paramos nosotros, se ha caído.
        if (!child.pgcompareStopping && onUnexpectedExit) {
          onUnexpectedExit({ code, signal, lastError });
        }
        return;
      }
      finish(reject, new Error(withHint(
        `El backend se cerró inesperadamente (código ${code}). ${lastError}`.trim(),
      )));
    });

    function handleLine(line) {
      if (!line) return;
      if (line.startsWith(READY_PREFIX)) {
        const info = safeParse(line.slice(READY_PREFIX.length));
        logger.info(`Backend escuchando en ${info.url} (Django ${info.django}, Python ${info.python}).`);
        finish(resolve, {
          url: info.url,
          port: info.port,
          token,
          info,
          stop: () => stopBackend(child, logger),
        });
        return;
      }
      if (line.startsWith(ERROR_PREFIX)) {
        const info = safeParse(line.slice(ERROR_PREFIX.length));
        finish(reject, new Error(withHint(
          info.message || 'Error desconocido al arrancar el backend.',
        )));
        return;
      }
      logger.raw(line);
    }
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function killNow(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

/** Cierre ordenado: cerrar stdin (el backend lo vigila), SIGTERM y, si no, a la fuerza. */
function stopBackend(child, logger) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  child.pgcompareStopping = true;

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);

    try {
      child.stdin.end();
    } catch {
      // stdin ya cerrado.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // El proceso ya no existe.
    }

    const timer = setTimeout(() => {
      logger.error('El backend no se cerró a tiempo; se termina a la fuerza.');
      killNow(child);
      setTimeout(done, 500);
    }, STOP_TIMEOUT_MS);
  });
}

module.exports = { startBackend, resolveCommand, REPO_ROOT };
