'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB antes de rotar

/**
 * Registro de la app: todo lo que escribe el backend Python (stdout/stderr)
 * más los eventos del proceso principal de Electron. Vive en
 * <userData>/logs/backend.log para poder abrirlo desde el menú Ayuda.
 */
function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'backend.log');

  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, path.join(logDir, 'backend.log.1'));
    }
  } catch {
    // No existe todavía: nada que rotar.
  }

  const stream = fs.createWriteStream(file, { flags: 'a' });
  const stamp = () => new Date().toISOString();

  const write = (text) => {
    if (!text) return;
    stream.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  return {
    path: file,
    dir: logDir,
    /** Línea con marca de tiempo. */
    info: (message) => write(`[${stamp()}] ${message}`),
    error: (message) => write(`[${stamp()}] ERROR ${message}`),
    /** Salida cruda del backend, ya viene con sus propios saltos de línea. */
    raw: (chunk) => write(String(chunk).replace(/\s+$/, '')),
    /** Últimas `lines` líneas, para mostrarlas en la pantalla de error. */
    tail(lines = 40) {
      try {
        const content = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        return content.filter(Boolean).slice(-lines).join('\n');
      } catch {
        return '';
      }
    },
    close() {
      try {
        stream.end();
      } catch {
        // Cerrando la app: da igual.
      }
    },
  };
}

module.exports = { createLogger };
