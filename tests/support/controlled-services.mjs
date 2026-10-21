/**
 * Controlled external services for real-app verification runs.
 *
 * Load into the Next server process under test only:
 *
 *   NODE_OPTIONS="--import <repo>/tests/support/controlled-services.mjs" npx next dev -p 3218
 *
 * It replaces the three external boundaries the app talks to (OpenRouter
 * model/vision/quota, Vercel Blob) with controlled responses, lets through
 * localhost and the one disposable Neon host, and refuses everything else.
 * Auth, route handlers, SQL, selectors, parsers and persistence run as
 * shipped; nothing here imports product code or reads a product switch.
 *
 * Required environment (the preload throws at startup without them):
 *   DATABASE_URL                 disposable Neon branch connection string
 *   ALLOWED_DB_HOST              must equal DATABASE_URL's hostname exactly
 *   CONTROLLED_SERVICES_LOG      absolute path; one JSON line per external request
 *   CONTROLLED_SERVICES_CONTROL  absolute path to the control file (may not exist yet)
 *   CONTROLLED_SERVICES_FIXTURES directory of synthetic fixtures (Blob reads are
 *                                served from <dir>/blob/<pathname>)
 *   OPENROUTER_API_KEY           any value that is not a real key (`sk-or-` is refused)
 *
 * Scenario switching: the control file is re-read on every OpenRouter request,
 * so a runner switches the next answer by rewriting it (write a temp file,
 * then rename). Only a process on this machine can change it. Shape:
 *
 *   {
 *     "generation": 3,                      // echoed into each log line
 *     "vision": { "status": 401, "message": "User not found." },
 *     "model":  { "status": 200, "text": "..." },
 *     "quota":  { "status": 200, "limit": 50 }
 *   }
 *
 * "vision" answers chat completions that carry an image part, "model" every
 * other chat completion (streamed when the request asks for `stream`). A
 * missing entry answers 503 and is logged as `unconfigured`. "quota" answers
 * GET /api/v1/key and defaults to a 50-request free tier.
 *
 * Log lines: {ts, pid, event, service, method, host, path, status, outcome,
 * generation, note}. Query strings, headers and bodies are never written.
 * Outcomes: `served` (controlled answer), `passthrough` (Neon), `blocked`.
 * Blocked traffic is labelled `dev_tooling` for Next dev's own calls (the
 * npm version check, telemetry) and `unexpected` for anything else.
 * `data:`, `blob:` and `file:` fetches are not network traffic: they run
 * unchanged and are logged as event `local`, never as `request`.
 *
 * Coverage: global fetch (AI SDK, Neon HTTP driver, quota probe), Vercel
 * Blob's own undici fetch (via the undici global dispatcher), and every
 * outbound TCP/TLS socket as a backstop. Child processes that are not Node
 * (Chrome for PDF export, Turbopack's native font download) are outside it.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "::",
  "::ffff:127.0.0.1",
]);

function fail(message) {
  const error = new Error(`controlled-services: ${message}`);
  process.stderr.write(`${error.message}\n`);
  throw error;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function requiredAbsolute(name) {
  const value = requiredEnv(name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  return value;
}

const logPath = requiredAbsolute("CONTROLLED_SERVICES_LOG");
const controlPath = requiredAbsolute("CONTROLLED_SERVICES_CONTROL");
const fixturesDir = requiredAbsolute("CONTROLLED_SERVICES_FIXTURES");
if (!existsSync(fixturesDir) || !statSync(fixturesDir).isDirectory()) {
  fail("CONTROLLED_SERVICES_FIXTURES must be an existing directory");
}

const allowedDbHost = requiredEnv("ALLOWED_DB_HOST").toLowerCase();
let dbHost;
try {
  dbHost = new URL(requiredEnv("DATABASE_URL")).hostname.toLowerCase();
} catch {
  fail("DATABASE_URL is not a URL");
}
if (dbHost !== allowedDbHost) fail("DATABASE_URL host does not equal ALLOWED_DB_HOST");
// The Neon HTTP driver may address the endpoint as `api.<region host>`.
const dbHosts = new Set([dbHost, dbHost.replace(/^[^.]+\./, "api.")]);

if (requiredEnv("OPENROUTER_API_KEY").startsWith("sk-or-")) {
  fail("OPENROUTER_API_KEY looks like a real OpenRouter key; use a fake value");
}

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry });
  appendFileSync(logPath, `${line}\n`);
}

function readControl() {
  if (!existsSync(controlPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(controlPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    log({ event: "control_error", note: "control file is not valid JSON; answering unconfigured" });
    return {};
  }
}

function isOpenRouterHost(host) {
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function isBlobHost(host) {
  return host.endsWith(".blob.vercel-storage.com") || host === "blob.vercel-storage.com";
}

function isBlobApi(host, pathname) {
  return host === "vercel.com" && pathname.startsWith("/api/blob");
}

// Next dev's own calls; still blocked, but not product traffic.
const DEV_TOOLING_HOSTS = new Set(["registry.npmjs.org", "telemetry.nextjs.org"]);
const LOCAL_SCHEMES = new Set(["data:", "blob:", "file:"]);

function blockedService(host) {
  return DEV_TOOLING_HOSTS.has(host) ? "dev_tooling" : "unexpected";
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorBody(status, message) {
  return { error: { code: status, message } };
}

// ---------------------------------------------------------------- OpenRouter

function hasImagePart(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((part) => part?.type === "image_url" || part?.type === "input_image"),
  );
}

function completion(model, text) {
  return {
    id: `gen-controlled-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    provider: "controlled",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function streamedCompletion(model, text) {
  const id = `gen-controlled-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (choice, extra = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, provider: "controlled", choices: [choice], ...extra })}\n\n`;
  const events = [
    chunk({ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }),
    chunk(
      { index: 0, delta: {}, finish_reason: "stop" },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ),
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  );
}

async function openRouterResponse(method, url, bodyText) {
  const control = readControl();
  const generation = control.generation ?? null;
  const base = { event: "request", method, host: url.hostname, path: url.pathname, generation };

  if (method === "GET" && url.pathname === "/api/v1/key") {
    const quota = control.quota ?? {};
    const status = Number(quota.status ?? 200);
    log({ ...base, service: "openrouter-quota", status, outcome: "served" });
    if (status !== 200) return json(status, errorBody(status, "Controlled quota failure"));
    return json(200, {
      data: {
        label: "controlled",
        limit: null,
        usage: 0,
        is_free_tier: true,
        free_model_daily_requests: { limit: Number(quota.limit ?? 50), used: 0, remaining: Number(quota.limit ?? 50) },
      },
    });
  }

  if (method === "POST" && url.pathname === "/api/v1/chat/completions") {
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // Logged below as an unparseable request; answered as unconfigured.
    }
    const service = hasImagePart(body) ? "vision" : "model";
    const entry = control[service];
    const model = typeof body?.model === "string" ? body.model : "controlled/model";
    if (!entry || typeof entry !== "object") {
      log({ ...base, service, status: 503, outcome: "unconfigured", note: "no controlled answer configured" });
      return json(503, errorBody(503, `controlled-services: no ${service} answer configured`));
    }
    const status = Number(entry.status ?? 200);
    log({ ...base, service, status, outcome: "served", note: body?.stream ? "stream" : undefined });
    if (status !== 200) {
      return json(status, errorBody(status, String(entry.message ?? "Controlled provider error")));
    }
    const text = String(entry.text ?? "");
    return body?.stream ? streamedCompletion(model, text) : json(200, completion(model, text));
  }

  log({ ...base, service: "openrouter", status: 404, outcome: "blocked", note: "unexpected OpenRouter path" });
  return json(404, errorBody(404, "controlled-services: unexpected OpenRouter path"));
}

// ---------------------------------------------------------------- Blob

function fixtureFor(pathname) {
  const root = path.resolve(fixturesDir, "blob");
  const file = path.resolve(root, decodeURIComponent(pathname.replace(/^\/+/, "")));
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

function contentTypeFor(file) {
  if (file.endsWith(".pdf")) return "application/pdf";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

/** One controlled Blob answer: { statusCode, body (Buffer|string), headers }. */
function blobAnswer(method, origin, requestPath) {
  const url = new URL(requestPath, origin);
  const host = url.hostname;
  const base = { event: "request", service: "blob", method, host, path: url.pathname };

  if (isBlobHost(host) && (method === "GET" || method === "HEAD")) {
    const file = fixtureFor(url.pathname);
    if (!file) {
      log({ ...base, status: 404, outcome: "served", note: "no fixture" });
      return { statusCode: 404, body: "Not Found", headers: { "content-type": "text/plain" } };
    }
    const bytes = readFileSync(file);
    log({ ...base, status: 200, outcome: "served" });
    return {
      statusCode: 200,
      body: method === "HEAD" ? "" : bytes,
      headers: {
        "content-type": contentTypeFor(file),
        "content-length": String(bytes.length),
        etag: `"controlled-${bytes.length}"`,
        "last-modified": new Date(0).toUTCString(),
      },
    };
  }

  if (isBlobApi(host, url.pathname) && method === "GET" && url.searchParams.has("url")) {
    let target;
    try {
      target = new URL(url.searchParams.get("url"));
    } catch {
      target = null;
    }
    const file = target ? fixtureFor(target.pathname) : null;
    if (!target || !file) {
      log({ ...base, status: 404, outcome: "served", note: "head: no fixture" });
      return {
        statusCode: 404,
        body: JSON.stringify({ error: { code: "not_found", message: "The requested blob does not exist" } }),
        headers: { "content-type": "application/json" },
      };
    }
    const size = statSync(file).size;
    log({ ...base, status: 200, outcome: "served", note: "head" });
    return {
      statusCode: 200,
      body: JSON.stringify({
        url: target.toString(),
        downloadUrl: `${target.toString()}?download=1`,
        pathname: target.pathname.replace(/^\/+/, ""),
        size,
        uploadedAt: new Date(0).toISOString(),
        contentType: contentTypeFor(file),
        contentDisposition: `attachment; filename="${path.basename(file)}"`,
        cacheControl: "public, max-age=0",
        etag: `"controlled-${size}"`,
      }),
      headers: { "content-type": "application/json" },
    };
  }

  log({ ...base, status: 403, outcome: "blocked", note: "unexpected Blob request" });
  return {
    statusCode: 403,
    body: JSON.stringify({ error: { code: "forbidden", message: "controlled-services: unexpected Blob request" } }),
    headers: { "content-type": "application/json" },
  };
}

