/**
 * Real-app verification of the study contracts S1a, S2, S3a and S5a over HTTP.
 *
 * Drives a running dev server that was started with the controlled-services
 * preload (tests/support/controlled-services.mjs) against a disposable Neon
 * branch. Seeds synthetic users (`*@example.invalid`) and their packs with SQL,
 * exercises the real routes, asserts on HTTP answers and database rows, writes
 * redacted evidence, and deletes every synthetic user it created.
 *
 * Usage:
 *   npx tsx scripts/verify-study-contracts.ts --init-fixtures <dir>
 *   npx tsx scripts/verify-study-contracts.ts --origin http://localhost:3218 \
 *     --out <dir outside the repo> --fixtures <dir> --scenario S1a|S2|S3a|S5a|all
 *
 * Required environment (refuses to start without it):
 *   DATABASE_URL                 the disposable branch; its host must equal ALLOWED_DB_HOST
 *   ALLOWED_DB_HOST              exact hostname of that branch
 *   CONTROLLED_SERVICES_LOG      the log path the server's preload writes
 *   CONTROLLED_SERVICES_CONTROL  the control file path the server's preload reads
 *
 * The origin must be http://localhost or http://127.0.0.1. Evidence goes to
 * <out>/<run id>/: one JSON file per scenario (HTTP transcript, database
 * before/after, assertions, timestamps, HEAD) and S5a's PDFs. Cookies, tokens,
 * password hashes and connection strings are redacted.
 *
 * S1a's login-page attempts replay the hydrated form's fetch action
 * (Next-Action header, React encodeReply body) and read the returned message.
 * S1a ages the synthetic user's login_throttles row by 16 minutes to stand in
 * for the lock expiring. Nothing else is written outside the synthetic users'
 * own rows. Exit code 0 only when every selected scenario passes.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { hashPassword } from "../lib/auth-utils";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCENARIOS = ["S1a", "S2", "S3a", "S5a"] as const;
type ScenarioName = (typeof SCENARIOS)[number];

// User-facing copy the contracts promise, kept here so a copy change is caught.
const LOCKED_MESSAGE = "Too many sign-in attempts. Try again in a few minutes.";
const INVALID_MESSAGE = "Invalid email or password.";
const VISION_SETUP_MESSAGE =
  "Slide reading isn't available right now. These pages stay unread, so try again later.";
const NO_READABLE_CONTENT = "(no readable content)";
/** app/not-found.tsx; streamed pages show it with HTTP 200 once loading UI has flushed. */
const NOT_FOUND_MARKER = "This page wandered off.";

/** A 1x1 baseline JPEG: the pages route only accepts JPEG bytes. */
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

// ---------------------------------------------------------------- arguments

type Args = {
  origin: string;
  out: string;
  fixtures: string;
  scenarios: ScenarioName[];
};

function die(message: string): never {
  console.error(`verify-study-contracts: ${message}`);
  process.exit(2);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) die(`${name} needs a value`);
  return value;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function initFixtures(dir: string): never {
  const target = path.resolve(dir);
  const jpeg = path.join(target, "page.jpg");
  if (existsSync(jpeg)) die(`${jpeg} already exists; not overwriting`);
  mkdirSync(path.join(target, "blob"), { recursive: true });
  writeFileSync(jpeg, Buffer.from(TINY_JPEG_BASE64, "base64"));
  console.log(`wrote synthetic fixtures to ${target} (page.jpg, blob/)`);
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const init = argValue(argv, "--init-fixtures");
  if (init) initFixtures(init);

  const origin = argValue(argv, "--origin") ?? die("--origin is required");
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(parsedOrigin.hostname) ||
    parsedOrigin.pathname !== "/"
  ) {
    die("--origin must be http://localhost:<port> or http://127.0.0.1:<port>");
  }

  const out = path.resolve(argValue(argv, "--out") ?? die("--out is required"));
  if (isInside(out, REPO_ROOT)) die("--out must be outside the repository");

  const fixtures = path.resolve(argValue(argv, "--fixtures") ?? die("--fixtures is required"));
  const jpeg = path.join(fixtures, "page.jpg");
  if (!existsSync(jpeg)) die(`${jpeg} is missing; create it with --init-fixtures`);
  const bytes = readFileSync(jpeg);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    die(`${jpeg} is not a JPEG`);
  }

  const scenario = argValue(argv, "--scenario") ?? die("--scenario is required");
  const scenarios =
    scenario === "all"
      ? [...SCENARIOS]
      : SCENARIOS.includes(scenario as ScenarioName)
        ? [scenario as ScenarioName]
        : die(`--scenario must be one of ${SCENARIOS.join(", ")} or all`);

  return { origin: parsedOrigin.origin, out, fixtures, scenarios };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) die(`${name} is required`);
  return value;
}

// ---------------------------------------------------------------- redaction

const SECRET_KEY = /cookie|token|hash|secret|password|authorization|csrf/i;

function redactString(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-connection-string]")
    .replace(/scrypt\$[^\s"']+/g, "[redacted-hash]")
    .replace(/(authjs\.[\w.-]+=)[^;\s"']+/g, "$1[redacted]");
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : redact(entry),
      ]),
    );
  }
  return value;
}

// ---------------------------------------------------------------- evidence

type Check = { name: string; pass: boolean; detail?: unknown };
type Exchange = {
  at: string;
  label: string;
  method: string;
  path: string;
  status: number;
  location?: string | null;
  /** Names of cookies the response set; values are never kept. */
  issued?: string[];
  body?: unknown;
};

class Evidence {
  readonly checks: Check[] = [];
  readonly transcript: Exchange[] = [];
  readonly database: Record<string, unknown> = {};
  readonly notes: string[] = [];
  readonly startedAt = new Date().toISOString();

