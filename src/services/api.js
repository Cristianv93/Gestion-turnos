const CSRF_COOKIE = "uzumaki_csrf";

export const isHttpApp = () => window.location.protocol.startsWith("http");

const csrfToken = () => document.cookie
  .split(";")
  .map((item) => item.trim())
  .find((item) => item.startsWith(`${CSRF_COOKIE}=`))
  ?.slice(CSRF_COOKIE.length + 1) || "";

export const csrfHeaders = () => {
  const token = csrfToken();
  return token ? { "X-CSRF-Token": token } : {};
};

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

// Cliente único para comandos de la app. Mantiene CSRF, caché y mensajes de
// error consistentes sin repartir fetch() por las pantallas.
export async function requestApi(path, { method = "GET", payload, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...csrfHeaders(),
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const result = await readJson(response);
  if (!response.ok) {
    const error = new Error(result.message || "No se pudo completar la operación.");
    error.code = result.error;
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function authenticate(username, password) {
  if (!isHttpApp()) throw new Error("Abrí la app desde server.py para iniciar sesión.");
  const result = await requestApi("/api/auth/login", { method: "POST", payload: { username, password } });
  return result.user;
}

export async function endSession() {
  if (!isHttpApp()) return;
  try {
    await requestApi("/api/auth/logout", { method: "POST" });
  } catch (error) {
    if (error.status !== 401) throw error;
  }
}
