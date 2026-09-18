# -*- mode: python ; coding: utf-8 -*-
"""Empaqueta el backend Django en un binario autónomo.

    cd desktop && npm run build:backend

Genera `desktop/dist-backend/pgcompare-backend/`, que electron-builder copia
dentro de la app como `resources/backend/`. Así el usuario final no necesita
tener Python ni instalar dependencias.
"""
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

SPEC_DIR = Path(SPECPATH).resolve()          # desktop/build
REPO_ROOT = SPEC_DIR.parent.parent           # raíz del repositorio
ENTRY = REPO_ROOT / "dbcompare" / "desktop_server.py"

# Plantillas y estáticos propios (PyInstaller no los detecta solo).
datas = [
    (str(REPO_ROOT / "comparator" / "templates"), "comparator/templates"),
    (str(REPO_ROOT / "comparator" / "static"), "comparator/static"),
]
# Plantillas/estáticos de Django (incluye el admin) y traducciones.
datas += collect_data_files("django")

# Módulos que Django importa por nombre en tiempo de ejecución.
hiddenimports = [
    "dbcompare.settings",
    "dbcompare.urls",
    "dbcompare.wsgi",
    "dbcompare.desktop_middleware",
    "comparator",
    "comparator.apps",
    "comparator.admin",
    "comparator.forms",
    "comparator.models",
    "comparator.urls",
    "comparator.views",
    "comparator.templatetags.dict_extras",
    "psycopg2",
    "waitress",
    "whitenoise",
    "whitenoise.middleware",
]
for package in (
    "comparator.migrations",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.messages",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "django.core.management",
    "django.db.backends.sqlite3",
    "django.template.loaders",
):
    hiddenimports += collect_submodules(package)

a = Analysis(
    [str(ENTRY)],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "test", "unittest", "pydoc_data"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="pgcompare-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,          # sin ventana propia: Electron lo lanza con windowsHide
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="pgcompare-backend",
)