  check(name: string, pass: boolean, detail?: unknown): boolean {
    this.checks.push({ name, pass, detail: detail === undefined ? undefined : redact(detail) });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}`);
    return pass;
  }

  must(name: string, pass: boolean, detail?: unknown): void {
    if (!this.check(name, pass, detail)) throw new Error(`required check failed: ${name}`);
  }

  db(label: string, value: unknown): void {
    this.database[label] = { at: new Date().toISOString(), value: redact(value) };
  }

  get passed(): boolean {
    return this.checks.length > 0 && this.checks.every((check) => check.pass);
  }
}

// ---------------------------------------------------------------- HTTP

class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: Response): string[] {
    const names: string[] = [];
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key, raw] = attribute.split("=").map((part) => part?.trim().toLowerCase());
        if (key === "max-age") return Number(raw) <= 0;
        if (key === "expires") return Date.parse(raw ?? "") <= Date.now();
        return false;
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
      names.push(name);
    }
    return names;
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  has(prefix: string): boolean {
    return [...this.cookies.keys()].some((name) => name.startsWith(prefix));
  }
}

type HttpOptions = {
  method?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  label: string;
  timeoutMs?: number;
  /** What to keep from the body in the transcript. */
  keep?: (text: string, response: Response) => unknown;
};

class Http {
  constructor(
    private readonly origin: string,
    private readonly evidence: Evidence,
    readonly jar = new CookieJar(),
  ) {}

  async request(pathname: string, options: HttpOptions): Promise<{ response: Response; text: string; bytes: Buffer }> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { ...options.headers };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    const response = await fetch(new URL(pathname, this.origin), {
      method,
      body: options.body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const setCookies = this.jar.store(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    const text = type.includes("pdf") ? "" : bytes.toString("utf8");
    this.evidence.transcript.push({
      at: new Date().toISOString(),
      label: options.label,
      method,
      path: pathname,
      status: response.status,
      location: response.headers.get("location"),
      issued: setCookies.length > 0 ? setCookies : undefined,
      body: redact(
        options.keep
          ? options.keep(text, response)
          : type.includes("json")
            ? safeJson(text)
            : type.includes("pdf")
              ? { pdfBytes: bytes.length }
              : { contentType: type, length: bytes.length },
      ),
    });
    return { response, text, bytes };
  }

  async json<T>(pathname: string, options: HttpOptions): Promise<{ status: number; body: T }> {
    const { response, text } = await this.request(pathname, options);
    return { status: response.status, body: safeJson(text) as T };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: text.slice(0, 200) };
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]!) : null;
}

/**
 * The login form's server action id. React renders it into the form for
 * no-JS posts: as `$ACTION_ID_<id>` when the action has no bound arguments, or
 * in the `$ACTION_<n>:0` descriptor `{"id":…}` when it does (useActionState
 * binds the previous state). The page has other forms (the sign-out button),
 * so the login form is the one with the email and password fields.
 */
function loginActionId(html: string): string {
  const form = (html.match(/<form\b[\s\S]*?<\/form>/g) ?? []).find(
    (candidate) => /\sname="email"/.test(candidate) && /\sname="password"/.test(candidate),
  );
  if (!form) throw new Error("the login page rendered no form with email and password fields");
  for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
    const name = attribute(tag, "name") ?? "";
    let id: unknown = null;
    if (name.startsWith("$ACTION_ID_")) id = name.slice("$ACTION_ID_".length);
    else if (/^\$ACTION_[^:]+:0$/.test(name)) id = (safeJson(attribute(tag, "value") ?? "") as { id?: unknown }).id;
    if (typeof id === "string" && /^[0-9a-f]{42}$/.test(id)) return id;
  }
  throw new Error("the login form carries no server action id");
}

/**
 * The action's return value from a Flight response. Row 0 is the payload
 * `{a: <result>, …}`, where the result is inline or a `$@<row>` reference to
 * the row that resolves it. Tagged rows (modules, hints, dev debug info) are
 * not JSON and are skipped.
 */
function flightActionResult(flight: string): unknown {
  const rows = new Map<string, unknown>();
  for (const line of flight.split("\n")) {
    const match = /^([0-9a-f]+):(.*)$/.exec(line);
    if (!match || rows.has(match[1]!)) continue;
    try {
      rows.set(match[1]!, JSON.parse(match[2]!));
    } catch {
      // Not a model row.
    }
  }
  let result = (rows.get("0") as { a?: unknown } | undefined)?.a;
  const reference = typeof result === "string" ? /^\$@([0-9a-f]+)$/.exec(result) : null;
  if (reference) result = rows.get(reference[1]!);
  return typeof result === "string" && result.startsWith("$$") ? result.slice(1) : result;
}

type SignInResult = { outcome: "signed_in" | "refused"; code: string | null; message: string | null };

async function signInViaCallback(http: Http, email: string, password: string, label: string): Promise<SignInResult> {
  const csrf = await http.json<{ csrfToken?: string }>("/api/auth/csrf", { label: `${label}: csrf` });
  if (!csrf.body.csrfToken) throw new Error("no csrfToken from /api/auth/csrf");
  const { response } = await http.request("/api/auth/callback/credentials", {
    method: "POST",
    label: `${label}: credentials callback`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf.body.csrfToken, email, password, callbackUrl: "/" }).toString(),
    keep: () => ({ fields: ["csrfToken", "email", "password", "callbackUrl"] }),
  });
  const location = response.headers.get("location") ?? "";
  const target = location ? new URL(location, "http://localhost") : null;
  const error = target?.searchParams.get("error") ?? null;
  if (
    response.status >= 300 &&
    response.status < 400 &&
    target &&
    !error &&
    !target.pathname.startsWith("/login") &&
    http.jar.has("authjs.session-token")
  ) {
    return { outcome: "signed_in", code: null, message: null };
  }
  return { outcome: "refused", code: target?.searchParams.get("code") ?? error, message: null };
}

/**
 * Submits the login form the way the hydrated page does: a fetch action
 * (`Next-Action: <id>`, `Accept: text/x-component`) whose body is React's
 * encodeReply of the action's arguments `[previous state, FormData]`. The
 * FormData's fields travel as `_1_<name>` and field `0` holds `[null,"$K1"]`.
 * A refusal comes back as the action's return value (the message the form
 * shows); a sign-in comes back as an `x-action-redirect` plus a session cookie.
 */
async function signInViaLoginPage(http: Http, email: string, password: string, label: string): Promise<SignInResult> {
  const page = await http.request("/login", { label: `${label}: login page`, keep: () => ({ html: true }) });
  const actionId = loginActionId(page.text);
  const form = new FormData();
  form.append("_1_email", email);
  form.append("_1_password", password);
  form.append("0", JSON.stringify([null, "$K1"]));
  const { response, text } = await http.request("/login", {
    method: "POST",
    label: `${label}: login page action`,
    headers: {
      origin: new URL(page.response.url).origin,
      accept: "text/x-component",
      "next-action": actionId,
    },
    body: form,
    keep: (flight, res) => {
      const result = flightActionResult(flight);
      return {
        contentType: res.headers.get("content-type"),
        actionRedirect: res.headers.get("x-action-redirect"),
        actionNotFound: res.headers.get("x-nextjs-action-not-found"),
        result,
        excerpt: typeof result === "string" ? undefined : flight.slice(0, 300),
      };
    },
  });
  const redirect = response.headers.get("x-action-redirect");
  if (redirect) {
    // The login action refuses by returning a message; a redirect to /login
    // means another action ran (sign-out), so the replay itself is wrong.
    if (new URL(redirect.split(";")[0]!, "http://localhost").pathname.startsWith("/login")) {
      throw new Error(`${label}: the login page action redirected to /login; the harness posted the wrong action`);
    }
    const signedIn = http.jar.has("authjs.session-token");
    return { outcome: signedIn ? "signed_in" : "refused", code: null, message: null };
  }
  if (
    response.headers.get("x-nextjs-action-not-found") === "1" ||
    !(response.headers.get("content-type") ?? "").startsWith("text/x-component")
  ) {
    throw new Error(`${label}: the login action answered ${response.status} without a Flight result`);
  }
  const result = flightActionResult(text);
  return { outcome: "refused", code: null, message: typeof result === "string" ? result : null };
}

async function sessionEmail(http: Http, label: string): Promise<string | null> {
  const session = await http.json<{ user?: { email?: string } } | null>("/api/auth/session", {
    label: `${label}: session`,
    keep: (text) => {
      const body = safeJson(text) as { user?: { email?: string } } | null;
      return { email: body?.user?.email ?? null };
    },
  });
  return session.body?.user?.email ?? null;
}

// ---------------------------------------------------------------- database

type Sql = NeonQueryFunction<false, false>;

async function query<T = Record<string, unknown>>(sql: Sql, text: string, params: unknown[] = []): Promise<T[]> {
  return (await sql.query(text, params)) as T[];
}

type Synthetic = { sql: Sql; runId: string; users: string[] };

async function createUser(ctx: Synthetic, role: string): Promise<{ id: string; email: string; password: string }> {
  const email = `${role}-${ctx.runId}@example.invalid`;
  const password = randomBytes(18).toString("base64url");
  const [row] = await query<{ id: string }>(
    ctx.sql,
    "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
    [email, await hashPassword(password), `Synthetic ${role}`],
  );
  ctx.users.push(email);
  return { id: row!.id, email, password };
}

async function createPack(ctx: Synthetic, userId: string, name: string): Promise<{ topicId: string; reviewerId: string }> {
  const [topic] = await query<{ id: string }>(
    ctx.sql,
    "INSERT INTO topics (user_id, name) VALUES ($1, $2) RETURNING id",
    [userId, `Synthetic ${ctx.runId}`],
  );
  const [reviewer] = await query<{ id: string }>(
    ctx.sql,
    "INSERT INTO reviewers (topic_id, name) VALUES ($1, $2) RETURNING id",
    [topic!.id, name],
  );
  return { topicId: topic!.id, reviewerId: reviewer!.id };
}

type JobSeed = {
  runId: string;
  minutesAgo: number;
  status: "queued" | "running" | "succeeded" | "failed" | "partial";
  mode: "full" | "single";
  intent: "generate_missing" | "redo";
  step: Kind | null;
  targetKinds: Kind[];
  completedKinds: Kind[];
};

type Kind = "locked_in" | "summary" | "test_me" | "carded";
const KINDS: Kind[] = ["locked_in", "summary", "test_me", "carded"];

async function insertJob(sql: Sql, userId: string, reviewerId: string, job: JobSeed): Promise<void> {
  const active = job.status === "queued" || job.status === "running";
  await query(
    sql,
    `INSERT INTO generation_jobs (
       user_id, reviewer_id, status, step, mode, intent, target_kinds, completed_kinds,
       generation_run_id, active, created_at, updated_at, finished_at
     ) VALUES (
       $1, $2, $3::generation_job_status, $4::generation_job_step, $5::generation_job_mode,
       $6::generation_job_intent, $7::jsonb, $8::jsonb, $9::uuid, $10::boolean,
       NOW() - make_interval(mins => $11::int), NOW() - make_interval(mins => $11::int),
       CASE WHEN $10::boolean THEN NULL ELSE NOW() - make_interval(mins => $11::int) END
     )`,
    [
      userId,
      reviewerId,
      job.status,
      job.step,
      job.mode,
      job.intent,
      JSON.stringify(job.targetKinds),
      JSON.stringify(job.completedKinds),
      job.runId,
      active,
      job.minutesAgo,
    ],
  );
}

type ViewSeed = {
  kind: Kind;
  runId: string | null;
  content: string;
  contentJson?: unknown;
  minutesAgo: number;
  isEdited?: boolean;
  revision?: number;
};

async function insertView(sql: Sql, reviewerId: string, view: ViewSeed): Promise<string> {
  const [row] = await query<{ id: string }>(
    sql,
    `INSERT INTO views (
       reviewer_id, kind, content, content_json, generation_run_id, is_edited, revision,
       content_revision, generated_at, updated_at
     ) VALUES (
       $1, $2::view_kind, $3, $4::jsonb, $5::uuid, $6::boolean, $7::int, $7::int,
       NOW() - make_interval(mins => $8::int), NOW() - make_interval(mins => $8::int)
     ) RETURNING id`,
    [
      reviewerId,
      view.kind,
      view.content,
      view.contentJson === undefined ? null : JSON.stringify(view.contentJson),
      view.runId,
      view.isEdited ?? false,
      view.revision ?? 1,
      view.minutesAgo,
    ],
  );
  return row!.id;
}

/** Row count and a digest of every row, per table, for one reviewer. */
async function snapshot(sql: Sql, reviewerId: string, tables: string[]): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const key = table === "reviewers" ? "id" : "reviewer_id";
    const [row] = await query<{ count: number; digest: string | null; updated: string | null }>(
      sql,
      `SELECT COUNT(*)::int AS count,
              md5(string_agg(row_to_json(t)::text, '|' ORDER BY t.id)) AS digest,
              ${["sources", "reviewers"].includes(table) ? "NULL" : "MAX(t.updated_at)::text"} AS updated
       FROM ${table} t WHERE t.${key} = $1`,
      [reviewerId],
    );
    result[table] = row;
  }
  return result;
}

async function cleanup(ctx: Synthetic): Promise<void> {
  if (ctx.users.length === 0) return;
  await query(ctx.sql, "DELETE FROM login_throttles WHERE email = ANY($1::text[])", [ctx.users]);
  await query(ctx.sql, "DELETE FROM users WHERE email = ANY($1::text[]) AND email LIKE '%@example.invalid'", [ctx.users]);
  ctx.users.length = 0;
}

// ---------------------------------------------------------------- preload log and control

type LogLine = {
  ts: string;
  event: string;
  service?: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  outcome?: string;
  generation?: number | null;
  dbHost?: string;
};

/** Preload services for the model (and Ask), vision, quota and Blob boundaries. */
const BOUNDARY_SERVICES = new Set(["model", "vision", "openrouter-quota", "openrouter", "blob"]);

/** Boundary services a scenario may be served by; everything else must stay unreached. */
const SERVED_BY_SCENARIO: Record<ScenarioName, Set<string>> = {
  S1a: new Set(),
  S2: new Set(),
  S3a: new Set(["vision", "openrouter-quota"]),
  S5a: new Set(),
};

/**
 * Traffic the scenario must not cause: anything not blocked by the preload
 * unless it is a controlled answer this scenario expects, and any attempt
 * on a boundary service even when blocked. Blocked dev tooling (Next's npm
 * version check) and other blocked hosts never reached the network.
 */
function unexpectedTraffic(lines: LogLine[], scenario: ScenarioName): LogLine[] {
  return lines.filter((line) =>
    line.outcome === "blocked"
      ? BOUNDARY_SERVICES.has(line.service ?? "")
      : line.outcome !== "served" || !SERVED_BY_SCENARIO[scenario].has(line.service ?? ""),
  );
}

class Services {
  private generation = 0;

  constructor(
    readonly logPath: string,
    readonly controlPath: string,
  ) {}

  offset(): number {
    return existsSync(this.logPath) ? statSync(this.logPath).size : 0;
  }

  linesSince(offset: number): LogLine[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath)
      .subarray(offset)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => safeJson(line) as LogLine);
  }

  /** External traffic other than the database, which the preload passes through. */
  externalSince(offset: number): LogLine[] {
    return this.linesSince(offset).filter(
      (line) => (line.event === "request" || line.event === "socket") && line.service !== "database",
    );
  }

  set(control: Record<string, unknown>): number {
    this.generation += 1;
    const temp = `${this.controlPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ generation: this.generation, ...control }));
    renameSync(temp, this.controlPath);
    return this.generation;
  }
}

