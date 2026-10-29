import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { OPENCODE_PIN } from "../src/opencode.js";

/**
 * A scriptable stand-in for `opencode serve`: the single substitution boundary in the test strategy.
 * Speaks the subset of OpenCode 1.19's HTTP + SSE protocol Cheap Agent uses, with the same paths and
 * event shapes as `@opencode-ai/sdk/v2`. Auth is accepted and ignored.
 *
 * Each `prompt_async` runs the first `fake.scriptFor(match, ...)` script its text contains, else the next queued
 * script (`fake.script(...)`); with none queued it just goes idle.
 */

/** Model as `prompt_async` takes it. */
export type Model = { providerID: string; modelID: string };
/** Model as `POST /session` takes it (note: `id`, not `modelID`). */
export type SessionModel = { id: string; providerID: string; variant?: string };
/** The custom `finish` tool's arguments (spec D8). */
export type FinishReport = { summary: string; risks: string[]; review: string[]; missing: string[] };
type Usage = { cost: number; input?: number; output?: number; reasoning?: number };

/** One scripted thing the worker does. ("Action", not "step": a step is a plan unit.) */
export type Action =
  /** Writes a file (relative to the session's directory) and emits `file.edited`. */
  | { edit: string; content: string }
  /** One tool turn: a completed (or errored) tool part. */
  | { tool: string; input?: Record<string, unknown>; output?: string; error?: string }
  /** Adds to the current model step's assistant message; emits `message.updated` with that message's running totals. */
  | { usage: Usage }
  /** Assistant text, e.g. a fenced `cheapag-result` block. */
  | { text: string }
  /** Asks via the question tool, then pauses until Cheap Agent replies or rejects. */
  | { question: string; options: string[]; header?: string }
  /** Asks several questions in one question-tool call. */
  | { questions: { question: string; options: string[] }[] }
  /** Requests a permission, then pauses until Cheap Agent replies. */
  | { permission: string; patterns?: string[] }
  /**
   * A retry status, after which the run hangs until aborted, as the real one does while it waits out retry-after.
   * With `reason`, a Go/free-tier limit (`action` set, as OpenCode 1.19 builds it); without, a plain rate limit such as
   * OpenRouter's 429 (no `action`). `next` is when OpenCode would retry (default in an hour).
   */
  | { retry: { reason?: "account_rate_limit" | "free_tier_limit"; message: string; next?: number; recoverAfter?: number } }
  /** Calls the custom `finish` tool with this report (as a completed `finish` tool part). */
  | { finish: FinishReport }
  /** A long model step: pauses this many ms, or until the session is aborted. */
  | { wait: number }
  /** Runs a test callback at this point of the run, e.g. to change the main checkout while the job is in flight. */
  | { hook: () => void }
  /**
   * Fails the run, then goes idle: via `session.error`, or (`on: "message"`) only on the assistant message, as abort does live.
   * A `statusCode` makes it a provider APIError, e.g. OpenRouter's 402 for insufficient credits.
   */
  | { error: { name: string; message: string; statusCode?: number }; on?: "session" | "message" };

type Session = { id: string; directory: string; agent?: string; model?: SessionModel; permission?: unknown; status: Status };
type Status = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number; action?: unknown };
/**
 * OpenCode's processing of one prompt (not a Cheap Agent job). Observed live on 1.19.0: each model step is its own
 * assistant message, opened at cost 0, re-emitted with running totals, and a tool call ends the step.
 */
type Run = { session: Session; model: Model; userMessageID: string; assistantID: string; usage: Required<Usage>; resume?: () => void; aborted: boolean };

// stands in for whatever model the real server would pick from its config
const DEFAULT_MODEL: Model = { providerID: "fake", modelID: "fake-default" };

