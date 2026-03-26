// ═══════════════════════════════════════════════════════════════
//  script.js  —  Sistema  /  client controller  (rewrite v2)
//  ALL API calls → server.js (/api/*)  — no direct OpenRouter
// ═══════════════════════════════════════════════════════════════
'use strict';

/* ── PROXY ────────────────────────────────────────────────────
   PipProxy é carregado por pip-proxy.js (antes deste script em
   index.html). Aqui apenas registramos o listener que recebe
   o conteúdo de páginas enviado pelo proxy.html via postMessage.
   Isso permite que a IA leia o conteúdo de qualquer URL aberta
   no browser proxy sem depender de /api/browse.
   ─────────────────────────────────────────────────────────── */
window.addEventListener('message', e => {
  // proxy.html manda { type:'proxy-content', url, text }
  // quando o usuário clica "enviar para IA"
  if (!e.data || e.data.type !== 'proxy-content') return;
  if (typeof window.SYS !== 'undefined' && window.SYS.injectBrowseContext) {
    window.SYS.injectBrowseContext(e.data.url, e.data.text);
  }
});

/* ── SERVER API wrappers ────────────────────────────────────── */
// returns headers including x-api-key if user typed one in the UI
function apiHeaders() {
  const key = sessionStorage.getItem('sys_api_key') || '';
  const h = { 'Content-Type': 'application/json' };
  if (key) h['x-api-key'] = key;
  return h;
}

const API = {
  // POST /api/chat → SSE  (callbacks: onChunk, onDone, onError)
  async chat(messages, model, systemPrompt, onChunk, onDone, onError) {
    let res;
    try { res = await fetch('/api/chat', { method:'POST', headers:apiHeaders(), body:JSON.stringify({messages,model,systemPrompt}) }); }
    catch(e) { onError(new Error('rede: '+e.message)); return; }
    if (!res.ok) { onError(new Error(`server ${res.status}: ${(await res.text().catch(()=>''))}`)); return; }
    const rdr=res.body.getReader(), dec=new TextDecoder(); let buf='', full='';
    try {
      while (true) {
        const {done,value}=await rdr.read(); if (done) break;
        buf+=dec.decode(value,{stream:true});
        const lines=buf.split('\n'); buf=lines.pop()||'';
        for (const ln of lines) {
          const t=ln.trim(); if (!t.startsWith('data: ')||t==='data: [DONE]') continue;
          try {
            const j=JSON.parse(t.slice(6));
            if (j.text)                { full+=j.text; onChunk(j.text); }
            if (j.chars!==undefined)   { onDone(full); return; }
            if (j.message)             { onError(new Error(j.message)); return; }
          } catch {}
        }
      }
      onDone(full);
    } catch(e) { onError(new Error('stream: '+e.message)); }
  },

  // POST /api/plan → JSON
  async plan(text) {
    const r=await fetch('/api/plan',{method:'POST',headers:apiHeaders(),body:JSON.stringify({text})});
    if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
    return r.json();
  },

  // POST /api/py → { stdout, stderr, exitCode, ms }
  async py(code, timeout=10000) {
    const r=await fetch('/api/py',{method:'POST',headers:apiHeaders(),body:JSON.stringify({code,timeout})});
    if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
    return r.json();
  },

  // GET /api/status
  async status() {
    const r=await fetch('/api/status'); if (!r.ok) throw new Error('offline'); return r.json();
  }
};

/* ── MARKDOWN ───────────────────────────────────────────────── */
function md(raw) {
  if (!raw) return '';
  let s=raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s=s.replace(/```([\w-]*)\n?([\s\S]*?)```/g,(_,l,c)=>`<pre><code class="lang-${l||'txt'}">${c.trimEnd()}</code></pre>`);
  s=s.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  s=s.replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>');
  s=s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*(?!\s)(.+?)(?<!\s)\*/g,'<em>$1</em>');
  s=s.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  s=s.replace(/^---+$/gm,'<hr>');
  s=s.replace(/^[-*] (.+)$/gm,'<li>$1</li>');
  s=s.replace(/(<li>[\s\S]+?<\/li>)/g,'<ul>$1</ul>');
  s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--bl)">$1</a>');
  s=s.replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
  return s;
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }


