"""Middleware de acceso para el modo escritorio.

El backend Django escucha en ``127.0.0.1``, así que cualquier proceso local
podría hablarle (y la app guarda credenciales de PostgreSQL). Electron genera
un token aleatorio en cada arranque, lo pasa al backend por variable de
entorno y abre la ventana con ``?token=...``: a partir de ahí el token viaja
en una cookie de sesión del navegador embebido.

Si ``PGCOMPARE_TOKEN`` no está definida el middleware no hace nada, de modo
que el modo web clásico sigue funcionando igual.
"""
from __future__ import annotations

import os
from secrets import compare_digest

from django.http import HttpResponseForbidden, HttpResponseRedirect

COOKIE_NAME = "pgcompare_token"
QUERY_PARAM = "token"

FORBIDDEN_HTML = """<!doctype html>
<html lang="es"><meta charset="utf-8"><title>Acceso denegado</title>
<body style="font-family:system-ui;background:#0b1120;color:#e2e8f0;padding:3rem">
<h1>Acceso denegado</h1>
<p>Este backend solo responde a la aplicación de escritorio que lo inició.</p>
</body></html>"""


class DesktopAccessMiddleware:
    """Exige el token de la sesión de escritorio en cada petición."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.token = os.environ.get("PGCOMPARE_TOKEN") or ""

    def __call__(self, request):
        if not self.token:
            return self.get_response(request)

        cookie = request.COOKIES.get(COOKIE_NAME)
        if cookie and compare_digest(cookie, self.token):
            return self.get_response(request)

        supplied = request.GET.get(QUERY_PARAM)
        if supplied and compare_digest(supplied, self.token):
            # Guardamos el token en una cookie y limpiamos la URL para que no
            # quede en el historial ni en los enlaces de la página.
            response = HttpResponseRedirect(self._url_without_token(request))
            response.set_cookie(
                COOKIE_NAME,
                self.token,
                httponly=True,
                samesite="Lax",
                path="/",
            )
            return response

        return HttpResponseForbidden(FORBIDDEN_HTML)

    @staticmethod
    def _url_without_token(request):
        params = request.GET.copy()
        params.pop(QUERY_PARAM, None)
        query = params.urlencode()
        return f"{request.path}?{query}" if query else request.path
