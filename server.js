// ═══════════════════════════════════════════════════════════════
//  server.js  —  Sistema backend
//
//  Endpoints:
//    GET  /              → public/index.html
//    POST /api/chat      → SSE stream from OpenRouter
//    POST /api/py        → execute Python 3 code, return JSON
//    GET  /api/status    → health check + model list
//
//  Start: node server.js   (or: npm start)
//  Env:   OPENROUTER_KEY=sk-or-...   (in .env or shell)
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const { callStream, runPython } = require('./callapi');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── HELPERS ──────────────────────────────────────────────────────
function getKey(req) {
  // Priority: .env key → client-provided key header (user brings own)
  return process.env.OPENROUTER_KEY
    || req.headers['x-api-key']
    || '';
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable Nginx buffering
  res.flushHeaders();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── POST /api/chat ──────────────────────────────────────────────
// Body: { messages: [{role, content}], model: string }
// Returns SSE stream:
//   event: chunk   data: { text: "..." }
//   event: done    data: { usage: {...} }
//   event: error   data: { message: "..." }
app.post('/api/chat', async (req, res) => {
  const { messages, model, systemPrompt } = req.body;
  const key = getKey(req);

  if (!key) {
    return res.status(401).json({ error: 'Nenhuma API key configurada. Defina OPENROUTER_KEY no .env ou envie via x-api-key header.' });
  }
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Campo messages inválido.' });
  }

  sseHeaders(res);

  // Send a "thinking start" event so client can show indicator
  sseSend(res, 'thinking', { model: model || 'desconhecido', ts: Date.now() });

  await callStream(
    messages,
    model || 'anthropic/claude-haiku-4-5',
    key,
    systemPrompt || null,
    // onChunk
    (delta) => {
      sseSend(res, 'chunk', { text: delta });
    },
    // onDone
    ({ content, usage }) => {
      sseSend(res, 'done', {
        usage: usage || null,
        chars: content.length
      });
      res.end();
    },
    // onError
    (err) => {
      sseSend(res, 'error', { message: err.message });
      res.end();
    }
  );

  req.on('close', () => {
    // client disconnected — nothing to clean up (fetch stream auto-aborts)
  });
});

// ─── POST /api/plan ─────────────────────────────────────────────
// Beta mode: analyse user input, return JSON plan (no stream)
// Body: { text: string }
// Returns: { intent, needsPython, pyCode, steps }
app.post('/api/plan', async (req, res) => {
  const { text } = req.body;
  const key = getKey(req);

  if (!key)  return res.status(401).json({ error: 'API key não configurada.' });
  if (!text) return res.status(400).json({ error: 'Campo text ausente.' });

  const prompt = `Analise o input abaixo e responda APENAS com JSON válido, sem markdown.

Input: ${JSON.stringify(text)}

JSON:
{
  "intent": "descrição curta da intenção (max 8 palavras, em português)",
  "needsPython": true ou false,
  "pyCode": "código python completo com print() — ou null",
  "steps": ["etapa 1", "etapa 2", "etapa 3"]
}

Regras:
- needsPython=true para: contar letras/chars/palavras, cálculos, lógica, datas
- pyCode deve sempre usar print() e nunca usar input()
- steps: máximo 3 itens curtos em português`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Sistema-plan'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        max_tokens: 400,
        temperature: 0.1,
        messages: [
          { role: 'system', content: 'Responda APENAS com JSON válido. Sem markdown, sem texto extra.' },
          { role: 'user',   content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `OpenRouter ${response.status}: ${err.slice(0,200)}` });
    }

    const data = await response.json();
    let raw = data.choices?.[0]?.message?.content || '{}';
    raw = raw.replace(/```json|```/g, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'JSON inválido na resposta: ' + raw.slice(0,100) });

    const plan = JSON.parse(match[0]);
    res.json(plan);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/py ────────────────────────────────────────────────
// Body: { code: string, timeout?: number }
// Returns: { stdout, stderr, exitCode, ms }
app.post('/api/py', async (req, res) => {
  const { code, timeout } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Código Python ausente.' });
  }
  if (code.length > 16000) {
    return res.status(400).json({ error: 'Código muito longo (max 16k chars).' });
  }

  const t0 = Date.now();
  const result = await runPython(code, timeout || 10000);
  result.ms = Date.now() - t0;

  res.json(result);
});

