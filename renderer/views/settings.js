'use strict';

/** Configuración del análisis con IA: clave de Claude y acceso a GitHub. */
(() => {
  const { html, raw, notify, route, $ } = window.App;

  // Modelos que se ofrecen, el recomendado primero.
  const MODELS = [
    ['claude-opus-5-5', 'Claude Opus 5.5 (recomendado: el más preciso para filtrar)'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (más rápido y barato)'],
    ['claude-fable-5-1', 'Claude Fable 5.1 (el más capaz, y el más caro)'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5 (muy barato; para comparaciones sencillas)'],
  ];

  route('/configuracion', async () => {
    const [settings, info] = await Promise.all([window.api.settings.get(), window.api.info()]);
    const { ai, github } = settings;

    const models = MODELS.some(([id]) => id === ai.model)
      ? MODELS : [[ai.model, ai.model], ...MODELS];
    const options = models.map(([id, label]) => raw(html`
      <option value="${id}" ${id === ai.model ? raw('selected') : ''}>${label}</option>`));

    return {
      html: html`
        <div class="card" style="max-width:680px;">
          <h1>Configuración</h1>
          <p class="muted">El <strong>análisis con IA</strong> lee unos Pull Requests de
            GitHub y deja marcadas solo las diferencias que esos PRs explican, con el
            script listo. Necesita una clave de la API de Claude y, si los repositorios
            son privados, un token de GitHub.</p>

          <h2 style="margin-top:1.5rem;">Claude (Anthropic)</h2>
          <label for="ai-key">Clave de la API</label>
          <input id="ai-key" type="password" autocomplete="off"
                 placeholder="${ai.hasKey ? '(guardada; escribe otra para cambiarla)' : 'sk-ant-…'}">
          <div class="muted">Se crea en la consola de Anthropic, en <em>API Keys</em>.
            Cada análisis consume tokens de esa cuenta.</div>
          ${ai.hasKey ? raw(html`
            <div class="check">
              <input id="ai-clear" type="checkbox">
              <label for="ai-clear">Borrar la clave guardada</label>
            </div>`) : ''}

          <label for="ai-model">Modelo</label>
          <select id="ai-model">${options}</select>

          <div class="form-actions">
            <button class="btn secondary" id="test-ai">🔌 Probar clave</button>
          </div>

          <h2 style="margin-top:1.75rem;">GitHub</h2>
          <label for="gh-user">Usuario</label>
          <input id="gh-user" type="text" autocomplete="off" value="${github.user}"
                 placeholder="tu-usuario">
          <label for="gh-token">Token de acceso</label>
          <input id="gh-token" type="password" autocomplete="off"
                 placeholder="${github.hasToken ? '(guardado; escribe otro para cambiarlo)' : 'github_pat_… o ghp_…'}">
          <div class="muted">Token personal con permiso de <strong>lectura</strong> de
            <em>Pull requests</em> y <em>Contents</em> en los repositorios de las
            integraciones. Sin token solo se leen repositorios públicos.</div>
          ${github.hasToken ? raw(html`
            <div class="check">
              <input id="gh-clear" type="checkbox">
              <label for="gh-clear">Borrar el token guardado</label>
            </div>`) : ''}
          <label for="gh-repo">Repositorio por defecto</label>
          <input id="gh-repo" type="text" autocomplete="off" value="${github.defaultRepo}"
                 placeholder="empresa/odoo-integraciones">
          <div class="muted">Opcional. Con él basta escribir <code>#123</code> para
            referirse a un PR de ese repositorio.</div>

          <div class="form-actions">
            <button class="btn secondary" id="test-gh">🔌 Probar GitHub</button>
          </div>

          <div class="form-actions" style="margin-top:1.75rem;">
            <button class="btn" id="save">Guardar</button>
          </div>
          <p class="muted" style="margin-top:.5rem;">
            ${info.encryption
              ? 'La clave y el token se guardan cifrados con el llavero del sistema.'
              : raw('<strong>Aviso:</strong> este sistema no ofrece llavero: la clave y '
                  + 'el token se guardarán en texto plano.')}
            Al analizar se envían a Anthropic las diferencias de la comparación y el
            código de los PRs; nunca los datos de las tablas.
          </p>
        </div>`,

      mounted(root) {
        const value = (id) => $(`#${id}`, root).value;
        const checked = (id) => Boolean($(`#${id}`, root) && $(`#${id}`, root).checked);

        /** Botón "Probar": se deshabilita mientras dura y avisa del resultado. */
        const tester = (buttonId, run) => {
          const button = $(`#${buttonId}`, root);
          button.addEventListener('click', async () => {
            const original = button.textContent;
            button.disabled = true;
            button.textContent = 'Probando…';
            try {
              const result = await run();
              notify(result.message, result.ok ? 'success' : 'error');
            } catch (error) {
              notify(error.message, 'error');
            } finally {
              button.disabled = false;
              button.textContent = original;
            }
          });
        };

        tester('test-ai', () => window.api.settings.testAi({
          apiKey: value('ai-key'), model: value('ai-model'),
        }));
        tester('test-gh', () => window.api.settings.testGithub({
          user: value('gh-user'), token: value('gh-token'),
        }));

        $('#save', root).addEventListener('click', async () => {
          try {
            await window.api.settings.save({
              aiApiKey: value('ai-key'),
              aiModel: value('ai-model'),
              clearAiKey: checked('ai-clear'),
              githubUser: value('gh-user'),
              githubToken: value('gh-token'),
              githubDefaultRepo: value('gh-repo'),
              clearGithubToken: checked('gh-clear'),
            });
            notify('Configuración guardada.');
            window.App.render();
          } catch (error) {
            notify(error.message, 'error');
          }
        });
      },
    };
  });
})();
