'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB antes de rotar

/**
 * Registro de la aplicación: errores de conexión a PostgreSQL y eventos del
 * proceso principal. Vive en <userData>/logs/app.log, que se puede abrir
 * desde la carpeta de datos (menú Archivo).
 */
function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'app.log');

  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, path.join(logDir, 'app.log.1'));
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
    /** Línea con marca de tiempo. */
    info: (message) => write(`[${stamp()}] ${message}`),
    error: (message) => write(`[${stamp()}] ERROR ${message}`),
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