// ---------------------------------------------------------------- global fetch

const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") fail("global fetch is unavailable");
// Node loads its bundled undici, which installs the default dispatcher, only
// on the first fetch call. Make that call with a data: URL (no network), then
// keep that dispatcher for pass-through calls before the Blob dispatcher below
// replaces the shared global one.
await (await originalFetch("data:,controlled-services")).arrayBuffer();
const DISPATCHER_V1 = Symbol.for("undici.globalDispatcher.1");
const DISPATCHER_V2 = Symbol.for("undici.globalDispatcher.2");
const nodeDispatcher = globalThis[DISPATCHER_V2] ?? globalThis[DISPATCHER_V1];
if (!nodeDispatcher) fail("Node's default undici dispatcher is not installed; cannot keep pass-through traffic apart");

function requestParts(input, init) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = new URL(isRequest ? input.url : String(input));
  const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  return { url, method, isRequest };
}

async function bodyTextOf(input, init, isRequest) {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (init?.body != null) return await new Response(init.body).text();
  if (isRequest) return await input.clone().text();
  return "";
}

globalThis.fetch = async function controlledFetch(input, init) {
  const { url, method, isRequest } = requestParts(input, init);
  if (LOCAL_SCHEMES.has(url.protocol)) {
    log({ event: "local", service: "local", method, scheme: url.protocol, outcome: "passthrough" });
    return originalFetch(input, init);
  }
  const host = url.hostname.toLowerCase();
  const signal = init?.signal ?? (isRequest ? input.signal : undefined);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

  if (LOOPBACK_HOSTS.has(host)) {
    return originalFetch(input, { ...init, dispatcher: nodeDispatcher });
  }
  if (dbHosts.has(host)) {
    log({ event: "request", service: "database", method, host, path: url.pathname, outcome: "passthrough" });
    return originalFetch(input, { ...init, dispatcher: nodeDispatcher });
  }
  if (isOpenRouterHost(host)) {
    return openRouterResponse(method, url, await bodyTextOf(input, init, isRequest));
  }
  if (isBlobHost(host) || isBlobApi(host, url.pathname)) {
    const answer = blobAnswer(method, url.origin, `${url.pathname}${url.search}`);
    return new Response(answer.body === "" ? null : answer.body, {
      status: answer.statusCode,
      headers: answer.headers,
    });
  }

  log({ event: "request", service: blockedService(host), method, host, path: url.pathname, outcome: "blocked" });
  throw new TypeError("fetch failed", {
    cause: new Error(`controlled-services blocked ${method} ${host}`),
  });
};

