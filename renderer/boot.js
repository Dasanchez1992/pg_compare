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

  // Aviso de versión nueva: banner arriba, con la descarga que toca a este
  // sistema y la opción de no volver a verlo para esa versión.
  window.api.updates.onAvailable((update) => {
    const descarga = update.asset
      ? html`<button class="btn sm" id="update-download">⬇ Descargar ${update.asset.name}</button>`
      : html`<button class="btn sm" id="update-download">Ver la descarga</button>`;

    const aviso = notify(html`
      <strong>Versión ${update.version} disponible</strong>
      <span class="muted">— tienes la ${window.App.version || 'actual'}</span>`,
    'update', { sticky: true, html: true });

    const acciones = document.createElement('span');
    acciones.className = 'msg-actions';
    acciones.innerHTML = html`${window.App.raw(descarga)}
      <button class="btn secondary sm" id="update-notes">Novedades</button>
      <button class="btn secondary sm" id="update-skip">Ahora no</button>`;
    aviso.querySelector('span').after(acciones);

    acciones.querySelector('#update-download').addEventListener('click', () => {
      window.api.updates.download(update.asset ? update.asset.url : update.url);
    });
    acciones.querySelector('#update-notes').addEventListener('click', () => {
      window.api.updates.download(update.url);
    });
    acciones.querySelector('#update-skip').addEventListener('click', () => {
      window.api.updates.skip(update.version);
      aviso.remove();
    });
  });

  // Barra de estado: dónde viven los datos y cómo se guardan las contraseñas.
  (async () => {
    try {
      const info = await window.api.info();
      window.App.version = info.version;
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
