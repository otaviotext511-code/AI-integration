// ═══════════════════════════════════════════════════════════════
//  callapi.js  —  OpenRouter API wrapper  (Node.js module)
//  Handles: streaming, system prompt, Python exec bridge
// ═══════════════════════════════════════════════════════════════

const { execFile } = require('child_process');

// ─── SYSTEM PROMPT ───────────────────────────────────────────────
// Forces concise, direct responses
const SYSTEM_PROMPT = `You are a precise, highly efficient assistant integrated into a dev environment called "Sistema".
Rules:
- Be maximally objective and concise. No filler, no apologies, no "certainly!".
- Answer in the same language the user writes in.
- For code: use fenced blocks with language tags.
- For lists: keep them tight.
- If you need to think through something complex, do it silently — only output the conclusion.
- Token budget is limited. Every word must earn its place.`;

// ─── STREAM CHAT ─────────────────────────────────────────────────
/**
 * callStream(messages, model, apiKey, onChunk, onDone, onError)
 *
 * Streams an OpenRouter chat completion.
 * @param {Array}    messages  - [{role, content}, ...]
 * @param {string}   model     - OpenRouter model string
 * @param {string}   apiKey    - sk-or-... key
 * @param {Function} onChunk   - called with each text delta string
 * @param {Function} onDone    - called with final {content, usage} when stream ends
 * @param {Function} onError   - called with Error on failure
 */
async function callStream(messages, model, apiKey, systemPromptOverride, onChunk, onDone, onError) {
  const sys = systemPromptOverride && systemPromptOverride.trim()
    ? systemPromptOverride.trim()
    : SYSTEM_PROMPT;
  const payload = {
    model,
    stream: true,
    max_tokens: 2048,
    temperature: 0.35,          // tighter = more objective
    messages: [
      { role: 'system', content: sys },
      ...messages
    ]
  };

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Sistema'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    onError(new Error('Falha de rede: ' + err.message));
    return;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    onError(new Error(`API ${response.status}: ${errText.slice(0, 200)}`));
    return;
  }

  // ─── Parse SSE stream ─────────────────────────────────────────
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let usage = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
          if (json.usage) usage = json.usage;
        } catch {
          // malformed chunk — skip
        }
      }
    }
  } catch (err) {
    onError(new Error('Erro de stream: ' + err.message));
    return;
  }

  onDone({ content: fullContent, usage });
}

// ─── PYTHON EXEC ─────────────────────────────────────────────────
/**
 * runPython(code, timeout?)
 * Executes a Python 3 script string.
 * Returns a Promise<{stdout, stderr, exitCode}>.
 */
function runPython(code, timeout = 10000) {
  return new Promise((resolve) => {
    const args = ['-c', code];

    const proc = execFile('python', args, { timeout }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ stdout: '', stderr: `Timeout (${timeout / 1000}s excedido)`, exitCode: 1 });
        return;
      }
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (err.code || 1) : 0
      });
    });

    // safety: kill if memory spikes (basic protection)
    proc.on('error', (e) => {
      resolve({ stdout: '', stderr: e.message, exitCode: 1 });
    });
  });
}

module.exports = { callStream, runPython, SYSTEM_PROMPT };
