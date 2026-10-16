import { createServer, type IncomingMessage } from "node:http";

/**
 * A scriptable stand-in for a model provider (OpenAI-compatible chat completions, streamed), for driving the *real*
 * bundled OpenCode offline: point OpenRouter's baseURL at it and each model step becomes the next scripted reply.
 * Lets tests check how OpenCode itself enforces Cheap Agent's permission ruleset, at no cost and with no network.
 */

export type Reply = { tool: string; args: Record<string, unknown> } | { text: string };

export async function startFakeLlm() {
  const replies: Reply[] = [];
  const requests: any[] = [];
  let seq = 0;

  const http = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400).end("malformed JSON");
      return;
    }
    requests.push(body);
    // title generation and other tool-less side requests get a plain answer and do not consume the script
    const reply: Reply = body.tools?.length ? (replies.shift() ?? { text: "Done." }) : { text: "Fake title" };
    const id = `chatcmpl-${++seq}`;
    const chunk = (delta: unknown, finish: string | null = null, extra = {}) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if ("tool" in reply) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${seq}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }));
      res.write(chunk({}, "tool_calls", { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    } else {
      res.write(chunk({ role: "assistant", content: reply.text }));
      res.write(chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    /** OpenRouter-style base URL (`…/api/v1`). */
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}/api/v1`,
    requests,
    /** Queues the model's next steps; a step with no reply left answers "Done." and ends the run. */
    script: (...steps: Reply[]) => void replies.push(...steps),
    close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }),
  };
}
