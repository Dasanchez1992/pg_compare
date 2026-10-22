'use strict';

/**
 * Análisis con IA de una comparación.
 *
 * BD2 (referencia) tiene aplicados unos Pull Requests de Odoo, pero también
 * muchos otros cambios ajenos. Claude lee el código de los PRs y la lista de
 * diferencias, y elige solo las que esos PRs explican. Con esa selección se
 * arma el script de siempre (`buildScript`): la IA elige filas, nunca escribe
 * SQL, así que el script sigue saliendo del catálogo de PostgreSQL.
 *
 * Lo que la IA no menciona queda fuera. Lo que marca como dudoso tampoco
 * entra: queda en "revisar" para que alguien lo mire.
 */

const EFFORT = 'high';
const MAX_TOKENS = 32000;
// Diferencias por petición. Con más, se reparte en varias peticiones que
// comparten el contexto de los PRs (cacheado).
const ROWS_PER_REQUEST = 2500;
const DETAIL_CHARS = 240;
// De estos tipos también se manda el SQL: su detalle no dice qué cambia, y su
// definición suele aparecer tal cual en el `init()` o la migración del PR.
const SQL_TYPES = new Set(['Vista', 'Vista mat.', 'Función', 'Trigger']);
const SQL_CHARS = 800;
const PATCH_CHARS = 20000;
const PR_CONTEXT_CHARS = 400000;
const BODY_CHARS = 4000;

// Si el modelo rechaza la petición por sus filtros de seguridad, la API la
// repite con otro modelo. Algunas cuentas o modelos no lo admiten: entonces
// se repite sin él.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM_PROMPT = `Eres un DBA experto en PostgreSQL y en Odoo.

Recibes:
1. Uno o más Pull Requests de GitHub con integraciones o módulos de Odoo: título, descripción y los cambios de código.
2. Las diferencias de estructura entre dos bases PostgreSQL de Odoo:
   - BD1 (destino): la base que se va a modificar.
   - BD2 (referencia): una base que YA tiene aplicados esos PRs, pero que además arrastra muchos cambios ajenos (otros módulos, pruebas, desarrollos a medias).
   Cada diferencia tiene un id y una sentencia SQL que lleva BD1 hacia BD2.

Tu tarea es quedarte SOLO con las diferencias que son consecuencia de los PRs. Todo lo demás es ruido y queda fuera. Hasta ahora una persona hacía este filtro a mano; tu selección se aplicará tal cual, así que ante la duda no incluyas: marca para revisión.

