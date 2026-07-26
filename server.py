from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from http import cookies
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import tempfile
from threading import Lock
from time import perf_counter
from urllib.parse import urlparse

try:
    from database import Database, DomainError
except ImportError:  # permite abrir la interfaz JSON aun antes de instalar dependencias
    Database = None
    DomainError = Exception


ROOT = Path(__file__).resolve().parent


def load_dotenv(path):
    """Carga .env sólo para desarrollo local; Railway inyecta sus variables."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(ROOT / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("DATABASE_PUBLIC_URL")
POSTGRES = Database(DATABASE_URL) if DATABASE_URL and Database else None
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "uzumaki-db.json"
STATE_WRITE_LOCK = Lock()
SESSIONS = {}
SESSION_COOKIE = "uzumaki_session"
CSRF_COOKIE = "uzumaki_csrf"
PBKDF2_ITERATIONS = 310_000
MAX_REQUEST_BYTES = 1_048_576
SESSION_MAX_AGE_SECONDS = int(os.environ.get("SESSION_MAX_AGE_SECONDS", "28800"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true" if os.environ.get("RAILWAY_ENVIRONMENT") else "false").lower() == "true"
LOGIN_MAX_ATTEMPTS = int(os.environ.get("LOGIN_MAX_ATTEMPTS", "5"))
LOGIN_WINDOW_SECONDS = int(os.environ.get("LOGIN_WINDOW_SECONDS", "900"))
PUBLIC_PATH_PREFIXES = ("/src/", "/assets/")
PUBLIC_PATHS = {"/", "/index.html"}
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
FAVICON_SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fb6f01"/><path d="M18 17h28v8H18zm0 14h28v8H18zm0 14h20v8H18z" fill="#fff"/></svg>"""
CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOGGER = logging.getLogger("uzumaki.server")
LOGIN_ATTEMPTS = {}
LOGIN_ATTEMPTS_LOCK = Lock()


def log_event(event, **fields):
    """Registro JSON seguro para consola/Railway; nunca recibe secretos."""
    details = {key: value for key, value in fields.items() if value is not None}
    LOGGER.info("%s %s", event, json.dumps(details, ensure_ascii=False, default=str, separators=(",", ":")))


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password, stored):
    if not isinstance(stored, str) or not stored.startswith("pbkdf2_sha256$"):
        return False
    try:
        _, iterations, salt, digest = stored.split("$", 3)
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations)).hex()
        return hmac.compare_digest(candidate, digest)
    except (TypeError, ValueError):
        return False


def validate_new_password(password):
    if not isinstance(password, str) or len(password) < 10:
        raise DomainError("La contraseña debe tener al menos 10 caracteres.")
    if len(password) > 256:
        raise DomainError("La contraseña es demasiado extensa.")


def read_state():
    return json.loads(DB_PATH.read_text(encoding="utf-8")) if DB_PATH.exists() else {}


def write_state(payload):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=DB_PATH.parent, delete=False) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=2)
        tmp.write("\n")
        tmp_path = Path(tmp.name)
    tmp_path.replace(DB_PATH)


def remove_credentials(payload):
    public = json.loads(json.dumps(payload))
    for item in public.get("users", []):
        item.pop("password", None)
        item.pop("passwordHash", None)
    return public


def migrate_passwords(payload):
    changed = False
    for item in payload.get("users", []):
        password = item.pop("password", None)
        if password:
            item["passwordHash"] = password_hash(password)
            changed = True
    return changed


