'use strict';

/** Inicio (proyectos de comparación) y formulario de proyecto. */
(() => {
  const {
    html, raw, notify, navigate, route, formatDate, plural, $, $$,
  } = window.App;

  // --- Inicio: tarjetas de proyecto ------------------------------------

  route('/', async () => {
    const [projects, info] = await Promise.all([
      window.api.projects.list(),
      window.api.info(),
    ]);

    const cards = projects.map((p) => raw(html`
      <div class="pcard" data-id="${p.id}">
        <h3>${p.name}</h3>
        <div class="flow">
          <span class="chip dst">${p.db1Name || '(conexión borrada)'}</span>
          <span class="arrow">→</span>
          <span class="chip">${p.db2Name || '(conexión borrada)'}</span>
        </div>
        <div class="meta">
          ${plural(p.runCount, 'comparación', 'comparaciones')}
          ${p.lastRun ? raw(html`· última: ${formatDate(p.lastRun)}`) : ''}
        </div>
        <div class="actions">
          <button class="btn sm" data-action="compare">▶ Comparar</button>
          <a class="btn secondary sm" data-route="#/historial?project=${p.id}">Historial</a>
          <a class="btn secondary sm" data-route="#/proyectos/${p.id}/editar">✎ Editar</a>
          <button class="btn danger sm" data-action="delete">Eliminar</button>
        </div>
      </div>`));

    const empty = html`
      <div class="card">
        <h3 style="margin-top:0;">Empieza en 3 pasos</h3>
        <div class="steps">
          <div class="step">
            <div class="num">1</div>
            <strong>Registra tus conexiones</strong>
            <p class="muted">Agrega las bases PostgreSQL (host, puerto, usuario…).</p>
            <a class="btn secondary sm" data-route="#/conexiones/nueva">+ Conexión</a>
          </div>
          <div class="step">
            <div class="num">2</div>
            <strong>Crea un proyecto</strong>
            <p class="muted">Elige BD1 (destino) y BD2 (referencia) una sola vez.</p>
            <a class="btn secondary sm" data-route="#/proyectos/nuevo">+ Proyecto</a>
          </div>
          <div class="step">
            <div class="num">3</div>
            <strong>Compara</strong>
            <p class="muted">Pulsa "Comparar" y genera tu script ALTER.</p>
          </div>
        </div>
        <p class="muted" style="margin-top:1rem;">¿Solo una comparación rápida?
          Usa la <a data-route="#/comparar">comparación ad hoc</a>.</p>
      </div>`;

    return {
      html: html`
        <div class="hero">
          <h1>Comparador de Bases de Datos PostgreSQL</h1>
          <p>Compara estructura (columnas, índices y constraints) entre dos bases y
             genera el script <strong>ALTER</strong> para igualarlas.</p>
          <div class="stats">
            <div class="stat"><div class="n">${info.stats.projects}</div><div class="l">Proyectos</div></div>
            <div class="stat"><div class="n">${info.stats.connections}</div><div class="l">Conexiones</div></div>
            <div class="stat"><div class="n">${info.stats.runs}</div><div class="l">Comparaciones</div></div>
          </div>
        </div>

        <div class="toolbar">
          <h2 style="margin:0;">Proyectos de comparación</h2>
          <span class="muted">Configura el par de bases una vez y compara cuando quieras.</span>
          <span class="spacer"></span>
          <a class="btn secondary" data-route="#/comparar">Comparación ad hoc</a>
          <a class="btn" data-route="#/proyectos/nuevo">+ Nuevo proyecto</a>
        </div>

        ${projects.length ? raw(`<div class="card-grid">${cards.map((c) => c.__html).join('')}</div>`) : raw(empty)}`,

      mounted(root) {
        for (const card of $$('.pcard', root)) {
          const project = projects.find((p) => String(p.id) === card.dataset.id);

          $('[data-action="compare"]', card).addEventListener('click', (event) => {
            if (!project.db1Name || !project.db2Name) {
              notify('Este proyecto apunta a una conexión que ya no existe.', 'error');
              return;
            }
            window.App.runComparison({
              db1Id: project.db1Id, db2Id: project.db2Id, projectId: project.id,
            }, event.currentTarget);
          });

          $('[data-action="delete"]', card).addEventListener('click', async () => {
            const ok = await window.api.confirm({
              title: 'Eliminar proyecto',
              message: `¿Eliminar el proyecto "${project.name}"?`,
              detail: 'Sus comparaciones se conservan en el historial como ad hoc.',
            });
            if (!ok) return;
            await window.api.projects.remove(project.id);
            notify('Proyecto eliminado.');
            window.App.render();
          });
        }
      },
    };
  });

  // --- Alta y edición de proyectos -------------------------------------

  async function projectForm({ params }) {
    const editing = Boolean(params.id);
    const [connections, project] = await Promise.all([
      window.api.connections.list(),
      editing ? window.api.projects.get(params.id) : null,
    ]);

    if (editing && !project) throw new Error('Ese proyecto ya no existe.');
    if (connections.length < 2) {
      return html`
        <div class="card" style="max-width:600px;">
          <h1>${editing ? 'Editar proyecto' : 'Nuevo proyecto'}</h1>
          <p class="muted">Necesitas al menos dos conexiones registradas.</p>
          <div class="form-actions">
            <a class="btn" data-route="#/conexiones/nueva">+ Nueva conexión</a>
          </div>
        </div>`;
    }

    const options = window.App.connectionOptions;
    return {
      html: html`
        <div class="card" style="max-width:600px;">
          <h1>${editing ? 'Editar proyecto' : 'Nuevo proyecto'}</h1>
          <p class="muted">El script generado transforma <strong>BD1</strong> para igualar
             su estructura a <strong>BD2</strong>.</p>

          <label for="name">Nombre</label>
          <input id="name" type="text" value="${project ? project.name : ''}"
                 placeholder="QA contra Producción" autofocus>

          <label for="db1">BD1 (destino)</label>
          <select id="db1">${options(connections, project ? project.db1Id : connections[0].id)}</select>

          <label for="db2">BD2 (referencia)</label>
          <select id="db2">${options(connections, project ? project.db2Id : connections[1].id)}</select>

          <div class="form-actions">
            <button class="btn" id="save">Guardar</button>
            <a class="btn secondary" data-route="#/">Cancelar</a>
          </div>
        </div>`,

      mounted(root) {
        const save = async () => {
          try {
            await window.api.projects.save({
              id: project ? project.id : undefined,
              name: $('#name', root).value,
              db1Id: $('#db1', root).value,
              db2Id: $('#db2', root).value,
            });
            notify(editing ? 'Proyecto actualizado.' : 'Proyecto guardado.');
            navigate('#/');
          } catch (error) {
            notify(error.message, 'error');
          }
        };

        $('#save', root).addEventListener('click', save);
        $('#name', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      },
    };
  }

  route('/proyectos/nuevo', projectForm);
  route('/proyectos/:id/editar', projectForm);
})();
