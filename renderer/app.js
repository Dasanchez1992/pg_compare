'use strict';

/**
 * Núcleo de la interfaz: enrutado por hash, plantillas y avisos.
 *
 * La interfaz no toca ni disco ni PostgreSQL: todo pasa por `window.api`,
 * el puente que expone el proceso principal.
 */

const App = {
  views: {},
  routes: [],
  current: null,      // vista montada, con su posible `onSaveScript`
};

// --- Plantillas -----------------------------------------------------------

const ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** Escapa texto que viene de la base de datos o del usuario. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Marca un fragmento ya construido para insertarlo sin escapar. */
function raw(value) {
  return { __html: String(value) };
}

/**
 * Plantilla que escapa por defecto:
 *   html`<td>${nombreDeTabla}</td>`
 * Los arrays se unen y los fragmentos marcados con `raw()` pasan tal cual.
 */
function html(strings, ...values) {
  return strings.reduce((out, chunk, i) => {
    if (i >= values.length) return out + chunk;
    const value = values[i];
    let rendered;
    if (value === null || value === undefined || value === false) rendered = '';
    else if (value && value.__html !== undefined) rendered = value.__html;
    else if (Array.isArray(value)) {
      rendered = value.map((v) => (v && v.__html !== undefined ? v.__html : esc(v))).join('');
    } else rendered = esc(value);
    return out + chunk + rendered;
  }, '');
}

/** Construye un nodo a partir de HTML. */
function node(markup) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = markup;
  return wrapper;
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// --- Formato --------------------------------------------------------------

/** Fecha local legible: 2026-01-31 14:05. */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Plural sencillo en español: 1 comparación / 2 comparaciones. */
function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// --- Avisos ---------------------------------------------------------------

/**
 * Muestra un aviso arriba (equivale a los mensajes flash de antes).
 * Con `html: true` el texto se inserta tal cual, para avisos con formato.
 */
function notify(text, kind = 'success', { sticky = false, html: asHtml = false } = {}) {
  const box = $('#messages');
  const el = node(html`
    <div class="msg ${kind}"><span>${asHtml ? raw(text) : text}</span>
      <button class="close" aria-label="Cerrar">&times;</button>
    </div>`).firstElementChild;

  $('button', el).addEventListener('click', () => el.remove());
  box.appendChild(el);
  if (!sticky) setTimeout(() => el.remove(), kind === 'error' ? 12000 : 5000);
  return el;
}

function clearMessages() {
  $('#messages').innerHTML = '';
}

// --- Enrutado -------------------------------------------------------------

/** Registra una vista: patrón con `:id` y función que devuelve el HTML. */
function route(pattern, view) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-z]+)/gi, (_m, name) => {
    names.push(name);
    return '([^/?]+)';
  })}$`);
  App.routes.push({ regex, names, view });
}

function parseHash() {
  const hash = window.location.hash || '#/';
  const [pathPart, queryPart] = hash.replace(/^#/, '').split('?');
  return {
    path: pathPart || '/',
    query: new URLSearchParams(queryPart || ''),
  };
}

function navigate(routeOrPath) {
  const target = routeOrPath.startsWith('#') ? routeOrPath : `#${routeOrPath}`;
  if (window.location.hash === target) render();
  else window.location.hash = target;
}

/** Marca la pestaña activa según la ruta. */
function highlightNav(path) {
  for (const link of $$('header nav a')) {
    const match = link.dataset.match;
    const active = match === 'proyectos'
      ? (path === '/' || path.startsWith('/proyectos'))
      : path.startsWith(`/${match}`);
    link.classList.toggle('active', active);
  }
}

let renderToken = 0;

/** Monta la vista que corresponde al hash actual. */
async function render() {
  const { path, query } = parseHash();
  const token = ++renderToken;
  highlightNav(path);
  App.current = null;

  const match = App.routes
    .map((r) => ({ r, m: r.regex.exec(path) }))
    .find(({ m }) => m);

  const view = $('#view');
  if (!match) {
    view.innerHTML = html`<div class="card"><h1>Página no encontrada</h1>
      <p class="muted">La ruta <code>${path}</code> no existe.</p></div>`;
    return;
  }

  const params = {};
  match.r.names.forEach((name, i) => { params[name] = match.m[i + 1]; });

  view.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
  try {
    const result = await match.r.view({ params, query });
    if (token !== renderToken) return;      // el usuario ya navegó a otra vista
    view.innerHTML = typeof result === 'string' ? result : (result.html || '');
    if (typeof result === 'object' && result.mounted) result.mounted(view);
    App.current = typeof result === 'object' ? result : null;
  } catch (error) {
    if (token !== renderToken) return;
    view.innerHTML = html`<div class="card">
      <h1>No se pudo abrir la vista</h1>
      <p class="msg error">${error.message}</p>
    </div>`;
  }
}

// --- Resaltado de SQL -----------------------------------------------------

function highlight(el) {
  if (!el || !window.hljs) return;
  el.removeAttribute('data-highlighted');
  el.className = 'language-sql';
  window.hljs.highlightElement(el);
}

/** Copia texto al portapapeles con respaldo para entornos sin permiso. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(area);
    return ok;
  }
}

Object.assign(App, {
  esc, raw, html, node, $, $$, formatDate, plural,
  notify, clearMessages, route, navigate, render, highlight, copyText,
});
window.App = App;
