'use strict';

/** Resultado de una comparación: grilla de diferencias y script ALTER. */
(() => {
  // Cambios que cuelgan de una tabla.
  const TABLE_CHILD_TYPES = new Set(['Columna', 'Índice', 'Constraint', 'Trigger', 'Partición']);

  // Veredicto del análisis con IA en la columna "IA" de la grilla.
  const AI_BADGE = {
    aplicar: '<span class="badge b-ai">Aplicar</span>',
    revisar: '<span class="badge b-chg">Revisar</span>',
    descartado: '<span class="muted">—</span>',
  };

  const {
    html, raw, notify, route, formatDate, highlight, copyText, $, $$,
  } = window.App;

  route('/historial/:id', async ({ params }) => {
    const [run, integrations] = await Promise.all([
      window.api.runs.get(params.id),
      window.api.settings.get(),
    ]);
    if (!run) throw new Error('Esa comparación ya no existe.');

    const cabecera = html`
      <div class="card">
        <div class="toolbar">
          <h1 style="margin:0;">${run.db1Name} <span class="muted">v</span> ${run.db2Name}</h1>
          <span class="muted">Guardada el ${formatDate(run.createdAt)}</span>
          <span class="spacer"></span>
          ${run.canRerun ? raw('<button class="btn" id="rerun">🔄 Re-ejecutar</button>') : ''}
          <a class="btn secondary" data-route="#/historial">Historial</a>
          <a class="btn secondary" data-route="#/comparar">← Nueva comparación</a>
        </div>
        <p class="muted">Total de diferencias: <strong>${run.totalChanges}</strong>
          · Esquema de destino: <strong>${run.db1Schema}</strong></p>
      </div>`;

    if (run.totalChanges === 0) {
      return {
        html: html`${raw(cabecera)}
          <div class="card"><p>✅ No se encontraron diferencias estructurales.
            Las bases son iguales.</p></div>`,
        mounted: (root) => bindRerun(root, run),
      };
    }

    // Si ya se generó un script se respeta aquella selección; si no, todo
    // marcado (el usuario desmarca lo que no quiera aplicar).
    const selected = new Set(run.hasScript ? run.selectedIds : run.rows.map((r) => r.id));

    // Si hubo análisis con IA, qué decidió de cada fila.
    const analysis = run.analysis || null;
    const verdicts = new Map();
    if (analysis) {
      for (const item of analysis.included) verdicts.set(item.id, 'aplicar');
      for (const item of analysis.review) verdicts.set(item.id, 'revisar');
    }
    const verdictOf = (id) => verdicts.get(id) || 'descartado';

    // Una tabla que existe en ambas bases no tiene fila propia: sus cambios
    // salen como columnas, índices, etc. Para que el filtro "Tabla" la
    // encuentre, cada uno de esos cambios hereda el estado de su tabla
    // (Nuevo/Sobra si la tabla entera se crea o se borra, Diferente si no).
    const estadoTabla = new Map(run.rows
      .filter((r) => r.type === 'Tabla').map((r) => [r.table, r.status]));
    const tableStatusOf = (item) => {
      if (item.type === 'Tabla') return item.status;
      if (!TABLE_CHILD_TYPES.has(item.type)) return '';
      return estadoTabla.get(item.table) || 'Diferente';
    };

    const filas = run.rows.map((item) => raw(html`
      <tr data-id="${item.id}" data-name="${item.name.toLowerCase()}"
          data-table="${item.table.toLowerCase()}"
          data-type="${item.type}" data-status="${item.status}"
          data-table-status="${tableStatusOf(item)}"
          data-ai="${analysis ? verdictOf(item.id) : ''}">
        <td class="check-cell">
          <input type="checkbox" style="width:auto;" ${selected.has(item.id) ? raw('checked') : ''}>
        </td>
        <td>${item.name}</td>
        <td>${item.type}</td>
        <td><span class="badge ${item.statusClass}">${item.status}</span></td>
        ${analysis ? raw(`<td>${AI_BADGE[verdictOf(item.id)]}</td>`) : ''}
        <td>${item.table}</td>
        <td><span class="muted det">${item.detail}</span></td>
      </tr>`));

    return {
      html: html`
        ${raw(cabecera)}

        ${raw(aiCard(run, integrations))}

        <div class="card">
          <div class="toolbar">
            <strong>Objetos</strong>
            <span class="muted" id="selection-count"></span>
            <span class="spacer"></span>
            <button type="button" class="btn secondary" id="only-filtered" hidden>
              Marcar solo lo filtrado</button>
            <button type="button" class="btn secondary" id="check-all">Marcar todo</button>
            <button type="button" class="btn secondary" id="uncheck-all">Desmarcar todo</button>
            <button type="button" class="btn secondary" id="show-script"
                    ${run.hasScript ? '' : raw('hidden')}>📄 Ver script guardado</button>
            <button type="button" class="btn" id="generate">⚙ Generar script</button>
          </div>

          <p class="notice" id="hidden-selected" hidden>
            <span id="hidden-selected-text"></span>
            <button type="button" class="btn secondary sm" id="uncheck-hidden">
              Desmarcar los ocultos</button>
          </p>

          <p class="notice" id="confirm-generate" hidden>
            <span id="confirm-generate-text"></span>
            <button type="button" class="btn sm" id="gen-visible"></button>
            <button type="button" class="btn secondary sm" id="gen-all"></button>
            <button type="button" class="btn secondary sm" id="gen-cancel">Cancelar</button>
          </p>

          <div class="grid-wrap">
            <table class="grid" id="grid">
              <thead>
                <tr>
                  <th style="width:2rem;"><input type="checkbox" id="check-header"
                      title="Marca o desmarca las filas que se ven ahora"></th>
                  <th>Nombre</th><th>Tipo</th><th>Estado</th>
                  ${analysis ? raw('<th title="Qué decidió el análisis con IA">IA</th>') : ''}
                  <th>Tabla / Esquema</th><th>Detalle</th>
                </tr>
                <tr class="filters">
                  <th></th>
                  <th><input type="text" id="f-name" placeholder="Filtrar por nombre..."></th>
                  <th>
                    <select id="f-type">
                      <option value="">(todos)</option>
                      <option title="La tabla y sus columnas, índices, constraints, triggers y particiones">Tabla</option>
                      <option>Columna</option>
                      <option>Índice</option><option>Constraint</option>
                      <option>Vista</option><option>Vista mat.</option>
                      <option>Secuencia</option>
                      <option>Función</option><option>Trigger</option>
                      <option>Partición</option>
                      <option>Tipo</option><option>Dominio</option>
                    </select>
                  </th>
                  <th>
                    <select id="f-status">
                      <option value="">(todos)</option>
                      <option>Nuevo</option><option>Diferente</option>
                      <option>Sobra</option><option>Manual</option>
                    </select>
                  </th>
                  ${analysis ? raw(`<th>
                    <select id="f-ai">
                      <option value="">(todos)</option>
                      <option value="aplicar">Aplicar</option>
                      <option value="revisar">Revisar</option>
                      <option value="descartado">Descartado</option>
                    </select>
                  </th>`) : ''}
                  <th><input type="text" id="f-table" placeholder="Filtrar por tabla..."></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${filas}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">SQL de la diferencia <span class="muted" id="detail-name"></span></h3>
          <pre><code id="detail-sql" class="language-sql">Selecciona una fila de la grilla para ver su SQL.</code></pre>
        </div>

        <div class="modal-overlay" id="script-modal">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Script ALTER">
            <div class="modal-header">
              <h2 id="script-title">Script ALTER completo</h2>
              <span class="spacer"></span>
              <button type="button" class="modal-close" id="modal-close" aria-label="Cerrar">&times;</button>
            </div>
            <div class="modal-body">
              <p class="muted" style="margin-top:0;">Aplica este script sobre
                <strong>${run.db1Name}</strong> para igualar su estructura a
                <strong>${run.db2Name}</strong>. Los DROP van comentados.</p>
              <pre><code id="script-content" class="language-sql"></code></pre>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn secondary" id="modal-close-2">Cerrar</button>
              <button type="button" class="btn secondary" id="copy-script">📋 Copiar</button>
              <button type="button" class="btn" id="download-script">⬇ Guardar .sql</button>
            </div>
          </div>
        </div>`,

      onSaveScript: () => {
        if (!run.hasScript) {
          notify('Genera el script antes de guardarlo.', 'error');
          return;
        }
        window.App.saveScriptFile(run.id);
      },

      mounted(root) {
        bindRerun(root, run);

        const grid = $('#grid tbody', root);
        const rowsEls = $$('tr', grid);
        const modal = $('#script-modal', root);
        const scriptEl = $('#script-content', root);
        let script = run.script || '';
        let hasScript = run.hasScript;

        // --- Selección de filas ---------------------------------------
        // El script se arma con lo marcado, no con lo que se ve: por eso la
        // cuenta de marcados está siempre a la vista y, si el filtro esconde
        // filas marcadas, se avisa en vez de colarlas sin más en el script.
        const boxOf = (tr) => $('input[type=checkbox]', tr);
        const isVisible = (tr) => tr.style.display !== 'none';
        const visibleRows = () => rowsEls.filter(isVisible);
        const checkedRows = () => rowsEls.filter((tr) => boxOf(tr).checked);

        const setChecked = (rows, state) => {
          for (const tr of rows) boxOf(tr).checked = state;
          refreshSelection();
        };

        const filterEls = ['f-name', 'f-table', 'f-type', 'f-status', 'f-ai']
          .map((id) => $(`#${id}`, root))
          .filter(Boolean);
        const filtering = () => filterEls.some((el) => el.value !== '');

        function refreshSelection() {
          const total = rowsEls.length;
          const visibles = visibleRows();
          const marcadas = checkedRows().length;
          const marcadasVisibles = visibles.filter((tr) => boxOf(tr).checked).length;
          const ocultasMarcadas = marcadas - marcadasVisibles;
          const conFiltro = filtering();

          $('#selection-count', root).textContent = conFiltro
            ? `${marcadas} de ${total} marcados · ${visibles.length} a la vista`
            : `${marcadas} de ${total} marcados`;

          const generar = $('#generate', root);
          generar.textContent = `⚙ Generar script (${marcadas})`;
          generar.disabled = marcadas === 0;
          generar.title = marcadas === 0 ? 'Marca al menos un cambio.' : '';

          const cabecera = $('#check-header', root);
          cabecera.checked = visibles.length > 0 && marcadasVisibles === visibles.length;
          cabecera.indeterminate = marcadasVisibles > 0 && marcadasVisibles < visibles.length;

          $('#only-filtered', root).hidden = !conFiltro;
          // La pregunta de "Generar script" deja de valer si cambia la selección.
          $('#confirm-generate', root).hidden = true;

          const aviso = $('#hidden-selected', root);
          aviso.hidden = ocultasMarcadas === 0;
          if (ocultasMarcadas > 0) {
            $('#hidden-selected-text', root).textContent = ocultasMarcadas === 1
              ? '⚠ Hay 1 cambio marcado que el filtro no muestra; también entra en el script.'
              : `⚠ Hay ${ocultasMarcadas} cambios marcados que el filtro no muestra; `
                + 'también entran en el script.';
          }
        }

        // "Marcar todo" y "Desmarcar todo" son literales: alcanzan a todas las
        // filas, las oculte o no el filtro.
        $('#check-all', root).addEventListener('click', () => setChecked(rowsEls, true));
        $('#uncheck-all', root).addEventListener('click', () => setChecked(rowsEls, false));

        // Para quedarse justo con lo filtrado (por ejemplo, una sola tabla).
        $('#only-filtered', root).addEventListener('click', () => {
          for (const tr of rowsEls) boxOf(tr).checked = isVisible(tr);
          refreshSelection();
        });

        $('#uncheck-hidden', root).addEventListener('click', () => {
          for (const tr of rowsEls) if (!isVisible(tr)) boxOf(tr).checked = false;
          refreshSelection();
        });

        // La casilla de la cabecera actúa sobre lo que se está viendo.
        $('#check-header', root).addEventListener('click', (e) => {
          setChecked(visibleRows(), e.currentTarget.checked);
        });

        grid.addEventListener('change', refreshSelection);

        // --- SQL de la fila seleccionada -------------------------------
        const showSql = (tr) => {
          for (const row of rowsEls) row.classList.remove('selected');
          tr.classList.add('selected');
          $('#detail-name', root).textContent = `— ${tr.children[1].textContent.trim()}`;
          const el = $('#detail-sql', root);
          el.textContent = run.sqlById[tr.dataset.id] || '(sin SQL)';
          highlight(el);
        };

        for (const tr of rowsEls) {
          tr.addEventListener('click', (event) => {
            // Pulsar la casilla marca/desmarca, no cambia la fila mostrada.
            if (event.target.closest('.check-cell')) return;
            showSql(tr);
          });
        }

        // --- Filtros ----------------------------------------------------
        const applyFilters = () => {
          const name = $('#f-name', root).value.toLowerCase();
          const table = $('#f-table', root).value.toLowerCase();
          const type = $('#f-type', root).value;
          const status = $('#f-status', root).value;
          const ai = analysis ? $('#f-ai', root).value : '';

          // "Tabla" abarca la tabla y todo lo que cuelga de ella, y el estado
          // se mira en la tabla: "Tabla + Diferente" son los cambios de las
          // tablas que existen en ambas bases. "Manual" se mira en la fila.
          const porTabla = type === 'Tabla';
          const estadoDe = (tr) => (porTabla && status !== 'Manual'
            ? tr.dataset.tableStatus : tr.dataset.status);

          for (const tr of rowsEls) {
            const ok = (!name || tr.dataset.name.includes(name))
              && (!table || tr.dataset.table.includes(table))
              && (!type || (porTabla ? tr.dataset.tableStatus !== '' : tr.dataset.type === type))
              && (!status || estadoDe(tr) === status)
              && (!ai || tr.dataset.ai === ai);
            tr.style.display = ok ? '' : 'none';
          }
          refreshSelection();
        };

        for (const el of filterEls) el.addEventListener('input', applyFilters);
        applyFilters();

        // --- Modal del script -------------------------------------------
        const openModal = () => {
          scriptEl.textContent = script;
          highlight(scriptEl);
          modal.classList.add('open');
        };
        const closeModal = () => modal.classList.remove('open');
        const setScriptTitle = (n) => {
          $('#script-title', root).textContent =
            `Script ALTER completo (${n} cambio${n === 1 ? '' : 's'})`;
        };

        $('#show-script', root).addEventListener('click', openModal);
        $('#modal-close', root).addEventListener('click', closeModal);
        $('#modal-close-2', root).addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        document.addEventListener('keydown', function onEsc(e) {
          if (!document.body.contains(modal)) {
            document.removeEventListener('keydown', onEsc);   // la vista ya cambió
          } else if (e.key === 'Escape') closeModal();
        });

        // --- Generar el script ------------------------------------------
        const generate = async () => {
          const button = $('#generate', root);
          const selectedIds = checkedRows().map((tr) => tr.dataset.id);
          if (selectedIds.length === 0) {
            notify('Marca al menos un cambio para generar el script.', 'error');
            return;
          }

          button.disabled = true;
          try {
            const updated = await window.api.runs.script({ id: run.id, selectedIds });
            script = updated.script;
            hasScript = true;
            run.hasScript = true;
            $('#show-script', root).hidden = false;
            setScriptTitle(selectedIds.length);
            openModal();
          } catch (error) {
            notify(error.message, 'error');
          } finally {
            refreshSelection();
          }
        };

        // Si el filtro esconde cambios marcados, se pregunta antes: lo normal
        // al filtrar y marcar un par de filas es querer solo esas.
        $('#generate', root).addEventListener('click', () => {
          const marcadas = checkedRows().length;
          const visibles = visibleRows().filter((tr) => boxOf(tr).checked).length;
          const ocultas = marcadas - visibles;
          if (ocultas === 0) {
            generate();
            return;
          }

          $('#hidden-selected', root).hidden = true;
          $('#confirm-generate-text', root).textContent = `Tienes ${visibles} cambio(s) `
            + `marcado(s) a la vista y otros ${ocultas} que el filtro esconde. `
            + '¿Cuáles van al script?';
          const soloVisibles = $('#gen-visible', root);
          soloVisibles.textContent = `Solo los ${visibles} a la vista`;
          soloVisibles.disabled = visibles === 0;
          $('#gen-all', root).textContent = `Todos los marcados (${marcadas})`;
          $('#confirm-generate', root).hidden = false;
        });

        $('#gen-visible', root).addEventListener('click', () => {
          for (const tr of rowsEls) if (!isVisible(tr)) boxOf(tr).checked = false;
          generate();
        });
        $('#gen-all', root).addEventListener('click', generate);
        $('#gen-cancel', root).addEventListener('click', refreshSelection);

        $('#copy-script', root).addEventListener('click', async (event) => {
          const button = event.currentTarget;
          const ok = await copyText(script);
          if (!ok) {
            notify('No se pudo copiar al portapapeles.', 'error');
            return;
          }
          button.textContent = '✅ Copiado';
          setTimeout(() => { button.textContent = '📋 Copiar'; }, 1500);
        });

        $('#download-script', root).addEventListener('click', () => {
          if (!hasScript) {
            notify('Genera el script antes de guardarlo.', 'error');
            return;
          }
          window.App.saveScriptFile(run.id);
        });

        // Si se vuelve a abrir una comparación con script, se muestra al pulsar
        // "Generar script"; el contenido ya está cargado desde el historial.
        if (hasScript) setScriptTitle(run.selectedIds.length);

        // --- Análisis con IA --------------------------------------------
        const aiRun = $('#ai-run', root);
        const aiCancel = $('#ai-cancel', root);
        const aiStatus = $('#ai-status', root);
        const aiStatusText = $('#ai-status-text', root);

        aiRun.addEventListener('click', async () => {
          const prsText = $('#ai-prs', root).value.trim();
          if (!prsText) {
            notify('Escribe al menos un PR.', 'error');
            return;
          }
          const nPrs = prsText.split(/[\s,;]+/).filter(Boolean).length;
          const ok = await window.api.confirm({
            title: 'Análisis con IA',
            message: `¿Analizar ${run.totalChanges} diferencias contra `
              + `${nPrs === 1 ? '1 PR' : `${nPrs} PRs`}?`,
            detail: 'Se leerán los PRs en GitHub y se enviarán a la API de Claude (Anthropic) '
              + 'las diferencias de esta comparación junto con el código de los PRs; los '
              + 'datos de las tablas no se envían. La selección actual se reemplaza por la '
              + 'que haga la IA.',
            confirmLabel: 'Analizar',
          });
          if (!ok) return;

          aiRun.disabled = true;
          aiCancel.hidden = false;
          aiStatus.hidden = false;
          aiStatusText.textContent = 'Preparando…';
          const stop = window.api.ai.onProgress((message) => {
            aiStatusText.textContent = message;
          });
          try {
            const updated = await window.api.ai.analyze({ id: run.id, prsText });
            const { included, review } = updated.analysis;
            notify(`Análisis listo: ${included.length} diferencia(s) a aplicar y `
              + `${review.length} a revisar. El script ya está generado con esa selección.`);
            window.App.render();
          } catch (error) {
            notify(error.message, 'error');
            aiRun.disabled = false;
            aiCancel.hidden = true;
            aiStatus.hidden = true;
          } finally {
            stop();
          }
        });
        aiCancel.addEventListener('click', () => window.api.ai.cancel());

        if (!analysis) return;

        $('#ai-mark', root).addEventListener('click', () => {
          const ids = new Set(analysis.included.map((item) => item.id));
          for (const tr of rowsEls) boxOf(tr).checked = ids.has(tr.dataset.id);
          refreshSelection();
        });
        $('#ai-script', root).addEventListener('click', () => {
          if (hasScript) openModal();
          else notify('Genera el script con «Generar script».', 'error');
        });
        $('#ai-copy', root).addEventListener('click', async (event) => {
          const button = event.currentTarget;
          if (!(await copyText(analysisText(run)))) {
            notify('No se pudo copiar al portapapeles.', 'error');
            return;
          }
          button.textContent = '✅ Copiado';
          setTimeout(() => { button.textContent = '📋 Copiar análisis'; }, 1500);
        });

        // Pulsar una fila del análisis lleva a su diferencia en la grilla.
        for (const item of $$('[data-goto]', root)) {
          item.addEventListener('click', () => {
            const target = rowsEls.find((tr) => tr.dataset.id === item.dataset.goto);
            if (!target) return;
            if (!isVisible(target)) {
              for (const el of filterEls) el.value = '';
              applyFilters();
            }
            showSql(target);
            target.scrollIntoView({ block: 'center' });
          });
        }
      },
    };
  });

  /** "tabla.columna" o solo el nombre, para los listados del análisis. */
  function objectName(row) {
    return row.table && row.table !== row.name ? `${row.table}.${row.name}` : row.name;
  }

  /** Tarjeta del análisis con IA: qué PRs analizar y, si ya se hizo, el resultado. */
  function aiCard(run, { ai, github }) {
    const analysis = run.analysis;
    const ejemplo = github.defaultRepo || 'empresa/odoo-integraciones';
    const placeholder = `https://github.com/${ejemplo}/pull/123\n${ejemplo}#124`
      + `${github.defaultRepo ? '\n#125' : ''}`;

    return html`
      <div class="card" id="ai-card">
        <div class="toolbar">
          <h2 style="margin:0;">🤖 Análisis con IA</h2>
          <span class="muted">deja marcadas solo las diferencias que explican los PRs</span>
          <span class="spacer"></span>
          <a class="btn secondary sm" data-route="#/configuracion">⚙ Configuración</a>
        </div>
        ${ai.hasKey ? '' : raw(html`<p class="notice">Falta la clave de la API de Claude.
          <a class="btn secondary sm" data-route="#/configuracion">Configurarla</a></p>`)}

        <label for="ai-prs">Pull Requests de Odoo</label>
        <textarea id="ai-prs" rows="3" spellcheck="false"
                  placeholder="${placeholder}">${analysis ? analysis.prsText : ''}</textarea>
        <div class="muted">Uno por línea: la dirección del PR o <code>dueño/repo#número</code>${
          github.defaultRepo ? raw(html`, o <code>#número</code> para ${github.defaultRepo}`) : ''}.</div>

        <div class="form-actions">
          <button type="button" class="btn" id="ai-run" ${ai.hasKey ? '' : raw('disabled')}>
            🤖 ${analysis ? 'Volver a analizar' : 'Analizar con IA'}</button>
          <button type="button" class="btn secondary" id="ai-cancel" hidden>Cancelar</button>
          <span class="ai-status" id="ai-status" hidden>
            <span class="spinner"></span><span id="ai-status-text"></span></span>
        </div>

        ${analysis ? raw(analysisHtml(run)) : ''}
      </div>`;
  }

  /** Resultado del análisis: resumen, qué se aplica, qué revisar y riesgos. */
  function analysisHtml(run) {
    const a = run.analysis;
    const byId = new Map(run.rows.map((row) => [row.id, row]));
    const descartadas = run.totalChanges - a.included.length - a.review.length;
    const usage = a.usage || {};

    const fila = (item, conPr) => {
      const row = byId.get(item.id) || { name: item.id, table: '', type: '', status: '' };
      return raw(html`
        <tr data-goto="${item.id}" title="Ver la diferencia en la grilla">
          <td>${objectName(row)}</td>
          <td>${row.type}</td>
          <td><span class="badge ${row.statusClass}">${row.status}</span></td>
          ${conPr ? raw(html`<td style="white-space:nowrap;">${item.pr}</td>`) : ''}
          <td class="det">${item.reason}</td>
        </tr>`);
    };
    const tabla = (items, conPr) => raw(html`
      <div class="table-wrap"><table class="ai-table">
        <thead><tr><th>Objeto</th><th>Tipo</th><th>Estado</th>
          ${conPr ? raw('<th>PR</th>') : ''}<th>Motivo</th></tr></thead>
        <tbody>${items.map((item) => fila(item, conPr))}</tbody>
      </table></div>`);
    const lista = (items) => raw(html`
      <ul class="ai-list">${items.map((text) => raw(html`<li>${text}</li>`))}</ul>`);
    const prs = a.prs.map((pr, i) => raw(html`${i ? ', ' : ''}<a href="${pr.url}"
      target="_blank" rel="noreferrer" title="${pr.title}">${pr.ref}</a>${
      pr.truncated ? ' (recortado)' : ''}`));

    const tokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)
      + (usage.output || 0);

    // Primero lo que hay que saber (qué se aplica y qué vigilar); el detalle
    // por PR queda plegado.
    return html`
      <div class="ai-result">
        <p class="muted">${formatDate(a.createdAt)} · ${a.model} · ${prs}
          · <strong>${a.included.length}</strong> a aplicar
          · <strong>${a.review.length}</strong> a revisar
          · ${descartadas} descartadas
          ${a.parts > 1 ? raw(html`· <span title="Con varias partes no se calcula lo esperado y no encontrado.">en ${a.parts} partes</span>`) : ''}
          · <span title="${usage.input} de entrada, ${usage.cacheRead} leídos de caché, ${usage.cacheWrite} escritos en caché, ${usage.output} de salida">${tokens.toLocaleString('es')} tokens</span></p>
        ${a.warnings.map((warning) => raw(html`<p class="notice">⚠ ${warning}</p>`))}

        <div class="ai-summary">${a.summary}</div>

        <div class="toolbar" style="margin-top:.85rem;">
          <button type="button" class="btn sm" id="ai-mark">☑ Marcar solo lo que eligió la IA</button>
          <button type="button" class="btn secondary sm" id="ai-script">📄 Ver script</button>
          <button type="button" class="btn secondary sm" id="ai-copy">📋 Copiar análisis</button>
        </div>

        <h3>A aplicar (${a.included.length})</h3>
        ${a.included.length
          ? tabla(a.included, true)
          : raw('<p class="muted">La IA no encontró diferencias que expliquen estos PRs.</p>')}

        ${a.review.length ? raw(html`
          <h3>A revisar (${a.review.length}) <span class="muted">· no entran en el script</span></h3>
          ${tabla(a.review, false)}`) : ''}

        ${a.risks.length ? raw(html`<h3>Riesgos</h3>${lista(a.risks)}`) : ''}

        ${a.missing.length ? raw(html`
          <h3>Esperado y no encontrado (${a.missing.length})</h3>
          <p class="muted">BD1 ya los tiene o BD2 no tiene el PR aplicado.</p>
          ${lista(a.missing.map((m) => `${m.pr} · ${m.object}: ${m.note}`))}`) : ''}

        ${a.prSummaries.length ? raw(html`
          <details class="ai-more">
            <summary>Cambios en la base por PR</summary>
            <ul class="ai-list">${a.prSummaries.map((pr) => raw(html`
              <li><strong>${pr.ref}</strong>: <span class="ai-pre">${pr.dbChanges}</span></li>`))}</ul>
          </details>`) : ''}
      </div>`;
  }

  /** El análisis en texto plano, para pegarlo en un ticket o un correo. */
  function analysisText(run) {
    const a = run.analysis;
    const byId = new Map(run.rows.map((row) => [row.id, row]));
    const linea = (item) => {
      const row = byId.get(item.id) || { name: item.id, table: '', type: '?', status: '?' };
      return `- [${row.type} · ${row.status}] ${objectName(row)}`
        + `${item.pr ? ` (${item.pr})` : ''}: ${item.reason}`;
    };
    const seccion = (title, lines) => (lines.length ? [title, ...lines, ''] : []);

    return [
      `Análisis con IA · ${run.db1Name} (destino) ← ${run.db2Name} (referencia)`,
      `${formatDate(a.createdAt)} · ${a.model} · PRs: ${a.prs.map((pr) => pr.ref).join(', ')}`,
      '',
      ...seccion('Avisos:', a.warnings.map((w) => `- ${w}`)),
      'Resumen:', a.summary, '',
      `A aplicar (${a.included.length}):`, ...a.included.map(linea), '',
      ...seccion(`A revisar (${a.review.length}):`, a.review.map(linea)),
      ...seccion('Riesgos:', a.risks.map((r) => `- ${r}`)),
      ...seccion('Esperado y no encontrado:',
        a.missing.map((m) => `- ${m.pr} · ${m.object}: ${m.note}`)),
      ...seccion('Cambios en la base por PR:',
        a.prSummaries.map((pr) => `- ${pr.ref}: ${pr.dbChanges}`)),
    ].join('\n').trim();
  }

  /** Botón "Re-ejecutar" de la cabecera. */
  function bindRerun(root, run) {
    const button = $('#rerun', root);
    if (!button) return;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const nuevo = await window.api.runs.rerun(run.id);
        notify(`Comparación repetida: ${nuevo.totalChanges} diferencia(s).`);
        window.App.navigate(`#/historial/${nuevo.id}`);
      } catch (error) {
        notify(error.message, 'error');
        button.disabled = false;
      }
    });
  }
})();
