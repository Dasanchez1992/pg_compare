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

  // --- Versiones nuevas -------------------------------------------------
  // El aviso sale arriba. Si esta copia se puede actualizar sola, el botón
  // principal descarga e instala; si no, abre la descarga en el navegador.
  let avisoVersion = null;
  const megas = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

  /** Descarga e instala, con el progreso en el propio aviso. */
  async function instalar(update, aviso) {
    const texto = $('span', aviso);
    const acciones = $('.msg-actions', aviso);
    if (acciones) acciones.hidden = true;
    texto.innerHTML = html`<strong>Descargando la versión ${update.version}…</strong>
      <span class="update-progress"><span></span></span> <span class="muted" id="update-bytes"></span>`;

    const dejarDeEscuchar = window.api.updates.onProgress(({ received, total }) => {
      if (total) $('.update-progress > span', aviso).style.width = `${(100 * received) / total}%`;
      $('#update-bytes', aviso).textContent = total
        ? `${megas(received)} de ${megas(total)}` : megas(received);
    });

    try {
      const result = await window.api.updates.install();
      texto.innerHTML = result.restarting
        ? html`<strong>Instalando la versión ${update.version}…</strong>
            <span class="muted">la aplicación se cerrará y volverá a abrirse sola.</span>`
        : html`<strong>Versión ${update.version} descargada.</strong>
            <span class="muted">Termina la instalación en el instalador del sistema que se acaba
            de abrir y vuelve a abrir la aplicación.</span>`;
    } catch (error) {
      texto.innerHTML = html`<strong>No se pudo instalar la versión ${update.version}.</strong>
        <span class="muted">${error.message}</span>`;
      if (acciones) acciones.hidden = false;
    } finally {
      dejarDeEscuchar();
    }
  }

  /** Pinta el aviso de versión nueva; `auto` lo instala sin esperar. */
  function avisarVersion(update, { auto = false } = {}) {
    if (avisoVersion) avisoVersion.remove();
    const principal = update.canInstall
      ? html`<button class="btn sm" id="update-install">⬇ Descargar e instalar</button>`
      : update.asset
        ? html`<button class="btn sm" id="update-install">⬇ Descargar ${update.asset.name}</button>`
        : html`<button class="btn sm" id="update-install">Ver la descarga</button>`;

    const aviso = notify(html`
      <strong>Versión ${update.version} disponible</strong>
      <span class="muted">— tienes la ${window.App.version || 'actual'}</span>`,
    'update', { sticky: true, html: true });
    avisoVersion = aviso;

    const acciones = document.createElement('span');
    acciones.className = 'msg-actions';
    acciones.innerHTML = html`${window.App.raw(principal)}
      <button class="btn secondary sm" id="update-notes">Novedades</button>
      <button class="btn secondary sm" id="update-skip">Ahora no</button>`;
    aviso.querySelector('span').after(acciones);

    acciones.querySelector('#update-install').addEventListener('click', () => {
      if (update.canInstall) instalar(update, aviso);
      else window.api.updates.download(update.asset ? update.asset.url : update.url);
    });
    acciones.querySelector('#update-notes').addEventListener('click', () => {
      window.api.updates.download(update.url);
    });
    acciones.querySelector('#update-skip').addEventListener('click', () => {
      window.api.updates.skip(update.version);
      aviso.remove();
    });

    if (auto && update.canInstall) instalar(update, aviso);
  }

  // Comprobación periódica del proceso principal: solo avisa.
  let comprobando = false;
  window.api.updates.onAvailable((update) => {
    if (!comprobando) avisarVersion(update);
  });

  // Botón de la cabecera: comprueba y, si hay versión nueva, la instala.
  $('#check-updates').addEventListener('click', async (event) => {
    const boton = event.currentTarget;
    boton.disabled = true;
    comprobando = true;
    try {
      const result = await window.api.updates.check();
      if (!result || result.upToDate) {
        notify(`Ya tienes la última versión (${(result && result.version) || window.App.version}).`);
      } else {
        avisarVersion(result, { auto: true });
      }
    } catch (error) {
      notify(`No se pudo comprobar si hay versiones nuevas: ${error.message}`, 'error');
    } finally {
      comprobando = false;
      boton.disabled = false;
    }
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
