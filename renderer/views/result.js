'use strict';

/** Resultado de una comparación: grilla de diferencias y script ALTER. */
(() => {
  const {
    html, raw, notify, route, formatDate, highlight, copyText, $, $$,
  } = window.App;

  route('/historial/:id', async ({ params }) => {
    const run = await window.api.runs.get(params.id);
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

    const filas = run.rows.map((item) => raw(html`
      <tr data-id="${item.id}" data-name="${item.name.toLowerCase()}"
          data-table="${item.table.toLowerCase()}"
          data-type="${item.type}" data-status="${item.status}">
        <td class="check-cell">
          <input type="checkbox" style="width:auto;" ${selected.has(item.id) ? raw('checked') : ''}>
        </td>
        <td>${item.name}</td>
        <td>${item.type}</td>
        <td><span class="badge ${item.statusClass}">${item.status}</span></td>
        <td>${item.table}</td>
        <td><span class="muted det">${item.detail}</span></td>
      </tr>`));

    return {
      html: html`
        ${raw(cabecera)}

        <div class="card">
          <div class="toolbar">
            <strong>Objetos</strong>
            <span class="muted" id="visible-count"></span>
            <span class="spacer"></span>
            <button type="button" class="btn secondary" id="check-all">Marcar todo</button>
            <button type="button" class="btn secondary" id="uncheck-all">Desmarcar todo</button>
            <button type="button" class="btn secondary" id="show-script"
                    ${run.hasScript ? '' : raw('hidden')}>📄 Ver script guardado</button>
            <button type="button" class="btn" id="generate">⚙ Generar script</button>
          </div>

          <div class="grid-wrap">
            <table class="grid" id="grid">
              <thead>
                <tr>
                  <th style="width:2rem;"><input type="checkbox" id="check-header"></th>
                  <th>Nombre</th><th>Tipo</th><th>Estado</th>
                  <th>Tabla / Esquema</th><th>Detalle</th>
                </tr>
                <tr class="filters">
                  <th></th>
                  <th><input type="text" id="f-name" placeholder="Filtrar por nombre..."></th>
                  <th>
                    <select id="f-type">
                      <option value="">(todos)</option>
                      <option>Tabla</option><option>Columna</option>
                      <option>Índice</option><option>Constraint</option>
                      <option>Vista</option><option>Secuencia</option>
                      <option>Función</option><option>Trigger</option>
                    </select>
                  </th>
                  <th>
                    <select id="f-status">
                      <option value="">(todos)</option>
                      <option>Nuevo</option><option>Diferente</option><option>Sobra</option>
                    </select>
                  </th>
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
        const visibleRows = () => rowsEls.filter((tr) => tr.style.display !== 'none');

        const setAll = (state) => {
          for (const tr of visibleRows()) {
            $('input[type=checkbox]', tr).checked = state;
          }
          $('#check-header', root).checked = state;
        };

        $('#check-all', root).addEventListener('click', () => setAll(true));
        $('#uncheck-all', root).addEventListener('click', () => setAll(false));
        $('#check-header', root).addEventListener('click', (e) => setAll(e.currentTarget.checked));

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
          let visible = 0;

          for (const tr of rowsEls) {
            const ok = (!name || tr.dataset.name.includes(name))
              && (!table || tr.dataset.table.includes(table))
              && (!type || tr.dataset.type === type)
              && (!status || tr.dataset.status === status);
            tr.style.display = ok ? '' : 'none';
            if (ok) visible += 1;
          }
          $('#visible-count', root).textContent = `${visible} objeto(s)`;
        };

        for (const id of ['f-name', 'f-table', 'f-type', 'f-status']) {
          $(`#${id}`, root).addEventListener('input', applyFilters);
        }
        applyFilters();

        // --- Modal del script -------------------------------------------
        const openModal = () => {
          scriptEl.textContent = script;
          highlight(scriptEl);
          modal.classList.add('open');
        };
        const closeModal = () => modal.classList.remove('open');

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
        $('#generate', root).addEventListener('click', async (event) => {
          const button = event.currentTarget;
          const selectedIds = rowsEls
            .filter((tr) => $('input[type=checkbox]', tr).checked)
            .map((tr) => tr.dataset.id);

          button.disabled = true;
          try {
            const updated = await window.api.runs.script({ id: run.id, selectedIds });
            script = updated.script;
            hasScript = true;
            run.hasScript = true;
            $('#show-script', root).hidden = false;
            $('#script-title', root).textContent =
              `Script ALTER completo (${selectedIds.length} cambio${selectedIds.length === 1 ? '' : 's'})`;
            openModal();
          } catch (error) {
            notify(error.message, 'error');
          } finally {
            button.disabled = false;
          }
        });

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
        if (hasScript) {
          $('#script-title', root).textContent =
            `Script ALTER completo (${run.selectedIds.length} cambio${run.selectedIds.length === 1 ? '' : 's'})`;
        }
      },
    };
  });

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
