'use strict';

/**
 * 各家模型服务的流式适配层。
 * 统一输出：onDelta(text) / onThinking(text) / onUsage(usage)
 */

/* ---------------- 通用工具 ---------------- */

async function* readLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      /* ignore */
    }
  }
}

async function httpError(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch (_) {
    /* ignore */
  }
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg =
      (j.error && (j.error.message || j.error)) ||
      j.message ||
      (Array.isArray(j) && j[0] && j[0].error && j[0].error.message) ||
      raw;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch (_) {
    /* ignore */
  }
  msg = String(msg || '').replace(/\s+/g, ' ').slice(0, 300);
  const err = new Error(`HTTP ${res.status}${msg ? ' · ' + msg : ''}`);
  err.status = res.status;
  return err;
}

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');

function normalizeMessages(messages) {
  return (messages || [])
    .filter((m) => m && typeof m.content === 'string' && m.content.length)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

/* ---------------- OpenAI 兼容 ---------------- */

async function streamOpenAI({ provider, model, messages, systemPrompt, temperature, maxTokens }, h) {
  const base = trimBase(provider.baseUrl) || 'https://api.openai.com/v1';
  const url = `${base}/chat/completions`;
  const msgs = [];
  if (systemPrompt && systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
  msgs.push(...normalizeMessages(messages));

  const body = {
    model,
    messages: msgs,
    stream: true,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (provider.extraBody && typeof provider.extraBody === 'object') Object.assign(body, provider.extraBody);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey || ''}`,
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
    signal: h.signal,
  });
  if (!res.ok) throw await httpError(res);

  for await (const line of readLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      continue;
    }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const choice = json.choices && json.choices[0];
    if (!choice) continue;
    const d = choice.delta || {};
    const reasoning = d.reasoning_content || d.reasoning;
    if (reasoning) h.onThinking(reasoning);
    if (d.content) h.onDelta(d.content);
    if (json.usage) h.onUsage(json.usage);
  }
}

/* ---------------- Anthropic Claude ---------------- */

async function streamAnthropic({ provider, model, messages, systemPrompt, temperature, maxTokens }, h) {
  const base = trimBase(provider.baseUrl) || 'https://api.anthropic.com';
  const url = `${base}/v1/messages`;

  // Claude 要求 user / assistant 交替出现，连续同角色需要合并
  const merged = [];
  for (const m of normalizeMessages(messages)) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ role: m.role, content: m.content });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();

  const body = {
    model,
    max_tokens: maxTokens || 4096,
    messages: merged,
    stream: true,
  };
  if (systemPrompt && systemPrompt.trim()) body.system = systemPrompt.trim();
  if (typeof temperature === 'number') body.temperature = Math.min(temperature, 1);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
    signal: h.signal,
  });
  if (!res.ok) throw await httpError(res);

  for await (const line of readLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      continue;
    }
    if (json.type === 'error') throw new Error(json.error?.message || 'Claude 返回错误');
    if (json.type === 'content_block_delta' && json.delta) {
      if (json.delta.type === 'text_delta' && json.delta.text) h.onDelta(json.delta.text);
      else if (json.delta.type === 'thinking_delta' && json.delta.thinking) h.onThinking(json.delta.thinking);
    } else if (json.type === 'message_delta' && json.usage) {
      h.onUsage({
        prompt_tokens: json.usage.input_tokens,
        completion_tokens: json.usage.output_tokens,
      });
    }
  }
}

/* ---------------- Google Gemini ---------------- */

async function streamGemini({ provider, model, messages, systemPrompt, temperature, maxTokens }, h) {
  const base = trimBase(provider.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta';
  const key = provider.apiKey || '';
  const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const contents = normalizeMessages(messages).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = { contents };
  if (systemPrompt && systemPrompt.trim()) {
    body.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
  }
  const gen = {};
  if (typeof temperature === 'number') gen.temperature = temperature;
  if (maxTokens) gen.maxOutputTokens = maxTokens;
  if (Object.keys(gen).length) body.generationConfig = gen;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(provider.headers || {}) },
    body: JSON.stringify(body),
    signal: h.signal,
  });
  if (!res.ok) throw await httpError(res);

  for await (const line of readLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      continue;
    }
    if (json.error) throw new Error(json.error.message || 'Gemini 返回错误');
    const cand = json.candidates && json.candidates[0];
    if (!cand) continue;
    const parts = (cand.content && cand.content.parts) || [];
    for (const p of parts) {
      if (p.thought) {
        if (p.text) h.onThinking(p.text);
      } else if (p.text) h.onDelta(p.text);
    }
    if (json.usageMetadata) {
      h.onUsage({
        prompt_tokens: json.usageMetadata.promptTokenCount,
        completion_tokens: json.usageMetadata.candidatesTokenCount,
      });
    }
  }
}

/* ---------------- Ollama 本地 ---------------- */

async function streamOllama({ provider, model, messages, systemPrompt, temperature, maxTokens }, h) {
  const base = trimBase(provider.baseUrl) || 'http://127.0.0.1:11434';
  const msgs = [];
  if (systemPrompt && systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
  msgs.push(...normalizeMessages(messages));

  const options = {};
  if (typeof temperature === 'number') options.temperature = temperature;
  if (maxTokens) options.num_predict = maxTokens;

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, stream: true, options }),
    signal: h.signal,
  });
  if (!res.ok) throw await httpError(res);

  for await (const line of readLines(res)) {
    const data = line.trim();
    if (!data) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      continue;
    }
    if (json.error) throw new Error(json.error);
    const m = json.message || {};
    if (m.thinking) h.onThinking(m.thinking);
    if (m.content) h.onDelta(m.content);
    if (json.done) {
      h.onUsage({
        prompt_tokens: json.prompt_eval_count,
        completion_tokens: json.eval_count,
      });
      break;
    }
  }
}

/* ---------------- 统一入口 ---------------- */

async function streamChat(payload, handlers) {
  const type = payload.provider && payload.provider.type;
  switch (type) {
    case 'openai':
      return streamOpenAI(payload, handlers);
    case 'anthropic':
      return streamAnthropic(payload, handlers);
    case 'gemini':
      return streamGemini(payload, handlers);
    case 'ollama':
      return streamOllama(payload, handlers);
    default:
      throw new Error(`不支持的接口类型：${type}`);
  }
}

/* ---------------- 模型列表 ---------------- */

async function listModels(provider) {
  const type = provider.type;
  const base = trimBase(provider.baseUrl);
  const signal = AbortSignal.timeout(20000);

  if (type === 'openai') {
    const res = await fetch(`${base || 'https://api.openai.com/v1'}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey || ''}`, ...(provider.headers || {}) },
      signal,
    });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return (j.data || []).map((m) => m.id).filter(Boolean).sort();
  }

  if (type === 'anthropic') {
    const res = await fetch(`${base || 'https://api.anthropic.com'}/v1/models?limit=100`, {
      headers: {
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      signal,
    });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return (j.data || []).map((m) => m.id).filter(Boolean);
  }

  if (type === 'gemini') {
    const res = await fetch(
      `${base || 'https://generativelanguage.googleapis.com/v1beta'}/models?key=${encodeURIComponent(provider.apiKey || '')}&pageSize=200`,
      { signal }
    );
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''));
  }

  if (type === 'ollama') {
    const res = await fetch(`${base || 'http://127.0.0.1:11434'}/api/tags`, { signal });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return (j.models || []).map((m) => m.name).filter(Boolean);
  }

  throw new Error(`不支持的接口类型：${type}`);
}

module.exports = { streamChat, listModels };
