'use strict';

/** Arranque de la interfaz: navegación, barra de estado y primera vista. */
(() => {
  const { $, html, notify, navigate, render } = window.App;

  // Enlaces internos: cualquier elemento con data-route navega.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-route]');
    if (!target) return;
    event.preventDefault();
    navigate(target.dataset.route);
  });

  window.addEventListener('hashchange', () => {
    window.App.clearMessages();
    render();
  });

  // Órdenes del menú nativo.
  window.api.onNavigate(navigate);
  window.api.onSaveScript(() => {
    const view = window.App.current;
    if (view && view.onSaveScript) view.onSaveScript();
    else notify('Abre una comparación con script generado para guardarlo.', 'error');
  });

  $('#open-data-dir').addEventListener('click', () => window.api.shell.openDataDir());

  // Barra de estado: dónde viven los datos y cómo se guardan las contraseñas.
  (async () => {
    try {
      const info = await window.api.info();
      $('#status-version').textContent = `v${info.version}`;
      $('#status-storage').innerHTML = info.encryption
        ? html`<span class="dot">●</span> Todo local · contraseñas cifradas con el llavero del sistema`
        : html`<span class="dot warn">●</span> Todo local · este sistema no tiene llavero:
               las contraseñas se guardan en texto plano`;
      if (info.loadError) notify(info.loadError, 'error', { sticky: true });
    } catch (error) {
      notify(`No se pudo leer el estado de la aplicación: ${error.message}`, 'error');
    }
  })();

  render();
})();
