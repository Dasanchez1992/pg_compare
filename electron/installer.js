'use strict';

/**
 * Descarga e instala una versión nueva.
 *
 * Cada forma de instalación se actualiza a su manera:
 *  · nsis      instalador de Windows: se ejecuta en silencio y vuelve a abrir
 *              la app al terminar.
 *  · portable  .exe suelto de Windows: el nuevo se guarda junto al actual y se
 *              abre ese.
 *  · appimage  se reemplaza el archivo .AppImage y se reabre.
 *  · deb       hace falta ser administrador: se abre el paquete con el
 *              instalador del sistema.
 *  · dev       ejecutándose con `npm start`: no hay nada que instalar.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { app, shell } = require('electron');

/** Cómo está instalada la aplicación que se está ejecutando. */
function installKind() {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32') {
    return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
  }
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : 'deb';
  return 'other';
}

/** ¿Se puede instalar sola, sin que el usuario haga nada más? */
function canInstall(kind = installKind()) {
  return ['nsis', 'portable', 'appimage', 'deb'].includes(kind);
}

/**
 * Descarga `asset` a la carpeta temporal avisando del progreso.
 * @param {(received:number, total:number) => void} onProgress
 */
async function download(asset, { fetchImpl, onProgress }) {
  const dir = path.join(app.getPath('temp'), 'pg-compare-update');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  const partial = `${file}.part`;

  const response = await fetchImpl(asset.url, { headers: { 'User-Agent': 'pg-compare-desktop' } });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub respondió ${response.status} al descargar ${asset.name}.`);
  }

  const total = Number(response.headers.get('content-length')) || asset.size || 0;
  let received = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        onProgress(received, total);
      }
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(partial));
  if (asset.size && received !== asset.size) {
    await fsp.rm(partial, { force: true });
    throw new Error(`La descarga quedó incompleta (${received} de ${asset.size} bytes).`);
  }
  onProgress(received, total || received);
  await fsp.rename(partial, file);
  return file;
}

/**
 * Instala el archivo descargado. Devuelve `{ restarting: true }` si la app se
 * va a cerrar para terminar la instalación.
 */
async function install(file, kind, logger) {
  switch (kind) {
    case 'nsis': {
      // /S: sin preguntas, en la misma carpeta de antes. --force-run: abre la
      // app al terminar. Se lanza suelto para que sobreviva a este cierre.
      logger.info(`Instalando ${file} en silencio.`);
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 500);
      return { restarting: true };
    }

    case 'portable': {
      const destino = path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE),
        path.basename(file));
      await fsp.copyFile(file, destino);
      logger.info(`Portable nuevo guardado en ${destino}.`);
      app.relaunch({ execPath: destino, args: [] });
      app.quit();
      return { restarting: true, path: destino };
    }

    case 'appimage': {
      // En Linux se puede reemplazar un archivo en uso: el proceso actual
      // sigue con el viejo hasta que se cierra.
      const actual = process.env.APPIMAGE;
      const nuevo = `${actual}.new`;
      await fsp.copyFile(file, nuevo);
      await fsp.chmod(nuevo, 0o755);
      await fsp.rename(nuevo, actual);
      logger.info(`AppImage reemplazada en ${actual}.`);
      app.relaunch({ execPath: actual, args: [] });
      app.quit();
      return { restarting: true, path: actual };
    }

    case 'deb': {
      const error = await shell.openPath(file);
      if (error) throw new Error(`No se pudo abrir el instalador del sistema: ${error}`);
      logger.info(`Paquete ${file} abierto con el instalador del sistema.`);
      return { restarting: false, path: file };
    }

    default:
      throw new Error('Esta copia de la aplicación no se puede actualizar sola.');
  }
}

module.exports = { installKind, canInstall, download, install };
