'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyze, callClaude, dependencyWarnings, prContext, readResult, rowLine,
} = require('../electron/core/analyzer');

const FK = 'account_move_sii_document_id_fkey';

/** Comparación de ejemplo: dos cambios del PR, uno que depende de otro, y ruido. */
function comparacion() {
  return {
    db1Name: 'produccion',
    db2Name: 'desarrollo',
    db1Schema: 'public',
    totalChanges: 4,
    rows: [
      {
        id: 'tbl_add:sii_document', group: 'tables_create', type: 'Tabla', status: 'Nuevo',
        table: 'sii_document', name: 'sii_document', detail: '7 columnas · solo existe en desarrollo',
      },
      {
        id: `con_add:account_move:${FK}`, group: 'constraints_add', type: 'Constraint',
        status: 'Nuevo', table: 'account_move', name: FK,
        detail: 'FOREIGN KEY — FOREIGN KEY (sii_document_id) REFERENCES sii_document(id)',
      },
      {
        id: 'col_add:res_partner:x_rut', group: 'columns_add', type: 'Columna', status: 'Nuevo',
        table: 'res_partner', name: 'x_rut', detail: 'character varying · solo existe en desarrollo',
      },
      {
        id: 'col_add:stock_move:x_prueba', group: 'columns_add', type: 'Columna', status: 'Nuevo',
        table: 'stock_move', name: 'x_prueba', detail: 'integer · solo existe en desarrollo',
      },
    ],
    sqlById: {
      'tbl_add:sii_document': 'CREATE TABLE "sii_document" (\n\t"id" serial NOT NULL\n);',
      [`con_add:account_move:${FK}`]: `ALTER TABLE "account_move" ADD CONSTRAINT "${FK}" `
        + 'FOREIGN KEY (sii_document_id) REFERENCES sii_document(id);',
      'col_add:res_partner:x_rut': 'ALTER TABLE "res_partner" ADD COLUMN "x_rut" character varying;',
      'col_add:stock_move:x_prueba': 'ALTER TABLE "stock_move" ADD COLUMN "x_prueba" integer;',
    },
  };
}

const PR = {
  ref: 'acme/odoo-int#7',
  title: 'Integración SII',
  body: 'Agrega el RUT y los documentos del SII.',
  state: 'merged',
  url: 'https://github.com/acme/odoo-int/pull/7',
  head: 'sii',
  base: '17.0',
  files: [
    {
      filename: 'l10n_sii/models/res_partner.py', status: 'modified', additions: 3, deletions: 0,
      patch: "+    x_rut = fields.Char('RUT')",
    },
    {
      filename: 'l10n_sii/views/res_partner_views.xml', status: 'modified', additions: 5,
      deletions: 0, patch: '+<field name="x_rut"/>',
    },
    {
      filename: 'l10n_sii/tests/test_rut.py', status: 'added', additions: 20, deletions: 0,
      patch: '+def test_rut(): pass',
    },
  ],
};

/** Respuesta de la API con el JSON del análisis. */
const respuesta = (json, extra = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(json) }],
  usage: {
    input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 800,
  },
  ...extra,
});

const resultado = (extra = {}) => ({
  summary: 'El PR agrega el RUT y la relación con los documentos del SII.',
  prs: [{ ref: 'acme/odoo-int#7', dbChanges: 'res_partner.x_rut, account_move.sii_document_id' }],
  included: [
    { id: 'col_add:res_partner:x_rut', pr: 'acme/odoo-int#7', reason: 'x_rut = fields.Char' },
    { id: `con_add:account_move:${FK}`, pr: 'acme/odoo-int#7', reason: 'Many2one al documento' },
  ],
  review: [],
  missing: [],
  risks: [],
  ...extra,
});

/**
 * Cliente falso con la forma del SDK: guarda las peticiones y contesta en
 * orden. Con `rejectFallback`, la vía beta responde 400 como una cuenta sin
 * acceso al respaldo de modelo.
 */
function clienteFalso(respuestas, { rejectFallback = false } = {}) {
  const calls = [];
  const via = (kind) => ({
    stream(params, options) {
      calls.push({ kind, params, options });
      return {
        finalMessage: async () => {
          if (kind === 'beta' && rejectFallback) {
            throw Object.assign(new Error('fallbacks: not available'), { status: 400 });
          }
          return respuestas.shift();
        },
      };
    },
  });
  return { calls, beta: { messages: via('beta') }, messages: via('plain') };
}

