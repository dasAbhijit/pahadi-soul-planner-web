import { DRAFT_TOOLS, type FunctionDecl } from './chatactions';
import { GUIDANCE_TOOL_NAME } from './prompt';

export const DEFAULT_MODEL = 'gemini-flash-latest';
/** Tried in order when the chosen model is busy, slow or retired, but only before any reply text has arrived. */
export const FALLBACK_MODELS = ['gemini-flash-lite-latest'];
/** Seconds to wait for the model to start answering before trying the next one. */
export const FIRST_BYTE_TIMEOUT_SECONDS = 40;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiRole = 'user' | 'model';
export interface GeminiMessage { role: GeminiRole; text: string }

/** What a streamed Gemini reply can contain. */
export type GeminiEvent =
  | { type: 'text'; text: string }
  /** The model wants to remember a rule about how it should behave. Nothing is saved until staff approve it. */
  | { type: 'guidance'; rule: string }
  /** The assistant prepared a draft (booking, payment). Nothing is saved until a person approves it. */
  | { type: 'draft'; tool: string; args: Record<string, unknown> };

export class GeminiError extends Error {
  constructor(public code: 'invalidModel' | 'noKey' | 'http' | 'timeout' | 'network', message: string, public status = 0) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiRequest { url: string; headers: Record<string, string>; body: string }

/** Parses one Server-Sent-Events line of a streamGenerateContent response. */
export function parseSSELine(line: string): GeminiEvent[] {
  if (!line.startsWith('data:')) return [];
  let root: unknown;
  try { root = JSON.parse(line.slice(5).trim()); } catch { return []; }
  const parts = (((root as any)?.candidates?.[0]?.content?.parts) ?? null) as unknown;
  if (!Array.isArray(parts)) return [];
  const out: GeminiEvent[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const text = (part as any).text;
    if (typeof text === 'string' && text !== '') out.push({ type: 'text', text });
    const call = (part as any).functionCall;
    if (call && call.name === GUIDANCE_TOOL_NAME) {
      const rule = call.args?.rule;
      if (typeof rule === 'string' && rule.trim() !== '') out.push({ type: 'guidance', rule: rule.trim() });
    } else if (call && typeof call.name === 'string' && DRAFT_TOOLS.includes(call.name) && call.args && typeof call.args === 'object' && !Array.isArray(call.args)) {
      out.push({ type: 'draft', tool: call.name, args: call.args as Record<string, unknown> });
    }
  }
  return out;
}

export function errorMessage(body: string): string {
  try {
    const m = (JSON.parse(body) as any)?.error?.message;
    if (typeof m === 'string') return m;
  } catch { /* fall through */ }
  return body === '' ? 'Unknown error' : body.slice(0, 300);
}

export function validatedModel(model: string): string {
  const t = model.trim();
  if (t === '' || !/^[A-Za-z0-9._-]+$/.test(t)) throw new GeminiError('invalidModel', 'The model name looks invalid.');
  return t;
}

export function shouldTryNextModel(e: unknown): boolean {
  if (e instanceof GeminiError) return e.code === 'timeout' || (e.code === 'http' && [404, 429, 500, 502, 503, 504].includes(e.status));
  return false;
}

/** The pieces of a request, so it can be checked without a network. The API key goes in a header, never in the URL. */
export function makeStreamRequest(apiKey: string, model: string, systemPrompt: string, history: GeminiMessage[], enableGuidanceTool = true, extraTools: FunctionDecl[] = []): GeminiRequest {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  };
  const declarations: FunctionDecl[] = [];
  if (enableGuidanceTool) {
    declarations.push({
      name: GUIDANCE_TOOL_NAME,
      description: 'Propose ONE short, self-contained rule about how the assistant should behave in all future conversations. Staff must approve it before it is saved.',
      parameters: {
        type: 'OBJECT',
        properties: { rule: { type: 'STRING', description: 'The rule, written as a direct instruction.' } },
        required: ['rule'],
      },
    });
  }
  declarations.push(...extraTools);
  if (declarations.length > 0) body.tools = [{ functionDeclarations: declarations }];
  return {
    url: `${BASE}/models/${validatedModel(model)}:streamGenerateContent?alt=sse`,
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export type Streamer = (apiKey: string, model: string, system: string, history: GeminiMessage[], signal?: AbortSignal, tools?: FunctionDecl[]) => AsyncIterable<GeminiEvent>;

/** Minimal Gemini REST client, called straight from the browser. */
export class GeminiClient {
  /**
   * Streams text chunks and guidance proposals as Gemini produces them. If the chosen model is busy, slow or
   * retired, the next model in FALLBACK_MODELS is tried, but never once part of a reply has already been shown.
   */
  async *stream(apiKey: string, model: string, systemPrompt: string, history: GeminiMessage[], signal?: AbortSignal, tools: FunctionDecl[] = []): AsyncGenerator<GeminiEvent> {
    const models = [...new Set([model, ...FALLBACK_MODELS])];
    for (let i = 0; i < models.length; i++) {
      let delivered = false;
      try {
        for await (const ev of this.streamOnce(apiKey, models[i], systemPrompt, history, signal, tools)) { delivered = true; yield ev; }
        return;
      } catch (e) {
        const isLast = i === models.length - 1;
        if (delivered || isLast || signal?.aborted || !shouldTryNextModel(e)) throw e;
      }
    }
  }

  private async *streamOnce(apiKey: string, model: string, systemPrompt: string, history: GeminiMessage[], signal?: AbortSignal, tools: FunctionDecl[] = []): AsyncGenerator<GeminiEvent> {
    const req = makeStreamRequest(apiKey, model, systemPrompt, history, true, tools);
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { timedOut = true; ctl.abort(); }, FIRST_BYTE_TIMEOUT_SECONDS * 1000);
    const stopTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    try {
      let res: Response;
      try {
        res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: ctl.signal, credentials: 'omit' });
      } catch (e) {
        throw this.failure(e, timedOut, signal);
      }
      if (!res.ok) {
        stopTimer();
        throw new GeminiError('http', `Gemini error ${res.status}: ${errorMessage(await res.text().catch(() => ''))}`, res.status);
      }
      if (!res.body) throw new GeminiError('network', 'Gemini sent an empty reply.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); } catch (e) { throw this.failure(e, timedOut, signal); }
          stopTimer();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            for (const ev of parseSSELine(line)) yield ev;
          }
        }
        buffer += decoder.decode();
        for (const ev of parseSSELine(buffer.replace(/\r$/, ''))) yield ev;
      } finally {
        try { await reader.cancel(); } catch { /* already closed */ }
      }
    } finally {
      stopTimer();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private failure(e: unknown, timedOut: boolean, signal?: AbortSignal): Error {
    if (signal?.aborted) return new DOMException('cancelled', 'AbortError');
    if (timedOut) return new GeminiError('timeout', 'Gemini took too long to start answering.');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return new GeminiError('network', "No internet connection. Try again when you're online.");
    return new GeminiError('network', "Couldn't reach Gemini. Check your connection and try again.");
  }

  /** Cheap authenticated call used by the "Test key" button. */
  async testKey(apiKey: string): Promise<void> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch(`${BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey }, signal: ctl.signal, credentials: 'omit' });
      if (!res.ok) throw new GeminiError('http', `Gemini error ${res.status}: ${errorMessage(await res.text().catch(() => ''))}`, res.status);
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      throw new GeminiError('network', "Couldn't reach Gemini. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
  }
}
