'use strict';

/**
 * Aviso de versiones nuevas.
 *
 * Consulta la última release publicada en GitHub y, si es más nueva que la
 * instalada, devuelve con qué archivo actualizarse. No descarga ni instala
 * nada por su cuenta: la app enseña un aviso y quien decide es el usuario.
 *
 * Es la única conexión que hace la aplicación fuera de las bases de datos
 * registradas, y se puede desactivar desde el menú Ayuda.
 */

const TIMEOUT_MS = 8000;

/** Extrae "owner/repo" del campo `repository` del package.json. */
function repoFromPackage(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository || {}).url;
  if (!url) return null;
  const match = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Convierte "v2.1.0-beta.2" en algo comparable.
 * Devuelve null si el texto no parece una versión.
 */
function parseVersion(text) {
  const match = String(text || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null,
  };
}

/**
 * Compara dos versiones: -1 si a < b, 0 si son iguales, 1 si a > b.
 * Una versión con sufijo (2.1.0-beta) va antes que la definitiva (2.1.0).
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;

  for (let i = 0; i < 3; i += 1) {
    if (va.numbers[i] !== vb.numbers[i]) return va.numbers[i] < vb.numbers[i] ? -1 : 1;
  }
  if (va.prerelease === vb.prerelease) return 0;
  if (!va.prerelease) return 1;      // 2.1.0 > 2.1.0-beta
  if (!vb.prerelease) return -1;
  return va.prerelease < vb.prerelease ? -1 : 1;
}

// Qué archivo de la release le sirve a cada sistema, por orden de preferencia.
const ASSET_PREFERENCE = {
  win32: [/setup.*\.exe$/i, /\.exe$/i],
  darwin: [/\.dmg$/i, /mac.*\.zip$/i],
  linux: [/\.appimage$/i, /\.deb$/i],
};

/** Elige el archivo descargable que corresponde al sistema. */
function pickAsset(assets, platform) {
  const candidates = (assets || []).filter((a) => a && a.name && a.browser_download_url
    && !/\.(blockmap|yml|yaml|sha512)$/i.test(a.name));

  for (const pattern of ASSET_PREFERENCE[platform] || []) {
    const found = candidates.find((a) => pattern.test(a.name));
    if (found) {
      return { name: found.name, url: found.browser_download_url, size: found.size || 0 };
    }
  }
  return null;
}

/** Pide a GitHub la última release publicada (ignora borradores y prereleases). */
async function fetchLatestRelease(repo, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pg-compare-desktop',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 404) return null;   // todavía no hay ninguna release
  if (!response.ok) {
    throw new Error(`GitHub respondió ${response.status} al consultar las versiones.`);
  }
  return response.json();
}

/**
 * Comprueba si hay una versión más nueva que la instalada.
 *
 * @returns {Promise<null|{version, name, url, notes, publishedAt, asset}>}
 *          null si ya está al día (o si no hay releases).
 */
async function checkForUpdate({
  repo,
  currentVersion,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
}) {
  if (!repo) throw new Error('No se sabe en qué repositorio buscar las versiones.');

  const release = await fetchLatestRelease(repo, fetchImpl);
  if (!release || release.draft || release.prerelease) return null;

  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) return null;
  if (compareVersions(currentVersion, version) >= 0) return null;

  return {
    version,
    name: release.name || `Versión ${version}`,
    url: release.html_url,
    notes: release.body || '',
    publishedAt: release.published_at || null,
    asset: pickAsset(release.assets, platform),
  };
}

module.exports = {
  checkForUpdate,
  compareVersions,
  parseVersion,
  pickAsset,
  repoFromPackage,
  fetchLatestRelease,
};
