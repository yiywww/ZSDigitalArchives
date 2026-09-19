/* ===========================================================
   中山文旅 · 数字档案 —— 前端交互
   密钥不在前端；所有请求都走本地代理 /api/chat
   =========================================================== */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    portals: $('portal-list'),
    thread: $('thread'),
    empty: $('hall-empty'),
    emptySub: $('empty-sub'),
    suggestions: $('suggestions'),
    input: $('input'),
    send: $('btn-send'),
    stop: $('btn-stop'),
    reset: $('btn-reset'),
    dossierNo: $('dossier-no'),
    shelf: $('shelf'),
    shelfList: $('shelf-list'),
    shelfToggle: $('btn-shelf'),
    shelfClose: $('shelf-close'),
    shelfNew: $('shelf-new'),
    shelfMask: $('shelf-mask'),
  };

  const state = {
    perspectives: [],
    current: null,
    sending: false,
    controller: null,
    history: [],     // 用于「已切换视角」判断
    volumes: [],     // 卷宗架存档
    activeId: '',
  };

  const KEY_CONV = 'zs.conversationId';
  const KEY_USER = 'zs.userId';

  /* ---------------- 工具 ---------------- */

  function randomId(prefix) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return prefix + hex;                       // 满足 ^[a-zA-Z0-9_-]{32,64}$
  }

  function getConversationId() {
    const id = localStorage.getItem(KEY_CONV) || '';
    return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : '';
  }

  function setConversationId(id) {
    if (id && /^[a-zA-Z0-9_-]{1,64}$/.test(id)) localStorage.setItem(KEY_CONV, id);
  }

  function resetConversationId() {
    localStorage.removeItem(KEY_CONV);
  }

  function getUserId() {
    let id = localStorage.getItem(KEY_USER);
    if (!id || !/^[a-zA-Z0-9_-]{32,64}$/.test(id)) {
      id = randomId('visitor');
      localStorage.setItem(KEY_USER, id);
    }
    return id;
  }

  function formatTime(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function formatDay(ts) {
    const d = ts ? new Date(ts) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function nearBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  }

  function scrollToBottom(force) {
    if (force || nearBottom()) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  /* ---------------- Markdown 轻渲染（无外部依赖）---------------- */

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TRIM_TAIL = /[.,;:!?、。，；：！？）)】」”"']+$/;

  function renderMarkdown(src) {
    const links = [];
    const stash = [];
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

    let text = String(src || '').replace(/\u0000/g, '');

    // 1) 代码块
    text = text.replace(/```[ \t]*([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) =>
      keep(`<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`));

    // 2) 转义
    text = escapeHtml(text);

    // 3) 行内代码
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${code}</code>`));

    // 4) 图片（知识库配图，同一张只保留第一处）
    const seenImg = new Set();
    text = text.replace(/!\[([^\]\n]{0,160})\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_m, alt, url) => {
      const src = url.replace(TRIM_TAIL, '');
      if (seenImg.has(src)) return '';
      seenImg.add(src);
      const caption = alt.trim() || '知识库配图';
      return keep(`<figure class="fig"><img src="${src}" alt="${caption}" loading="lazy" /><figcaption>${caption}</figcaption></figure>`);
    });

    // 5) 显式 Markdown 链接
    text = text.replace(/\[([^\]\n]{1,120})\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_m, label, url) => {
      const href = url.replace(TRIM_TAIL, '');
      links.push({ title: label.trim(), url: href });
      return keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label.trim()}</a>`);
    });

    // 5) 裸链接
    text = text.replace(/(https?:\/\/[^\s<>"'）)】\]]+)/g, (m) => {
      const href = m.replace(TRIM_TAIL, '');
      if (!href) return m;
      const tail = m.slice(href.length);
      links.push({ title: href, url: href });
      return keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`) + tail;
    });

    // 6) 强调
    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // 7) 块级
    const lines = text.split(/\r?\n/);
    const html = [];
    let para = [];
    let list = null;   // 'ul' | 'ol'
    let quote = false;

    const flushPara = () => {
      if (para.length) { html.push(`<p>${para.join('<br />')}</p>`); para = []; }
    };
    const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
    const closeQuote = () => { if (quote) { html.push('</blockquote>'); quote = false; } };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (!line.trim()) { flushPara(); closeList(); closeQuote(); continue; }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushPara(); closeList(); closeQuote();
        const tag = heading[1].length <= 2 ? 'h3' : 'h4';
        html.push(`<${tag}>${heading[2]}</${tag}>`);
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushPara(); closeList(); closeQuote();
        html.push('<hr />');
        continue;
      }

      const quoteLine = /^\s*>\s?(.*)$/.exec(line);
      if (quoteLine) {
        flushPara(); closeList();
        if (!quote) { html.push('<blockquote>'); quote = true; }
        else html.push('<br />');
        html.push(quoteLine[1]);
        continue;
      }
      closeQuote();

      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        flushPara();
        if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
        html.push(`<li>${ul[1]}</li>`);
        continue;
      }

      const ol = /^\s*\d+[.)、]\s+(.*)$/.exec(line);
      if (ol) {
        flushPara();
        if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
        html.push(`<li>${ol[1]}</li>`);
        continue;
      }

      closeList();
      para.push(line.trim());
    }
    flushPara(); closeList(); closeQuote();

    let out = html.join('');
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] ?? '');

    // 去重来源
    const seen = new Set();
    const sources = links.filter((l) => {
      const k = l.url.replace(/[#?].*$/, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return { html: out, sources };
  }

  /* ---------------- 视角 ---------------- */

  function renderPortals() {
    els.portals.innerHTML = '';
    state.perspectives.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'portal' + (state.current?.id === p.id ? ' active' : '');
      btn.dataset.id = p.id;
      btn.innerHTML = `
        <span class="p-pick">已择</span>
        <span class="p-seal">${escapeHtml(p.seal || '问')}</span>
        <span class="p-name">${escapeHtml(p.name)}</span>
        <span class="p-tag">${escapeHtml(p.tagline || '')}</span>`;
      btn.addEventListener('click', () => choosePerspective(p.id));
      els.portals.appendChild(btn);
    });
    renderSuggestions();
  }

  function choosePerspective(id) {
    const next = state.perspectives.find((p) => p.id === id);
    if (!next || next.id === state.current?.id) return;
    const hadMessages = state.history.length > 0;
    state.current = next;

    if (hadMessages) {
      // 切换视角即另起新会话，避免上下文串味
      resetConversationId();
      const label = `已转至「${next.name}」视角`;
      addSwitchNote(label);
      currentVolume()?.messages.push({ role: 'note', text: label, at: Date.now() });
      els.empty.hidden = true;
      scrollToBottom(true);
    } else {
      resetConversationId();
    }

    const vol = currentVolume();
    if (vol) {
      vol.perspectiveId = next.id;
      vol.conversationId = '';
      saveStore();
    }

    renderPortals();
    updateDossierNo();
    els.input.placeholder = `从「${next.name}」视角提问……`;
  }

  function renderSuggestions() {
    els.suggestions.innerHTML = '';
    const list = state.current?.examples || [];
    els.emptySub.textContent = state.current
      ? `门径已开：${state.current.name} · ${state.current.tagline || ''}`
      : '先择一门径，再道出你的疑问';
    list.slice(0, 4).forEach((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'suggestion';
      b.textContent = q;
      b.addEventListener('click', () => { els.input.value = q; send(); });
      els.suggestions.appendChild(b);
    });
  }

  function updateDossierNo() {
    const id = localStorage.getItem(KEY_CONV) || '';
    els.dossierNo.textContent = `卷宗编号 ${id ? id.slice(0, 12) : '——'}`;
  }

  /* ---------------- 卷宗架（历史存档） ---------------- */

  const KEY_VOLUMES = 'zs.volumes';
  const STORE_LIMIT = 2000000;   // 存档字符上限，超出则淘汰最旧卷宗
  const THOUGHT_KEEP = 1500;     // 思虑过程存档截断长度

  function loadStore() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY_VOLUMES) || 'null');
      if (data && Array.isArray(data.volumes)) {
        state.volumes = data.volumes.filter((v) => v && typeof v.id === 'string' && Array.isArray(v.messages));
        state.activeId = typeof data.activeId === 'string' ? data.activeId : '';
      }
    } catch { /* 存档损坏则忽略 */ }
  }

  function saveStore() {
    let payload = '';
    for (;;) {
      payload = JSON.stringify({ volumes: state.volumes, activeId: state.activeId });
      if (payload.length <= STORE_LIMIT || state.volumes.length <= 1) break;
      // 淘汰最旧的一卷（跳过当前卷）
      let idx = -1;
      for (let i = state.volumes.length - 1; i >= 0; i--) {
        if (state.volumes[i].id !== state.activeId) { idx = i; break; }
      }
      if (idx < 0) break;
      state.volumes.splice(idx, 1);
    }
    try {
      localStorage.setItem(KEY_VOLUMES, payload);
    } catch {
      // 仍超限：只保留最近一半
      state.volumes = state.volumes.slice(0, Math.max(1, Math.ceil(state.volumes.length / 2)));
      try {
        localStorage.setItem(KEY_VOLUMES, JSON.stringify({ volumes: state.volumes, activeId: state.activeId }));
      } catch { /* 放弃写入，不影响本次会话 */ }
    }
    renderShelf();
  }

  function currentVolume() {
    return state.volumes.find((v) => v.id === state.activeId) || null;
  }

  function ensureVolume() {
    let vol = currentVolume();
    if (vol) return vol;
    vol = {
      id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      conversationId: '',
      perspectiveId: state.current?.id || '',
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.volumes.unshift(vol);
    state.activeId = vol.id;
    return vol;
  }

  function trimThought(text) {
    const t = String(text || '');
    return t.length > THOUGHT_KEEP ? `${t.slice(0, THOUGHT_KEEP)}\n…（思虑过长，存档已截断）` : t;
  }

  function renderShelf() {
    if (!els.shelfList) return;
    els.shelfList.innerHTML = '';
    if (!state.volumes.length) {
      els.shelfList.innerHTML = '<p class="shelf-empty">架上尚无存档</p>';
      return;
    }
    state.volumes.forEach((v) => {
      const p = state.perspectives.find((x) => x.id === v.perspectiveId);
      const item = document.createElement('div');
      item.className = 'shelf-item' + (v.id === state.activeId ? ' active' : '');
      item.innerHTML = `
        <button class="shelf-open" type="button">
          <span class="shelf-title">${escapeHtml(v.title || '未命名卷宗')}</span>
          <span class="shelf-meta">${escapeHtml(p?.name || '—')} · ${formatDay(v.updatedAt)} · ${v.messages.length} 则</span>
        </button>
        <button class="shelf-del" type="button" title="删除此卷">删</button>`;
      item.querySelector('.shelf-open').addEventListener('click', () => openVolume(v.id));
      item.querySelector('.shelf-del').addEventListener('click', (e) => { e.stopPropagation(); removeVolume(v.id); });
      els.shelfList.appendChild(item);
    });
  }

  function applyVolume(v) {
    const p = state.perspectives.find((x) => x.id === v.perspectiveId) || state.perspectives[0];
    state.current = p;
    renderPortals();
    if (v.conversationId) localStorage.setItem(KEY_CONV, v.conversationId);
    else resetConversationId();
    renderThreadFromVolume(v);
    updateDossierNo();
    els.input.placeholder = p ? `从「${p.name}」视角提问……` : '键入你的疑问……';
  }

  function openVolume(id) {
    if (id !== state.activeId) {
      state.controller?.abort();
      const v = state.volumes.find((x) => x.id === id);
      if (!v) return;
      state.activeId = id;
      applyVolume(v);
      scrollToBottom(true);
    }
    saveStore();
    closeShelf();
  }

  function removeVolume(id) {
    state.volumes = state.volumes.filter((v) => v.id !== id);
    if (state.activeId === id) {
      state.activeId = '';
      els.thread.innerHTML = '';
      state.history = [];
      resetConversationId();
      els.empty.hidden = false;
      renderSuggestions();
      updateDossierNo();
    }
    saveStore();
  }

  function openShelf() {
    els.shelf.classList.add('open');
    els.shelfMask.classList.add('open');
  }

  function closeShelf() {
    els.shelf.classList.remove('open');
    els.shelfMask.classList.remove('open');
  }

  /* ---------------- 消息渲染 ---------------- */

  function addUserMessage(text, perspective, at) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    wrap.innerHTML = `
      <div>
        <div class="bubble">${escapeHtml(text)}</div>
        <div class="stamp">${formatTime(at ? new Date(at) : new Date())} · ${escapeHtml(perspective?.name || '')}</div>
      </div>`;
    els.thread.appendChild(wrap);
    state.history.push({ role: 'user', text });
  }

  function addSwitchNote(text) {
    const note = document.createElement('div');
    note.className = 'switch-note';
    note.innerHTML = `<span class="rule"></span><span>${escapeHtml(text)}</span><span class="rule"></span>`;
    els.thread.appendChild(note);
  }

  /** 从存档还原整卷：用户提问、视角切换标记、档案答复 */
  function renderThreadFromVolume(v) {
    els.thread.innerHTML = '';
    state.history = [];
    const p = state.perspectives.find((x) => x.id === v.perspectiveId) || state.perspectives[0];
    v.messages.forEach((m) => {
      if (m.role === 'user') {
        addUserMessage(m.text, p, m.at);
      } else if (m.role === 'note') {
        addSwitchNote(m.text);
      } else if (m.role === 'assistant') {
        const node = createAssistantMessage(p, { pending: false, at: m.at });
        node.raw = m.raw || '';
        node.refs = m.refs || [];
        if (m.thought) {
          node.thoughtRaw = m.thought;
          node.thought.hidden = false;
          node.thought.classList.add('collapsed');
          node.thoughtIcon.textContent = '▸';
          node.thoughtBody.textContent = m.thought;
        }
        paint(node, false);
        state.history.push({ role: 'assistant', text: node.raw });
      }
    });
    els.empty.hidden = v.messages.length > 0;
    renderSuggestions();
  }

  function createAssistantMessage(perspective, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    wrap.innerHTML = `
      <article class="dossier">
        <header class="dossier-head">
          <span class="dossier-tag">档案答复 · ${escapeHtml(perspective?.name || '')}</span>
          <span class="dossier-time">${formatTime(opts.at ? new Date(opts.at) : new Date())}</span>
        </header>
        <div class="dossier-progress">
          <div class="progress-line">
            <span class="spinner" aria-hidden="true"></span>
            <span class="progress-text">正在调阅档案</span>
            <span class="progress-meta">已用 0 秒</span>
          </div>
          <div class="progress-steps"></div>
        </div>
        <div class="thought-block collapsed" hidden>
          <div class="thought-head"><span class="caret-icon">▸</span><span>思虑过程</span></div>
          <div class="thought-body"></div>
        </div>
        <div class="dossier-body"></div>
        <div class="sources" hidden><h4>卷宗出处</h4><div class="source-list"></div></div>
        <div class="dossier-foot">
          <button class="dossier-fold" type="button">收起</button>
        </div>
      </article>`;

    const node = {
      root: wrap,
      dossier: wrap.querySelector('.dossier'),
      body: wrap.querySelector('.dossier-body'),
      thought: wrap.querySelector('.thought-block'),
      thoughtBody: wrap.querySelector('.thought-body'),
      thoughtHead: wrap.querySelector('.thought-head'),
      thoughtIcon: wrap.querySelector('.caret-icon'),
      sources: wrap.querySelector('.sources'),
      sourceList: wrap.querySelector('.source-list'),
      fold: wrap.querySelector('.dossier-fold'),
      progress: wrap.querySelector('.dossier-progress'),
      progressText: wrap.querySelector('.progress-text'),
      progressMeta: wrap.querySelector('.progress-meta'),
      progressSteps: wrap.querySelector('.progress-steps'),
      raw: '',
      pending: '',
      thoughtRaw: '',
      thoughtQueue: '',
      thoughtTimer: null,
      answerQueue: '',
      streamEnded: false,
      stages: [],
      startedAt: Date.now(),
      progressTimer: null,
      streamBuf: '',
      phase: 'start',    // start → thinking → answer
      refs: [],
      links: [],
    };

    if (opts.pending === false) node.progress.hidden = true;
    else startProgress(node);

    node.fold.addEventListener('click', () => {
      const collapsed = node.dossier.classList.toggle('collapsed');
      node.fold.textContent = collapsed ? '展开' : '收起';
    });

    node.thoughtHead.addEventListener('click', () => {
      const collapsed = node.thought.classList.toggle('collapsed');
      node.thoughtIcon.textContent = collapsed ? '▸' : '▾';
    });

    els.thread.appendChild(wrap);
    return node;
  }

  function paint(node, caret) {
    const { html, sources } = renderMarkdown(node.raw);
    node.body.innerHTML = html + (caret ? '<span class="typing-caret"></span>' : '');
    const merged = [...node.refs, ...sources];
    const seen = new Set();
    const finalSources = merged.filter((s) => {
      const k = s.url.replace(/[#?].*$/, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    node.links = finalSources;

    if (finalSources.length) {
      node.sources.hidden = false;
      node.sourceList.innerHTML = finalSources
        .map((s, i) => {
          let host = s.url;
          try { host = new URL(s.url).hostname; } catch { /* ignore */ }
          const title = s.title && s.title !== s.url ? s.title : host;
          return `<a class="source-card" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">
              <span class="source-index">${i + 1}</span>
              <span class="source-main">
                <span class="source-title">${escapeHtml(title)}</span>
                <span class="source-url">${escapeHtml(host)}</span>
              </span>
            </a>`;
        })
        .join('');
    }
  }

  /* ---------------- 调阅进度 ---------------- */

  /** 上游是整包下发，等待期用工作流节点给出「正在做什么」 */
  function startProgress(node) {
    node.progress.hidden = false;
    if (node.progressTimer) return;
    node.progressTimer = setInterval(() => {
      const sec = Math.round((Date.now() - node.startedAt) / 1000);
      node.progressMeta.textContent = `已用 ${sec} 秒`;
    }, 1000);
  }

  function stopProgress(node) {
    if (node.progressTimer) { clearInterval(node.progressTimer); node.progressTimer = null; }
    node.progress.hidden = true;
  }

  function applyStage(node, stage) {
    if (!stage) return;
    if (stage.title && !node.stages.includes(stage.title)) {
      if (stage.status === 'running') {
        node.progressText.textContent = `正在${stage.title}`;
        return;
      }
      if (stage.status === 'done') {
        node.stages.push(stage.title);
        node.progressSteps.innerHTML = node.stages
          .map((t) => `<span class="step">✓ ${escapeHtml(t)}</span>`)
          .join('');
      }
    }
  }

  /* ---------------- 思虑过程 ---------------- */

  /** 思虑：逐段显现（上游整包下发，这里补出流式感），显现完自动折叠 */
  function feedThought(node, text) {
    if (!text) return;
    node.thought.hidden = false;
    if (!node.thoughtRaw && !node.thoughtQueue) {
      node.thought.classList.remove('collapsed');
      node.thoughtIcon.textContent = '▾';
    }
    node.thoughtQueue += text;
    if (!node.thoughtTimer) node.thoughtTimer = setInterval(() => revealThought(node), 22);
    scrollToBottom(false);
  }

  function revealThought(node) {
    if (!node.thoughtQueue) {
      clearInterval(node.thoughtTimer);
      node.thoughtTimer = null;
      onThoughtDrained(node);
      return;
    }
    const size = Math.min(180, Math.max(6, Math.round(node.thoughtQueue.length / 12)));
    node.thoughtRaw += node.thoughtQueue.slice(0, size);
    node.thoughtQueue = node.thoughtQueue.slice(size);
    node.thoughtBody.textContent = node.thoughtRaw;
    scrollToBottom(false);
  }

  /** 思虑显现完毕：折叠，并把排队的正文交给打字机 */
  function onThoughtDrained(node) {
    collapseThought(node);
    if (node.answerQueue && node.typewriter) {
      node.typewriter.feed(node.answerQueue);
      node.answerQueue = '';
    }
    if (node.streamEnded && node.typewriter) node.typewriter.finish();
  }

  /** 正文排在思虑之后，避免两段同时滚动 */
  function queueAnswer(node, text) {
    if (!text) return;
    stopProgress(node);
    if (node.thoughtTimer) { node.answerQueue += text; return; }
    if (!node.typewriter) { node.answerQueue += text; return; }
    node.typewriter.feed(text);
  }

  function collapseThought(node) {
    if (!node.thoughtRaw || node.thought.classList.contains('collapsed')) return;
    node.thought.classList.add('collapsed');
    node.thoughtIcon.textContent = '▸';
  }

  // 推理标签（拼接写法，避免被格式化处理破坏）
  const THINK_OPEN = '<' + 'think' + '>';
  const THINK_CLOSE = '<' + '/' + 'think' + '>';

  /** 上游把推理写成了  thinking… 混在正文里，这里剥出来 */
  function feedStream(node, text) {
    node.streamBuf += text;

    if (node.phase === 'answer') {
      queueAnswer(node, node.streamBuf);
      node.streamBuf = '';
      return;
    }

    if (node.phase === 'start') {
      const trimmed = node.streamBuf.replace(/^\s+/, '');
      if (trimmed.startsWith(THINK_OPEN)) {
        node.phase = 'thinking';
        node.streamBuf = trimmed.slice(THINK_OPEN.length);
      } else if (trimmed.length < THINK_OPEN.length && THINK_OPEN.startsWith(trimmed)) {
        return;  // 标签可能被切开，等下一片
      } else {
        node.phase = 'answer';
        queueAnswer(node, trimmed);
        node.streamBuf = '';
        return;
      }
    }

    if (node.phase === 'thinking') {
      const end = node.streamBuf.indexOf(THINK_CLOSE);
      if (end >= 0) {
        feedThought(node, node.streamBuf.slice(0, end).replace(/\s+$/, ''));
        node.streamBuf = node.streamBuf.slice(end + THINK_CLOSE.length);
        node.phase = 'answer';
        if (node.streamBuf) { queueAnswer(node, node.streamBuf); node.streamBuf = ''; }
      } else {
        // 保留尾部若干字符，防止结束标签被截断
        const keep = THINK_CLOSE.length;
        if (node.streamBuf.length > keep) {
          feedThought(node, node.streamBuf.slice(0, node.streamBuf.length - keep));
          node.streamBuf = node.streamBuf.slice(node.streamBuf.length - keep);
        }
      }
    }
  }

  /** 打字节奏：待输出越长，吐字越快，贴近阅读速度 */
  function createTypewriter(node, onDone) {
    let timer = null;
    const tick = () => {
      if (!node.pending) {
        if (timer) { clearInterval(timer); timer = null; }
        onDone();
        return;
      }
      const size = Math.min(24, Math.max(1, Math.round(node.pending.length / 9)));
      node.raw += node.pending.slice(0, size);
      node.pending = node.pending.slice(size);
      paint(node, true);
      scrollToBottom(false);
    };
    return {
      feed(text) { node.pending += text; if (!timer) timer = setInterval(tick, 26); },
      finish() {
        if (!node.pending && !timer) { onDone(); return; }
        if (!timer) timer = setInterval(tick, 26);
      },
      flushNow() {
        if (node.pending) { node.raw += node.pending; node.pending = ''; }
        if (timer) { clearInterval(timer); timer = null; }
        paint(node, false);
      },
    };
  }

  function setSending(on) {
    state.sending = on;
    els.send.disabled = on;
    els.stop.hidden = !on;
    els.send.querySelector('span').textContent = on ? '作答中' : '发问';
  }

  /* ---------------- 发送 ---------------- */

  async function send() {
    if (state.sending) return;
    const text = els.input.value.trim();
    if (!text) return;
    if (!state.current) { els.emptySub.textContent = '请先在上方择一门径'; return; }

    els.input.value = '';
    autosize();
    els.empty.hidden = true;

    const perspective = state.current;
    addUserMessage(text, perspective);
    const vol = ensureVolume();
    vol.messages.push({ role: 'user', text, at: Date.now() });
    vol.perspectiveId = perspective.id;
    if (!vol.title) vol.title = text.length > 26 ? `${text.slice(0, 26)}…` : text;
    const node = createAssistantMessage(perspective);
    setSending(true);
    scrollToBottom(true);

    let typewriter = createTypewriter(node, () => {
      paint(node, false);
      scrollToBottom(false);
    });
    node.typewriter = typewriter;

    state.controller = new AbortController();
    let streamError = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: state.controller.signal,
        body: JSON.stringify({
          message: text,
          perspectiveId: state.current.id,
          conversationId: getConversationId(),
          userId: getUserId(),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`本地代理返回 ${res.status}${detail ? ` · ${detail.slice(0, 200)}` : ''}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const frame = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          if (!frame.trim() || frame.startsWith(':')) continue;

          let eventName = 'message';
          const dataLines = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;

          let data;
          try { data = JSON.parse(dataLines.join('\n')); } catch { data = {}; }

          if (eventName === 'delta' && data.text) {
            feedStream(node, data.text);
          } else if (eventName === 'stage') {
            applyStage(node, data);
          } else if (eventName === 'thought' && data.text) {
            feedThought(node, data.text);
          } else if (eventName === 'meta' && data.conversationId) {
            setConversationId(data.conversationId);
            vol.conversationId = data.conversationId;
            updateDossierNo();
          } else if (eventName === 'references' && Array.isArray(data.items)) {
            node.refs = data.items;
            paint(node, true);
          } else if (eventName === 'error') {
            streamError = data.message || '上游返回了未知错误';
          } else if (eventName === 'done') {
            // 结束
          }
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') streamError = `请求失败：${String(err?.message || err)}`;
    } finally {
      // 收尾：处理残留在缓冲里的内容
      if (node.streamBuf) {
        if (node.phase === 'thinking') feedThought(node, node.streamBuf);
        else queueAnswer(node, node.streamBuf);
        node.streamBuf = '';
      }
      stopProgress(node);
      // 兜底：上游未输出推理结束标签时，用推理内容充当正文，避免空白答复
      if (node.phase !== 'answer' && !node.raw && !node.pending && !node.answerQueue && node.thoughtRaw) {
        if (node.thoughtTimer) { clearInterval(node.thoughtTimer); node.thoughtTimer = null; }
        node.raw = node.thoughtRaw;
        node.thoughtRaw = '';
        node.thoughtQueue = '';
        node.thought.hidden = true;
        paint(node, false);
      }

      // 思虑仍在显现时，收尾交给 onThoughtDrained
      node.streamEnded = true;
      if (!node.thoughtTimer) typewriter.finish();
      setSending(false);
      state.controller = null;

      if (streamError) {
        const box = document.createElement('div');
        box.className = 'failure';
        box.textContent = streamError;
        node.dossier.appendChild(box);
        node.fold.textContent = '展开';
        if (!node.raw) node.body.innerHTML = '';
      } else if (!node.raw) {
        node.body.innerHTML = '<p style="color:var(--ink-3)">未收到任何内容，请稍后重试。</p>';
        node.fold.textContent = '展开';
      }

      state.history.push({ role: 'assistant', text: node.raw });

      // 归档：正文可能还在打字机/显现队列里，取全量
      const gotSomething = node.raw || node.pending || node.answerQueue || node.thoughtRaw;
      if (gotSomething) vol.messages.push({
        role: 'assistant',
        raw: node.raw + node.pending + node.answerQueue,
        thought: trimThought(node.thoughtRaw + node.thoughtQueue),
        refs: node.refs,
        at: Date.now(),
      });
      vol.updatedAt = Date.now();
      saveStore();

      scrollToBottom(false);
      updateDossierNo();
    }
  }

  /* ---------------- 输入框 ---------------- */

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 168) + 'px';
  }

  els.input.addEventListener('input', autosize);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  els.send.addEventListener('click', send);
  els.stop.addEventListener('click', () => state.controller?.abort());

  /** 另起一卷：当前卷留在架上，开一张新卷 */
  function newVolume() {
    state.controller?.abort();
    state.volumes = state.volumes.filter((v) => v.messages.length > 0);   // 空卷不留档
    state.activeId = '';
    els.thread.innerHTML = '';
    state.history = [];
    resetConversationId();
    els.empty.hidden = false;
    renderSuggestions();
    updateDossierNo();
    setSending(false);
    saveStore();
    els.input.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  els.reset.addEventListener('click', newVolume);

  els.shelfToggle.addEventListener('click', openShelf);
  els.shelfClose.addEventListener('click', closeShelf);
  els.shelfMask.addEventListener('click', closeShelf);
  els.shelfNew.addEventListener('click', () => { newVolume(); closeShelf(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeShelf(); });

  /* ---------------- 初始化 ---------------- */

  async function boot() {
    updateDossierNo();
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      if (!res.ok) throw new Error(cfg.error || '配置读取失败');
      state.perspectives = cfg.perspectives || [];
      state.current = state.perspectives[0] || null;
      document.title = cfg.appName || document.title;
      if (cfg.appName) document.querySelector('.masthead-text h1').textContent = cfg.appName;
      if (cfg.appSubtitle) document.querySelector('.masthead-text p').textContent = cfg.appSubtitle;
      renderPortals();
      loadStore();
      const v = currentVolume();
      if (v && v.messages.length) applyVolume(v);
      else if (state.current) els.input.placeholder = `从「${state.current.name}」视角提问……`;
      renderShelf();
    } catch (err) {
      els.emptySub.textContent = `初始化失败：${String(err.message || err)}`;
      els.emptySub.style.color = 'var(--cinnabar)';
    }
    autosize();
  }

  boot();
})();