'use strict';

/** Historial de comparaciones guardadas. */
(() => {
  const { html, raw, notify, route, formatDate, $, $$ } = window.App;

  route('/historial', async ({ query }) => {
    const projectId = query.get('project');
    const [runs, project] = await Promise.all([
      window.api.runs.list(projectId ? { projectId } : {}),
      projectId ? window.api.projects.get(projectId) : null,
    ]);

    const rows = runs.map((run) => raw(html`
      <tr data-id="${run.id}">
        <td>${formatDate(run.createdAt)}</td>
        <td>${run.projectName || raw('<span class="muted">ad hoc</span>')}</td>
        <td>${run.db1Name}</td>
        <td>${run.db2Name}</td>
        <td>${run.totalChanges}</td>
        <td>${run.hasScript
          ? raw(html`<span class="badge b-add">generado (${run.selectedCount})</span>`)
          : raw('<span class="muted">—</span>')}</td>
        <td style="white-space:nowrap; text-align:right;">
          <a class="btn secondary sm" data-route="#/historial/${run.id}">Ver</a>
          ${run.canRerun
            ? raw('<button class="btn secondary sm" data-action="rerun" title="Repetir">🔄</button>')
            : ''}
          ${run.hasScript
            ? raw('<button class="btn secondary sm" data-action="save">⬇ .sql</button>')
            : ''}
          <button class="btn danger sm" data-action="delete">Eliminar</button>
        </td>
      </tr>`));

    const table = html`
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Fecha</th><th>Proyecto</th><th>BD1 (destino)</th><th>BD2 (referencia)</th>
                <th>Diferencias</th><th>Script</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    return {
      html: html`
        <div class="card">
          <div class="toolbar">
            <h1 style="margin:0;">Historial de comparaciones${project
              ? raw(html` <span class="muted">— ${project.name}</span>`) : ''}</h1>
            <span class="spacer"></span>
            ${project ? raw('<button class="btn" id="run-project">▶ Comparar ahora</button>') : ''}
            <a class="btn secondary" data-route="#/comparar">+ Nueva (ad hoc)</a>
          </div>
          ${project
            ? raw(html`<p class="muted">Mostrando solo comparaciones del proyecto
                <strong>${project.name}</strong>.
                <a data-route="#/historial">Ver todo el historial</a></p>`)
            : raw('<p class="muted">Cada comparación queda guardada aquí para consultarla '
                + 'o regenerar su script cuando quieras.</p>')}
          ${runs.length
            ? raw(table)
            : raw(html`<p>Aún no hay comparaciones guardadas.
                <a data-route="#/comparar">Ejecuta la primera</a>.</p>`)}
        </div>`,

      mounted(root) {
        const runProject = $('#run-project', root);
        if (runProject) {
          runProject.addEventListener('click', (event) => window.App.runComparison({
            db1Id: project.db1Id, db2Id: project.db2Id, projectId: project.id,
          }, event.currentTarget));
        }

        for (const tr of $$('tbody tr', root)) {
          const run = runs.find((r) => String(r.id) === tr.dataset.id);

          const rerun = $('[data-action="rerun"]', tr);
          if (rerun) {
            rerun.addEventListener('click', async (event) => {
              const button = event.currentTarget;
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

          const save = $('[data-action="save"]', tr);
          if (save) {
            save.addEventListener('click', () => window.App.saveScriptFile(run.id));
          }

          $('[data-action="delete"]', tr).addEventListener('click', async () => {
            const ok = await window.api.confirm({
              title: 'Eliminar comparación',
              message: `¿Eliminar la comparación ${run.db1Name} vs ${run.db2Name}?`,
              detail: `Del ${formatDate(run.createdAt)}. Se borra también su script generado.`,
            });
            if (!ok) return;
            await window.api.runs.remove(run.id);
            notify('Comparación eliminada del historial.');
            window.App.render();
          });
        }
      },
    };
  });

  /** Guarda el script de una comparación con el diálogo del sistema. */
  window.App.saveScriptFile = async (runId) => {
    try {
      const result = await window.api.runs.saveSql(runId);
      if (!result.saved) return;
      const aviso = notify(`Script guardado en ${result.path}`, 'success', { sticky: true });
      const link = document.createElement('button');
      link.className = 'btn secondary sm';
      link.textContent = 'Mostrar en carpeta';
      link.style.marginLeft = '.6rem';
      link.addEventListener('click', () => window.api.shell.showFile(result.path));
      aviso.querySelector('span').appendChild(link);
      setTimeout(() => aviso.remove(), 15000);
    } catch (error) {
      notify(error.message, 'error');
    }
  };
})();