class UzumakiHandler(SimpleHTTPRequestHandler):
    def handle_one_request(self):
        self._request_started_at = perf_counter()
        self._request_id = secrets.token_hex(8)
        try:
            return super().handle_one_request()
        except CLIENT_DISCONNECT_ERRORS:
            log_event("client_disconnected", method=getattr(self, "command", None),
                      path=self._path() if hasattr(self, "path") else None,
                      remote=self._client_ip(),
                      actor=getattr(self, "_actor_id", None),
                      request_id=getattr(self, "_request_id", None))
            return None

    def log_message(self, format, *args):
        # Reemplaza el formato ruidoso del servidor estándar por un evento útil.
        log_event("http_request", method=getattr(self, "command", None), path=self._path() if hasattr(self, "path") else None,
                  remote=self._client_ip(), status=args[1] if len(args) > 1 else None,
                  actor=getattr(self, "_actor_id", None),
                  request_id=getattr(self, "_request_id", None),
                  duration_ms=round((perf_counter() - getattr(self, "_request_started_at", perf_counter())) * 1000, 1))

    def end_headers(self):
        # TLS se termina en el proxy inverso; estas cabeceras protegen la app
        # y evitan que el navegador interprete contenido inesperado.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("X-Request-Id", getattr(self, "_request_id", "unknown"))
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        super().end_headers()

    def _path(self):
        return urlparse(self.path).path

    def _client_ip(self):
        if os.environ.get("RAILWAY_ENVIRONMENT"):
            forwarded = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if forwarded:
                return forwarded
        return self.client_address[0]

    def _cookie_suffix(self):
        secure = COOKIE_SECURE or self.headers.get("X-Forwarded-Proto", "").lower() == "https"
        return "; Secure" if secure else ""

    def _same_origin(self, required=True):
        origin = self.headers.get("Origin")
        if not origin:
            return not required
        secure = COOKIE_SECURE or self.headers.get("X-Forwarded-Proto", "").lower() == "https"
        proto = self.headers.get("X-Forwarded-Proto", "https" if secure else "http").split(",")[0].strip()
        expected = f"{proto}://{self.headers.get('Host', '')}"
        return hmac.compare_digest(origin.rstrip("/"), expected.rstrip("/"))

    def _csrf_valid(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get(CSRF_COOKIE)
        supplied = self.headers.get("X-CSRF-Token", "")
        return bool(token and supplied and hmac.compare_digest(token.value, supplied))

    def _require_mutation_protection(self):
        if not self._same_origin() or not self._csrf_valid():
            log_event("request_rejected", path=self._path(), remote=self._client_ip(), reason="csrf_or_origin")
            self._send_json(403, {"error": "csrfRejected", "message": "La solicitud no pudo ser validada. Recargá la página e intentá de nuevo."})
            return False
        return True

    def _login_limited(self):
        now = datetime.now(timezone.utc).timestamp()
        ip = self._client_ip()
        with LOGIN_ATTEMPTS_LOCK:
            attempts = [item for item in LOGIN_ATTEMPTS.get(ip, []) if now - item < LOGIN_WINDOW_SECONDS]
            LOGIN_ATTEMPTS[ip] = attempts
            return len(attempts) >= LOGIN_MAX_ATTEMPTS

    def _record_login_failure(self):
        now = datetime.now(timezone.utc).timestamp()
        ip = self._client_ip()
        with LOGIN_ATTEMPTS_LOCK:
            attempts = [item for item in LOGIN_ATTEMPTS.get(ip, []) if now - item < LOGIN_WINDOW_SECONDS]
            attempts.append(now)
            LOGIN_ATTEMPTS[ip] = attempts

    def _clear_login_failures(self):
        with LOGIN_ATTEMPTS_LOCK:
            LOGIN_ATTEMPTS.pop(self._client_ip(), None)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_no_content(self):
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    @staticmethod
    def _with_week(result, session, week_id):
        """Devuelve el comando y sólo la semana que cambió."""
        return {**result, "week": POSTGRES.week(session, week_id)}

    @staticmethod
    def _with_request(result, session, request_id):
        """Devuelve el comando y sólo la solicitud que cambió."""
        return {**result, "request": POSTGRES.request_data(session, request_id)}

    @staticmethod
    def _with_people(result, session):
        """La administración necesita refrescar únicamente personal y accesos."""
        return {**result, **POSTGRES.employees_data(session)}

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_REQUEST_BYTES:
                return None
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            return None

    def _session(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get(SESSION_COOKIE)
        if POSTGRES:
            try:
                return POSTGRES.session_user(token.value if token else None)
            except Exception:
                LOGGER.exception("session_lookup_failed")
                self._session_lookup_failed = True
                return None
        session = SESSIONS.get(token.value) if token else None
        if session and datetime.now(timezone.utc).timestamp() - session["createdAt"] > SESSION_MAX_AGE_SECONDS:
            SESSIONS.pop(token.value, None)
            return None
        return session

    def _session_token(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get(SESSION_COOKIE)
        return token.value if token else ""

    def _require_session(self):
        session = self._session()
        if not session:
            if getattr(self, "_session_lookup_failed", False):
                self._send_json(503, {"error": "databaseUnavailable", "message": "No se pudo validar la sesión con PostgreSQL."})
                return None
            log_event("authentication_required", path=self._path(), remote=self._client_ip())
            self._send_json(401, {"error": "authenticationRequired", "message": "Iniciá sesión para continuar."})
            return None
        self._actor_id = session.get("id")
        return session

    def _send_session(self, user):
        session_user = {key: user.get(key) for key in ("id", "username", "name", "role", "employeeId", "mustChangePassword")}
        token = POSTGRES.create_session(session_user["id"], SESSION_MAX_AGE_SECONDS) if POSTGRES else secrets.token_urlsafe(32)
        if not POSTGRES:
            SESSIONS[token] = {**session_user, "createdAt": datetime.now(timezone.utc).timestamp()}
        csrf_token = secrets.token_urlsafe(32)
        log_event("login_success", user_id=session_user["id"], role=session_user["role"], storage="postgres" if POSTGRES else "json")
        body = json.dumps({"user": session_user}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        secure = self._cookie_suffix()
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_MAX_AGE_SECONDS}{secure}")
        self.send_header("Set-Cookie", f"{CSRF_COOKIE}={csrf_token}; SameSite=Strict; Path=/; Max-Age={SESSION_MAX_AGE_SECONDS}{secure}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self._path()
        if path == "/.well-known/appspecific/com.chrome.devtools.json":
            return self._send_no_content()
        if path == "/favicon.ico":
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(FAVICON_SVG)))
            self.end_headers()
            self.wfile.write(FAVICON_SVG)
            return
        if path == "/health":
            return self._send_json(200, {"ok": True, "service": "gestion-turnos"})
        if path == "/ready":
            if not POSTGRES:
                return self._send_json(503, {"ok": False, "storage": "postgresqlRequired"})
            try:
                return self._send_json(200, {"ok": POSTGRES.ready(), "storage": "postgresql"})
            except Exception:
                LOGGER.exception("readiness_failed")
                return self._send_json(503, {"ok": False, "storage": "postgresql"})
        if path in {"/api/bootstrap", "/api/state"}:
            session = self._require_session()
            if not session:
                return
            if session.get("mustChangePassword"):
                return self._send_json(403, {"error": "passwordChangeRequired", "message": "Debés cambiar tu contraseña antes de continuar."})
            if POSTGRES:
                try:
                    # /api/state queda como alias de transición. Las sesiones
                    # nuevas usan el bootstrap acotado, sin recorrer todo el
                    # historial de semanas y sus posiciones.
                    payload = POSTGRES.bootstrap(session)
                except Exception:
                    LOGGER.exception("bootstrap_read_failed")
                    return self._send_json(503, {"error": "databaseUnavailable", "message": "No se pudo leer PostgreSQL."})
                return self._send_json(200, payload)
            if not DB_PATH.exists():
                return self._send_json(404, {"error": "Base JSON no creada"})
            try:
                with STATE_WRITE_LOCK:
                    payload = read_state()
                return self._send_json(200, remove_credentials(payload))
            except json.JSONDecodeError:
                return self._send_json(500, {"error": "Base JSON inválida"})
        if path == "/api/me":
            session = self._require_session()
            return self._send_json(200, {"user": {key: value for key, value in session.items() if key != "createdAt"}}) if session else None
        if path.startswith("/api/"):
            session = self._require_session()
            if not session:
                return
            if session.get("mustChangePassword"):
                return self._send_json(403, {"error": "passwordChangeRequired", "message": "Debés cambiar tu contraseña antes de continuar."})
            if not POSTGRES:
                return self._send_json(503, {"error": "postgresRequired", "message": "PostgreSQL debe estar configurado."})
            try:
                if path == "/api/dashboard":
                    return self._send_json(200, POSTGRES.dashboard(session))
                if path == "/api/employees":
                    return self._send_json(200, POSTGRES.employees_data(session))
                if path == "/api/requests":
                    return self._send_json(200, POSTGRES.requests_data(session))
                if path.startswith("/api/planning/weeks/"):
                    week_id = path.split("/")[4]
                    return self._send_json(200, {"week": POSTGRES.week(session, week_id)})
                if path == "/api/notifications":
                    return self._send_json(200, POSTGRES.notifications_data(session))
            except DomainError as error:
                return self._send_json(error.status, {"error": error.code, "message": error.message})
            except Exception:
                LOGGER.exception("api_contract_failed path=%s", path)
                return self._send_json(503, {"error": "databaseUnavailable", "message": "No se pudo preparar la respuesta."})
        # Nunca exponer la base de datos, el código del servidor ni archivos del repositorio.
        if path.startswith("/src/data/") or (path not in PUBLIC_PATHS and not path.startswith(PUBLIC_PATH_PREFIXES)):
            return self._send_json(404, {"error": "Recurso no encontrado"})
        return super().do_GET()

    def do_POST(self):
        path = self._path()
        if path == "/api/auth/login":
            if not self._same_origin(required=False):
                return self._send_json(403, {"error": "originRejected", "message": "La solicitud no es válida."})
            if self._login_limited():
                log_event("login_rate_limited", remote=self._client_ip())
                return self._send_json(429, {"error": "tooManyAttempts", "message": "Demasiados intentos. Esperá unos minutos antes de volver a probar."})
            payload = self._read_json_body() or {}
            username = str(payload.get("username", "")).strip().lower()
            password = str(payload.get("password", ""))
            if not username or not password:
                return self._send_json(400, {"error": "invalidCredentials", "message": "Ingresá usuario y contraseña."})
            if POSTGRES:
                try:
                    user = POSTGRES.login_user(username)
                except Exception:
                    LOGGER.exception("login_database_failed username=%s", username)
                    return self._send_json(503, {"error": "databaseUnavailable", "message": "No se pudo conectar con PostgreSQL."})
                if not user or not verify_password(password, user.get("password_hash", "")):
                    self._record_login_failure()
                    log_event("login_failed", username=username, reason="invalid_credentials")
                    return self._send_json(401, {"error": "invalidCredentials", "message": "Usuario o contraseña incorrectos."})
                self._clear_login_failures()
                return self._send_session(POSTGRES.user_dto(user))
            with STATE_WRITE_LOCK:
                try:
                    state = read_state()
                except json.JSONDecodeError:
                    return self._send_json(500, {"error": "Base JSON inválida"})
                changed = migrate_passwords(state)
                if changed:
                    state["stateUpdatedAt"] = now_iso()
                    write_state(state)
                user = next((item for item in state.get("users", []) if item.get("username", "").lower() == username), None)
            if not user or not verify_password(password, user.get("passwordHash", "")):
                self._record_login_failure()
                log_event("login_failed", username=username, reason="invalid_credentials")
                return self._send_json(401, {"error": "invalidCredentials", "message": "Usuario o contraseña incorrectos."})
            self._clear_login_failures()
            return self._send_session(user)
        if path == "/api/auth/logout":
            if not self._require_mutation_protection():
                return
            jar = cookies.SimpleCookie(self.headers.get("Cookie"))
            token = jar.get(SESSION_COOKIE)
            session = self._session()
            if token:
                if POSTGRES:
                    POSTGRES.revoke_session(token.value)
                else:
                    SESSIONS.pop(token.value, None)
            log_event("logout", user_id=session.get("id") if session else None)
            self.send_response(204)
            secure = self._cookie_suffix()
            self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}")
            self.send_header("Set-Cookie", f"{CSRF_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0{secure}")
            self.end_headers()
            return
        session = self._require_session()
        if not session:
            return
        if not self._require_mutation_protection():
            return
        if session.get("mustChangePassword") and path != "/api/me/change-password":
            return self._send_json(403, {"error": "passwordChangeRequired", "message": "Debés cambiar tu contraseña antes de continuar."})
        if POSTGRES:
            try:
                body = self._read_json_body()
                if not isinstance(body, dict):
                    raise DomainError("JSON inválido.")
                log_event("operation_started", actor=session["id"], method="POST", path=path)
                if path == "/api/planning/assignments":
                    result = POSTGRES.assign(session, body.get("weekId"), body.get("positionId"), body.get("employeeId"), body.get("version")); log_event("planning_assignment_saved", actor=session["id"], week_id=body.get("weekId"), position_id=body.get("positionId"), employee_id=body.get("employeeId")); return self._send_json(200, self._with_week(result, session, body.get("weekId")))
                if path == "/api/planning/weeks":
                    result = POSTGRES.create_week(session, body.get("name"), body.get("startDate"))
                    return self._send_json(201, self._with_week(result, session, result["id"]))
                if path == "/api/planning/days-off":
                    result = POSTGRES.add_day_off(session, body.get("weekId"), body.get("employeeId"), body.get("date"), body.get("sectorId"), body.get("type"), body.get("version"))
                    return self._send_json(200, self._with_week(result, session, body.get("weekId")))
                if path == "/api/planning/exceptions":
                    result = POSTGRES.upsert_exception(session, body.get("weekId"), body, body.get("version"))
                    return self._send_json(200, self._with_week(result, session, body.get("weekId")))
                if path.startswith("/api/planning/weeks/") and path.endswith("/status"):
                    week_id = path.split("/")[4]
                    return self._send_json(200, self._with_week(POSTGRES.set_week_status(session, week_id, body.get("status"), body.get("version")), session, week_id))
                if path == "/api/requests":
                    result = POSTGRES.create_request(session, body)
                    return self._send_json(201, self._with_request(result, session, result["id"]))
                if path.startswith("/api/requests/") and path.endswith("/resolve"):
                    request_id = path.split("/")[3]
                    return self._send_json(200, self._with_request(POSTGRES.resolve_request(session, request_id, body.get("status")), session, request_id))
                if path.startswith("/api/requests/") and path.endswith("/partner-response"):
                    request_id = path.split("/")[3]
                    return self._send_json(200, self._with_request(POSTGRES.resolve_partner_request(session, request_id, body.get("status")), session, request_id))
                if path.startswith("/api/requests/") and path.endswith("/revoke"):
                    request_id = path.split("/")[3]
                    return self._send_json(200, self._with_request(POSTGRES.revoke_request(session, request_id, body.get("reason")), session, request_id))
                if path == "/api/notifications/read":
                    result = POSTGRES.mark_notifications_read(session, body.get("notificationId"))
                    return self._send_json(200, {**result, **POSTGRES.notifications_data(session)})
                if path == "/api/users":
                    password = str(body.get("password") or "")
                    validate_new_password(password)
                    return self._send_json(201, self._with_people(POSTGRES.upsert_user(session, body, password_hash(password) if password else None), session))
                if path == "/api/me/change-password":
                    current_password = str(body.get("currentPassword") or "")
                    new_password = str(body.get("newPassword") or "")
                    validate_new_password(new_password)
                    return self._send_json(200, POSTGRES.change_own_password(session, current_password, password_hash(new_password), verify_password, self._session_token()))
                if path.startswith("/api/users/") and path.endswith("/reset-password"):
                    new_password = str(body.get("newPassword") or "")
                    validate_new_password(new_password)
                    return self._send_json(200, self._with_people(POSTGRES.reset_user_password(session, path.split("/")[3], password_hash(new_password), str(body.get("reason") or "")), session))
                if path.startswith("/api/users/") and path.endswith("/deactivate"):
                    return self._send_json(200, self._with_people(POSTGRES.deactivate_user(session, path.split("/")[3]), session))
                if path.startswith("/api/users/") and path.endswith("/reactivate"):
                    return self._send_json(200, self._with_people(POSTGRES.reactivate_user(session, path.split("/")[3]), session))
                if path.startswith("/api/users/") and path.endswith("/profile"):
                    if body.get("password"):
                        raise DomainError("La contraseña se administra desde el restablecimiento de acceso.")
                    body["userId"] = path.split("/")[3]
                    return self._send_json(200, self._with_people(POSTGRES.upsert_user(session, body), session))
            except DomainError as error:
                log_event("domain_rejected", actor=session.get("id"), path=path, code=error.code, reason=error.message)
                return self._send_json(error.status, {"error": error.code, "message": error.message})
            except Exception:
                LOGGER.exception("operation_failed path=%s actor=%s", path, session.get("id"))
                return self._send_json(500, {"error": "internalError", "message": "No se pudo completar la operación."})
        return self._send_json(404, {"error": "Endpoint no encontrado"})

    def do_DELETE(self):
        session = self._require_session()
        if not session:
            return
        if not self._require_mutation_protection():
            return
        if not POSTGRES:
            return self._send_json(404, {"error": "Endpoint no encontrado"})
        path = self._path()
        try:
            log_event("operation_started", actor=session["id"], method="DELETE", path=path)
            version = self.headers.get("If-Match")
            expected_version = int(version) if version else None
            if path.startswith("/api/planning/assignments/"):
                week_id = self.headers.get("X-Week-Id")
                return self._send_json(200, self._with_week(POSTGRES.remove_assignment(session, week_id, path.split("/")[4], expected_version), session, week_id))
            if path.startswith("/api/planning/days-off/"):
                week_id = self.headers.get("X-Week-Id")
                return self._send_json(200, self._with_week(POSTGRES.remove_day_off(session, week_id, path.split("/")[4], expected_version), session, week_id))
            if path.startswith("/api/planning/exceptions/"):
                week_id = self.headers.get("X-Week-Id")
                return self._send_json(200, self._with_week(POSTGRES.remove_exception(session, week_id, path.split("/")[4], expected_version), session, week_id))
            if path.startswith("/api/planning/weeks/"):
                return self._send_json(200, {**POSTGRES.delete_week(session, path.split("/")[4], expected_version), "deletedWeekId": path.split("/")[4]})
        except DomainError as error:
            log_event("domain_rejected", actor=session.get("id"), path=path, code=error.code, reason=error.message)
            return self._send_json(error.status, {"error": error.code, "message": error.message})
        except (TypeError, ValueError):
            return self._send_json(400, {"error": "validationError", "message": "Versión o identificador inválido."})
        except Exception:
            LOGGER.exception("delete_operation_failed path=%s actor=%s", path, session.get("id"))
            return self._send_json(500, {"error": "internalError", "message": "No se pudo completar la operación."})
        return self._send_json(404, {"error": "Endpoint no encontrado"})

    def do_PUT(self):
        if self._path() != "/api/state":
            return self._send_json(404, {"error": "Endpoint no encontrado"})
        session = self._require_session()
        if not session:
            return
        if not self._require_mutation_protection():
            return
        if POSTGRES:
            return self._send_json(410, {"error": "legacyStateWriteDisabled", "message": "PostgreSQL es la fuente de datos. Usá los endpoints de dominio."})
        payload = self._read_json_body()
        if not isinstance(payload, dict):
            return self._send_json(400, {"error": "JSON inválido"})

        with STATE_WRITE_LOCK:
            try:
                current = read_state()
            except json.JSONDecodeError:
                return self._send_json(500, {"error": "Base JSON inválida"})

            current_revision = current.get("stateRevision", 0)
            expected_revision = payload.get("stateRevision")
            if not isinstance(expected_revision, int) or expected_revision != current_revision:
                return self._send_json(409, {
                    "error": "stateConflict",
                    "message": "El estado cambió desde que esta pestaña lo cargó.",
                    "currentRevision": current_revision,
                    "currentUpdatedAt": current.get("stateUpdatedAt"),
                })

            if session.get("role") not in {"admin", "manager"}:
                protected = ("employees", "planningWeek", "weeklySchedules", "catalogs")
                changed_protected_data = any(payload.get(key) != current.get(key) for key in protected)
                changed_users = remove_credentials({"users": payload.get("users", [])}) != remove_credentials({"users": current.get("users", [])})
                if changed_protected_data or changed_users:
                    return self._send_json(403, {"error": "forbidden", "message": "Tu perfil no puede modificar datos de planificación o personal."})
            current_users = {item.get("id") or item.get("username"): item for item in current.get("users", [])}
            for item in payload.get("users", []):
                if item.get("password"):
                    item["passwordHash"] = password_hash(item.pop("password"))
                else:
                    previous = current_users.get(item.get("id") or item.get("username"))
                    if previous and previous.get("passwordHash"):
                        item["passwordHash"] = previous["passwordHash"]
            payload["stateRevision"] = current_revision + 1
            payload["stateUpdatedAt"] = now_iso()
            write_state(payload)

        return self._send_json(200, {
            "ok": True,
            "path": str(DB_PATH.relative_to(ROOT)),
            "stateRevision": payload["stateRevision"],
            "stateUpdatedAt": payload["stateUpdatedAt"],
        })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "53123"))
    host = os.environ.get("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), UzumakiHandler)
    log_event("server_started", url=f"http://{host}:{port}", storage="postgres" if POSTGRES else "json", log_level=LOG_LEVEL, cookie_secure=COOKIE_SECURE)
    if POSTGRES:
        log_event("database_configured", provider="postgresql", source="DATABASE_URL")
    else:
        log_event("json_fallback_enabled", path=str(DB_PATH))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log_event("server_stopped", reason="keyboard_interrupt")
    finally:
        server.server_close()
        if POSTGRES:
            POSTGRES.close()