/* ── WINDOW MANAGER ─────────────────────────────────────────── */
window.WM = (() => {
  let wins=[], zT=10, sq=0;
  const desk=()=>document.getElementById('desk');
  const DW=()=>desk().offsetWidth, DH=()=>desk().offsetHeight-42, EDGE=20;

  function spawn(opts={}) {
    const id=++sq, dw=DW(), dh=DH();
    const pw=opts.w||Math.min(440,dw*.47), ph=opts.h||Math.min(320,dh*.52);
    const off=(wins.length%6)*24;
    const px=opts.x!==undefined?opts.x:Math.max(10,dw-pw-20-off);
    const py=opts.y!==undefined?opts.y:Math.max(6,dh-ph-20-off);
    const el=document.createElement('div');
    el.className='pip focused'; el.id='pip-'+id;
    el.style.cssText=`left:${px}px;top:${py}px;width:${pw}px;height:${ph}px;z-index:${++zT}`;
    const s={id,el,label:opts.label||'pip-'+id,collapsed:false};
    el.innerHTML=tpl(id,s.label,opts.content||'');
    desk().appendChild(el); wins.push(s); attachBeh(s); updateChips(); doFocus(id);
    return s;
  }

  function tpl(id, label, content) {
    const rhs=['n','s','e','w','ne','nw','se','sw'].map(d=>`<div class="rh" data-d="${d}"></div>`).join('');
    const body=content
      ?`<div class="pip-body" style="overflow:auto;padding:10px;font-size:.62rem;line-height:1.65;color:var(--tx);">${content}</div>`
      :`<div class="pip-body"><div class="empty-state"><div class="empty-icon">⧉</div><span>janela vazia</span>
         <button class="btn-small" onclick="WM.loadURL(${id})">abrir URL</button></div>
         <iframe class="pip-iframe" id="frm-${id}" style="display:none;width:100%;height:100%;border:none;"
           sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"></iframe></div>`;
    return `${rhs}<div class="pip-head" data-id="${id}">
      <div class="pip-grip"><span><i></i><i></i></span><span><i></i><i></i></span><span><i></i><i></i></span></div>
      <span class="pip-lbl" id="wlbl-${id}">${esc(label)}</span>
      <div class="pip-btns">
        <button class="pip-btn" onclick="WM.toggleCol(${id})">–</button>
        <button class="pip-btn pip-close" onclick="WM.close(${id})">✕</button>
      </div></div>${body}<div class="szb" id="szb-${id}"></div>`;
  }

  function loadURL(id) {
    const url=prompt('URL:'); if(!url) return;
    const full=url.startsWith('http')?url:'https://'+url;
    const frm=document.getElementById('frm-'+id); if(!frm) return;
    frm.parentElement.querySelector('.empty-state').style.display='none';
    PipProxy.load(full,frm,{
      onStart:()=>{frm.style.display='block';},
      onSuccess:p=>{const s=wins.find(w=>w.id===id);if(s){try{s.label=new URL(full).hostname;}catch{s.label=url;}
        const l=document.getElementById('wlbl-'+id);if(l)l.textContent=s.label;updateChips();}},
      onError:e=>alert('Erro: '+e)
    });
  }

  function openFilePicker() {
    const inp=document.createElement('input'); inp.type='file';
    inp.accept='.html,.htm,.svg,.txt,.md,.js,.css,.json';
    inp.onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();
      r.onload=ev=>{const s=spawn({label:f.name});const frm=s.el.querySelector('iframe');
        if(frm&&/\.(html?|svg)$/i.test(f.name)){frm.srcdoc=ev.target.result;frm.style.display='block';
          s.el.querySelector('.empty-state').style.display='none';}
        else{s.el.querySelector('.pip-body').innerHTML=`<div style="padding:12px;font-size:.62rem;line-height:1.65;white-space:pre-wrap;overflow:auto;height:100%;">${esc(ev.target.result)}</div>`;}
      };r.readAsText(f);};inp.click();
  }

  function attachBeh(s) {
    const {id,el}=s;
    el.addEventListener('mousedown',()=>doFocus(id));
    const h=el.querySelector('.pip-head');
    let drag=false,ox,oy;
    h.addEventListener('mousedown',e=>{if(e.target.closest('button,.pip-btns'))return;drag=true;const r=el.getBoundingClientRect();ox=e.clientX-r.left;oy=e.clientY-r.top;el.style.transition='none';el.style.right='auto';el.style.bottom='auto';e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!drag)return;el.style.left=Math.max(0,Math.min(DW()-el.offsetWidth,e.clientX-ox))+'px';el.style.top=Math.max(0,Math.min(DH()-el.offsetHeight,e.clientY-oy))+'px';showGuide(getZone(e.clientX,e.clientY));});
    document.addEventListener('mouseup',e=>{if(!drag)return;drag=false;const z=getZone(e.clientX,e.clientY);hideGuide();if(z)snapTo(id,z);});
    h.addEventListener('dblclick',e=>{if(!e.target.closest('button'))snapTo(id,'full');});
    el.querySelectorAll('.rh').forEach(rh=>{
      let rs=false,dir,rx,ry,rw,rh2,rl,rt;
      rh.addEventListener('mousedown',e=>{rs=true;dir=rh.dataset.d;rx=e.clientX;ry=e.clientY;rw=el.offsetWidth;rh2=el.offsetHeight;rl=el.offsetLeft;rt=el.offsetTop;el.style.transition='none';el.style.right='auto';el.style.bottom='auto';e.preventDefault();e.stopPropagation();});
      document.addEventListener('mousemove',e=>{if(!rs)return;const dx=e.clientX-rx,dy=e.clientY-ry;let nw=rw,nh=rh2,nl=rl,nt=rt;if(dir.includes('e'))nw=Math.max(200,rw+dx);if(dir.includes('s'))nh=Math.max(130,rh2+dy);if(dir.includes('w')){nw=Math.max(200,rw-dx);nl=rl+(rw-nw);}if(dir.includes('n')){nh=Math.max(130,rh2-dy);nt=rt+(rh2-nh);}el.style.width=nw+'px';el.style.height=nh+'px';el.style.left=nl+'px';el.style.top=nt+'px';const b=document.getElementById('szb-'+id);if(b){b.textContent=Math.round(nw)+'×'+Math.round(nh);b.style.opacity='1';}});
      document.addEventListener('mouseup',()=>{if(rs){rs=false;setTimeout(()=>{const b=document.getElementById('szb-'+id);if(b)b.style.opacity='0';},900);}});
    });
  }

  function doFocus(id){wins.forEach(w=>w.el.classList.remove('focused'));const s=wins.find(w=>w.id===id);if(!s)return;s.el.style.zIndex=++zT;s.el.classList.add('focused');updateChips();}
  function close(id){const i=wins.findIndex(w=>w.id===id);if(i===-1)return;wins[i].el.classList.add('pip-dy');setTimeout(()=>{wins[i].el.remove();wins.splice(i,1);updateChips();},200);}
  function toggleCol(id){const s=wins.find(w=>w.id===id);if(!s)return;s.collapsed=!s.collapsed;s.el.classList.toggle('col',s.collapsed);const b=s.el.querySelector('.pip-btn[onclick*="toggleCol"]');if(b)b.textContent=s.collapsed?'+':'–';}
  function removeLast(){if(!wins.length)return;close(wins.reduce((a,b)=>+a.el.style.zIndex>+b.el.style.zIndex?a:b).id);}
  function resetAll(){[...wins].forEach(s=>s.el.remove());wins=[];zT=10;sq=0;updateChips();}

  function snapTo(id,pos){
    const s=wins.find(w=>w.id===id);if(!s)return;
    const el=s.el,dw=DW(),dh=DH(),ow=el.offsetWidth,oh=el.offsetHeight,p=14;
    const M={tl:[p,p,ow,oh],tc:[(dw-ow)/2,p,ow,oh],tr:[dw-ow-p,p,ow,oh],ml:[p,(dh-oh)/2,ow,oh],mc:[(dw-ow)/2,(dh-oh)/2,ow,oh],mr:[dw-ow-p,(dh-oh)/2,ow,oh],bl:[p,dh-oh-p,ow,oh],bc:[(dw-ow)/2,dh-oh-p,ow,oh],br:[dw-ow-p,dh-oh-p,ow,oh],left:[0,0,dw/2,dh],right:[dw/2,0,dw/2,dh],full:[0,0,dw,dh]};
    const [x,y,w,h]=M[pos]||M.mc;
    el.classList.add('sn');el.style.right='auto';el.style.bottom='auto';
    el.style.left=x+'px';el.style.top=y+'px';el.style.width=w+'px';el.style.height=h+'px';
    setTimeout(()=>el.classList.remove('sn'),240);
  }
  function ar(s,x,y,w,h){s.el.classList.add('sn');s.el.style.right='auto';s.el.style.bottom='auto';s.el.style.left=x+'px';s.el.style.top=y+'px';s.el.style.width=w+'px';s.el.style.height=h+'px';setTimeout(()=>s.el.classList.remove('sn'),240);}
  function gridLayout(c=2){if(!wins.length)return;const dw=DW(),dh=DH(),r=Math.ceil(wins.length/c),tw=Math.floor(dw/c),th=Math.floor(dh/r);wins.forEach((s,i)=>ar(s,(i%c)*tw,Math.floor(i/c)*th,tw,th));}
  function tileH(){if(!wins.length)return;const dw=DW(),dh=DH(),tw=Math.floor(dw/wins.length);wins.forEach((s,i)=>ar(s,i*tw,0,tw,dh));}
  function cascade(){if(!wins.length)return;const dw=DW(),dh=DH(),bw=Math.min(480,dw*.52),bh=Math.min(340,dh*.58);wins.forEach((s,i)=>{ar(s,i*24+24,i*24+24,bw,bh);s.el.style.zIndex=10+i;});doFocus(wins[wins.length-1].id);}
  function getZone(mx,my){const dw=DW();if(mx<EDGE)return'left';if(mx>dw-EDGE)return'right';if(my<EDGE)return'full';return null;}
  function showGuide(z){const g=document.getElementById('guide'),dw=window.innerWidth,top=68,dh=window.innerHeight-42-68;const Z={left:{left:0,top,width:dw/2,height:dh},right:{left:dw/2,top,width:dw/2,height:dh},full:{left:0,top,width:dw,height:dh}};if(!z||!Z[z]){g.style.display='none';return;}const r=Z[z];g.style.display='block';Object.assign(g.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});}
  function hideGuide(){document.getElementById('guide').style.display='none';}
  function updateChips(){const chips=document.getElementById('wb-chips');if(!chips)return;const maxZ=wins.length?Math.max(...wins.map(s=>+s.el.style.zIndex||0)):0;chips.innerHTML=wins.map(s=>`<div class="wb-chip ${+s.el.style.zIndex===maxZ?'wc-active':''}" onclick="WM.focus(${s.id})"><div class="wdot"></div><span class="wb-chip-lbl">${esc(s.label)}</span></div>`).join('');}
  function focus(id){doFocus(id);}
  function getWins(){return wins;}
  return{spawn,close,focus,openFilePicker,removeLast,resetAll,gridLayout,tileH,cascade,updateChips,loadURL,getWins};
})();


