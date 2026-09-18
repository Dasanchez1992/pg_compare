"""Pruebas de las piezas que solo usa la app de escritorio."""
import os
import socket
import tempfile
from pathlib import Path
from unittest import mock

from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase

from dbcompare import desktop_server
from dbcompare.desktop_middleware import COOKIE_NAME, DesktopAccessMiddleware
from dbcompare.settings import _flag, _secret_key_from

TOKEN = "t0k3n-de-prueba"


def _ok(_request):
    return HttpResponse("ok")


class DesktopAccessMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def _middleware(self, token=TOKEN):
        middleware = DesktopAccessMiddleware(_ok)
        middleware.token = token
        return middleware

    def test_sin_token_configurado_no_bloquea(self):
        """Modo web: si no hay token, el middleware es transparente."""
        response = self._middleware(token="")(self.factory.get("/"))
        self.assertEqual(response.status_code, 200)

    def test_peticion_sin_credenciales_es_rechazada(self):
        response = self._middleware()(self.factory.get("/"))
        self.assertEqual(response.status_code, 403)

    def test_cookie_valida_deja_pasar(self):
        request = self.factory.get("/historial/")
        request.COOKIES[COOKIE_NAME] = TOKEN
        self.assertEqual(self._middleware()(request).status_code, 200)

    def test_cookie_invalida_es_rechazada(self):
        request = self.factory.get("/")
        request.COOKIES[COOKIE_NAME] = "otro"
        self.assertEqual(self._middleware()(request).status_code, 403)

    def test_token_en_la_url_guarda_cookie_y_limpia_la_direccion(self):
        response = self._middleware()(self.factory.get("/", {"token": TOKEN}))

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "/")
        cookie = response.cookies[COOKIE_NAME]
        self.assertEqual(cookie.value, TOKEN)
        self.assertTrue(cookie["httponly"])

    def test_el_resto_de_parametros_sobrevive_a_la_limpieza(self):
        response = self._middleware()(
            self.factory.get("/historial/", {"token": TOKEN, "project": "3"})
        )
        self.assertEqual(response["Location"], "/historial/?project=3")

    def test_token_en_la_url_renueva_una_cookie_caducada(self):
        """Tras reiniciar la app el token cambia; la cookie vieja se sustituye."""
        request = self.factory.get("/", {"token": TOKEN})
        request.COOKIES[COOKIE_NAME] = "token-de-la-sesion-anterior"

        response = self._middleware()(request)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.cookies[COOKIE_NAME].value, TOKEN)

    def test_token_incorrecto_en_la_url_es_rechazado(self):
        response = self._middleware()(self.factory.get("/", {"token": "falso"}))
        self.assertEqual(response.status_code, 403)


class SettingsHelperTests(SimpleTestCase):
    def test_flag_interpreta_los_valores_habituales(self):
        casos = [("1", True), ("true", True), ("TRUE", True), ("yes", True),
                 ("on", True), (" 1 ", True), ("0", False), ("no", False), ("", False)]
        for raw, esperado in casos:
            with self.subTest(raw=raw):
                with mock.patch.dict(os.environ, {"PGCOMPARE_TEST_FLAG": raw}):
                    self.assertEqual(_flag("PGCOMPARE_TEST_FLAG"), esperado)

    def test_flag_usa_el_valor_por_defecto_si_no_hay_variable(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PGCOMPARE_TEST_FLAG", None)
            self.assertTrue(_flag("PGCOMPARE_TEST_FLAG", default=True))
            self.assertFalse(_flag("PGCOMPARE_TEST_FLAG"))

    def test_la_clave_secreta_se_crea_una_vez_y_se_reutiliza(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secret_key.txt"

            primera = _secret_key_from(path)
            segunda = _secret_key_from(path)

            self.assertTrue(primera)
            self.assertEqual(primera, segunda)
            self.assertEqual(path.read_text(encoding="utf-8").strip(), primera)


class DesktopServerTests(SimpleTestCase):
    def test_argumentos_por_defecto(self):
        args = desktop_server._parse_args([])

        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.port, 0)          # el sistema elige uno libre
        self.assertFalse(args.watch_stdin)

    def test_reserva_un_puerto_libre_en_loopback(self):
        sock = desktop_server._bind("127.0.0.1", 0)
        try:
            host, port = sock.getsockname()[:2]
            self.assertEqual(host, "127.0.0.1")
            self.assertGreater(port, 0)
            # Está escuchando: un segundo bind al mismo puerto debe fallar.
            with self.assertRaises(OSError):
                otro = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    otro.bind(("127.0.0.1", port))
                finally:
                    otro.close()
        finally:
            sock.close()

    def test_el_sello_de_estaticos_detecta_la_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            stamp = Path(tmp) / ".collected"

            self.assertFalse(desktop_server._stamp_matches(stamp, "1.0.0"))
            stamp.write_text("1.0.0", encoding="utf-8")
            self.assertTrue(desktop_server._stamp_matches(stamp, "1.0.0"))
            self.assertFalse(desktop_server._stamp_matches(stamp, "1.1.0"))

    def test_la_carpeta_de_datos_por_defecto_es_propia_de_la_app(self):
        self.assertEqual(desktop_server._default_data_dir().name, "pg-compare-desktop")