// ---------------------------------------------------------------- S1a

async function scenarioS1a(ctx: Synthetic, origin: string, evidence: Evidence): Promise<void> {
  const user = await createUser(ctx, "s1a");
  const throttle = async (label: string) => {
    const rows = await query(
      ctx.sql,
      "SELECT failed_count, window_started_at, locked_until, updated_at, NOW() AS db_now FROM login_throttles WHERE email = $1",
      [user.email],
    );
    evidence.db(label, rows);
    return rows[0] as { failed_count: number; locked_until: Date | null; db_now: Date } | undefined;
  };

  evidence.must("no throttle row before the run", (await throttle("throttle before")) === undefined);

  // Five wrong passwords, alternating the callback and the login page action.
  const wrong = `${user.password}-wrong`;
  const attempts: Array<{ via: "callback" | "page"; expectLocked: boolean }> = [
    { via: "callback", expectLocked: false },
    { via: "page", expectLocked: false },
    { via: "callback", expectLocked: false },
    { via: "page", expectLocked: false },
    { via: "callback", expectLocked: true },
  ];
  for (const [index, attempt] of attempts.entries()) {
    const number = index + 1;
    const http = new Http(origin, evidence);
    const result =
      attempt.via === "callback"
        ? await signInViaCallback(http, user.email, wrong, `wrong #${number}`)
        : await signInViaLoginPage(http, user.email, wrong, `wrong #${number}`);
    evidence.check(`wrong #${number} (${attempt.via}) is refused`, result.outcome === "refused", result);
    if (attempt.via === "callback") {
      const expected = attempt.expectLocked ? "login_locked" : "invalid_credentials";
      evidence.check(`wrong #${number} callback code is ${expected}`, result.code === expected, result);
    } else {
      evidence.check(`wrong #${number} page shows the invalid message`, result.message === INVALID_MESSAGE, result);
    }
    const row = await throttle(`throttle after wrong #${number}`);
    evidence.check(`shared counter is ${number} after wrong #${number}`, row?.failed_count === number, row);
  }

  const locked = await throttle("throttle at lock");
  const lockedUntil = locked?.locked_until ? new Date(locked.locked_until) : null;
  evidence.check(
    "lock lasts about 15 minutes",
    lockedUntil !== null &&
      locked !== undefined &&
      Math.abs(lockedUntil.getTime() - new Date(locked.db_now).getTime() - 15 * 60_000) < 60_000,
    { lockedUntil, dbNow: locked?.db_now },
  );

  const correctCallback = await signInViaCallback(new Http(origin, evidence), user.email, user.password, "correct during lock");
  evidence.check(
    "correct password via callback is refused with login_locked",
    correctCallback.outcome === "refused" && correctCallback.code === "login_locked",
    correctCallback,
  );
  const correctPage = await signInViaLoginPage(new Http(origin, evidence), user.email, user.password, "correct during lock");
  evidence.check(
    "correct password via login page shows the locked message",
    correctPage.outcome === "refused" && correctPage.message === LOCKED_MESSAGE,
    correctPage,
  );
  const during = await throttle("throttle after correct attempts during lock");
  evidence.check(
    "a refused correct password leaves the lock unchanged",
    during?.failed_count === 5 &&
      during?.locked_until !== null &&
      new Date(during!.locked_until!).getTime() === lockedUntil?.getTime(),
    during,
  );

  // Stand-in for 15 minutes passing: age only this synthetic row.
  await query(
    ctx.sql,
    `UPDATE login_throttles
     SET locked_until = locked_until - INTERVAL '16 minutes',
         window_started_at = window_started_at - INTERVAL '16 minutes'
     WHERE email = $1 AND email LIKE '%@example.invalid'`,
    [user.email],
  );
  evidence.notes.push("S1a aged the synthetic throttle row by 16 minutes to simulate lock expiry.");
  await throttle("throttle after aging");

  const afterCallback = new Http(origin, evidence);
  const expired = await signInViaCallback(afterCallback, user.email, user.password, "correct after expiry");
  evidence.check("correct password via callback signs in after expiry", expired.outcome === "signed_in", expired);
  evidence.check(
    "the session belongs to the synthetic user",
    (await sessionEmail(afterCallback, "after expiry")) === user.email,
  );
  evidence.check("the throttle row is cleared", (await throttle("throttle after sign-in")) === undefined);

  const pageHttp = new Http(origin, evidence);
  const pageSignIn = await signInViaLoginPage(pageHttp, user.email, user.password, "correct via page after expiry");
  evidence.check(
    "correct password via login page signs in",
    pageSignIn.outcome === "signed_in" && pageHttp.jar.has("authjs.session-token"),
    pageSignIn,
  );
  evidence.check(
    "the login page session belongs to the synthetic user",
    (await sessionEmail(pageHttp, "after page sign-in")) === user.email,
  );
}

