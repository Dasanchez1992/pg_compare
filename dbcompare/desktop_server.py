"""Servidor local que usa la aplicación de escritorio (Electron).

Se lanza como proceso hijo desde ``desktop/electron/backend.js``:

    python -m dbcompare.desktop_server --data-dir <userData> --watch-stdin

Qué hace, en orden:

1. Reserva un puerto libre en la interfaz de loopback (o el que se le indique).
2. Arranca Django en modo escritorio, aplica migraciones y recolecta estáticos
   dentro de la carpeta de datos del usuario.
3. Escribe en ``stdout`` una línea ``PGCOMPARE_READY {json}`` con la URL real,
   que es la señal que espera Electron para abrir la ventana.
4. Sirve la app con waitress (WSGI puro Python, multiplataforma) hasta que el
   proceso padre muera o llegue una señal de término.

Todo lo que se imprima en ``stderr`` lo recoge Electron en
``<carpeta de datos>/logs/backend.log``.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import threading
import traceback
from pathlib import Path

READY_PREFIX = "PGCOMPARE_READY"
ERROR_PREFIX = "PGCOMPARE_ERROR"
DEFAULT_HOST = "127.0.0.1"


def _emit(prefix: str, payload: dict) -> None:
    """Manda un mensaje estructurado al proceso padre por stdout."""
    sys.stdout.write(f"{prefix} {json.dumps(payload)}\n")
    sys.stdout.flush()


def _parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="pgcompare-backend",
        description="Backend local de Comparador de BD para la app de escritorio.",
    )
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help="Interfaz donde escuchar (por defecto 127.0.0.1).")
    parser.add_argument("--port", type=int, default=0,
                        help="Puerto; 0 = el sistema elige uno libre.")
    parser.add_argument("--data-dir", default=None,
                        help="Carpeta de datos del usuario (BD, estáticos, clave).")
    parser.add_argument("--threads", type=int, default=6,
                        help="Hilos de waitress (por defecto 6).")
    parser.add_argument("--watch-stdin", action="store_true",
                        help="Termina cuando el proceso padre cierra stdin.")
    parser.add_argument("--force-collectstatic", action="store_true",
                        help="Recolecta los estáticos aunque no hayan cambiado.")
    parser.add_argument("--no-token", action="store_true",
                        help="Desactiva la comprobación del token de acceso.")
    return parser.parse_args(argv)


def _bind(host: str, port: int) -> socket.socket:
    """Deja el puerto reservado antes de arrancar Django (evita carreras)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    sock.setblocking(False)
    return sock


def _configure_environment(args) -> Path:
    data_dir = Path(args.data_dir).expanduser() if args.data_dir else _default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "dbcompare.settings")
    os.environ["PGCOMPARE_DESKTOP"] = "1"
    os.environ["PGCOMPARE_DATA_DIR"] = str(data_dir)
    if args.no_token:
        os.environ.pop("PGCOMPARE_TOKEN", None)
    return data_dir


def _default_data_dir() -> Path:
    """Carpeta de datos equivalente a ``app.getPath('userData')``."""
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "pg-compare-desktop"


def _prepare_django(data_dir: Path, *, force_collectstatic: bool) -> None:
    """Migraciones + estáticos. Es idempotente y rápido tras el primer arranque."""
    from django.conf import settings
    from django.core.management import call_command

    call_command("migrate", interactive=False, verbosity=0)

    static_root = Path(settings.STATIC_ROOT)
    stamp = static_root / ".collected"
    version = os.environ.get("PGCOMPARE_APP_VERSION", "")
    if force_collectstatic or not version or not _stamp_matches(stamp, version):
        static_root.mkdir(parents=True, exist_ok=True)
        call_command("collectstatic", interactive=False, verbosity=0)
        if version:
            try:
                stamp.write_text(version, encoding="utf-8")
            except OSError:
                pass


def _stamp_matches(stamp: Path, version: str) -> bool:
    try:
        return stamp.read_text(encoding="utf-8").strip() == version
    except OSError:
        return False


def _watch_parent() -> None:
    """Si Electron muere sin avisar, stdin llega a EOF y cerramos el backend."""
    def _wait():
        try:
            while sys.stdin.readline():
                pass
        except Exception:  # noqa: BLE001 - el padre ya no está
            pass
        os._exit(0)

    if sys.stdin is None:
        return
    threading.Thread(target=_wait, name="parent-watchdog", daemon=True).start()


def _install_signal_handlers(server) -> None:
    def _stop(signum, _frame):  # noqa: ANN001
        try:
            server.close()
        finally:
            raise SystemExit(0)

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _stop)
            except (ValueError, OSError):  # pragma: no cover - hilo secundario
                pass


def main(argv=None) -> int:
    args = _parse_args(argv)
    sock = None
    try:
        data_dir = _configure_environment(args)
        sock = _bind(args.host, args.port)
        host, port = sock.getsockname()[:2]
        os.environ["PGCOMPARE_PORT"] = str(port)

        import django
        from django.core.wsgi import get_wsgi_application

        django.setup()
        _prepare_django(data_dir, force_collectstatic=args.force_collectstatic)
        application = get_wsgi_application()

        from waitress.server import create_server

        server = create_server(
            application,
            sockets=[sock],
            threads=args.threads,
            ident="pg_compare",
            clear_untrusted_proxy_headers=True,
        )
    except BaseException as exc:  # noqa: BLE001 - hay que reportarlo al padre
        if sock is not None:
            sock.close()
        traceback.print_exc()
        _emit(ERROR_PREFIX, {"message": str(exc), "type": type(exc).__name__})
        return 1

    _emit(READY_PREFIX, {
        "url": f"http://{host}:{port}/",
        "host": host,
        "port": port,
        "pid": os.getpid(),
        "dataDir": str(data_dir),
        "django": django.get_version(),
        "python": sys.version.split()[0],
    })

    if args.watch_stdin:
        _watch_parent()
    _install_signal_handlers(server)

    try:
        server.run()
    except (SystemExit, KeyboardInterrupt):
        pass
    finally:
        try:
            server.close()
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
