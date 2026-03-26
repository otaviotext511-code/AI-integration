// ═══════════════════════════════════════════════════════════════
//  pip-proxy.js  —  PipProxy  (cliente puro, sem backend)
//
//  Como funciona:
//    1. fetch() na cadeia de proxies CORS públicos
//    2. injeta o HTML via srcdoc no iframe (burla X-Frame-Options)
//    3. reescreve <base href> para que CSS/imagens relativas carreguem
//    4. intercepta cliques em <a> para abrir links em _blank
//
//  Uso:
//    PipProxy.load(url, iframeEl, { onStart, onProgress, onSuccess, onError })
//    PipProxy.loadDirect(url, iframeEl)          // sem proxy, iframe direto
//    PipProxy.fetchForAI(url)                    // retorna texto limpo para contexto IA
//    PipProxy.testAll()                          // testa todos os proxies
//    PipProxy.pin(idx)                           // trava em proxy específico
//    PipProxy.getList()                          // lista proxies disponíveis
// ═══════════════════════════════════════════════════════════════

window.PipProxy = (() => {

  // Cadeia de proxies CORS públicos — tenta em ordem até um funcionar
  const PROXIES = [
    { name: 'corsproxy.io', build: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: 'allorigins',   build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'codetabs',     build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  ];

  // null = auto-fallback (tenta todos em ordem)
  // número = usa só aquele índice (pinado)
  let pinned = null;

  // ─── FETCH ────────────────────────────────────────────────────
  // Tenta cada proxy da cadeia até obter HTML válido
  async function fetchHTML(url) {
    const list = (pinned !== null) ? [PROXIES[pinned]] : PROXIES;
    for (const p of list) {
      try {
        const res = await fetch(p.build(url), { signal: AbortSignal.timeout(9000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const html = await res.text();
        if (html.trim().length < 50) throw new Error('resposta vazia');
        return { html, proxy: p.name };
      } catch(e) {
        console.warn('[PipProxy]', p.name, '→', e.message);
      }
    }
    throw new Error('Todos os proxies falharam. Site muito restrito ou sem internet.');
  }

  // ─── REWRITE ──────────────────────────────────────────────────
  // Dois problemas que o rewrite resolve:
  //   1. Recursos relativos (css, imagens) quebram no srcdoc → injeta <base href>
  //   2. Navegação interna recarregaria o srcdoc e perderia o contexto → intercepta <a>
  function rewrite(html, baseURL) {
    // Garante um único <base href> apontando para a URL original
    if (/<base\s/i.test(html))
      html = html.replace(/<base[^>]*>/i, `<base href="${baseURL}">`);
    else
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${baseURL}">`);

    // Script injetado no fim do body: redireciona cliques de âncora para _blank
    const guard = `<script>(function(){
      document.addEventListener('click', function(e) {
        var a = e.target.closest('a');
        if (a && a.href && a.getAttribute('href') && a.getAttribute('href') !== '#'
            && !a.href.startsWith('javascript')) {
          e.preventDefault();
          window.open(a.href, '_blank');
        }
      });
    })();<\\/script>`;

    if (/<\/body>/i.test(html))
      html = html.replace(/<\/body>/i, guard + '</body>');
    else
      html += guard;

    return html;
  }

  // ─── LOAD (proxy → srcdoc) ────────────────────────────────────
  // Callbacks opcionais:
  //   onStart()              — começa a carregar
  //   onProgress(msg)        — atualização de status
  //   onSuccess(proxyName)   — carregou com sucesso
  //   onError(errorMsg)      — falhou
  async function load(url, frameEl, cbs = {}) {
    const { onStart, onProgress, onSuccess, onError } = cbs;
    if (onStart) onStart();
    try {
      if (onProgress) onProgress('conectando ao proxy…');
      const { html, proxy } = await fetchHTML(url);
      if (onProgress) onProgress('reescrevendo URLs relativas…');
      frameEl.removeAttribute('src');
      frameEl.srcdoc = rewrite(html, url);
      frameEl.style.display = 'block';
      if (onSuccess) onSuccess(proxy);
    } catch(e) {
      if (onError) onError(e.message);
    }
  }

  // ─── LOAD DIRECT ──────────────────────────────────────────────
  // Para sites que permitem iframe direto (sem X-Frame-Options: deny)
  function loadDirect(url, frameEl) {
    frameEl.removeAttribute('srcdoc');
    frameEl.src = url;
    frameEl.style.display = 'block';
  }

  // ─── FETCH FOR AI ─────────────────────────────────────────────
  // Busca a página e retorna texto limpo para adicionar ao contexto da IA.
  // Remove scripts, estilos, nav e footer para economizar tokens.
  async function fetchForAI(url) {
    const { html } = await fetchHTML(url);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script, style, nav, footer, header, noscript').forEach(el => el.remove());
    const text = (tmp.innerText || tmp.textContent || '')
      .replace(/\s{3,}/g, '\n\n')   // colapsa espaços excessivos
      .trim()
      .slice(0, 10000);             // limita para não explodir o contexto
    return text;
  }

  // ─── TEST ALL ─────────────────────────────────────────────────
  // Testa todos os proxies com uma URL simples e retorna latências
  async function testAll(testURL = 'https://example.com') {
    return Promise.all(PROXIES.map(async (p, i) => {
      const t = Date.now();
      try {
        const r = await fetch(p.build(testURL), { signal: AbortSignal.timeout(6000) });
        return { i, name: p.name, ok: r.ok, ms: Date.now() - t };
      } catch {
        return { i, name: p.name, ok: false, ms: Date.now() - t };
      }
    }));
  }

  // ─── PIN ──────────────────────────────────────────────────────
  // Trava o PipProxy num proxy específico. idx = -1 ou null → auto
  function pin(idx) {
    pinned = (idx === null || idx === -1) ? null : idx;
  }

  function getList() {
    return PROXIES.map((p, i) => ({ ...p, i }));
  }

  return { load, loadDirect, fetchForAI, testAll, pin, getList };
})();