// ---------------------------------------------------------------- S2

type S2Case = {
  name: string;
  jobs: Array<Omit<JobSeed, "runId"> & { run: string }>;
  views: Array<{ kind: Kind; run: string | null; minutesAgo: number; isEdited?: boolean; revision?: number }>;
  visible: Kind[];
  /** Kinds that must be listed in staleKinds; null means staleKinds must be empty. */
  stale: Kind[] | null;
};

const S2_CASES: S2Case[] = [
  {
    name: "full, then Summary redo, then Carded redo",
    jobs: [
      { run: "R1", minutesAgo: 30, status: "succeeded", mode: "full", intent: "redo", step: "carded", targetKinds: KINDS, completedKinds: KINDS },
      { run: "R2", minutesAgo: 20, status: "succeeded", mode: "single", intent: "redo", step: "summary", targetKinds: ["summary"], completedKinds: ["summary"] },
      { run: "R3", minutesAgo: 10, status: "succeeded", mode: "single", intent: "redo", step: "carded", targetKinds: ["carded"], completedKinds: ["carded"] },
    ],
    views: [
      { kind: "locked_in", run: "R1", minutesAgo: 30 },
      { kind: "summary", run: "R2", minutesAgo: 20 },
      { kind: "test_me", run: "R1", minutesAgo: 30 },
      { kind: "carded", run: "R3", minutesAgo: 10 },
    ],
    visible: KINDS,
    stale: null,
  },
  {
    name: "Generate missing, then Test Me redo",
    jobs: [
      { run: "R1", minutesAgo: 30, status: "partial", mode: "full", intent: "redo", step: "test_me", targetKinds: KINDS, completedKinds: ["locked_in", "summary"] },
      { run: "R2", minutesAgo: 20, status: "succeeded", mode: "full", intent: "generate_missing", step: "carded", targetKinds: ["test_me", "carded"], completedKinds: ["test_me", "carded"] },
      { run: "R3", minutesAgo: 10, status: "succeeded", mode: "single", intent: "redo", step: "test_me", targetKinds: ["test_me"], completedKinds: ["test_me"] },
    ],
    views: [
      { kind: "locked_in", run: "R1", minutesAgo: 30 },
      { kind: "summary", run: "R1", minutesAgo: 30 },
      { kind: "test_me", run: "R3", minutesAgo: 10 },
      { kind: "carded", run: "R2", minutesAgo: 20 },
    ],
    visible: KINDS,
    stale: null,
  },
  {
    name: "partial failed full redo replaces the earlier run",
    jobs: [
      { run: "R1", minutesAgo: 30, status: "succeeded", mode: "full", intent: "redo", step: "carded", targetKinds: KINDS, completedKinds: KINDS },
      { run: "R2", minutesAgo: 10, status: "partial", mode: "full", intent: "redo", step: "test_me", targetKinds: KINDS, completedKinds: ["locked_in", "summary"] },
    ],
    views: [
      { kind: "locked_in", run: "R2", minutesAgo: 10 },
      { kind: "summary", run: "R2", minutesAgo: 10 },
      { kind: "test_me", run: "R1", minutesAgo: 30 },
      { kind: "carded", run: "R1", minutesAgo: 30 },
    ],
    visible: ["locked_in", "summary"],
    stale: ["test_me", "carded"],
  },
  {
    name: "active Summary redo hides only Summary",
    jobs: [
      { run: "R1", minutesAgo: 30, status: "succeeded", mode: "full", intent: "redo", step: "carded", targetKinds: KINDS, completedKinds: KINDS },
      { run: "R2", minutesAgo: 1, status: "running", mode: "single", intent: "redo", step: "summary", targetKinds: ["summary"], completedKinds: [] },
    ],
    views: KINDS.map((kind) => ({ kind, run: "R1", minutesAgo: 30 })),
    visible: ["locked_in", "test_me", "carded"],
    stale: ["summary"],
  },
  {
    name: "protected manual Locked In edit stays visible",
    jobs: [
      { run: "R1", minutesAgo: 30, status: "succeeded", mode: "full", intent: "redo", step: "carded", targetKinds: KINDS, completedKinds: KINDS },
    ],
    views: [
      { kind: "locked_in", run: "R1", minutesAgo: 5, isEdited: true, revision: 2 },
      { kind: "summary", run: "R1", minutesAgo: 30 },
      { kind: "test_me", run: "R1", minutesAgo: 30 },
      { kind: "carded", run: "R1", minutesAgo: 30 },
    ],
    visible: KINDS,
    stale: ["summary", "test_me", "carded"],
  },
  {
    name: "pre-boundary rows stay hidden after a failed full redo",
    jobs: [
      { run: "R1", minutesAgo: 40, status: "succeeded", mode: "full", intent: "redo", step: "carded", targetKinds: KINDS, completedKinds: KINDS },
      { run: "R2", minutesAgo: 30, status: "succeeded", mode: "single", intent: "redo", step: "summary", targetKinds: ["summary"], completedKinds: ["summary"] },
      { run: "R3", minutesAgo: 10, status: "failed", mode: "full", intent: "redo", step: "summary", targetKinds: KINDS, completedKinds: ["locked_in"] },
    ],
    views: [
      { kind: "locked_in", run: "R3", minutesAgo: 10 },
      { kind: "summary", run: "R2", minutesAgo: 30 },
      { kind: "test_me", run: "R1", minutesAgo: 40 },
      { kind: "carded", run: null, minutesAgo: 50 },
    ],
    visible: ["locked_in"],
    stale: ["summary", "test_me", "carded"],
  },
];