export async function startFakeOpencode(opts: { version?: string } = {}) {
  const version = opts.version ?? OPENCODE_PIN;
  let seq = 0;
  const id = (prefix: string) => `${prefix}_fake${String(++seq).padStart(4, "0")}`;

  const sessions = new Map<string, Session>();
  const runs = new Map<string, Run>(); // session id → active run
  const scripts: Action[][] = [];
  const keyed: { match: string; actions: Action[] }[] = []; // taken by the first prompt whose text contains `match`
  const subscribers = new Set<{ directory: string; res: ServerResponse }>();
  const pending = new Map<string, Run>(); // question/permission request id → paused run

  /** Everything Cheap Agent sent, for assertions. */
  const recorded = {
    requests: [] as { method: string; path: string; directory?: string; body?: any }[],
    sessions: [] as { id: string; directory: string; agent?: string; model?: SessionModel; permission?: unknown }[],
    prompts: [] as { sessionID: string; agent?: string; model?: Model; parts: unknown[] }[],
    questionReplies: [] as { requestID: string; answers?: string[][]; rejected: boolean }[],
    permissionReplies: [] as { requestID: string; reply: string; message?: string }[],
    aborts: [] as string[],
    disposed: [] as string[],
  };

  function emit(directory: string, type: string, properties: Record<string, unknown>) {
    const line = `data: ${JSON.stringify({ id: id("evt"), type, properties })}\n\n`;
    for (const sub of subscribers) if (sub.directory === directory) sub.res.write(line);
  }

  function setStatus(session: Session, status: Status) {
    session.status = status;
    emit(session.directory, "session.status", { sessionID: session.id, status });
    if (status.type === "idle") emit(session.directory, "session.idle", { sessionID: session.id });
  }

  function stop(run: Run) {
    run.aborted = true;
    runs.delete(run.session.id);
    for (const [requestID, r] of pending) if (r === run) pending.delete(requestID);
    run.resume?.();
  }

  function assistantMessage({ session, model, userMessageID, assistantID, usage }: Run) {
    return {
      id: assistantID, sessionID: session.id, role: "assistant", time: { created: Date.now() }, parentID: userMessageID,
      modelID: model.modelID, providerID: model.providerID, mode: session.agent ?? "build", agent: session.agent ?? "build",
      path: { cwd: session.directory, root: session.directory }, cost: usage.cost,
      tokens: { input: usage.input, output: usage.output, reasoning: usage.reasoning, cache: { read: 0, write: 0 } },
    };
  }

  /** A tool call ends the model step: the next actions belong to a fresh assistant message. */
  function nextStep(run: Run) {
    run.assistantID = id("msg");
    run.usage = { cost: 0, input: 0, output: 0, reasoning: 0 };
    emit(run.session.directory, "message.updated", { sessionID: run.session.id, info: assistantMessage(run) });
  }

  function toolPart(run: Run, tool: string, input: Record<string, unknown>, output?: string, error?: string) {
    const time = { start: Date.now(), end: Date.now() };
    const state = error === undefined
      ? { status: "completed", input, output: output ?? "", title: tool, metadata: {}, time }
      : { status: "error", input, error, time };
    return { id: id("prt"), sessionID: run.session.id, messageID: run.assistantID, type: "tool", callID: id("call"), tool, state };
  }

  /** Emits a question/permission request and pauses the run until it is answered (or aborted). */
  function ask(run: Run, type: "question.asked" | "permission.asked", properties: Record<string, unknown>) {
    const requestID = id(type === "question.asked" ? "que" : "per");
    pending.set(requestID, run);
    emit(run.session.directory, type, { id: requestID, sessionID: run.session.id, tool: { messageID: run.assistantID, callID: id("call") }, ...properties });
    return new Promise<void>((resolve) => (run.resume = resolve));
  }

  /** Resumes the run paused on `requestID`; false when nothing is pending under it. */
  function answer(requestID: string, type: string, properties: Record<string, unknown>) {
    const run = pending.get(requestID);
    if (!run) return false;
    pending.delete(requestID);
    emit(run.session.directory, type, { sessionID: run.session.id, requestID, ...properties });
    run.resume?.();
    return true;
  }

  async function execute(run: Run, actions: Action[]) {
    const { session } = run;
    const dir = session.directory;
    const part = (p: unknown) => emit(dir, "message.part.updated", { sessionID: session.id, part: p, time: Date.now() });
    emit(dir, "message.updated", { sessionID: session.id, info: assistantMessage(run) });
    for (const action of actions) {
      await new Promise((r) => setImmediate(r)); // let the client observe each event in order, as a real worker would
      if (run.aborted) return;
      if ("hook" in action) {
        action.hook();
      } else if ("wait" in action) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, action.wait);
          run.resume = () => (clearTimeout(timer), resolve());
        });
      } else if ("edit" in action) {
        const file = join(dir, action.edit);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, action.content);
        emit(dir, "file.edited", { file });
      } else if ("tool" in action) {
        part(toolPart(run, action.tool, action.input ?? {}, action.output, action.error));
        nextStep(run);
      } else if ("usage" in action) {
        for (const key of ["cost", "input", "output", "reasoning"] as const) run.usage[key] += action.usage[key] ?? 0;
        emit(dir, "message.updated", { sessionID: session.id, info: assistantMessage(run) });
      } else if ("text" in action) {
        part({ id: id("prt"), sessionID: session.id, messageID: run.assistantID, type: "text", text: action.text, time: { start: Date.now(), end: Date.now() } });
      } else if ("questions" in action) {
        await ask(run, "question.asked", {
          questions: action.questions.map((q) => ({ question: q.question, header: "Question", options: q.options.map((label) => ({ label, description: label })) })),
        });
      } else if ("question" in action) {
        await ask(run, "question.asked", {
          questions: [{ question: action.question, header: action.header ?? "Question", options: action.options.map((label) => ({ label, description: label })) }],
        });
      } else if ("permission" in action) {
        await ask(run, "permission.asked", { permission: action.permission, patterns: action.patterns ?? ["*"], metadata: {}, always: [] });
      } else if ("retry" in action) {
        const { reason, message, next, recoverAfter } = action.retry;
        setStatus(session, {
          type: "retry", attempt: 1, message, next: next ?? Date.now() + 3_600_000,
          ...(reason && {
            action: { reason, provider: run.model.providerID, title: reason === "account_rate_limit" ? "Go limit reached" : "Free limit reached", message, label: "open settings" },
          }),
        });
        if (recoverAfter !== undefined) {
          // a transient retry that OpenCode's own backoff gets past: busy again, then the script continues
          await new Promise((r) => setTimeout(r, recoverAfter));
          if (run.aborted) return;
          setStatus(session, { type: "busy" });
        } else {
          await new Promise<void>((resolve) => (run.resume = resolve)); // only an abort ends this
        }
      } else if ("finish" in action) {
        part(toolPart(run, "finish", action.finish, "Reported. Stop now."));
        nextStep(run);
      } else if ("error" in action) {
        const { name, message, statusCode } = action.error;
        const error = { name, data: { message, ...(statusCode && { statusCode, isRetryable: false }) } };
        if (action.on === "message") emit(dir, "message.updated", { sessionID: session.id, info: { ...assistantMessage(run), error } });
        else emit(dir, "session.error", { sessionID: session.id, error });
        break;
      }
    }
    if (run.aborted) return;
    runs.delete(session.id);
    setStatus(session, { type: "idle" });
  }

  async function readBody(req: IncomingMessage) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : undefined;
  }

  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };
  const notFound = (res: ServerResponse, message: string) => json(res, { name: "NotFoundError", data: { message } }, 404);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fake");
    const header = req.headers["x-opencode-directory"];
    // like the real server, a request without a directory addresses the server's own (default) instance
    const directory = url.searchParams.get("directory") ?? (typeof header === "string" ? decodeURIComponent(header) : process.cwd());
    let body: any;
    try {
      body = req.method === "POST" ? await readBody(req) : undefined;
    } catch {
      return json(res, { name: "BadRequestError", data: { message: "malformed JSON body" } }, 400);
    }
    recorded.requests.push({ method: req.method!, path: url.pathname, directory, body });

    const route = `${req.method} ${url.pathname}`;
    let m: RegExpMatchArray | null;

    if (route === "GET /global/health") return json(res, { healthy: true, version });

    if (route === "GET /event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", properties: {} })}\n\n`);
      const sub = { directory, res };
      subscribers.add(sub);
      res.on("close", () => subscribers.delete(sub));
      return;
    }

    if (route === "POST /session") {
      const session: Session = { id: id("ses"), directory, agent: body?.agent, model: body?.model, permission: body?.permission, status: { type: "idle" } };
      sessions.set(session.id, session);
      recorded.sessions.push({ id: session.id, directory, agent: session.agent, model: session.model, permission: session.permission });
      return json(res, { id: session.id, slug: session.id, projectID: "fake", directory, title: "fake session", version, time: { created: Date.now(), updated: Date.now() } });
    }

    if (route === "GET /session/status") {
      const busy = [...sessions.values()].filter((s) => s.directory === directory && s.status.type !== "idle");
      return json(res, Object.fromEntries(busy.map((s) => [s.id, s.status])));
    }

    if ((m = route.match(/^POST \/session\/([^/]+)\/prompt_async$/))) {
      const session = sessions.get(m[1]);
      if (!session) return notFound(res, `session ${m[1]} not found`);
      recorded.prompts.push({ sessionID: session.id, agent: body?.agent, model: body?.model, parts: body?.parts ?? [] });
      const previous = runs.get(session.id);
      if (previous) stop(previous); // one run per session: a new prompt supersedes a hanging one
      // a continued prompt may switch model (fallback/escalation); it applies to this run only
      const model = body?.model ?? (session.model && { providerID: session.model.providerID, modelID: session.model.id }) ?? DEFAULT_MODEL;
      const run: Run = { session, model, userMessageID: id("msg"), assistantID: id("msg"), usage: { cost: 0, input: 0, output: 0, reasoning: 0 }, aborted: false };
      runs.set(session.id, run);
      res.writeHead(204).end();
      setStatus(session, { type: "busy" });
      const text = (body?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("\n");
      const k = keyed.findIndex((s) => text.includes(s.match));
      void execute(run, k >= 0 ? keyed.splice(k, 1)[0].actions : (scripts.shift() ?? []));
      return;
    }

    if (route === "POST /instance/dispose") {
      recorded.disposed.push(directory);
      return json(res, true);
    }

    if ((m = route.match(/^POST \/session\/([^/]+)\/abort$/))) {
      recorded.aborts.push(m[1]);
      const run = runs.get(m[1]);
      if (run) {
        stop(run);
        // observed live on 1.19.0: abort emits no session.error; the open assistant message is updated, then the session idles
        emit(run.session.directory, "message.updated", {
          sessionID: m[1], info: { ...assistantMessage(run), error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } } },
        });
        setStatus(run.session, { type: "idle" });
      }
      return json(res, true);
    }

    if ((m = route.match(/^POST \/question\/([^/]+)\/(reply|reject)$/))) {
      const rejected = m[2] === "reject";
      recorded.questionReplies.push({ requestID: m[1], answers: body?.answers, rejected });
      const ok = answer(m[1], rejected ? "question.rejected" : "question.replied", rejected ? {} : { answers: body?.answers });
      return ok ? json(res, true) : notFound(res, `question ${m[1]} not pending`);
    }

    if ((m = route.match(/^POST \/permission\/([^/]+)\/reply$/))) {
      recorded.permissionReplies.push({ requestID: m[1], reply: body?.reply, message: body?.message });
      const ok = answer(m[1], "permission.replied", { reply: body?.reply });
      return ok ? json(res, true) : notFound(res, `permission ${m[1]} not pending`);
    }

    notFound(res, `fake opencode does not implement ${route}`);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    recorded,
    /** Queues the worker's actions for the next prompt; call once per expected prompt (self-fix, fallback, reply…). */
    script: (...actions: Action[]) => void scripts.push(actions),
    /** Queues actions for the first prompt containing `match`, ahead of the plain queue: concurrent sessions (parallel groups) get their own. */
    scriptFor: (match: string, ...actions: Action[]) => void keyed.push({ match, actions }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const run of runs.values()) stop(run);
        for (const sub of subscribers) sub.res.end();
        subscribers.clear();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
