"""Configuración de Django para el proyecto dbcompare.

El proyecto se puede ejecutar de dos formas:

* **Web** (``python manage.py runserver``): comportamiento clásico, los datos
  viven junto al código (``db.sqlite3`` en la raíz del repositorio).
* **Escritorio** (app Electron, ver ``desktop/``): se activa con la variable
  de entorno ``PGCOMPARE_DESKTOP=1``. La base interna, los archivos estáticos
  y la clave secreta se guardan en la carpeta de datos del usuario
  (``PGCOMPARE_DATA_DIR``), porque la app empaquetada es de solo lectura.
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path


def _flag(name: str, default: bool = False) -> bool:
    """Lee una variable de entorno booleana ('1', 'true', 'yes', 'on')."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# Raíz del código. Con PyInstaller el código se descomprime en una carpeta
# temporal (``sys._MEIPASS``), así que no se puede usar ``__file__``.
if getattr(sys, "frozen", False):
    BASE_DIR = Path(getattr(sys, "_MEIPASS", None) or Path(sys.executable).parent)
else:
    BASE_DIR = Path(__file__).resolve().parent.parent

# Modo escritorio: lo activa el proceso principal de Electron.
DESKTOP_MODE = _flag("PGCOMPARE_DESKTOP")

# Carpeta de datos escribible (BD interna, estáticos, clave, logs).
DATA_DIR = Path(os.environ.get("PGCOMPARE_DATA_DIR") or BASE_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _secret_key_from(path: Path) -> str:
    """Devuelve la clave guardada en ``path``, creándola la primera vez."""
    try:
        key = path.read_text(encoding="utf-8").strip()
        if key:
            return key
    except OSError:
        pass
    key = secrets.token_urlsafe(64)
    path.write_text(key, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:  # sistemas de archivos sin permisos POSIX (Windows)
        pass
    return key


if DESKTOP_MODE:
    # Clave por instalación, generada al primer arranque.
    SECRET_KEY = os.environ.get("PGCOMPARE_SECRET_KEY") or _secret_key_from(
        DATA_DIR / "secret_key.txt"
    )
else:
    # ⚠️ Cambia esta clave en producción y no la subas al repositorio.
    SECRET_KEY = os.environ.get(
        "PGCOMPARE_SECRET_KEY", "django-insecure-cambia-esta-clave-en-produccion"
    )

DEBUG = _flag("PGCOMPARE_DEBUG", default=not DESKTOP_MODE)

if DESKTOP_MODE:
    ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]"]
    _port = os.environ.get("PGCOMPARE_PORT")
    if _port:
        CSRF_TRUSTED_ORIGINS = [
            f"http://127.0.0.1:{_port}",
            f"http://localhost:{_port}",
        ]
    # Cookies propias: en localhost el navegador no separa por puerto, así
    # evitamos pisarnos con otra app Django que corra en la misma máquina.
    SESSION_COOKIE_NAME = "pgcompare_sessionid"
    CSRF_COOKIE_NAME = "pgcompare_csrftoken"
    SESSION_COOKIE_SAMESITE = "Lax"
    CSRF_COOKIE_SAMESITE = "Lax"
else:
    ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "comparator",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

if DESKTOP_MODE:
    # Solo la ventana de Electron (que conoce el token) puede usar el backend.
    MIDDLEWARE.insert(0, "dbcompare.desktop_middleware.DesktopAccessMiddleware")

# WhiteNoise sirve los estáticos sin necesidad de un servidor web aparte.
# Es imprescindible con DEBUG=False (modo escritorio); en modo web solo se
# usa si está instalado.
if not DEBUG:
    try:
        import whitenoise  # noqa: F401
    except ImportError:  # pragma: no cover - depende del entorno
        pass
    else:
        MIDDLEWARE.insert(
            MIDDLEWARE.index("django.middleware.security.SecurityMiddleware") + 1,
            "whitenoise.middleware.WhiteNoiseMiddleware",
        )

ROOT_URLCONF = "dbcompare.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "dbcompare.wsgi.application"

# BD interna de la app (para guardar las conexiones registradas).
# Aquí usamos SQLite para simplicidad; puedes cambiarla por PostgreSQL.
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": Path(os.environ.get("PGCOMPARE_DB_PATH") or (DATA_DIR / "db.sqlite3")),
        "OPTIONS": {"timeout": 20},
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "es"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = Path(
    os.environ.get("PGCOMPARE_STATIC_ROOT")
    or (DATA_DIR / "static" if DESKTOP_MODE else BASE_DIR / "staticfiles")
)
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

if DESKTOP_MODE:
    # Sin consola visible: todo lo que se loguea lo captura Electron y lo
    # escribe en <carpeta de datos>/logs/backend.log.
    LOGGING = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "desktop": {"format": "[%(asctime)s] %(levelname)s %(name)s: %(message)s"},
        },
        "handlers": {
            "stderr": {
                "class": "logging.StreamHandler",
                "stream": sys.stderr,
                "formatter": "desktop",
            },
        },
        "root": {"handlers": ["stderr"], "level": "INFO"},
        "loggers": {
            "django.request": {
                "handlers": ["stderr"],
                "level": "ERROR",
                "propagate": False,
            },
        },
    }