type ViewsPayload = Record<Kind, { content: string; generationRunId: string | null; isEdited: boolean } | null> & {
  staleKinds?: string[];
};

function viewToken(caseIndex: number, kind: Kind): string {
  return `zqcase${caseIndex + 1}${kind.replace("_", "")}token`;
}

async function scenarioS2(ctx: Synthetic, origin: string, evidence: Evidence): Promise<void> {
  const owner = await createUser(ctx, "s2-owner");
  const http = new Http(origin, evidence);
  evidence.must("owner signs in", (await signInViaCallback(http, owner.email, owner.password, "owner")).outcome === "signed_in");

  for (const [index, testCase] of S2_CASES.entries()) {
    const label = `case ${index + 1} (${testCase.name})`;
    const pack = await createPack(ctx, owner.id, `Synthetic S2 case ${index + 1}`);
    const runs = new Map<string, string>();
    const runFor = (name: string) => {
      if (!runs.has(name)) runs.set(name, randomUUID());
      return runs.get(name)!;
    };
    for (const job of testCase.jobs) {
      const { run, ...rest } = job;
      await insertJob(ctx.sql, owner.id, pack.reviewerId, { ...rest, runId: runFor(run) });
    }
    for (const view of testCase.views) {
      await insertView(ctx.sql, pack.reviewerId, {
        kind: view.kind,
        runId: view.run === null ? null : runFor(view.run),
        content: viewContent(view.kind, viewToken(index, view.kind)),
        contentJson: viewJson(view.kind, viewToken(index, view.kind)),
        minutesAgo: view.minutesAgo,
        isEdited: view.isEdited,
        revision: view.revision,
      });
    }
    const before = await snapshot(ctx.sql, pack.reviewerId, ["views", "generation_jobs"]);
    evidence.db(`${label}: seeded`, { runs: Object.fromEntries(runs), rows: before });

    const views = await http.json<ViewsPayload>(`/api/reviewers/${pack.reviewerId}/views`, {
      label: `${label}: views`,
      keep: (text) => summarizeViews(safeJson(text) as ViewsPayload),
    });
    evidence.check(`${label}: views answers 200`, views.status === 200);
    for (const kind of KINDS) {
      const seeded = testCase.views.find((view) => view.kind === kind)!;
      const row = views.body[kind];
      if (testCase.visible.includes(kind)) {
        evidence.check(
          `${label}: ${kind} is visible from its run`,
          row !== null &&
            row.content.includes(viewToken(index, kind)) &&
            row.generationRunId === (seeded.run === null ? null : runFor(seeded.run)) &&
            row.isEdited === (seeded.isEdited ?? false),
          summarizeViews(views.body)[kind],
        );
      } else {
        evidence.check(`${label}: ${kind} is hidden`, row === null, summarizeViews(views.body)[kind]);
      }
    }
    const stale = views.body.staleKinds ?? [];
    evidence.check(
      `${label}: staleKinds ${testCase.stale === null ? "is empty" : `lists ${testCase.stale.join(", ")}`}`,
      testCase.stale === null ? stale.length === 0 : testCase.stale.every((kind) => stale.includes(kind)),
      { staleKinds: stale },
    );

    for (const kind of ["locked_in", "summary"] as const) {
      const page = await http.request(`/topics/${pack.topicId}/reviewers/${pack.reviewerId}/print?kind=${kind}`, {
        label: `${label}: print ${kind}`,
        keep: (html) => ({ shownKinds: KINDS.filter((each) => html.includes(viewToken(index, each))) }),
      });
      const shown = page.text.includes(viewToken(index, kind));
      evidence.check(
        `${label}: print ${kind} ${testCase.visible.includes(kind) ? "shows" : "omits"} its content`,
        page.response.status === 200 && shown === testCase.visible.includes(kind),
        { status: page.response.status, shown },
      );
    }

    const after = await snapshot(ctx.sql, pack.reviewerId, ["views", "generation_jobs"]);
    evidence.db(`${label}: after reads`, after);
    evidence.check(`${label}: reads changed no rows`, JSON.stringify(after) === JSON.stringify(before));
  }
}

