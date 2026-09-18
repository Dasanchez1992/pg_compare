'use strict';

const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

const DEFAULTS = { width: 1280, height: 860 };
const MIN = { width: 940, height: 620 };

/** Recuerda tamaño/posición de la ventana entre ejecuciones. */
function createWindowState(userDataDir) {
  const file = path.join(userDataDir, 'window-state.json');

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };

  const saved = read();
  const state = {
    width: Math.max(saved.width || DEFAULTS.width, MIN.width),
    height: Math.max(saved.height || DEFAULTS.height, MIN.height),
    x: saved.x,
    y: saved.y,
    maximized: Boolean(saved.maximized),
  };

  // Si la pantalla donde estaba ya no existe (portátil desconectado del
  // monitor externo), la posición guardada dejaría la ventana fuera de vista.
  if (Number.isInteger(state.x) && Number.isInteger(state.y)) {
    const visible = screen.getAllDisplays().some(({ workArea }) => (
      state.x + state.width > workArea.x
      && state.y + state.height > workArea.y
      && state.x < workArea.x + workArea.width
      && state.y < workArea.y + workArea.height
    ));
    if (!visible) {
      delete state.x;
      delete state.y;
    }
  }

  return {
    bounds: state,
    minimum: MIN,
    /** Engancha los eventos que persisten el estado de la ventana. */
    track(win) {
      const save = () => {
        if (win.isDestroyed()) return;
        const maximized = win.isMaximized();
        const bounds = maximized ? win.getNormalBounds() : win.getBounds();
        try {
          fs.writeFileSync(file, JSON.stringify({ ...bounds, maximized }, null, 2));
        } catch {
          // Si no se puede guardar, la próxima vez abrirá con el tamaño por defecto.
        }
      };

      let timer = null;
      const debounced = () => {
        clearTimeout(timer);
        timer = setTimeout(save, 400);
      };

      win.on('resize', debounced);
      win.on('move', debounced);
      win.on('maximize', save);
      win.on('unmaximize', save);
      win.on('close', () => {
        clearTimeout(timer);
        save();
      });
    },
  };
}

module.exports = { createWindowState };
