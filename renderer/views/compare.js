'use strict';

/** Comparación ad hoc: elegir dos bases y comparar. */
(() => {
  const { html, raw, esc, notify, navigate, route, $ } = window.App;

  /**
   * Ejecuta una comparación mostrando el progreso y abre su resultado.
   * La usan también las tarjetas de proyecto y el historial.
   */
  async function runComparison({ db1Id, db2Id, projectId = null }, button = null) {
    const aviso = notify('Conectando…', 'success', { sticky: true });
    const texto = aviso.querySelector('span');
    const stop = window.api.onProgress((message) => { texto.textContent = message; });
    if (button) button.disabled = true;

    try {
      const run = await window.api.runs.compare({ db1Id, db2Id, projectId });
      aviso.remove();
      notify(`Comparación lista: ${run.totalChanges} diferencia(s).`);
      navigate(`#/historial/${run.id}`);
      return run;
    } catch (error) {
      aviso.remove();
      notify(error.message, 'error');
      return null;
    } finally {
      stop();
      if (button) button.disabled = false;
    }
  }

  /** <option> de cada conexión guardada. */
  function options(connections, selected) {
    return connections.map((c) => raw(
      `<option value="${c.id}"${String(c.id) === String(selected) ? ' selected' : ''}>`
      + `${esc(c.name)} — ${esc(c.user)}@${esc(c.host)}:${esc(c.port)}/${esc(c.dbname)}`
      + '</option>',
    ));
  }

  route('/comparar', async () => {
    const connections = await window.api.connections.list();

    if (connections.length < 2) {
      return html`
        <div class="card" style="max-width:700px;">
          <h1>Comparar bases de datos</h1>
          <p class="muted">Necesitas al menos dos conexiones registradas para comparar.</p>
          <div class="form-actions">
            <a class="btn" data-route="#/conexiones/nueva">+ Nueva conexión</a>
            <a class="btn secondary" data-route="#/conexiones">Ver conexiones</a>
          </div>
        </div>`;
    }

    return {
      html: html`
        <div class="card" style="max-width:700px;">
          <h1>Comparar bases de datos</h1>
          <p class="muted">
            Se comparan columnas, índices y constraints. El script ALTER resultante
            transforma <strong>BD1</strong> para que su estructura quede igual a <strong>BD2</strong>.
          </p>
          <label for="db1">BD1 — Destino (se modificará para igualar a BD2)</label>
          <select id="db1">${options(connections, connections[0].id)}</select>

          <label for="db2">BD2 — Referencia (estructura deseada)</label>
          <select id="db2">${options(connections, connections[1].id)}</select>

          <div class="form-actions">
            <button class="btn" id="run">Comparar →</button>
          </div>
        </div>`,

      mounted(root) {
        $('#run', root).addEventListener('click', (event) => {
          const db1Id = $('#db1', root).value;
          const db2Id = $('#db2', root).value;
          if (db1Id === db2Id) {
            notify('Selecciona dos bases de datos distintas.', 'error');
            return;
          }
          runComparison({ db1Id, db2Id }, event.currentTarget);
        });
      },
    };
  });

  window.App.runComparison = runComparison;
  window.App.connectionOptions = options;
})();