function viewContent(kind: Kind, token: string): string {
  if (kind === "locked_in") return `## Synthetic section\n\nSynthetic Locked In ${token} for verification.`;
  if (kind === "summary") return `## Synthetic summary\n\nSynthetic Summary ${token}.`;
  if (kind === "test_me") return JSON.stringify([{ id: "q1", question: `Synthetic question ${token}?`, choices: ["A", "B", "C", "D"], answer: "A" }]);
  return JSON.stringify([{ id: "c1", front: `Synthetic front ${token}`, back: "Synthetic back" }]);
}

function viewJson(kind: Kind, token: string): unknown {
  if (kind === "carded") return [{ id: "c1", front: `Synthetic front ${token}`, back: "Synthetic back" }];
  if (kind === "test_me") return JSON.parse(viewContent(kind, token));
  return undefined;
}

function summarizeViews(body: ViewsPayload | null): Record<string, unknown> {
  if (!body || typeof body !== "object") return { body };
  return {
    ...Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        body[kind]
          ? { generationRunId: body[kind]!.generationRunId, isEdited: body[kind]!.isEdited, length: body[kind]!.content.length }
          : null,
      ]),
    ),
    staleKinds: body.staleKinds,
  };
}

// ---------------------------------------------------------------- S3a

function multipart(fields: Array<[string, string] | [string, Buffer, string]>): { body: Buffer; type: string } {
  const boundary = `----verify${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const field of fields) {
    if (field.length === 2) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field[0]}"\r\n\r\n${field[1]}\r\n`));
    } else {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field[0]}"; filename="${field[2]}"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        field[1],
        Buffer.from("\r\n"),
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/** Reasons OpenRouter gives for a key or model it refuses. */
const PROVIDER_SETUP_MESSAGES: Record<number, string> = {
  401: "No auth credentials found",
  403: "Key is disabled",
  404: "No endpoints found for this model",
};

const LONG_PAGE_TEXT =
  "Synthetic lecture page one. This page carries enough extracted text that it is not sent for slide reading. ".repeat(3);

async function seedScannedSource(ctx: Synthetic, reviewerId: string, label: string): Promise<{ id: string; text: string }> {
  const text = [
    "<<<page 1>>>",
    "",
    LONG_PAGE_TEXT.trim(),
    "",
    "<<<page 2>>>",
    "",
    "Fig. 2",
    "",
    "<<<page 3>>>",
    "",
    "Fig. 3",
  ].join("\n");
  const [row] = await query<{ id: string }>(
    ctx.sql,
    `INSERT INTO sources (reviewer_id, filename, mime, kind, blob_pathname, ingest_status, extracted_text)
     VALUES ($1, $2, 'application/pdf', 'pdf', $3, 'ready', $4) RETURNING id`,
    [reviewerId, `synthetic-${label}.pdf`, `synthetic/${ctx.runId}/${label}/${randomUUID()}.pdf`, text],
  );
  return { id: row!.id, text };
}

async function sourceText(sql: Sql, sourceId: string): Promise<string> {
  const [row] = await query<{ extracted_text: string }>(sql, "SELECT extracted_text FROM sources WHERE id = $1", [sourceId]);
  return row?.extracted_text ?? "";
}

function pageBody(text: string, page: number): string {
  const match = new RegExp(`<<<page ${page}>>>([\\s\\S]*?)(?=<<<page \\d+>>>|$)`).exec(text);
  return match?.[1]?.trim() ?? "";
}

async function scenarioS3a(
  ctx: Synthetic,
  origin: string,
  evidence: Evidence,
  services: Services,
  jpeg: Buffer,
): Promise<void> {
  const owner = await createUser(ctx, "s3a-owner");
  const http = new Http(origin, evidence);
  evidence.must("owner signs in", (await signInViaCallback(http, owner.email, owner.password, "owner")).outcome === "signed_in");
  const pack = await createPack(ctx, owner.id, "Synthetic S3a pack");
  const source = await seedScannedSource(ctx, pack.reviewerId, "s3a");
  evidence.db("source seeded", { sourceId: source.id, pages: { 2: pageBody(source.text, 2), 3: pageBody(source.text, 3) } });
  const pagesPath = `/api/reviewers/${pack.reviewerId}/sources/${source.id}/pages`;

  const pending = async (label: string) =>
    (await http.json<{ pending?: number[] }>(pagesPath, { label })).body.pending ?? [];
  evidence.check("pages 2 and 3 start pending", JSON.stringify(await pending("pending at start")) === "[2,3]");

  const post = async (label: string, page: number, last: boolean) => {
    const form = multipart([
      ["page", String(page)],
      ["image", jpeg, `page-${page}.jpg`],
      ...(last ? ([["last", "1"]] as Array<[string, string]>) : []),
    ]);
    return http.json<{ error?: string; read?: number[]; pending?: number[]; unreadable?: number[] }>(pagesPath, {
      method: "POST",
      label,
      headers: { "content-type": form.type, "content-length": String(form.body.length) },
      body: new Uint8Array(form.body),
      timeoutMs: 150_000,
    });
  };

  for (const status of [401, 403, 404]) {
    const offset = services.offset();
    const reason = PROVIDER_SETUP_MESSAGES[status]!;
    const generation = services.set({ vision: { status, message: reason } });
    const answer = await post(`vision ${status}, last try`, 2, true);
    evidence.check(`vision ${status}: route answers 502`, answer.status === 502, answer.body);
    evidence.check(`vision ${status}: setup message`, answer.body.error === VISION_SETUP_MESSAGE, answer.body);
    evidence.check(`vision ${status}: the provider's reason is not shown`, !JSON.stringify(answer.body).includes(reason));
    const text = await sourceText(ctx.sql, source.id);
    evidence.db(`source after vision ${status}`, { page2: pageBody(text, 2) });
    evidence.check(`vision ${status}: source text unchanged`, text === source.text);
    evidence.check(`vision ${status}: no "${NO_READABLE_CONTENT}" written`, !text.includes(NO_READABLE_CONTENT));
    evidence.check(`vision ${status}: page 2 still pending`, (await pending(`pending after vision ${status}`)).includes(2));
    const calls = services.externalSince(offset).filter((line) => line.service === "vision");
    evidence.check(
      `vision ${status}: the controlled boundary answered`,
      calls.length > 0 && calls.every((line) => line.status === status && line.generation === generation),
      calls,
    );
  }

  const reading = `zqs3areadingtoken page two reading`;
  services.set({ vision: { status: 200, text: `<<<page 2>>>\n${reading}` } });
  const success = await post("vision success", 2, false);
  evidence.check("vision success: page 2 is read", success.status === 200 && JSON.stringify(success.body.read) === "[2]", success.body);
  const afterSuccess = await sourceText(ctx.sql, source.id);
  evidence.db("source after success", { page2: pageBody(afterSuccess, 2), page3: pageBody(afterSuccess, 3) });
  evidence.check("vision success: reading stored under the slide image marker", pageBody(afterSuccess, 2).includes(`<<<slide image>>>\n${reading}`));
  evidence.check("vision success: only page 3 pending", JSON.stringify(await pending("pending after success")) === "[3]");

  services.set({ vision: { status: 400, message: "Invalid image data" } });
  const refused = await post("vision 400 naming the image, last try", 3, true);
  evidence.check(
    "vision 400: page 3 settles as unreadable",
    refused.status === 200 && JSON.stringify(refused.body.unreadable) === "[3]",
    refused.body,
  );
  const afterRefusal = await sourceText(ctx.sql, source.id);
  evidence.db("source after 400", { page3: pageBody(afterRefusal, 3) });
  evidence.check(`vision 400: page 3 records "${NO_READABLE_CONTENT}"`, pageBody(afterRefusal, 3).includes(NO_READABLE_CONTENT));
  evidence.check("vision 400: nothing pending", JSON.stringify(await pending("pending after 400")) === "[]");
}