Cómo se traduce el código de Odoo a la base de datos:
- Un modelo con \`_name = 'sale.order.line'\` vive en la tabla \`sale_order_line\` (puntos a guiones bajos), salvo que defina \`_table\`.
- \`_inherit = 'modelo'\` sin un \`_name\` distinto extiende la tabla existente: sus campos nuevos son columnas nuevas de esa tabla.
- \`_inherit\` con un \`_name\` nuevo crea otra tabla con todos los campos heredados. \`_inherits\` (delegación) añade una columna many2one hacia el padre.
- Toda tabla de modelo (también \`TransientModel\`) tiene id, create_uid, create_date, write_uid y write_date, salvo \`_log_access = False\`. Un modelo con \`_auto = False\` no crea tabla.
- Los campos almacenados son columnas con el mismo nombre: Char → character varying (con tamaño si tiene size), Text y Html → text, Integer → integer, Float → double precision (numeric si tiene digits), Monetary → numeric, Boolean → boolean, Date → date, Datetime → timestamp without time zone, Selection → character varying, Json y Properties → jsonb, Many2one → integer más una FOREIGN KEY \`<tabla>_<campo>_fkey\` hacia la tabla destino (ON DELETE según ondelete; SET NULL por defecto).
- No crean columna: One2many, los compute sin \`store=True\`, los related sin \`store=True\`, y Binary/Image con attachment (el caso por defecto; con attachment=False son bytea).
- Many2many crea una tabla de relación: la del parámetro \`relation\` o, por defecto, \`<tabla1>_<tabla2>_rel\` con los dos nombres de tabla en orden alfabético, con dos columnas \`<tabla>_id\` (o column1/column2), clave primaria compuesta e índice.
- \`required=True\` pone NOT NULL. \`index=True\` crea el índice \`<tabla>__<campo>_index\` (Odoo 16 en adelante) o \`<tabla>_<campo>_index\` (versiones anteriores). \`default=\` no crea DEFAULT en la base: Odoo lo aplica en Python.
- \`_sql_constraints = [('nombre', 'unique(...)', ...)]\` crea la constraint \`<tabla>_<nombre>\`. Desde Odoo 18 también \`models.Constraint\`, \`models.Index\` y \`models.UniqueIndex\`.
- Un \`init()\` con \`CREATE OR REPLACE VIEW\` (modelos de reporte con \`_auto = False\`) crea una vista. El SQL directo en \`init()\`, en los hooks (\`pre_init_hook\`, \`post_init_hook\`) o en \`migrations/<versión>/pre-*.py\` / \`post-*.py\` puede crear funciones, triggers, índices o columnas, y renombrar cosas.
- Los modelos y campos definidos como datos XML (\`ir.model\`, \`ir.model.fields\`, prefijo \`x_\`) también crean tablas y columnas.
- Las vistas XML, menús, acciones, reglas de acceso (\`ir.model.access.csv\`), traducciones, JS, CSS y tests NO cambian la estructura.
- Renombrar un campo suele aparecer como una columna Nueva más la vieja que Sobra. Quitar un campo deja su columna como Sobra: Odoo no la borra. Cambiar el tipo aparece como Columna Diferente.

Reglas de selección:
- Incluye una diferencia solo si puedes señalar el PR —y, si puedes, el archivo o el campo— que la explica.
- Incluye también lo que una diferencia incluida necesita para aplicarse, si está en la lista y el PR lo justifica: la tabla nueva a la que apunta una clave foránea, la función que usa un trigger, la tabla de una columna.
- Las diferencias que Sobran (DROP) solo si el PR elimina explícitamente ese modelo o campo. Aun así se emiten comentadas en el script.
- Si el PR la explica solo en parte o no estás seguro (nombres parecidos, versión de Odoo dudosa, el mismo campo en otro modelo), va a "review", no a "included".
- Usa únicamente ids que aparezcan en la lista. No inventes ids.
- Si un cambio del PR debería producir una diferencia que NO aparece en la lista, anótalo en "missing": puede ser que BD1 ya lo tenga o que BD2 no tenga el PR aplicado.

Responde en español.
- "summary": análisis en texto plano, sin markdown salvo guiones para listas. Qué cambia cada PR en la base, qué diferencias se aplican y qué riesgos ves (NOT NULL sobre tablas con datos, cambios de tipo, borrados, datos que habría que migrar).
- "prs": por cada PR, qué cambios de estructura implica.
- "included": las diferencias a aplicar, con el PR que las explica y el motivo concreto.
- "review": las dudosas, con el motivo de la duda.
- "missing" y "risks": como se explicó arriba.`;

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    prs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, dbChanges: { type: 'string' } },
        required: ['ref', 'dbChanges'],
        additionalProperties: false,
      },
    },
    included: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, pr: { type: 'string' }, reason: { type: 'string' },
        },
        required: ['id', 'pr', 'reason'],
        additionalProperties: false,
      },
    },
    review: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pr: { type: 'string' }, object: { type: 'string' }, note: { type: 'string' },
        },
        required: ['pr', 'object', 'note'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'prs', 'included', 'review', 'missing', 'risks'],
  additionalProperties: false,
};

/** Recorta un texto largo dejando constancia de que se recortó. */
function clip(text, max, marker = '\n[… recortado …]') {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(max, 0))}${marker}`;
}

/** Texto en una sola línea, para que cada diferencia ocupe una. */
function oneLine(text, max) {
  return clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max, '…');
}

/**
 * ¿Puede este archivo cambiar la estructura de la base? El código Python, el
 * SQL y los XML que definen modelos o campos, sí; las vistas, la seguridad,
 * los tests, las traducciones o el JS, no. De esos solo se manda el nombre.
 */
function changesSchema(file) {
  const name = file.filename.toLowerCase();
  if (/(^|\/)tests?\//.test(name) || /(^|\/)i18n\//.test(name)) return false;
  if (name.endsWith('.py') || name.endsWith('.sql')) return true;
  return name.endsWith('.xml') && /ir\.model(\.fields)?["']/.test(file.patch || '');
}

/**
 * Texto con los PRs para el modelo. Si el código no cabe en el presupuesto se
 * recorta, y esos PRs se devuelven en `truncated` para avisarlo.
 */
function prContext(prs, { patchChars = PATCH_CHARS, totalChars = PR_CONTEXT_CHARS } = {}) {
  let budget = totalChars;
  const truncated = new Set();

  const blocks = prs.map((pr) => {
    const relevant = pr.files.filter(changesSchema);
    const others = pr.files.filter((file) => !changesSchema(file));
    const lines = [
      `### PR ${pr.ref}: ${pr.title}`,
      `Estado: ${pr.state} · ${pr.url}${pr.head ? ` · rama ${pr.head} → ${pr.base}` : ''}`,
      '',
      'Descripción:',
      clip(pr.body.trim() || '(sin descripción)', BODY_CHARS),
      '',
    ];

    for (const file of relevant) {
      let patch = file.patch || '(diff no disponible: archivo binario o demasiado grande)';
      const limit = Math.min(patchChars, budget);
      if (patch.length > limit) {
        patch = clip(patch, limit);
        truncated.add(pr.ref);
      }
      budget -= patch.length;
      lines.push(`--- ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`,
        patch, '');
    }

    if (others.length) {
      lines.push('Otros archivos (no cambian la estructura; sin diff):',
        ...others.map((file) => `- ${file.filename} (${file.status})`), '');
    }
    return lines.join('\n');
  });

  return { text: blocks.join('\n'), truncated: [...truncated] };
}