/* ── SYSTEM CONTROLLER ─────────────────────────────────────── */
window.SYS = (() => {
  // STATE
  let files=[],activeFile=null,tabs=[],activeTab=null,fileIdSq=0;
  let aiHistory=[],aiSummary='',sysPrompt='',betaMode=false,aiStreaming=false;
  let modeWindows=false,engineOpen=false,langIdx=0;
  const LANGS=['txt','js','html','css','json','md','py'];
  const DEFAULT_MODELS=[
    {value:'google/gemini-2.0-flash-001',      label:'gemini-2.0-flash' },
    {value:'anthropic/claude-haiku-4-5',        label:'claude-haiku-4-5' },
    {value:'anthropic/claude-sonnet-4-5',       label:'claude-sonnet-4-5'},
    {value:'anthropic/claude-opus-4',           label:'claude-opus-4'    },
    {value:'openai/gpt-4o-mini',                label:'gpt-4o-mini'      },
    {value:'openai/gpt-4o',                     label:'gpt-4o'           },
    {value:'meta-llama/llama-3.3-70b-instruct', label:'llama-3.3-70b'    },
    {value:'mistralai/mistral-7b-instruct',     label:'mistral-7b'       },
    {value:'deepseek/deepseek-chat',            label:'deepseek-chat'    },
  ];
  const PRESET={
    model:'google/gemini-2.0-flash-001',
    instruction:'Seja direto e objetivo. Responda na mesma língua do usuário. Sem introduções, sem filler. Para código use blocos com linguagem.',
    desc:'Gemini 2.0 Flash — rápido, barato, excelente custo-benefício'
  };
  const CTX={TRIGGER:12,KEEP:4};

  // INIT
  function init() {
    const sk=sessionStorage.getItem('sys_api_key'); if(sk)document.getElementById('ai-key').value=sk;
    const ss=sessionStorage.getItem('sys_prompt'); if(ss){sysPrompt=ss;document.getElementById('ai-sys-prompt').value=ss;updateSysCharCount();}
    const em=JSON.parse(sessionStorage.getItem('extra_models')||'[]');
    renderModelSelect([...DEFAULT_MODELS,...em]);
    checkServer(); updateFileList(); updateLineNums(); updateEditorStatus();

    // Drag & drop visual feedback
    const dropZone = document.getElementById('file-drop');
    if (dropZone) {
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
      });
    }
  }

  // SERVER STATUS
  async function checkServer() {
    const dot=document.getElementById('server-dot');
    try {
      const d=await API.status();
      dot.classList.add('ok');
      if (d.keyConfigured){
        document.getElementById('api-dot').classList.add('ok');
        document.getElementById('ai-dot-ind').classList.add('ok');
        hideKeyBanner();
      } else { showKeyBanner(); }
      logEngine('ok',`servidor ok — node ${d.node} — key: ${d.keyConfigured?'✓ .env':'✗ não configurada'}`);
    } catch {
      dot.classList.remove('ok'); showKeyBanner();
      logEngine('warn','servidor offline — inicie: npm start');
    }
  }

  // KEY BANNER
  function showKeyBanner() {
    if (document.getElementById('key-banner')) return;
    const b=document.createElement('div'); b.id='key-banner';
    b.innerHTML=`<span style="flex:1">⚠ servidor offline ou sem API key<span style="display:block;font-size:.5rem;opacity:.5;margin-top:2px">inicie server.js e configure OPENROUTER_KEY no .env</span></span>
      <button onclick="SYS.checkServer()" style="border:1px solid rgba(232,124,58,.4);border-radius:5px;background:rgba(232,124,58,.1);color:var(--ac);font-family:var(--mn);font-size:.56rem;padding:3px 9px;cursor:pointer;white-space:nowrap;flex-shrink:0">reconectar</button>`;
    Object.assign(b.style,{display:'flex',alignItems:'center',gap:'10px',padding:'8px 10px',margin:'6px 8px',borderRadius:'7px',border:'1px solid rgba(232,124,58,.3)',background:'rgba(232,124,58,.07)',fontSize:'.58rem',color:'rgba(255,180,100,.9)',lineHeight:'1.5',animation:'fadeIn .2s ease'});
    const msgs=document.getElementById('ai-msgs'); msgs.insertBefore(b,msgs.firstChild);
  }
  function hideKeyBanner(){const b=document.getElementById('key-banner');if(b)b.remove();}

  // FILES
  function addFileFromDisk(){const inp=document.createElement('input');inp.type='file';inp.multiple=true;inp.accept='.html,.htm,.js,.ts,.css,.json,.md,.mdx,.txt,.svg,.py';inp.onchange=e=>Array.from(e.target.files).forEach(loadFile);inp.click();}
  
  // Internal file loader (does not touch UI, returns promise with id)
  function _loadFileInternal(f) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = ev => {
        const id = ++fileIdSq;
        const ext = f.name.split('.').pop().toLowerCase();
        const tm = {
          js: 'js', ts: 'js', py: 'py',
          html: 'html', htm: 'html', css: 'css',
          json: 'json', md: 'md', mdx: 'md',
          svg: 'html', txt: 'txt'
        };
        files.push({
          id,
          name: f.name,
          content: ev.target.result,
          type: tm[ext] || 'txt',
          size: f.size
        });
        resolve(id);
      };
      r.readAsText(f);
    });
  }

  // Public single file loader
  async function loadFile(f) {
    const id = await _loadFileInternal(f);
    openTab(id);
    updateFileList();
  }

  // Handle drop (multiple files)
  async function handleDrop(e) {
    e.preventDefault();
    const dropArea = document.getElementById('file-drop');
    if (dropArea) dropArea.classList.remove('drag-over');

    const filesToAdd = Array.from(e.dataTransfer.files);
    if (!filesToAdd.length) return;

    const newIds = [];
    for (const f of filesToAdd) {
      const id = await _loadFileInternal(f);
      if (id) newIds.push(id);
    }

    if (newIds.length) {
      openTab(newIds[newIds.length - 1]); // open last file
      updateFileList();                   // single UI refresh
    }
  }

  function newFile(){const id=++fileIdSq;files.push({id,name:`arquivo-${id}.txt`,content:'',type:'txt',size:0});updateFileList();openTab(id);}
  function openTab(fid){
    if(!tabs.includes(fid))tabs.push(fid);activeTab=fid;
    const f=files.find(x=>x.id===fid);
    if(f){activeFile=f;document.getElementById('editor').value=f.content;
      const ext=f.name.split('.').pop().toLowerCase();
      const lm={js:'js',ts:'js',html:'html',htm:'html',css:'css',json:'json',md:'md',mdx:'md',py:'py',svg:'html'};
      const lang=lm[ext]||'txt';langIdx=LANGS.indexOf(lang);if(langIdx<0)langIdx=0;
      document.getElementById('st-lang').textContent=lang;
      document.getElementById('tb-file-lbl').textContent=f.name;}
    renderTabs();updateLineNums();updateEditorStatus();
  }
  function closeTab(fid,e){if(e)e.stopPropagation();const i=tabs.indexOf(fid);if(i===-1)return;tabs.splice(i,1);if(activeTab===fid){activeTab=tabs[i]||tabs[i-1]||null;if(activeTab)openTab(activeTab);else{activeFile=null;document.getElementById('editor').value='';document.getElementById('tb-file-lbl').textContent='—';}}renderTabs();}
  function renderTabs(){
    const bar=document.getElementById('file-tabs-bar');
    const add='<button class="tab-add" onclick="SYS.newFile()" title="Novo arquivo">+</button>';
    if(!tabs.length){bar.innerHTML='<div class="empty-state" style="flex:none;flex-direction:row;padding:0;gap:6px;font-size:.55rem;color:var(--dm);">sem arquivos abertos</div>'+add;return;}
    bar.innerHTML=tabs.map(fid=>{const f=files.find(x=>x.id===fid)||{name:'?'};return`<div class="file-tab ${fid===activeTab?'tab-active':''}" onclick="SYS.openTab(${fid})"><span>${esc(f.name)}</span><span class="tab-close" onclick="SYS.closeTab(${fid},event)">✕</span></div>`;}).join('')+add;
  }
  function updateFileList(filter=''){
    const list=document.getElementById('file-list'),empty=document.getElementById('files-empty');
    const vis=files.filter(f=>!filter||f.name.toLowerCase().includes(filter.toLowerCase()));
    if(!vis.length){empty.style.display='';list.innerHTML='';list.appendChild(empty);return;}
    empty.style.display='none';
    list.innerHTML=vis.map(f=>`<div class="file-item ${f.id===activeTab?'selected':''}" onclick="SYS.openTab(${f.id})"><span class="fi-icon">${fileIcon(f.type)}</span><span class="fi-name">${esc(f.name)}</span><span class="fi-size">${fmtSize(f.size)}</span></div>`).join('');
  }
  function searchFiles(q){document.getElementById('file-search-in').value=q;document.getElementById('search-input').value=q;updateFileList(q);}
  function toggleSearch(){document.getElementById('search-input').focus();}
  function clearFiles(){if(files.length&&!confirm('Remover todos os arquivos?'))return;files=[];tabs=[];activeFile=null;activeTab=null;renderTabs();document.getElementById('editor').value='';document.getElementById('tb-file-lbl').textContent='—';updateLineNums();updateEditorStatus();}
  function saveCurrentFile(){if(!activeFile)return;activeFile.content=document.getElementById('editor').value;const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([activeFile.content],{type:'text/plain'})),download:activeFile.name});a.click();const si=document.getElementById('st-saved');si.style.display='';setTimeout(()=>si.style.display='none',2000);}

  // EDITOR
  function onEditorInput(){if(activeFile)activeFile.content=document.getElementById('editor').value;updateLineNums();updateEditorStatus();}
  function onEditorKey(e){if(e.key==='Tab'){e.preventDefault();const ed=e.target,s=ed.selectionStart,en=ed.selectionEnd;ed.value=ed.value.substring(0,s)+'  '+ed.value.substring(en);ed.selectionStart=ed.selectionEnd=s+2;onEditorInput();}if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveCurrentFile();}}
  function updateLineNums(){const ed=document.getElementById('editor');document.getElementById('line-nums').innerHTML=Array.from({length:ed.value.split('\n').length},(_,i)=>`<div>${i+1}</div>`).join('');}
  function syncScroll(){document.getElementById('line-nums').scrollTop=document.getElementById('editor').scrollTop;}
  function updateEditorStatus(){const ed=document.getElementById('editor'),v=ed.value;document.getElementById('st-char').textContent=v.length;const b=v.substring(0,ed.selectionStart);document.getElementById('st-ln').textContent=b.split('\n').length;document.getElementById('st-col').textContent=b.split('\n').pop().length+1;}
  function cycleLang(){langIdx=(langIdx+1)%LANGS.length;document.getElementById('st-lang').textContent=LANGS[langIdx];}

  // EXECUTE
  function runPreview(){const c=document.getElementById('editor').value;if(!c.trim()){logEngine('warn','Editor vazio.');return;}const w=window.open('','_blank');w.document.write(c);w.document.close();}
  function execFile(){
    const c=document.getElementById('editor').value;if(!c.trim()){logEngine('warn','Editor vazio.');return;}if(!engineOpen)toggleEngine();
    if(LANGS[langIdx]!=='js'){logEngine('warn',`Exec local só suporta JS. Lang: ${LANGS[langIdx]}`);return;}
    logEngine('info','▷ executando JS…');
    const [ol,oe,ow]=[console.log,console.error,console.warn];
    console.log=(...a)=>{ol(...a);logEngine('log',a.map(x=>JSON.stringify(x)).join(' '));};
    console.error=(...a)=>{oe(...a);logEngine('err',a.map(x=>JSON.stringify(x)).join(' '));};
    console.warn=(...a)=>{ow(...a);logEngine('warn',a.map(x=>JSON.stringify(x)).join(' '));};
    try{new Function(c)();logEngine('ok','✓ concluído');}catch(e){logEngine('err','Erro: '+e.message);}
    [console.log,console.error,console.warn]=[ol,oe,ow];
  }
  async function runPython(){
    const c=document.getElementById('editor').value;if(!c.trim()){logEngine('warn','Editor vazio.');return;}if(!engineOpen)toggleEngine();
    logEngine('py','🐍 enviando ao servidor /api/py…');
    try{const{stdout,stderr,exitCode,ms}=await API.py(c);if(stdout)stdout.split('\n').filter(Boolean).forEach(l=>logEngine('log',l));if(stderr)stderr.split('\n').filter(Boolean).forEach(l=>logEngine('err',l));logEngine(exitCode===0?'ok':'err',`exit ${exitCode} — ${ms}ms`);}
    catch(e){logEngine('err','Falha: '+e.message);}
  }

  // ENGINE CONSOLE
  function toggleEngine(){engineOpen=!engineOpen;document.getElementById('engine-overlay').classList.toggle('eng-open',engineOpen);document.getElementById('workspace').style.bottom=engineOpen?'220px':'0';}
  function clearEngine(){document.getElementById('eng-log').innerHTML='<div class="empty-state" style="padding:.5rem"><span style="font-size:.58rem;color:var(--dm)">// limpo</span></div>';}
  function logEngine(type,msg){
    const log=document.getElementById('eng-log');const empty=log.querySelector('.empty-state');if(empty)empty.remove();
    const ts=new Date().toTimeString().slice(0,8);const labels={log:'LOG',err:'ERR',warn:'WRN',info:'INF',ok:'OK ',py:'PY '};
    const line=document.createElement('div');line.className='log-line';
    line.innerHTML=`<span class="log-ts">${ts}</span><span class="log-type lt-${type}">${labels[type]||type}</span><span class="log-msg">${esc(String(msg))}</span>`;
    log.appendChild(line);log.scrollTop=log.scrollHeight;
  }

  // PANELS
  function setPanel(p){['ai','edit','engine'].forEach(id=>document.getElementById('tab-'+id).classList.toggle('active',id===p));if(p==='ai')document.getElementById('ai-input').focus();if(p==='edit')document.getElementById('editor').focus();if(p==='engine')toggleEngine();}

  // MODE WINDOWS
  function toggleModeWindows(){modeWindows=!modeWindows;document.getElementById('btn-mode-win').classList.toggle('active',modeWindows);document.getElementById('workspace').classList.toggle('ws-hidden',modeWindows);document.getElementById('desk').classList.toggle('desk-active',modeWindows);document.getElementById('winbar').classList.toggle('wb-active',modeWindows);document.getElementById('engine-overlay').style.display=modeWindows?'none':'';if(modeWindows&&!WM.getWins().length)spawnPanelWindows();}
  function spawnPanelWindows(){const dw=window.innerWidth,dh=window.innerHeight-42-68,hw=Math.floor(dw/2),hh=Math.floor(dh/2);WM.spawn({label:'arquivos',w:hw,h:hh,x:0,y:0,content:files.length?files.map(f=>`<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">${fileIcon(f.type)} ${esc(f.name)}</div>`).join(''):'<em style="color:var(--dm)">nenhum arquivo</em>'});WM.spawn({label:'editor',w:hw,h:hh,x:hw,y:0,content:activeFile?`<pre style="font-size:.58rem;overflow:auto">${esc(activeFile.content.slice(0,3000))}</pre>`:'<em style="color:var(--dm)">nenhum arquivo</em>'});WM.spawn({label:'painel AI',w:hw,h:hh,x:0,y:hh,content:'<div style="font-size:.62rem;color:var(--dm)">use o modo normal para chat AI.</div>'});WM.spawn({label:'engine',w:hw,h:hh,x:hw,y:hh,content:'<div style="font-size:.62rem;color:var(--gr)">//&nbsp;engine<br><span style="color:var(--dm)">use ▷ execute file no modo normal.</span></div>'});}

  // MODELS
  function renderModelSelect(models){const sel=document.getElementById('ai-model'),cur=sel.value;sel.innerHTML=models.map(m=>`<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');if(cur&&[...sel.options].some(o=>o.value===cur))sel.value=cur;}
  function toggleAddModel(){const row=document.getElementById('ai-addmodel-row'),vis=row.style.display!=='none';row.style.display=vis?'none':'flex';if(!vis)document.getElementById('ai-addmodel-in').focus();}
  function addModel(){const inp=document.getElementById('ai-addmodel-in'),val=inp.value.trim();if(!val)return;const label=val.includes('/')?val.split('/').pop():val;const extra=JSON.parse(sessionStorage.getItem('extra_models')||'[]');if(!extra.some(m=>m.value===val)){extra.push({value:val,label});sessionStorage.setItem('extra_models',JSON.stringify(extra));}renderModelSelect([...DEFAULT_MODELS,...extra]);document.getElementById('ai-model').value=val;inp.value='';toggleAddModel();}

  // PRESET
  function applyPreset(){const btn=document.getElementById('btn-preset'),hint=document.getElementById('preset-hint'),sel=document.getElementById('ai-model');if(![...sel.options].some(o=>o.value===PRESET.model)){const opt=document.createElement('option');opt.value=PRESET.model;opt.textContent=PRESET.model.split('/').pop();sel.appendChild(opt);}sel.value=PRESET.model;document.getElementById('ai-sys-prompt').value=PRESET.instruction;sysPrompt=PRESET.instruction;sessionStorage.setItem('sys_prompt',sysPrompt);updateSysCharCount();const body=document.getElementById('sysbar-body');if(body.style.display==='none')toggleSysPrompt();btn.classList.add('applied');btn.textContent='✓ aplicado';hint.textContent=PRESET.desc;setTimeout(()=>{btn.classList.remove('applied');btn.textContent='★ AI recomenda';},2200);}

  // SESSION PROMPT
  function toggleSysPrompt(){const body=document.getElementById('sysbar-body'),arr=document.getElementById('sysbar-arr'),open=body.style.display!=='none';body.style.display=open?'none':'block';arr.classList.toggle('open',!open);if(!open)document.getElementById('ai-sys-prompt').focus();}
  function onSysPromptInput(){sysPrompt=document.getElementById('ai-sys-prompt').value;sessionStorage.setItem('sys_prompt',sysPrompt);updateSysCharCount();let dot=document.getElementById('sys-active-dot');if(sysPrompt.trim()){if(!dot){dot=document.createElement('span');dot.id='sys-active-dot';dot.className='sys-active-dot';dot.title='instrução ativa';document.getElementById('ai-model').parentElement.appendChild(dot);}}else{if(dot)dot.remove();}}
  function updateSysCharCount(){const el=document.getElementById('sys-char-count');if(el)el.textContent=sysPrompt.length+' chars';onSysPromptInput();}
  function clearSysPrompt(){sysPrompt='';document.getElementById('ai-sys-prompt').value='';sessionStorage.removeItem('sys_prompt');updateSysCharCount();}
  function setApiKey(v) {
    const key = v.trim();
    sessionStorage.setItem('sys_api_key', key);
    // update dots immediately
    const ok = key.length > 8;
    const dotInd = document.getElementById('ai-dot-ind');
    const dotApi = document.getElementById('api-dot');
    if (dotInd) { dotInd.classList.toggle('ok', ok); dotInd.classList.remove('ld'); }
    if (dotApi) dotApi.classList.toggle('ok', ok);
    if (ok) hideKeyBanner(); else showKeyBanner();
  }
  function checkApiKey() {
    const key = sessionStorage.getItem('sys_api_key') || '';
    const serverOk = document.getElementById('server-dot').classList.contains('ok');
    if (key.length > 8 || serverOk) hideKeyBanner();
  }
  function injectEditorContext(){const c=document.getElementById('editor').value;if(!c.trim()){alert('Editor vazio.');return;}const ta=document.getElementById('ai-input');ta.value=`contexto do editor:\n\`\`\`${LANGS[langIdx]}\n${c.slice(0,3000)}\n\`\`\`\n\n`;aiResize();ta.focus();}
  function clearAI(){aiHistory=[];aiSummary='';document.getElementById('ai-msgs').innerHTML='<div class="empty-state" id="ai-empty"><div class="empty-icon">◈</div><span>histórico limpo</span></div>';updateCtxBadge();}


  // BETA MODE TOGGLE
  function toggleBeta(){betaMode=!betaMode;const btn=document.getElementById('btn-beta');btn.classList.toggle('beta-on',betaMode);btn.title=betaMode?'Beta Py ATIVO — clique para desativar':'Beta Py Mode';addAIMsg('ai',betaMode?'⚡ **Beta Py Mode ativado.** Vou planejar cada resposta e usar Python quando necessário.':'**Beta Py Mode desativado.**');}

  // PY POPUP CONTROLS — all with null guards (popup HTML may not exist)
  let _popT=null;
  const _g = id => document.getElementById(id);
  const _gs = (id,w) => { const e=_g(id); if(e) e.style.display=w; };
  const _gt = (id,v) => { const e=_g(id); if(e) e.textContent=v; };
  const _gc = (id,v) => { const e=_g(id); if(e) e.className=v; };
  const _gp = v     => { const e=_g('py-popup-progress'); if(e) e.style.width=v; };

  function popShow(title){
    clearTimeout(_popT);
    const p=_g('py-popup'); if(!p) return;
    p.classList.remove('py-popup-out');
    _gt('py-popup-title',title);
    ['py-popup-intent','py-popup-steps','py-popup-code-sec','py-popup-result-sec'].forEach(id=>_gs(id,'none'));
    _gp('0%'); _gc('py-popup-dots','py-popup-dots'); p.style.display='block';
  }
  function popIntent(v){
    _gt('py-intent-val',v); _gs('py-popup-intent','flex'); _gp('20%');
  }
  function popSteps(steps,idx){
    const el=_g('py-steps-list');
    if(el) el.innerHTML=steps.map((s,i)=>`<div class="py-step ${i<idx?'done':i===idx?'active':''}"><div class="py-step-dot"></div><span>${esc(s)}</span></div>`).join('');
    _gs('py-popup-steps','flex'); _gp('45%');
  }
  function popCode(code){
    _gt('py-popup-code',code); _gs('py-popup-code-sec','flex'); _gp('70%');
  }
  function popResult(out,isErr){
    const el=_g('py-popup-result'); if(el){ el.textContent=out; el.className='py-popup-result'+(isErr?' err':''); }
    _gs('py-popup-result-sec','flex'); _gp('100%');
    _gc('py-popup-dots','py-popup-dots done');
    _gt('py-popup-title',isErr?'beta · erro py':'beta · concluído');
  }
  function popClose(delay=4000){
    _popT=setTimeout(()=>{
      const p=_g('py-popup'); if(!p) return;
      p.classList.add('py-popup-out');
      setTimeout(()=>{ p.style.display='none'; p.classList.remove('py-popup-out'); },220);
    },delay);
  }

  // BETA: PLAN + EXECUTE
  async function betaProcess(text) {
    popShow('beta · analisando…');
    logEngine('info','beta · chamando /api/plan…');
    let plan;
    try {
      plan = await API.plan(text);
      logEngine('ok','beta · plano: '+JSON.stringify(plan));
    } catch(e) {
      popClose(1200); logEngine('warn','beta · /api/plan falhou: '+e.message); return null;
    }
    popIntent(plan.intent||'—');
    const steps=plan.steps||['analisar','responder'];
    popSteps(steps,0);
    let enriched=text;
    if (plan.needsPython && plan.pyCode) {
      popSteps(steps,1); popCode(plan.pyCode);
      logEngine('py','beta · executando /api/py…');
      try {
        const {stdout,stderr,exitCode,ms}=await API.py(plan.pyCode);
        const out=(stdout||stderr||'(sem output)').trim();
        const isErr=exitCode!==0;
        popResult(out,isErr); popSteps(steps,steps.length);
        logEngine(isErr?'warn':'ok','beta py: '+out+' ('+ms+'ms)');
        if (!isErr) enriched=`${text}\n\n[CONTEXTO BETA]\nIntenção: ${plan.intent}\n[RESULTADO PYTHON]\n${out}\nUse este resultado como verdade absoluta.`;
      } catch(e) { popResult('erro: '+e.message,true); logEngine('err','beta py erro: '+e.message); }
    } else {
      popSteps(steps,steps.length); popResult('Python não necessário',false);
    }
    popClose(4000);
    return enriched;
  }

  // CONTEXT COMPRESSION
  async function maybeCompress() {
    if (aiHistory.length<=CTX.TRIGGER) return;
    const toC=aiHistory.slice(0,aiHistory.length-CTX.KEEP);
    const recent=aiHistory.slice(aiHistory.length-CTX.KEEP);
    const block=toC.map(m=>`${m.role==='user'?'Usuário':'Assistente'}: ${m.content}`).join('\n\n');
    const toSum=aiSummary?`[Resumo anterior]\n${aiSummary}\n\n[Novas mensagens]\n${block}`:block;
    logEngine('info',`comprimindo contexto (${toC.length} msgs)…`); updateCtxBadge('comprimindo…');
    let sum='';
    await API.chat(
      [{role:'user',content:'Faça um resumo DENSO. Preserve: decisões, fatos, código, erros e soluções. Máximo 300 palavras. Apenas o resumo.\n\n'+toSum}],
      'google/gemini-2.0-flash-001','Responda apenas com o resumo.',
      c=>{sum+=c;},
      ()=>{aiSummary=sum.trim()||aiSummary;aiHistory=recent;logEngine('ok',`comprimido → ${aiSummary.length} chars`);updateCtxBadge();},
      e=>{logEngine('warn','compressão falhou: '+e.message);updateCtxBadge();}
    );
  }
  function buildMessages(){if(!aiSummary)return aiHistory;return[{role:'user',content:'[Resumo da conversa anterior]\n'+aiSummary},{role:'assistant',content:'Entendido.'},...aiHistory];}
  function updateCtxBadge(text){const b=document.getElementById('ai-ctx-badge');if(!b)return;if(text){b.textContent=text;b.style.color='var(--bl)';return;}const chars=aiHistory.reduce((s,m)=>s+m.content.length,0)+(aiSummary?aiSummary.length:0),tok=Math.round(chars/4);b.style.color='var(--dm)';b.textContent=tok>999?`~${(tok/1000).toFixed(1)}k tkn`:`~${tok} tkn`;}

  // THINKING INDICATOR
  function makeThinkingEl(model){
    const div=document.createElement('div'); div.className='ai-msg';
    const ts=Date.now();
    div.innerHTML=`<div class="ai-avatar">AI</div>
      <div class="ai-bubble" style="background:rgba(91,156,246,.06);border-color:rgba(91,156,246,.18);padding:8px 10px;">
        <div class="ai-thinking">
          <div class="thinking-dots"><div class="tdot"></div><div class="tdot"></div><div class="tdot"></div></div>
          <span class="thinking-label">pensando…</span>
          <div class="thinking-info">ℹ
            <div class="thinking-tooltip">
              <div class="tt-row"><span class="tt-key">modelo</span><span class="tt-val">${esc(model.split('/').pop())}</span></div>
              <div class="tt-row"><span class="tt-key">tempo</span><span class="tt-val ld" id="tt-time">0s</span></div>
              <div class="tt-row"><span class="tt-key">chunks</span><span class="tt-val" id="tt-chunks">0</span></div>
              <div class="tt-row"><span class="tt-key">chars</span><span class="tt-val" id="tt-chars">0</span></div>
            </div>
          </div>
        </div>
      </div>`;
    div._timer=setInterval(()=>{const el=document.getElementById('tt-time');if(el)el.textContent=((Date.now()-ts)/1000).toFixed(1)+'s';else clearInterval(div._timer);},200);
    return div;
  }

  // AI SEND
  function aiKeydown(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendAI();}}
  function aiResize(){const t=document.getElementById('ai-input');t.style.height='auto';t.style.height=Math.min(110,t.scrollHeight)+'px';}

  // helper — always unlocks UI regardless of what happened
  function unlockAI() {
    aiStreaming=false;
    document.getElementById('ai-send-btn').disabled=false;
    document.getElementById('ai-dot-ind').classList.remove('ld');
  }

  async function sendAI() {
    if (aiStreaming) return;
    const input=document.getElementById('ai-input');
    const text=input.value.trim(); if(!text) return;

    // guard: server must be online
    if (!document.getElementById('server-dot').classList.contains('ok')) {
      const k=document.getElementById('ai-key');
      k.style.boxShadow='0 0 0 2px rgba(240,96,96,.6)';
      setTimeout(()=>{ k.style.boxShadow=''; },1800);
      showKeyBanner(); return;
    }

    // lock immediately — prevents double-send during beta phase too
    aiStreaming=true;
    document.getElementById('ai-send-btn').disabled=true;
    document.getElementById('ai-dot-ind').classList.add('ld');

    input.value=''; aiResize();
    const model=document.getElementById('ai-model').value;

    try {
      // ── BETA phase (plan + optional python) ──────────────────
      let finalText=text;
      if (betaMode) {
        logEngine('info','beta · iniciando…');
        const enriched=await betaProcess(text);
        if (enriched!==null) finalText=enriched;
        logEngine(finalText!==text?'ok':'warn',
          finalText!==text?'beta · texto enriquecido com resultado py':'beta · usando texto original');
      }

      // show original to user, send enriched to AI
      addAIMsg('user',text);
      aiHistory.push({role:'user',content:finalText});
      await maybeCompress();

      // build system prompt
      const sys=(sysPrompt.trim()||
        'Be maximally concise and objective. Answer in the same language the user writes in. No filler. Use code blocks for code.')
        +(betaMode?'\n\n[BETA MODE] When the message contains [RESULTADO PYTHON], use that value as absolute truth. Be direct.':'');

      // thinking bubble — stays visible until first chunk arrives
      const thinkEl=makeThinkingEl(model);
      document.getElementById('ai-msgs').appendChild(thinkEl); scrollAI();

      // streaming bubble (created once, populated by onChunk)
      const wrap=document.createElement('div'); wrap.className='ai-msg';
      const av=document.createElement('div'); av.className='ai-avatar'; av.textContent='AI';
      const bubble=document.createElement('div'); bubble.className='ai-bubble stream-cursor';
      wrap.appendChild(av); wrap.appendChild(bubble);

      let fullText='', chunks=0, bubbleAdded=false;

      await API.chat(
        buildMessages(), model, sys,
        // onChunk — first chunk removes thinking and shows bubble
        delta=>{
          if (!bubbleAdded) {
            bubbleAdded=true;
            clearInterval(thinkEl._timer); thinkEl.remove();
            document.getElementById('ai-msgs').appendChild(wrap);
          }
          fullText+=delta; chunks++;
          bubble.innerHTML=md(fullText);
          scrollAI();
        },
        // onDone
        ()=>{
          // if no chunks arrived at all, remove thinking and show bubble with error
          if (!bubbleAdded) {
            clearInterval(thinkEl._timer); thinkEl.remove();
            document.getElementById('ai-msgs').appendChild(wrap);
          }
          bubble.classList.remove('stream-cursor');
          if (fullText.trim()) {
            aiHistory.push({role:'assistant',content:fullText});
            updateCtxBadge();
            logEngine('ok',`resposta: ${fullText.length} chars, ${chunks} chunks`);
          } else {
            if (aiHistory.length&&aiHistory[aiHistory.length-1].role==='user') aiHistory.pop();
            bubble.innerHTML='<span style="color:var(--rd);font-size:.58rem">⚠ resposta vazia — tente novamente</span>';
            logEngine('warn','onDone: resposta vazia');
          }
          unlockAI();
        },
        // onError
        err=>{
          if (!bubbleAdded) {
            clearInterval(thinkEl._timer); thinkEl.remove();
            document.getElementById('ai-msgs').appendChild(wrap);
          }
          bubble.classList.remove('stream-cursor');
          bubble.innerHTML=`<span style="color:var(--rd);font-size:.58rem">⚠ ${esc(err.message)}</span>`;
          if (aiHistory.length&&aiHistory[aiHistory.length-1].role==='user') aiHistory.pop();
          logEngine('err','API.chat erro: '+err.message);
          unlockAI();
        }
      );

    } catch(e) {
      // safety net — should never reach here, but ensures UI is never stuck
      logEngine('err','sendAI erro inesperado: '+e.message);
      addAIMsg('ai','⚠ Erro inesperado: '+e.message);
      if (aiHistory.length&&aiHistory[aiHistory.length-1].role==='user') aiHistory.pop();
      unlockAI();
    }
  }

  function addAIMsg(role,text){const empty=document.getElementById('ai-empty');if(empty)empty.remove();const div=document.createElement('div');div.className='ai-msg'+(role==='user'?' usr':'');div.innerHTML=`<div class="ai-avatar">${role==='user'?'U':'AI'}</div><div class="ai-bubble">${role==='user'?esc(text):md(text)}</div>`;document.getElementById('ai-msgs').appendChild(div);scrollAI();}
  function scrollAI(){const m=document.getElementById('ai-msgs');m.scrollTop=m.scrollHeight;}

  // MODAL
  function confirmReset(){document.getElementById('modal-body').textContent='₢ Fecha todas as janelas e limpa o estado. Confirmar?';document.getElementById('modal-confirm-btn').onclick=()=>{WM.resetAll();closeModal();};document.getElementById('confirm-modal').classList.add('open');}
  function closeModal(){document.getElementById('confirm-modal').classList.remove('open');}

  // UTILS
  function fileIcon(t){return{js:'⟨/⟩',html:'⊛',css:'⊙',json:'{}',md:'#',txt:'≡',py:'🐍'}[t]||'◈';}
  function fmtSize(b){return b<1024?b+'b':b<1048576?(b/1024).toFixed(1)+'k':(b/1048576).toFixed(1)+'M';}

  // ─── BROWSE ─────────────────────────────────────────────────
  // Abre o proxy.html numa nova janela com a URL desejada.
  // Opcionalmente, também busca o conteúdo via PipProxy.fetchForAI()
  // e injeta como contexto na próxima mensagem da IA.
  let _browseWin = null;

  function browse(url, fetchContext = false) {
    if (!url) { url = prompt('URL para abrir no browser:'); if (!url) return; }
    if (!url.startsWith('http')) url = 'https://' + url;

    // Reutiliza a janela se já estiver aberta; senão abre nova
    if (_browseWin && !_browseWin.closed) {
      _browseWin.postMessage({ type: 'load-url', url, useProxy: true }, '*');
      _browseWin.focus();
    } else {
      _browseWin = window.open('proxy.html?url=' + encodeURIComponent(url), 'sistema-browser',
        'width=1024,height=720,menubar=no,toolbar=no,location=no,status=no');
    }

    // Se o caller pediu contexto, busca o HTML limpo e injeta no AI
    if (fetchContext && window.PipProxy) {
      addAIMsg('ai', `🌐 Buscando conteúdo de **${url}** para análise…`);
      PipProxy.fetchForAI(url)
        .then(text => injectBrowseContext(url, text))
        .catch(err => addAIMsg('ai', `⚠️ Não foi possível buscar **${url}**: ${err}`));
    }
  }

  // Chamado pelo postMessage do proxy.html quando o usuário clica
  // "enviar para IA", ou pelo browse() com fetchContext=true.
  // Injeta o conteúdo como uma mensagem de sistema no histórico da IA.
  function injectBrowseContext(url, text) {
    if (!text) return;
    const snippet = text.slice(0, 6000); // respeita o orçamento de tokens
    const contextMsg = `[CONTEXTO DE NAVEGAÇÃO]\nURL: ${url}\n\n${snippet}`;
    // insere no histórico como mensagem de usuário (invisível no chat)
    aiHistory.push({ role: 'user', content: contextMsg });
    // feedback visual no chat
    addAIMsg('ai', `✓ Conteúdo de **${url}** adicionado ao contexto (${text.length} chars). Agora posso responder perguntas sobre essa página.`);
    updateCtxBadge();
  }

  // PUBLIC API
  return {
    init, checkServer,
    addFileFromDisk, handleDrop, newFile, openTab, closeTab, clearFiles, saveCurrentFile,
    onEditorInput, onEditorKey, syncScroll, updateEditorStatus, cycleLang,
    runPreview, execFile, runPython, toggleEngine, clearEngine, logEngine,
    setPanel, toggleModeWindows,
    renderModelSelect, toggleAddModel, addModel, applyPreset,
    toggleSysPrompt, onSysPromptInput, updateSysCharCount, clearSysPrompt,
    setApiKey, checkApiKey, injectEditorContext, clearAI,
    aiKeydown, aiResize, sendAI,
    toggleBeta, updateCtxBadge,
    searchFiles, toggleSearch,
    confirmReset, closeModal,
    browse, injectBrowseContext   // ← integração proxy ↔ IA
  };
})();

