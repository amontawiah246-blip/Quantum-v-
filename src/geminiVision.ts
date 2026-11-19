// Gemini transport. It sends ONE request containing the text evidence AND the screenshot (inlineData PNG), and reports whether the
// image really was in that request (`imageSent`). Every failure is thrown as AiUnavailableError. There is no local "analyst" that
// answers instead: a missing key, a 429, a timeout or a blocked reply means the AI did not verify anything.
import { AiCaller, AiRequest, AiUnavailableError } from './aiVerification';

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** minimum spacing between calls (the free tier allows ~5 per minute). Calls wait for their slot up to maxWaitMs, then fail as RATE_LIMITED */
  minIntervalMs?: number;
  maxWaitMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export function geminiBody(req: AiRequest) {
  const parts: Record<string, unknown>[] = [{ text: req.prompt }];
  let imageSent = false;
  if (req.image) { parts.push({ inlineData: { mimeType: req.image.mimeType, data: req.image.base64 } }); imageSent = true; }
  return {
    imageSent,
    body: {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    },
  };
}

export function createGeminiCaller(o: GeminiOptions = {}): AiCaller {
  const key = o.apiKey ?? process.env.GEMINI_API_KEY;
  const model = o.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minInterval = o.minIntervalMs ?? Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 12000);
  const maxWait = o.maxWaitMs ?? 25000;
  const timeout = o.timeoutMs ?? 40000;
  let nextSlot = 0;

  return async (req) => {
    if (!key || key === 'MY_GEMINI_API_KEY') throw new AiUnavailableError('NO_KEY', 'GEMINI_API_KEY is not set on the server');
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new AiUnavailableError('NOT_CONFIGURED', `invalid GEMINI_MODEL "${model}"`);

    // take a time slot (synchronously, so parallel callers queue up in order)
    const t = now();
    const slot = Math.max(t, nextSlot);
    if (slot - t > maxWait) throw new AiUnavailableError('RATE_LIMITED', `local rate limit: the next free slot is ${Math.round((slot - t) / 1000)}s away`);
    nextSlot = slot + minInterval;
    if (slot > t) await sleep(slot - t);

    const { body, imageSent } = geminiBody(req);
    let res: Response;
    try {
      res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'User-Agent': 'aistudio-build' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new AiUnavailableError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', `Gemini request failed: ${(e as Error)?.message ?? e}`.slice(0, 160));
    }
    if (res.status === 429) throw new AiUnavailableError('RATE_LIMITED', 'Gemini rate limit / quota reached (HTTP 429)');
    if (!res.ok) throw new AiUnavailableError('HTTP_ERROR', `Gemini answered HTTP ${res.status}`);

    let j: any;
    try { j = await res.json(); } catch { throw new AiUnavailableError('BAD_RESPONSE', 'Gemini reply was not JSON'); }
    if (j?.promptFeedback?.blockReason) throw new AiUnavailableError('BLOCKED', `Gemini blocked the request (${j.promptFeedback.blockReason})`);
    const cand = j?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (!text) throw new AiUnavailableError(cand?.finishReason && cand.finishReason !== 'STOP' ? 'BLOCKED' : 'EMPTY', `Gemini returned no text${cand?.finishReason ? ` (${cand.finishReason})` : ''}`);
    return { text, imageSent };
  };
}
