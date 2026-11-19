// NVIDIA NIM multimodal vision transport with automatic multi-model failover and optional Gemini fallback.
// Sends ONE request containing the text evidence AND the chart screenshot (image_url PNG data URI),
// validates that the model returned parseable verification JSON, and switches to the next model on error,
// rate limit, timeout, or malformed output.
import { AiCaller, AiRequest, AiUnavailableError, parseAiResponse } from './aiVerification';

export const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Ordered by verified live multimodal latency and JSON schema reliability on NVIDIA NIM.
export const DEFAULT_NVIDIA_MODELS = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'stepfun-ai/step-5-preview',
  'google/gemma-4-31b-it',
] as const;

export interface NvidiaOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  now?: () => number;
}

export function nvidiaModelsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const raw = String(env.NVIDIA_MODELS ?? '').trim();
  if (!raw) return [...DEFAULT_NVIDIA_MODELS];
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length ? parsed : [...DEFAULT_NVIDIA_MODELS];
}

export function hasNvidiaKey(env: Record<string, string | undefined> = process.env): boolean {
  const key = String(env.NVIDIA_API_KEY ?? '').trim();
  return !!key && key !== 'MY_NVIDIA_API_KEY';
}

export function nvidiaBody(req: AiRequest, model: string, maxTokens = 4096) {
  const content: Record<string, unknown>[] = [{ type: 'text', text: req.prompt }];
  let imageSent = false;
  if (req.image) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${req.image.mimeType};base64,${req.image.base64}` },
    });
    imageSent = true;
  }
  const body: {
    model: string;
    temperature: number;
    max_tokens: number;
    messages: { role: string; content: string | Record<string, unknown>[] }[];
    chat_template_kwargs?: { enable_thinking: boolean };
  } = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content },
    ],
  };
  if (/nemotron/i.test(model)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return { imageSent, body };
}

function extractMessageText(choice: any): string {
  const msg = choice?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  if (Array.isArray(msg.content)) {
    const joined = msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (joined.trim()) return joined;
  }
  if (typeof msg.reasoning_content === 'string' && /\{[\s\S]*\}/.test(msg.reasoning_content)) {
    return msg.reasoning_content;
  }
  return '';
}

export function createNvidiaCaller(o: NvidiaOptions = {}): AiCaller {
  const key = o.apiKey ?? process.env.NVIDIA_API_KEY;
  const baseUrl = o.baseUrl ?? process.env.NVIDIA_BASE_URL ?? DEFAULT_NVIDIA_BASE_URL;
  const models = o.models?.length ? o.models : nvidiaModelsFromEnv();
  const doFetch = o.fetchImpl ?? fetch;
  const timeout = o.timeoutMs ?? Number(process.env.NVIDIA_TIMEOUT_MS ?? 18000);
  const maxTokens = o.maxTokens ?? 4096;
  const now = o.now ?? Date.now;
  // Brief per-model cooldowns so dead/rate-limited models are skipped immediately on subsequent setups.
  const cooldownUntil = new Map<string, number>();

  return async (req) => {
    if (!key || key === 'MY_NVIDIA_API_KEY') {
      throw new AiUnavailableError('NO_KEY', 'NVIDIA_API_KEY is not set on the server');
    }

    const tStart = now();
    const active = models.filter((m) => (cooldownUntil.get(m) ?? 0) <= tStart);
    const ordered = active.length ? active : models;
    const errors: string[] = [];
    let lastError: AiUnavailableError | null = null;

    for (const model of ordered) {
      const { body, imageSent } = nvidiaBody(req, model, maxTokens);
      let res: Response;
      try {
        res = await doFetch(baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        const name = (e as Error)?.name;
        const kind = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
        const msg = `${model}: ${(e as Error)?.message ?? e}`;
        errors.push(msg);
        lastError = new AiUnavailableError(kind, msg.slice(0, 160));
        cooldownUntil.set(model, now() + 20_000);
        continue;
      }

      if (res.status === 429) {
        errors.push(`${model}: HTTP 429`);
        lastError = new AiUnavailableError('RATE_LIMITED', `${model} rate limited (HTTP 429)`);
        cooldownUntil.set(model, now() + 30_000);
        continue;
      }
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        errors.push(`${model}: HTTP ${res.status}`);
        lastError = new AiUnavailableError('HTTP_ERROR', `${model} answered HTTP ${res.status}`);
        cooldownUntil.set(model, now() + (res.status === 404 ? 600_000 : 60_000));
        continue;
      }
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status}`);
        lastError = new AiUnavailableError('HTTP_ERROR', `${model} answered HTTP ${res.status}`);
        cooldownUntil.set(model, now() + 15_000);
        continue;
      }

      let j: any;
      try {
        j = await res.json();
      } catch {
        errors.push(`${model}: non-JSON HTTP body`);
        lastError = new AiUnavailableError('BAD_RESPONSE', `${model} reply was not JSON`);
        continue;
      }

      const cand = j?.choices?.[0];
      const text = extractMessageText(cand);
      if (!text) {
        const finish = cand?.finish_reason ? ` (${cand.finish_reason})` : '';
        errors.push(`${model}: empty text${finish}`);
        lastError = new AiUnavailableError('EMPTY', `${model} returned no text${finish}`);
        continue;
      }

      // Verify the reply matches the verification JSON contract before accepting it;
      // if this model produced malformed JSON or omitted required fields, fail over to the next model.
      try {
        parseAiResponse(text, req, imageSent);
      } catch (e) {
        if (e instanceof AiUnavailableError && e.kind === 'WRONG_REQUEST') {
          throw e;
        }
        const msg = `${model}: ${(e as Error)?.message ?? e}`;
        errors.push(msg);
        lastError = e instanceof AiUnavailableError ? e : new AiUnavailableError('BAD_RESPONSE', msg.slice(0, 160));
        continue;
      }

      return { text, imageSent };
    }

    throw lastError ?? new AiUnavailableError('HTTP_ERROR', `All NVIDIA models failed: ${errors.join('; ')}`.slice(0, 160));
  };
}

/** Chains multiple AI callers in priority order, switching to the next provider on any AiUnavailableError (except WRONG_REQUEST). */
export function createFailoverCaller(callers: { name: string; caller: AiCaller }[]): AiCaller {
  return async (req) => {
    let lastError: unknown = null;
    for (const { caller } of callers) {
      try {
        return await caller(req);
      } catch (err) {
        if (err instanceof AiUnavailableError && err.kind === 'WRONG_REQUEST') throw err;
        lastError = err;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new AiUnavailableError('NOT_CONFIGURED', 'No AI vision provider configured');
  };
}