// ---------------------------------------------------------------- S5a

const S5A_TABLES = ["cards", "views", "generation_jobs", "study_annotations", "sources", "reviewers"];
const S5A_TABLE_TOKENS = { locked_in: "zqs5alockedintable", summary: "zqs5asummarytable" } as const;
const DISPLAY_TEX = String.raw`E_k = \frac{1}{2} m v^2`;
const INLINE_TEX = String.raw`v = \frac{d}{t}`;

/** Inline math, display math and a GFM table, in the reader's syntax (remark-math, remark-gfm). */
function richStudyBlock(tableToken: string): string {
  return [
    "",
    `Speed is $${INLINE_TEX}$ for a steady trip [S1 p.1].`,
    "",
    "$$",
    DISPLAY_TEX,
    "$$",
    "",
    "| Quantity | Value |",
    "| --- | --- |",
    `| ${tableToken} | 42 |`,
  ].join("\n");
}

/**
 * What the print page rendered for the rich block: KaTeX MathML for both math
 * spans (display math carries display="block") and an HTML table holding the
 * token. Checked on the page's HTML, not its Flight payload.
 */
function richRendering(html: string, tableToken: string) {
  const maths = html.match(/<math\b[^>]*>[\s\S]*?<\/math>/g) ?? [];
  const display = maths.find((math) => /^<math\b[^>]*\sdisplay="block"/.test(math));
  const inline = maths.find((math) => !/^<math\b[^>]*\sdisplay="block"/.test(math) && math.includes(INLINE_TEX));
  return {
    katex: html.includes('class="katex"'),
    displayMath: Boolean(display?.includes(DISPLAY_TEX)),
    inlineMath: Boolean(inline),
    table: (html.match(/<table\b[\s\S]*?<\/table>/g) ?? []).some((table) => table.includes(tableToken)),
  };
}

async function scenarioS5a(ctx: Synthetic, origin: string, evidence: Evidence, services: Services, outDir: string): Promise<void> {
  const owner = await createUser(ctx, "s5a-owner");
  const other = await createUser(ctx, "s5a-other");
  const http = new Http(origin, evidence);
  const otherHttp = new Http(origin, evidence);
  evidence.must("owner signs in", (await signInViaCallback(http, owner.email, owner.password, "owner")).outcome === "signed_in");
  evidence.must("other owner signs in", (await signInViaCallback(otherHttp, other.email, other.password, "other")).outcome === "signed_in");

  const pack = await createPack(ctx, owner.id, "Synthetic S5a pack");
  const runId = randomUUID();
  await insertJob(ctx.sql, owner.id, pack.reviewerId, {
    runId, minutesAgo: 30, status: "succeeded", mode: "full", intent: "redo", step: "carded", targetKinds: KINDS, completedKinds: KINDS,
  });
  const lockedIn = `## Synthetic section\n\nzqs5alockedintoken is the first claim [S1 p.1]. A second synthetic sentence follows [S1 p.1].\n${richStudyBlock(S5A_TABLE_TOKENS.locked_in)}`;
  const lockedInId = await insertView(ctx.sql, pack.reviewerId, { kind: "locked_in", runId, content: lockedIn, minutesAgo: 30 });
  await insertView(ctx.sql, pack.reviewerId, {
    kind: "summary",
    runId,
    content: `## Synthetic summary\n\nzqs5asummarytoken in brief [S1 p.1].\n${richStudyBlock(S5A_TABLE_TOKENS.summary)}`,
    minutesAgo: 30,
  });
  await insertView(ctx.sql, pack.reviewerId, { kind: "test_me", runId, content: viewContent("test_me", "zqs5atestme"), contentJson: viewJson("test_me", "zqs5atestme"), minutesAgo: 30 });
  const cardItems = [
    { id: "c1", front: "zqs5acardfront one", back: "Synthetic back one [S1 p.1]" },
    { id: "c2", front: "zqs5acardfront two", back: "Synthetic back two [S1 p.1]" },
  ];
  await insertView(ctx.sql, pack.reviewerId, { kind: "carded", runId, content: JSON.stringify(cardItems), contentJson: cardItems, minutesAgo: 30 });
  const quote = "zqs5alockedintoken is the first claim";
  const start = lockedIn.indexOf(quote);
  await query(
    ctx.sql,
    `INSERT INTO study_annotations (user_id, reviewer_id, view_id, kind, content_revision, start_offset, end_offset, quote, note)
     VALUES ($1, $2, $3, 'locked_in', 1, $4, $5, $6, 'zqs5anotetoken')`,
    [owner.id, pack.reviewerId, lockedInId, start, start + quote.length, quote],
  );
  const source = await seedScannedSource(ctx, pack.reviewerId, "s5a");

  const pending = await http.json<{ pending?: number[] }>(`/api/reviewers/${pack.reviewerId}/sources/${source.id}/pages`, {
    label: "pending scanned pages",
  });
  evidence.check("the pack has a pending scanned page", (pending.body.pending ?? []).length > 0, pending.body);

  const before = await snapshot(ctx.sql, pack.reviewerId, S5A_TABLES);
  const [cardRows] = await query<{ count: number }>(ctx.sql, "SELECT COUNT(*)::int AS count FROM cards WHERE reviewer_id = $1", [pack.reviewerId]);
  evidence.check("Carded has items but no saved card rows", cardRows!.count === 0);
  evidence.db("before exports", before);

  services.set({});
  const offset = services.offset();
  const pdfDir = path.join(outDir, "S5a");
  mkdirSync(pdfDir, { recursive: true });
  const exports: Array<{ kind: string; citations: string; notes: string }> = [];
  for (const kind of ["locked_in", "summary"]) {
    for (const citations of ["on", "off"]) {
      for (const notes of ["on", "off"]) exports.push({ kind, citations, notes });
    }
  }
  exports.push({ kind: "packet", citations: "on", notes: "on" }, { kind: "packet", citations: "off", notes: "off" });

  for (const entry of exports) {
    const params = `kind=${entry.kind}&citations=${entry.citations}&notes=${entry.notes}`;
    const { response, bytes } = await http.request(`/api/reviewers/${pack.reviewerId}/pdf?${params}`, {
      label: `pdf ${params}`,
      timeoutMs: 120_000,
    });
    const isPdf =
      response.status === 200 &&
      (response.headers.get("content-type") ?? "").includes("application/pdf") &&
      bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) writeFileSync(path.join(pdfDir, `${entry.kind}-citations-${entry.citations}-notes-${entry.notes}.pdf`), bytes);
    evidence.check(`pdf ${params} is a PDF`, isPdf, { status: response.status, bytes: bytes.length });
  }

  // The pages the Locked In and Summary PDFs print, read inside the no-write window.
  for (const kind of ["locked_in", "summary"] as const) {
    const token = S5A_TABLE_TOKENS[kind];
    const page = await http.request(`/topics/${pack.topicId}/reviewers/${pack.reviewerId}/print?kind=${kind}`, {
      label: `print ${kind}`,
      keep: (html) => richRendering(html, token),
    });
    const rendered = richRendering(page.text, token);
    evidence.check(
      `print ${kind} renders KaTeX display and inline math and the table`,
      page.response.status === 200 && Object.values(rendered).every(Boolean),
      { status: page.response.status, ...rendered },
    );
  }

  for (const kind of ["locked_in", "summary", "packet"]) {
    const answer = await otherHttp.request(`/api/reviewers/${pack.reviewerId}/pdf?kind=${kind}`, { label: `other owner pdf ${kind}` });
    evidence.check(`another owner's pdf ${kind} is 404`, answer.response.status === 404);
  }
  // These pages stream their loading UI before the ownership check calls
  // notFound(), so the status can already be 200; the body must be the
  // not-found page with none of the owner's content.
  for (const page of ["print?kind=locked_in", "print?kind=summary", "packet"]) {
    const answer = await otherHttp.request(`/topics/${pack.topicId}/reviewers/${pack.reviewerId}/${page}`, {
      label: `other owner ${page}`,
      keep: (html) => ({ notFound: html.includes(NOT_FOUND_MARKER), leaked: html.includes("zqs5a") }),
    });
    const status = answer.response.status;
    const notFound = answer.text.includes(NOT_FOUND_MARKER);
    const leaked = answer.text.includes("zqs5a");
    evidence.check(
      `another owner's ${page} renders the not-found page without owner content`,
      (status === 200 || status === 404) && notFound && !leaked,
      { status, notFound, leaked },
    );
  }

  const after = await snapshot(ctx.sql, pack.reviewerId, S5A_TABLES);
  evidence.db("after exports", after);
  for (const table of S5A_TABLES) {
    evidence.check(`${table}: no row or updated_at change`, JSON.stringify(after[table]) === JSON.stringify(before[table]), {
      before: before[table],
      after: after[table],
    });
  }
  const external = services.externalSince(offset);
  evidence.check(
    "zero outbound model, vision, Ask, quota or Blob requests during exports",
    external.every((line) => line.outcome === "blocked" && !BOUNDARY_SERVICES.has(line.service ?? "")),
    external,
  );
}