// ---------------------------------------------------------------- Blob's undici

// @vercel/blob calls its own undici (v6) fetch, which dispatches through the
// shared global dispatcher. Answer every origin from a mock agent of that same
// undici, so no Blob request can reach the network.
const blobRequire = createRequire(new URL("../../node_modules/@vercel/blob/package.json", import.meta.url));
let blobUndici;
try {
  blobUndici = blobRequire("undici");
} catch {
  fail("cannot load the undici copy that @vercel/blob uses");
}
const mockAgent = new blobUndici.MockAgent();
mockAgent.disableNetConnect();
mockAgent
  .get(() => true)
  .intercept({ path: () => true, method: () => true })
  .reply((options) => {
    const target = new URL(String(options.path), String(options.origin));
    if (!isBlobHost(target.hostname) && !isBlobApi(target.hostname, target.pathname)) {
      log({ event: "request", service: blockedService(target.hostname), method: options.method, host: target.hostname, path: target.pathname, outcome: "blocked" });
      throw new Error(`controlled-services blocked ${options.method} ${target.hostname}`);
    }
    const answer = blobAnswer(String(options.method).toUpperCase(), String(options.origin), String(options.path));
    return { statusCode: answer.statusCode, data: answer.body, responseOptions: { headers: answer.headers } };
  })
  .persist();
blobUndici.setGlobalDispatcher(mockAgent);

// ---------------------------------------------------------------- sockets

function socketHost(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) return null;
    return String(first.host ?? "localhost");
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return null;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = socketHost(args)?.toLowerCase() ?? null;
  if (host === null || LOOPBACK_HOSTS.has(host) || dbHosts.has(host)) {
    return originalConnect.apply(this, args);
  }
  log({ event: "socket", service: blockedService(host), host, outcome: "blocked" });
  process.nextTick(() => this.destroy(new Error(`controlled-services blocked a socket to ${host}`)));
  return this;
};

log({
  event: "preload_ready",
  dbHost,
  node: process.version,
  argv: process.argv.slice(1, 3).map((arg) => path.basename(arg)),
});