test('pide a Claude la selección con los PRs en caché y el formato JSON', async () => {
  const client = clienteFalso([respuesta(resultado())]);
  const analysis = await analyze({
    client, model: 'claude-opus-5-5', run: comparacion(), prs: [PR], now: () => 'ahora',
  });

  assert.equal(client.calls.length, 1);
  const { kind, params } = client.calls[0];
  assert.equal(kind, 'beta');
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.fallbacks, 'default');
  assert.equal(params.output_config.format.type, 'json_schema');
  const [prs, diferencias] = params.messages[0].content;
  assert.deepEqual(prs.cache_control, { type: 'ephemeral' });
  assert.match(prs.text, /x_rut = fields\.Char/);
  assert.match(diferencias.text, /col_add:stock_move:x_prueba\tColumna\tNuevo/);

  assert.deepEqual(analysis.included.map((i) => i.id),
    ['col_add:res_partner:x_rut', `con_add:account_move:${FK}`]);
  assert.equal(analysis.createdAt, 'ahora');
  assert.deepEqual(analysis.usage, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 800 });
  assert.deepEqual(analysis.servedBy, ['claude-opus-5-5']);
});

test('avisa si lo incluido apunta a una tabla nueva que quedó fuera', async () => {
  const client = clienteFalso([respuesta(resultado())]);
  const analysis = await analyze({ client, model: 'm', run: comparacion(), prs: [PR] });
  assert.ok(analysis.warnings.some((w) => /tabla nueva sii_document/.test(w)), analysis.warnings);
});

test('descarta ids inventados y lo dudoso no entra en el script', async () => {
  const client = clienteFalso([respuesta(resultado({
    included: [
      ...resultado().included,
      { id: 'col_add:no:existe', pr: 'acme/odoo-int#7', reason: '?' },
      { id: 'tbl_add:sii_document', pr: 'acme/odoo-int#7', reason: 'modelo sii.document' },
    ],
    review: [{ id: 'tbl_add:sii_document', reason: 'no está claro el _name' }],
  }))]);
  const analysis = await analyze({ client, model: 'm', run: comparacion(), prs: [PR] });

  assert.ok(!analysis.included.some((i) => i.id === 'col_add:no:existe'));
  assert.ok(!analysis.included.some((i) => i.id === 'tbl_add:sii_document'));
  assert.deepEqual(analysis.review.map((i) => i.id), ['tbl_add:sii_document']);
  assert.ok(analysis.warnings.some((w) => /1 id\(s\) que no existen/.test(w)));
});

test('si la cuenta no admite el respaldo de modelo, repite sin él', async () => {
  const client = clienteFalso([respuesta(resultado())], { rejectFallback: true });
  const message = await callClaude(client, { model: 'm', messages: [] });

  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(client.calls.map((c) => c.kind), ['beta', 'plain']);
  assert.equal(client.calls[1].params.fallbacks, undefined);
});