/* ── BOOT ──────────────────────────────────────────────────── */
window.addEventListener('load', () => {
  SYS.init();
  document.getElementById('confirm-modal').addEventListener('click', e => {
    if (e.target===document.getElementById('confirm-modal')) SYS.closeModal();
  });
});

/* ──────────────────────────────────────────────────────────────
   SISTEMA CONSOLE  (Ctrl+Ç / Ctrl+` to toggle)
   Commands: help, clear, status, ls, py <code>, node <code>,
             or any JS expression evaluated client-side
────────────────────────────────────────────────────────────── */
window.CONSOLE = (() => {
  let visible   = false;
  let history   = [];      // command history
  let histIdx   = -1;
  let dragging  = false, resizing = false;
  let ox, oy, ow, oh, ex, ey;

  // ── DOM helpers ────────────────────────────────────────────
  const el   = () => document.getElementById('sys-console');
  const out  = () => document.getElementById('syscon-out');
  const inp  = () => document.getElementById('syscon-input');
  const badge= () => document.getElementById('syscon-badge');

  // ── Toggle ─────────────────────────────────────────────────
  function toggle() {
    visible = !visible;
    const c = el();
    if (visible) {
      c.style.display = 'flex';
      c.classList.remove('syscon-out');
      setTimeout(() => inp().focus(), 50);
      badge().textContent = document.getElementById('server-dot').classList.contains('ok') ? 'server' : 'offline';
      badge().className   = document.getElementById('server-dot').classList.contains('ok') ? 'syscon-badge' : 'syscon-badge offline';
    } else {
      c.classList.add('syscon-out');
      setTimeout(() => c.style.display = 'none', 160);
    }
  }

  // ── Print ───────────────────────────────────────────────────
  function print(text, type = 'out') {
    const o = out();
    const line = document.createElement('div');
    line.className = 'syscon-line';
    line.innerHTML = `<span class="syscon-line-${type}">${esc(String(text))}</span>`;
    o.appendChild(line);
    o.scrollTop = o.scrollHeight;
  }

  function printCmd(cmd) {
    const o = out();
    const line = document.createElement('div');
    line.className = 'syscon-line';
    line.innerHTML = `<span class="syscon-line-prompt">›</span><span class="syscon-line-cmd">${esc(cmd)}</span>`;
    o.appendChild(line);
  }

  function clear() {
    out().innerHTML = '';
  }

  // ── Built-in commands ───────────────────────────────────────
  const BUILTINS = {
    help() {
      print('comandos disponíveis:', 'info');
      print('  help              — esta ajuda', 'sys');
      print('  clear             — limpar output', 'sys');
      print('  status            — status do servidor', 'sys');
      print('  ls                — listar arquivos carregados', 'sys');
      print('  history           — histórico AI', 'sys');
      print('  py <código>       — executar Python no servidor', 'sys');
      print('  node <código>     — executar Node.js no servidor', 'sys');
      print('  <expressão JS>    — avaliado no cliente', 'sys');
    },

    clear() { clear(); },

    async status() {
      try {
        const d = await API.status();
        print(`servidor: ok — node ${d.node}`, 'ok');
        print(`API key:  ${d.keyConfigured ? '✓ configurada (.env)' : '✗ não configurada'}`, d.keyConfigured ? 'ok' : 'warn');
        print(`modelos:  ${d.models.length} disponíveis`, 'info');
      } catch(e) {
        print('servidor offline — inicie: npm start', 'err');
      }
    },

    ls() {
      if (!window.SYS) { print('SYS não disponível', 'err'); return; }
      // access files via the DOM (SYS is encapsulated)
      const items = document.querySelectorAll('.file-item .fi-name');
      if (!items.length) { print('nenhum arquivo carregado', 'warn'); return; }
      items.forEach(el => print('  ' + el.textContent, 'out'));
    },

    history() {
      // peek at AI history via SYS if exposed
      print('histórico AI: use SYS diretamente no cliente', 'sys');
    },

    async py(code) {
      if (!code.trim()) { print('uso: py <código python>', 'warn'); return; }
      print('🐍 executando…', 'sys');
      try {
        const { stdout, stderr, exitCode, ms } = await API.py(code);
        if (stdout) stdout.split('\n').filter(Boolean).forEach(l => print(l, 'out'));
        if (stderr) stderr.split('\n').filter(Boolean).forEach(l => print(l, 'err'));
        print(`exit ${exitCode} — ${ms}ms`, exitCode === 0 ? 'ok' : 'err');
      } catch(e) { print('erro: ' + e.message, 'err'); }
    },

    async node(code) {
      if (!code.trim()) { print('uso: node <código js>', 'warn'); return; }
      print('⬛ executando no servidor…', 'sys');
      try {
        const r = await fetch('/api/console', {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify({ code })
        });
        if (!r.ok) { print(`HTTP ${r.status}`, 'err'); return; }
        const { result, logs, error, ms } = await r.json();
        if (logs && logs.length) logs.forEach(l => print(l, 'out'));
        if (error)  print('erro: ' + error, 'err');
        if (result !== null && result !== undefined) print(result, 'ok');
        print(`${ms}ms`, 'sys');
      } catch(e) { print('falha: ' + e.message, 'err'); }
    }
  };

  // ── Run command ─────────────────────────────────────────────
  async function run(raw) {
    const cmd = raw.trim();
    if (!cmd) return;

    history.unshift(cmd);
    if (history.length > 80) history.pop();
    histIdx = -1;

    printCmd(cmd);

    // split into command + args
    const [head, ...rest] = cmd.split(/\s+/);
    const tail = rest.join(' ');

    if (BUILTINS[head.toLowerCase()]) {
      await BUILTINS[head.toLowerCase()](tail);
      return;
    }

    // evaluate as client-side JS expression
    try {
      const result = eval(cmd);         // intentional eval for REPL
      const resolved = await Promise.resolve(result);
      if (resolved !== undefined) {
        print(typeof resolved === 'object' ? JSON.stringify(resolved, null, 2) : String(resolved), 'ok');
      }
    } catch(e) {
      print(e.message, 'err');
    }
  }

  // ── Key handler ─────────────────────────────────────────────
  function onKey(e) {
    if (e.key === 'Enter') {
      const v = inp().value; inp().value = ''; run(v);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      histIdx = Math.min(histIdx + 1, history.length - 1);
      if (history[histIdx] !== undefined) inp().value = history[histIdx];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      histIdx = Math.max(histIdx - 1, -1);
      inp().value = histIdx >= 0 ? history[histIdx] : '';
    } else if (e.key === 'Escape') {
      toggle();
    }
  }

  // ── Drag ────────────────────────────────────────────────────
  function initDrag() {
    const hd = document.getElementById('syscon-hd');
    const c  = el();

    hd.addEventListener('mousedown', e => {
      if (e.target.closest('button,.syscon-resize,.syscon-hd-btns')) return;
      dragging = true;
      const r = c.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      c.style.transition = 'none'; c.style.bottom = 'auto'; c.style.right = 'auto';
      c.style.left = r.left + 'px'; c.style.top = r.top + 'px';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      c.style.left = Math.max(0, Math.min(window.innerWidth  - c.offsetWidth,  e.clientX - ox)) + 'px';
      c.style.top  = Math.max(0, Math.min(window.innerHeight - c.offsetHeight, e.clientY - oy)) + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });

    // resize from bottom-right corner
    const rzh = document.getElementById('syscon-resize');
    rzh.addEventListener('mousedown', e => {
      resizing = true;
      const r = c.getBoundingClientRect();
      ex = e.clientX; ey = e.clientY; ow = r.width; oh = r.height;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      c.style.width  = Math.max(280, ow + (e.clientX - ex)) + 'px';
      c.style.height = Math.max(160, oh + (e.clientY - ey)) + 'px';
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  }

  // ── Global shortcut ─────────────────────────────────────────
  function initShortcut() {
    document.addEventListener('keydown', e => {
      // Ctrl+Ç  (key='ç' or key='Ç', code='Semicolon' on BR keyboards)
      // Ctrl+`  (fallback for non-BR keyboards)
      if (!e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'ç' || k === '`' || k === '\\') {
        e.preventDefault();
        toggle();
      }
    });
  }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    initDrag();
    initShortcut();
  }

  return { toggle, clear, onKey, init, run, print };
})();

// init console after DOM ready
window.addEventListener('load', () => CONSOLE.init());