'use strict';

/**
 * Cifrado de las contraseñas de las conexiones.
 *
 * Usa `safeStorage` de Electron, que delega en el llavero del sistema
 * (Keychain en macOS, DPAPI en Windows, libsecret/kwallet en Linux): la
 * contraseña queda ilegible fuera de la cuenta de usuario que la guardó.
 *
 * Si el sistema no ofrece llavero (Linux sin servicio de secretos), se
 * guarda en claro y `available` queda en false para poder avisarlo en la
 * interfaz, igual que hacía la versión anterior de la app.
 */

function createCipher(safeStorage, logger = null) {
  let available = false;
  try {
    available = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    available = false;
  }

  if (!available && logger) {
    logger.info(
      'El sistema no ofrece llavero: las contraseñas se guardarán en texto plano.',
    );
  }

  return {
    available,

    encrypt(text) {
      const value = String(text ?? '');
      if (!value) return { enc: 'plain', value: '' };
      if (!available) return { enc: 'plain', value };
      try {
        return { enc: 'safe', value: safeStorage.encryptString(value).toString('base64') };
      } catch (error) {
        if (logger) logger.error(`No se pudo cifrar la contraseña: ${error.message}`);
        return { enc: 'plain', value };
      }
    },

    decrypt(blob) {
      if (!blob) return '';
      if (typeof blob === 'string') return blob;       // formato antiguo
      if (blob.enc === 'plain') return blob.value || '';
      if (blob.enc !== 'safe') return '';
      try {
        return safeStorage.decryptString(Buffer.from(blob.value, 'base64'));
      } catch (error) {
        // Pasa si se copian los datos a otra máquina o a otro usuario.
        if (logger) logger.error(`No se pudo descifrar una contraseña: ${error.message}`);
        return '';
      }
    },
  };
}

module.exports = { createCipher };