// ─── POST /api/console ───────────────────────────────────────────
// Execute a Node.js expression server-side and return result
// Body: { code: string }
// Returns: { result, error, ms }
app.post('/api/console', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string')
    return res.status(400).json({ error: 'Campo code ausente.' });
  if (code.length > 8000)
    return res.status(400).json({ error: 'Código muito longo.' });

  const t0 = Date.now();
  const logs = [];

  // sandbox: capture console.log output
  const fakeConsole = {
    log:  (...a) => logs.push(a.map(x => typeof x === 'object' ? JSON.stringify(x,null,2) : String(x)).join(' ')),
    error:(...a) => logs.push('ERR: ' + a.join(' ')),
    warn: (...a) => logs.push('WRN: ' + a.join(' ')),
    info: (...a) => logs.push('INF: ' + a.join(' ')),
  };

  // expose useful server-side context
  const ctx = {
    console:  fakeConsole,
    process,
    require,
    env:      process.env,
    uptime:   () => process.uptime(),
    PORT:     process.env.PORT || 3000,
    KEY_OK:   !!process.env.OPENROUTER_KEY,
  };

  let result = undefined, error = null;
  try {
    const fn = new Function(...Object.keys(ctx), `"use strict"; return (${code})`);
    result = await fn(...Object.values(ctx));
  } catch(e) {
    try {
      // retry as statement (no return)
      const fn2 = new Function(...Object.keys(ctx), `"use strict"; ${code}`);
      result = await fn2(...Object.values(ctx));
    } catch(e2) {
      error = e2.message;
    }
  }

  res.json({
    result:  result !== undefined ? (typeof result === 'object' ? JSON.stringify(result,null,2) : String(result)) : null,
    logs,
    error,
    ms: Date.now() - t0
  });
});

// ─── POST /api/browse ────────────────────────────────────────────
// Advanced proxy with Playwright primary + CORS fallback chain
// Body: { url, waitFor?, screenshot?, cookies? }
// Returns: { html, method, ms, screenshot? }

const CORS_CHAIN = [
  { name: 'corsproxy.io',  build: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
  { name: 'allorigins',    build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs',      build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
];

async function browseWithPlaywright(url, opts = {}) {
  // lazy require — if not installed, throws and we fall back
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      ...(opts.cookies ? { storageState: { cookies: opts.cookies } } : {})
    });
    const page = await ctx.newPage();

    // block heavy assets to speed up
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf}', r => r.abort());

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // optional extra wait (for SPAs)
    if (opts.waitFor) {
      try { await page.waitForSelector(opts.waitFor, { timeout: 5000 }); }
      catch { /* selector never appeared, continue anyway */ }
    } else {
      await page.waitForTimeout(800);
    }

    const html = await page.content();
    const screenshot = opts.screenshot ? await page.screenshot({ type: 'png', fullPage: false }) : null;
    await browser.close();
    return {
      html,
      method: 'playwright',
      screenshot: screenshot ? screenshot.toString('base64') : null
    };
  } catch(e) {
    await browser.close();
    throw e;
  }
}

async function browseWithCORSChain(url) {
  for (const proxy of CORS_CHAIN) {
    try {
      const res = await fetch(proxy.build(url), {
        signal: AbortSignal.timeout(9000),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      if (html.trim().length < 100) throw new Error('resposta vazia');
      return { html, method: proxy.name };
    } catch(e) {
      console.warn(`[browse] ${proxy.name} falhou:`, e.message);
    }
  }
  throw new Error('Todos os proxies CORS falharam.');
}

app.post('/api/browse', async (req, res) => {
  const { url, waitFor, screenshot, cookies } = req.body;
  if (!url) return res.status(400).json({ error: 'url obrigatória' });

  const t0 = Date.now();
  let result;

  // 1. try Playwright
  try {
    result = await browseWithPlaywright(url, { waitFor, screenshot, cookies });
  } catch(e) {
    console.warn('[browse] Playwright falhou:', e.message, '— tentando CORS chain');
    // 2. fallback to CORS chain
    try {
      result = await browseWithCORSChain(url);
    } catch(e2) {
      return res.status(502).json({ error: e2.message, playwrightError: e.message });
    }
  }

  result.ms  = Date.now() - t0;
  result.url = url;
  // rewrite relative URLs to absolute
  result.html = result.html
    .replace(/<base[^>]*>/gi, '')
    .replace(/(<head[^>]*>)/i, `$1<base href="${url}">`);

  res.json(result);
});

// ─── GET /api/debug-key ──────────────────────────────────────────
// Shows if key is loaded (never shows the key itself)
app.get('/api/debug-key', (req, res) => {
  const key = process.env.OPENROUTER_KEY || '';
  res.json({
    loaded:  key.length > 0,
    length:  key.length,
    prefix:  key.length > 8 ? key.slice(0, 8) + '...' : '(vazio)',
    envFile: require('path').join(__dirname, '.env'),
  });
});

// ─── GET /api/status ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    keyConfigured: !!process.env.OPENROUTER_KEY,
    node: process.version,
    models: [
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-opus-4',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct'
    ]
  });
});

// ─── SPA fallback ────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────┐`);
  console.log(`  │  Sistema  →  http://localhost:${PORT}   │`);
  console.log(`  └─────────────────────────────────────┘`);
  console.log(`  API key: ${process.env.OPENROUTER_KEY ? '✓ carregada do .env' : '✗ não configurada (use x-api-key header)'}`);
  console.log(`  Python:  exec via /api/py\n`);
});