test('las comparaciones grandes se reparten en partes y se unen en un solo resumen', async () => {
  const client = clienteFalso([
    respuesta(resultado({
      summary: 'Parte 1: está la FK.', included: [resultado().included[1]],
      risks: ['La parte 2 no se vio.'],
    })),
    respuesta(resultado({ summary: 'Parte 2: está el RUT.', included: [resultado().included[0]] })),
    respuesta({
      summary: 'El PR agrega el RUT y la relación con el documento del SII.',
      prs: [{ ref: 'acme/odoo-int#7', dbChanges: 'res_partner.x_rut; FK de account_move' }],
      risks: [],
    }),
  ]);
  const analysis = await analyze({
    client, model: 'm', run: comparacion(), prs: [PR], rowsPerRequest: 2,
  });

  assert.equal(client.calls.length, 3);
  assert.match(client.calls[1].params.messages[0].content[1].text, /Esta es la parte 2/);
  assert.equal(analysis.parts, 2);
  assert.equal(analysis.included.length, 2);
  assert.equal(analysis.usage.input, 3000);

  // La unión no reenvía el código de los PRs, solo lo elegido y lo que dijo cada parte.
  const union = client.calls[2].params;
  assert.equal(union.output_config.effort, 'low');
  assert.match(union.messages[0].content, /## Se aplican \(2\)/);
  assert.match(union.messages[0].content, /Parte 1: está la FK/);
  assert.doesNotMatch(union.messages[0].content, /fields\.Char\('RUT'\)/);
  assert.doesNotMatch(union.messages[0].content, /## Pull Requests/);
  assert.equal(analysis.summary, 'El PR agrega el RUT y la relación con el documento del SII.');
  assert.deepEqual(analysis.risks, []);
});

test('si falla la unión de las partes, queda el resumen de cada una', async () => {
  const client = clienteFalso([
    respuesta(resultado({ summary: 'Uno.' })),
    respuesta(resultado({ summary: 'Dos.' })),
    respuesta(resultado(), { stop_reason: 'max_tokens' }),
  ]);
  const analysis = await analyze({
    client, model: 'm', run: comparacion(), prs: [PR], rowsPerRequest: 2,
  });

  assert.match(analysis.summary, /Parte 1 de 2:\nUno\./);
  assert.ok(analysis.warnings.some((w) => /No se pudo unir/.test(w)));
  assert.equal(analysis.included.length, 2);
});

test('una negativa o una respuesta cortada se explican', () => {
  assert.throws(() => readResult({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
    /no quiso analizar.*cyber/);
  assert.throws(() => readResult({ stop_reason: 'max_tokens', content: [] }), /se cortó/);
  assert.throws(() => readResult({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{' }] }),
    /JSON/);
});

test('del PR se manda el código que cambia la base y solo el nombre del resto', () => {
  const xmlModelo = {
    filename: 'l10n_sii/data/ir_model.xml', status: 'added', additions: 4, deletions: 0,
    patch: '+<record model="ir.model.fields" id="field_x_giro">',
  };
  const { text, truncated } = prContext([{ ...PR, files: [...PR.files, xmlModelo] }]);

  assert.match(text, /--- l10n_sii\/models\/res_partner\.py/);
  assert.match(text, /--- l10n_sii\/data\/ir_model\.xml/);
  assert.match(text, /- l10n_sii\/views\/res_partner_views\.xml \(modified\)/);
  assert.doesNotMatch(text, /field name="x_rut"/);
  assert.doesNotMatch(text, /def test_rut/);
  assert.deepEqual(truncated, []);
});

test('si el código no cabe se recorta y se avisa', () => {
  const grande = {
    ...PR,
    files: [{ ...PR.files[0], patch: `+${'x'.repeat(500)}` }],
  };
  const { text, truncated } = prContext([grande], { patchChars: 100 });
  assert.match(text, /recortado/);
  assert.deepEqual(truncated, ['acme/odoo-int#7']);
});

test('cada diferencia va en una línea, con el SQL solo donde aporta', () => {
  const funcion = {
    id: 'fn_alter:calc(integer)', type: 'Función', status: 'Diferente', table: 'calc(integer)',
    name: 'calc(integer)', detail: 'definición distinta (3 líneas → 5 líneas)',
  };
  const sql = { 'fn_alter:calc(integer)': 'CREATE OR REPLACE FUNCTION calc(integer)\nRETURNS int' };
  const linea = rowLine(funcion, sql);
  assert.doesNotMatch(linea, /\n/);
  assert.match(linea, /SQL: CREATE OR REPLACE FUNCTION calc\(integer\) RETURNS int/);

  const run = comparacion();
  assert.doesNotMatch(rowLine(run.rows[2], run.sqlById), /SQL:/);
});

test('avisa del trigger cuya función nueva no se incluyó', () => {
  const rows = [
    {
      id: 'trg_add:sale_order:audit', group: 'triggers_create', type: 'Trigger', status: 'Nuevo',
      table: 'sale_order', name: 'audit', detail: '',
    },
    {
      id: 'fn_add:audit_fn()', group: 'functions_create', type: 'Función', status: 'Nuevo',
      table: 'audit_fn()', name: 'audit_fn()', detail: '',
    },
  ];
  const sql = {
    'trg_add:sale_order:audit': 'CREATE TRIGGER audit AFTER UPDATE ON sale_order '
      + 'FOR EACH ROW EXECUTE FUNCTION audit_fn();',
  };
  const warnings = dependencyWarnings(rows, sql, new Set(['trg_add:sale_order:audit']));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /función nueva audit_fn\(\)/);

  assert.deepEqual(dependencyWarnings(rows, sql, new Set(rows.map((r) => r.id))), []);
});
