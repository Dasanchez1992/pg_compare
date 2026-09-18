#!/usr/bin/env node
'use strict';

/**
 * Construye el backend Django como binario autónomo con PyInstaller.
 * Se ejecuta antes de electron-builder (`npm run dist`).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..');
const DIST_DIR = path.join(DESKTOP_DIR, 'dist-backend');
const WORK_DIR = path.join(DESKTOP_DIR, 'build', '.pyinstaller');
const SPEC = path.join(DESKTOP_DIR, 'build', 'backend.spec');

const isWindows = process.platform === 'win32';

function findPython() {
  const candidates = [
    process.env.PGCOMPARE_PYTHON,
    path.join(REPO_ROOT, '.venv', isWindows ? 'Scripts/python.exe' : 'bin/python'),
    path.join(REPO_ROOT, 'venv', isWindows ? 'Scripts/python.exe' : 'bin/python'),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found || (isWindows ? 'python' : 'python3');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status;
}

const python = findPython();
console.log(`> Python: ${python}`);

const check = spawnSync(python, ['-m', 'PyInstaller', '--version'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error(
    '\nFalta PyInstaller en ese intérprete.\n'
    + `Instálalo con:  ${python} -m pip install -r requirements-desktop.txt\n`
    + 'O indica otro intérprete con la variable PGCOMPARE_PYTHON.\n',
  );
  process.exit(1);
}
console.log(`> PyInstaller ${String(check.stdout).trim()}`);

fs.rmSync(DIST_DIR, { recursive: true, force: true });

const status = run(python, [
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--distpath', DIST_DIR,
  '--workpath', WORK_DIR,
  SPEC,
], { cwd: REPO_ROOT });

if (status !== 0) {
  console.error('\nPyInstaller terminó con errores.');
  process.exit(status || 1);
}

const exe = path.join(DIST_DIR, 'pgcompare-backend', isWindows ? 'pgcompare-backend.exe' : 'pgcompare-backend');
if (!fs.existsSync(exe)) {
  console.error(`\nNo se generó el binario esperado: ${exe}`);
  process.exit(1);
}

console.log(`\n✔ Backend listo: ${exe}`);
