'use strict';

/** Conexiones guardadas: listado, alta y edición. */
(() => {
  const { html, raw, notify, navigate, route, $, $$ } = window.App;

  route('/conexiones', async () => {
    const connections = await window.api.connections.list();

    const rows = connections.map((c) => raw(html`
      <tr data-id="${c.id}">
        <td><strong>${c.name}</strong></td>
        <td>${c.host}</td>
        <td>${c.port}</td>
        <td>${c.dbname}</td>
        <td>${c.user}</td>
        <td>${c.schema}</td>
        <td>${c.ssl ? raw('<span class="badge b-add">SSL</span>') : raw('<span class="muted">—</span>')}</td>
        <td style="white-space:nowrap; text-align:right;">
          <button class="btn secondary sm" data-action="test">🔌 Probar</button>
          <a class="btn secondary sm" data-route="#/conexiones/${c.id}/editar">✎ Editar</a>
          <button class="btn danger sm" data-action="delete">Eliminar</button>
        </td>
      </tr>`));

    const table = html`
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Nombre</th><th>Host</th><th>Puerto</th><th>Base</th>
                <th>Usuario</th><th>Esquema</th><th>SSL</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    return {
      html: html`
        <div class="card">
          <div class="toolbar">
            <h1 style="margin:0;">Conexiones registradas</h1>
            <span class="spacer"></span>
            <a class="btn" data-route="#/conexiones/nueva">+ Nueva conexión</a>
          </div>
          <p class="muted">Guarda tantas bases de datos como necesites y luego
             selecciónalas para comparar.</p>
          ${connections.length
            ? raw(table)
            : raw(html`<p>No hay conexiones aún.
                <a data-route="#/conexiones/nueva">Crea la primera</a>.</p>`)}
        </div>`,

      mounted(root) {
        for (const tr of $$('tbody tr', root)) {
          const conn = connections.find((c) => String(c.id) === tr.dataset.id);

          $('[data-action="test"]', tr).addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const original = button.textContent;
            button.disabled = true;
            button.textContent = 'Probando…';
            const result = await window.api.connections.test({ id: conn.id, ...conn });
            button.disabled = false;
            button.textContent = original;
            notify(`${conn.name}: ${result.message}`, result.ok ? 'success' : 'error');
          });

          $('[data-action="delete"]', tr).addEventListener('click', async () => {
            const ok = await window.api.confirm({
              title: 'Eliminar conexión',
              message: `¿Eliminar la conexión "${conn.name}"?`,
              detail: 'Se borrarán también los proyectos que la usen. '
                    + 'Las comparaciones del historial se conservan.',
            });
            if (!ok) return;
            const { deletedProjects } = await window.api.connections.remove(conn.id);
            notify(deletedProjects
              ? `Conexión eliminada (y ${deletedProjects} proyecto/s que la usaban).`
              : 'Conexión eliminada.');
            window.App.render();
          });
        }
      },
    };
  });

  // --- Formulario -------------------------------------------------------

  const FIELDS = [
    ['name', 'Nombre', 'text', "Alias para identificar la conexión, ej: 'Producción' o 'QA'."],
    ['host', 'Host', 'text', ''],
    ['port', 'Puerto', 'number', ''],
    ['dbname', 'Base de datos', 'text', ''],
    ['user', 'Usuario', 'text', ''],
    ['password', 'Contraseña', 'password', ''],
    ['schema', 'Esquema', 'text', "Esquema de PostgreSQL a comparar (por defecto 'public')."],
  ];

  const DEFAULTS = {
    name: '', host: 'localhost', port: 5432, dbname: '',
    user: '', password: '', schema: 'public', ssl: false,
  };

  async function connectionForm({ params }) {
    const editing = Boolean(params.id);
    const conn = editing ? await window.api.connections.get(params.id) : null;
    if (editing && !conn) throw new Error('Esa conexión ya no existe.');

    const values = { ...DEFAULTS, ...(conn || {}) };
    const info = await window.api.info();

    const inputs = FIELDS.map(([id, label, type, help]) => {
      const isPassword = id === 'password';
      const placeholder = isPassword && conn && conn.hasPassword ? '(sin cambios)' : '';
      return raw(html`
        <label for="${id}">${label}</label>
        <input id="${id}" type="${type}" value="${isPassword ? '' : values[id]}"
               placeholder="${placeholder}" autocomplete="off">
        ${help ? raw(html`<div class="muted">${help}</div>`) : ''}`);
    });

    return {
      html: html`
        <div class="card" style="max-width:600px;">
          <h1>${editing ? 'Editar conexión' : 'Nueva conexión'}</h1>
          ${inputs}
          <div class="check">
            <input id="ssl" type="checkbox" ${values.ssl ? raw('checked') : ''}>
            <label for="ssl">Conectar con SSL</label>
          </div>
          <div class="muted">Actívalo si el servidor exige conexiones cifradas.</div>

          <div class="form-actions">
            <button class="btn" id="save">Guardar</button>
            <button class="btn secondary" id="test">🔌 Probar conexión</button>
            <a class="btn secondary" data-route="#/conexiones">Cancelar</a>
          </div>
          <p class="muted" style="margin-top:.5rem;">
            "Probar conexión" verifica los datos ingresados sin guardar todavía.
            ${info.encryption
              ? 'La contraseña se guarda cifrada con el llavero del sistema.'
              : raw('<strong>Aviso:</strong> este sistema no ofrece llavero, '
                  + 'la contraseña se guardará en texto plano.')}
          </p>
        </div>`,

      mounted(root) {
        const readForm = () => ({
          id: conn ? conn.id : undefined,
          ...Object.fromEntries(FIELDS.map(([id]) => [id, $(`#${id}`, root).value])),
          ssl: $('#ssl', root).checked,
        });

        $('#test', root).addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = 'Probando…';
          try {
            const result = await window.api.connections.test(readForm());
            notify(result.message, result.ok ? 'success' : 'error');
          } catch (error) {
            notify(error.message, 'error');
          } finally {
            button.disabled = false;
            button.textContent = '🔌 Probar conexión';
          }
        });

        $('#save', root).addEventListener('click', async () => {
          try {
            await window.api.connections.save(readForm());
            notify(editing ? 'Conexión actualizada.' : 'Conexión guardada.');
            navigate('#/conexiones');
          } catch (error) {
            notify(error.message, 'error');
          }
        });

        $('#name', root).focus();
      },
    };
  }

  route('/conexiones/nueva', connectionForm);
  route('/conexiones/:id/editar', connectionForm);
})();
