'use strict';

/**
 * Lectura de Pull Requests de GitHub para el análisis con IA.
 *
 * Solo lee: el título, la descripción y los archivos cambiados de cada PR.
 * Con un token se pueden leer repositorios privados y el límite de consultas
 * sube de 60 a 5000 por hora.
 */

const API = 'https://api.github.com';
const TIMEOUT_MS = 20000;
const FILES_PER_PAGE = 100;
// GitHub no devuelve más de 3000 archivos por PR.
const MAX_FILE_PAGES = 30;

/**
 * Convierte el texto que escribe el usuario en una lista de PRs. Acepta, uno
 * por línea o separados por espacios o comas:
 *   https://github.com/dueño/repo/pull/123
 *   dueño/repo#123   ·   dueño/repo/pull/123
 *   #123  ·  123     (con el repositorio por defecto)
 *
 * @returns {{repo: string, number: number, ref: string}[]}
 */
function parsePrRefs(text, defaultRepo = '') {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
  const refs = [];
  const invalid = [];
  const seen = new Set();

  for (const token of tokens) {
    let match = token.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i)
      || token.match(/^([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/);
    let repo = match && match[1];
    let number = match && match[2];

    if (!match && (match = token.match(/^#?(\d+)$/))) {
      if (!defaultRepo) {
        invalid.push(`${token} (falta el repositorio: escribe dueño/repo#${match[1]} `
          + 'o configura un repositorio por defecto)');
        continue;
      }
      repo = defaultRepo;
      number = match[1];
    }

    if (!repo) {
      invalid.push(token);
      continue;
    }
    const ref = `${repo}#${Number(number)}`;
    if (seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    refs.push({ repo, number: Number(number), ref });
  }

  if (invalid.length) {
    throw new Error(`No se reconocen estos PRs: ${invalid.join(', ')}.`);
  }
  return refs;
}

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pg-compare-desktop',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** GET a la API de GitHub con mensajes de error que se entienden. */
async function getJson(path, { token, fetchImpl = globalThis.fetch, what }) {
  const response = await fetchImpl(`${API}${path}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.ok) return response.json();
  if (response.status === 401) {
    throw new Error('GitHub rechazó el token: revisa que sea correcto y no haya caducado.');
  }
  if (response.status === 404) {
    throw new Error(`${what}: no existe o el token no tiene acceso a ese repositorio.`);
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    throw new Error(remaining === '0'
      ? 'Se agotó el límite de consultas a GitHub. Configura un token o espera una hora.'
      : `${what}: GitHub respondió ${response.status} (sin permiso).`);
  }
  throw new Error(`${what}: GitHub respondió ${response.status}.`);
}

/**
 * Lee un PR con todos sus archivos cambiados.
 * `patch` falta en los archivos binarios o demasiado grandes para GitHub.
 */
async function fetchPullRequest({ repo, number, ref }, { token, fetchImpl } = {}) {
  const base = `/repos/${repo}/pulls/${number}`;
  const pr = await getJson(base, { token, fetchImpl, what: ref });

  const files = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const batch = await getJson(`${base}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      { token, fetchImpl, what: `${ref} (archivos)` });
    files.push(...batch);
    if (batch.length < FILES_PER_PAGE) break;
  }

  return {
    ref,
    repo,
    number,
    title: pr.title || '',
    body: pr.body || '',
    state: pr.merged_at ? 'merged' : pr.state,
    url: pr.html_url,
    author: pr.user ? pr.user.login : null,
    base: pr.base ? pr.base.ref : null,
    head: pr.head ? pr.head.ref : null,
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || null,
    })),
  };
}

/**
 * Comprueba el token. Si se indicó usuario, avisa cuando el token es de otra
 * cuenta (pasa al pegar el token de un compañero).
 */
async function testGithub({ user, token, fetchImpl } = {}) {
  if (!token) {
    return {
      ok: true,
      message: 'Sin token: solo se podrán leer repositorios públicos (60 consultas por hora).',
    };
  }
  try {
    const me = await getJson('/user', { token, fetchImpl, what: 'Usuario' });
    if (user && me.login.toLowerCase() !== String(user).toLowerCase()) {
      return {
        ok: false,
        message: `El token es de "${me.login}", no de "${user}".`,
      };
    }
    return { ok: true, message: `Conectado a GitHub como ${me.login}.` };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

module.exports = { parsePrRefs, fetchPullRequest, testGithub };