/** Una diferencia en una línea: id, tipo, estado, tabla, nombre, detalle [, SQL]. */
function rowLine(row, sqlById = {}) {
  const fields = [row.id, row.type, row.status, row.table, row.name,
    oneLine(row.detail, DETAIL_CHARS)];
  if (SQL_TYPES.has(row.type) && sqlById[row.id]) {
    fields.push(`SQL: ${oneLine(sqlById[row.id], SQL_CHARS)}`);
  }
  return fields.join('\t');
}

function chunk(items, size) {
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts.length ? parts : [[]];
}

/**
 * Petición a la API. Los PRs van primero y marcados para la caché: si hay
 * varias partes, la segunda y siguientes los leen de ahí.
 */
function buildRequest({ model, run, context, rows, part, parts }) {
  const header = [
    '## Comparación',
    `BD1 (destino, se modifica): ${run.db1Name} · esquema ${run.db1Schema || 'public'}`,
    `BD2 (referencia, ya tiene los PRs y otros cambios): ${run.db2Name}`,
    parts > 1
      ? `Hay ${run.rows.length} diferencias, repartidas en ${parts} partes. Esta es la parte `
        + `${part} (${rows.length} diferencias). No ves las demás partes: deja "missing" vacío.`
      : `Hay ${rows.length} diferencias.`,
    '',
    'Formato: id<TAB>tipo<TAB>estado<TAB>tabla<TAB>nombre<TAB>detalle[<TAB>SQL]',
    '',
  ];

  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: RESULT_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `## Pull Requests\n\n${context}`,
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: [...header, ...rows.map((row) => rowLine(row, run.sqlById))].join('\n'),
        },
      ],
    }],
  };
}

/** ¿La API rechazó el respaldo de modelo (beta no disponible para esta cuenta)? */
function isFallbackRejection(error) {
  return Boolean(error) && error.status === 400 && /fallback|beta/i.test(error.message || '');
}