// ---------------------------------------------------------------- main

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = requiredEnv("DATABASE_URL");
  const allowedHost = requiredEnv("ALLOWED_DB_HOST").toLowerCase();
  let dbHost: string;
  try {
    dbHost = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    die("DATABASE_URL is not a URL");
  }
  if (dbHost !== allowedHost) die("DATABASE_URL host does not equal ALLOWED_DB_HOST; refusing");

  const services = new Services(requiredEnv("CONTROLLED_SERVICES_LOG"), requiredEnv("CONTROLLED_SERVICES_CONTROL"));
  const ready = services.linesSince(0).filter((line) => line.event === "preload_ready");
  if (!ready.some((line) => line.dbHost === allowedHost)) {
    die("the preload log has no preload_ready line for ALLOWED_DB_HOST; start the server with the preload");
  }

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${randomBytes(3).toString("hex")}`;
  const outDir = path.join(args.out, runId);
  mkdirSync(outDir, { recursive: true });
  const jpeg = readFileSync(path.join(args.fixtures, "page.jpg"));
  const sql = neon(databaseUrl);
  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);

  // Compile the shell once so first-render work lands before any scenario's log window.
  const warm = await fetch(new URL("/login", args.origin), { redirect: "manual", signal: AbortSignal.timeout(120_000) });
  if (warm.status !== 200) die(`GET /login answered ${warm.status}; is the server running at ${args.origin}?`);

  const summary: Record<string, unknown> = {};
  for (const name of args.scenarios) {
    console.log(`${name}`);
    const evidence = new Evidence();
    const ctx: Synthetic = { sql, runId: `${runId.toLowerCase()}-${name.toLowerCase()}`, users: [] };
    const offset = services.offset();
    services.set({});
    let error: string | null = null;
    try {
      if (name === "S1a") await scenarioS1a(ctx, args.origin, evidence);
      if (name === "S2") await scenarioS2(ctx, args.origin, evidence);
      if (name === "S3a") await scenarioS3a(ctx, args.origin, evidence, services, jpeg);
      if (name === "S5a") await scenarioS5a(ctx, args.origin, evidence, services, outDir);
      const traffic = services.externalSince(offset);
      const unexpected = unexpectedTraffic(traffic, name);
      evidence.check("no unexpected or real external traffic during the scenario", unexpected.length === 0, unexpected);
      const blocked = traffic.filter((line) => line.outcome === "blocked" && !unexpected.includes(line));
      if (blocked.length > 0) {
        evidence.notes.push(
          `The preload blocked ${blocked.length} non-boundary request(s): ${[...new Set(blocked.map((line) => `${line.service} ${line.host}`))].join(", ")}.`,
        );
      }
    } catch (caught) {
      error = redactString(caught instanceof Error ? caught.message : String(caught));
      console.log(`  ERROR ${error}`);
    } finally {
      try {
        await cleanup(ctx);
        evidence.notes.push("Synthetic users and their rows were deleted.");
      } catch (caught) {
        evidence.notes.push(`Cleanup failed: ${redactString(String(caught))}`);
        error ??= "cleanup failed";
      }
    }
    const passed = error === null && evidence.passed;
    const report = {
      scenario: name,
      passed,
      error,
      startedAt: evidence.startedAt,
      finishedAt: new Date().toISOString(),
      origin: args.origin,
      dbHost: allowedHost,
      head,
      dirtyFiles: dirty,
      checks: evidence.checks,
      database: evidence.database,
      transcript: evidence.transcript,
      externalTraffic: services.externalSince(offset),
      notes: evidence.notes,
    };
    writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(redact(report), null, 2)}\n`);
    summary[name] = { passed, error, failed: evidence.checks.filter((check) => !check.pass).map((check) => check.name) };
    console.log(`  ${passed ? "PASSED" : "FAILED"}`);
  }

  services.set({});
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify({ runId, head, dirtyFiles: dirty, summary }, null, 2)}\n`);
  console.log(`evidence: ${outDir}`);
  const allPassed = Object.values(summary).every((entry) => (entry as { passed: boolean }).passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error(redactString(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(2);
});