/** Llama a Claude en streaming (las respuestas largas no agotan el tiempo). */
async function callClaude(client, params, { signal } = {}) {
  try {
    return await client.beta.messages.stream(
      { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' },
      { signal },
    ).finalMessage();
  } catch (error) {
    if (!isFallbackRejection(error)) throw error;
    return client.messages.stream(params, { signal }).finalMessage();
  }
}

/** JSON de la respuesta, con errores que se entienden. */
function readResult(message) {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details && message.stop_details.category;
    throw new Error(`Claude no quiso analizar esta comparación${category ? ` (${category})` : ''}.`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('La respuesta de Claude se cortó por larga. Prueba con menos PRs a la vez.');
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Claude devolvió una respuesta que no se pudo leer como JSON.');
  }
}

/**
 * Junta las respuestas de todas las partes y descarta lo que no cuadra: ids
 * que no existen, y duplicados. Lo que la IA puso a la vez en "incluir" y en
 * "revisar" se queda en "revisar".
 */
function mergeResults(results, rows) {
  const known = new Set(rows.map((row) => row.id));
  const unknown = new Set();
  const review = new Map();
  const included = new Map();
  const prs = new Map();
  const risks = new Set();
  const missing = [];

  for (const result of results) {
    for (const item of result.review || []) {
      if (!known.has(item.id)) unknown.add(item.id);
      else if (!review.has(item.id)) review.set(item.id, item);
    }
    for (const item of result.included || []) {
      if (!known.has(item.id)) unknown.add(item.id);
      else if (!included.has(item.id)) included.set(item.id, item);
    }
    for (const pr of result.prs || []) {
      const previous = prs.get(pr.ref);
      prs.set(pr.ref, previous && previous !== pr.dbChanges
        ? `${previous}\n${pr.dbChanges}` : pr.dbChanges);
    }
    (result.risks || []).forEach((risk) => risks.add(risk));
    missing.push(...(result.missing || []));
  }
  for (const id of review.keys()) included.delete(id);

  const summary = results.length === 1
    ? results[0].summary
    : results.map((r, i) => `Parte ${i + 1} de ${results.length}:\n${r.summary}`).join('\n\n');

  const warnings = [];
  if (unknown.size) {
    warnings.push(`La IA citó ${unknown.size} id(s) que no existen en la comparación; `
      + 'se ignoraron.');
  }
  if (results.length > 1) {
    warnings.push(`La comparación se analizó en ${results.length} partes: la lista de cambios `
      + 'esperados que no aparecen ("missing") no se calcula.');
  }

  return {
    summary,
    prSummaries: [...prs].map(([ref, dbChanges]) => ({ ref, dbChanges })),
    included: [...included.values()],
    review: [...review.values()],
    missing,
    risks: [...risks],
    warnings,
  };
}

const FK_RE = /REFERENCES\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?\s*\(/gi;
const TRIGGER_FN_RE = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?\s*\(/i;

/**
 * Lo que el script necesita y la selección deja fuera: se avisa, no se añade,
 * porque meter una tabla que ningún PR justifica tampoco sería correcto.
 */
function dependencyWarnings(rows, sqlById, includedIds) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const left = (id) => byId.has(id) && !includedIds.has(id);
  const label = (row) => `${row.type} ${row.table === row.name ? row.name : `${row.table}.${row.name}`}`;
  const warnings = [];

  for (const id of includedIds) {
    const row = byId.get(id);
    if (!row) continue;
    const sql = sqlById[id] || '';

    if (row.group !== 'tables_create' && left(`tbl_add:${row.table}`)) {
      warnings.push(`${label(row)} es de la tabla nueva ${row.table}, que no está incluida.`);
    }
    for (const [, target] of sql.matchAll(FK_RE)) {
      if (target !== row.table && left(`tbl_add:${target}`)) {
        warnings.push(`${label(row)} apunta a la tabla nueva ${target}, que no está incluida.`);
      }
    }
    const trigger = row.group.startsWith('triggers_') && TRIGGER_FN_RE.exec(sql);
    if (trigger) {
      const fn = rows.find((r) => r.group === 'functions_create'
        && r.name.startsWith(`${trigger[1]}(`) && !includedIds.has(r.id));
      if (fn) {
        warnings.push(`${label(row)} usa la función nueva ${fn.name}, que no está incluida.`);
      }
    }
  }
  return [...new Set(warnings)];
}

function addUsage(total, usage = {}) {
  total.input += usage.input_tokens || 0;
  total.output += usage.output_tokens || 0;
  total.cacheRead += usage.cache_read_input_tokens || 0;
  total.cacheWrite += usage.cache_creation_input_tokens || 0;
}

/**
 * Analiza una comparación contra unos PRs.
 *
 * @param {object} options
 * @param {object} options.client  cliente de Anthropic (`@anthropic-ai/sdk`)
 * @param {string} options.model
 * @param {object} options.run     comparación con `rows` y `sqlById`
 * @param {object[]} options.prs   PRs leídos con `fetchPullRequest`
 */
async function analyze({
  client, model, run, prs, signal, onProgress = () => {},
  rowsPerRequest = ROWS_PER_REQUEST, now = () => new Date().toISOString(),
}) {
  if (!prs.length) throw new Error('Indica al menos un PR.');
  if (!run.rows.length) throw new Error('Esta comparación no tiene diferencias que analizar.');

  const context = prContext(prs);
  const parts = chunk(run.rows, rowsPerRequest);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const servedBy = new Set();
  const results = [];

  for (const [index, rows] of parts.entries()) {
    onProgress(parts.length > 1
      ? `Claude está analizando las diferencias (parte ${index + 1} de ${parts.length})…`
      : 'Claude está analizando las diferencias…');
    const message = await callClaude(client, buildRequest({
      model, run, context: context.text, rows, part: index + 1, parts: parts.length,
    }), { signal });
    addUsage(usage, message.usage);
    if (message.model) servedBy.add(message.model);
    results.push(readResult(message));
  }

  const merged = mergeResults(results, run.rows);
  const includedIds = new Set(merged.included.map((item) => item.id));
  if (context.truncated.length) {
    merged.warnings.push(`El código de ${context.truncated.join(', ')} no cupo entero y se `
      + 'recortó: la IA no lo vio completo.');
  }

  return {
    createdAt: now(),
    model,
    servedBy: [...servedBy],
    prs: prs.map((pr) => ({
      ref: pr.ref,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      files: pr.files.length,
      truncated: context.truncated.includes(pr.ref),
    })),
    ...merged,
    warnings: [...merged.warnings, ...dependencyWarnings(run.rows, run.sqlById, includedIds)],
    parts: parts.length,
    usage,
  };
}

module.exports = {
  analyze,
  buildRequest,
  callClaude,
  changesSchema,
  dependencyWarnings,
  mergeResults,
  prContext,
  readResult,
  rowLine,
  RESULT_SCHEMA,
  SYSTEM_PROMPT,
};
