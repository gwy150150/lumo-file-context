'use strict';

/* ============================================================
   Lumo · 渲染进程
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DEFAULT_PROVIDERS = () => [
  {
    id: 'openai',
    type: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    enabled: false,
  },
  {
    id: 'deepseek',
    type: 'openai',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabled: false,
  },
  {
    id: 'anthropic',
    type: 'anthropic',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-3-5-haiku-latest'],
    enabled: false,
  },
  {
    id: 'gemini',
    type: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    enabled: false,
  },
  {
    id: 'ollama',
    type: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
    enabled: false,
  },
];

const state = {
  settings: {
    theme: 'light',
    providers: DEFAULT_PROVIDERS(),
    active: { providerId: null, model: null },
    temperature: 0.7,
    maxTokens: 0,
    systemPrompt: '',
  },
  conversations: [],
  currentId: null,
  streaming: null,
};

const els = {};

/* ============================================================
   启动
   ============================================================ */

async function boot() {
  cacheEls();
  let data = null;
  try {
    data = await lumo.load();
  } catch (_) {
    data = null;
  }
  if (data) {
    if (data.settings) {
      state.settings = Object.assign(state.settings, data.settings);
      if (!Array.isArray(state.settings.providers) || !state.settings.providers.length) {
        state.settings.providers = DEFAULT_PROVIDERS();
      }
    }
    if (Array.isArray(data.conversations)) state.conversations = data.conversations;
  }

  applyTheme(state.settings.theme);
  bindEvents();

  if (state.conversations.length) {
    state.currentId = state.conversations[0].id;
  } else {
    newConversation(false);
  }

  renderConvList();
  renderMessages();
  renderSettings();
  updateModelChip();
  updateSendState();

  const info = await lumo.info().catch(() => ({ version: '1.1.0', dataPath: '—' }));
  applyDataInfo(info);
  els.aboutLine.textContent = `Lumo v${info.version} · 本地存储，密钥不会离开这台电脑`;
}

function cacheEls() {
  els.convList = $('#convList');
  els.messages = $('#messages');
  els.input = $('#input');
  els.send = $('#btnSend');
  els.stop = $('#btnStop');
  els.chatTitle = $('#chatTitle');
  els.modelChipText = $('#modelChipText');
  els.modelChip = $('#btnModelChip');
  els.modelPopover = $('#modelPopover');
  els.drawer = $('#drawer');
  els.scrim = $('#scrim');
  els.providerList = $('#providerList');
  els.dataPath = $('#dataPath');
  els.aboutLine = $('#aboutLine');
  els.tempRange = $('#tempRange');
  els.tempVal = $('#tempVal');
  els.maxTokens = $('#maxTokens');
  els.systemPrompt = $('#systemPrompt');
  els.hljsTheme = $('#hljsTheme');
  els.composerBox = $('#composerBox');
  els.composerNote = $('#composerNote');
  els.attachBtn = $('#btnAttach');
  els.attachList = $('#attachList');
  els.dropMask = $('#dropMask');
  els.main = $('.main');
  els.btnChangeDataDir = $('#btnChangeDataDir');
  els.btnOpenDataDir = $('#btnOpenDataDir');
  els.btnResetDataDir = $('#btnResetDataDir');
}

function applyDataInfo(info) {
  const pathInfo = info || {};
  const dir =
    pathInfo.dataDir ||
    (pathInfo.dataPath ? pathInfo.dataPath.replace(/[\\/]lumo-data\.json$/i, '') : '—');
  els.dataPath.textContent = dir || '—';
  els.dataPath.title = pathInfo.dataPath || dir || '';
  if (els.btnResetDataDir) els.btnResetDataDir.hidden = !pathInfo.customDataDir;
}

/* ============================================================
   持久化
   ============================================================ */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    lumo.save({ settings: state.settings, conversations: state.conversations }).catch(() => {});
  }, 180);
}

/* ============================================================
   主题
   ============================================================ */

function resolvedTheme() {
  const t = state.settings.theme;
  if (t === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return t === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  state.settings.theme = theme;
  const real = resolvedTheme();
  document.documentElement.dataset.theme = real;
  els.hljsTheme.href = real === 'dark' ? 'vendor/hljs-dark.css' : 'vendor/hljs-light.css';
  lumo
    .setOverlay({
      color: real === 'dark' ? '#1b1b1f' : '#ffffff',
      symbolColor: real === 'dark' ? '#c8c8d0' : '#4b4b52',
    })
    .catch(() => {});
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === theme));
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'system') applyTheme('system');
});

/* ============================================================
   会话
   ============================================================ */

const currentConv = () => state.conversations.find((c) => c.id === state.currentId) || null;
const getConv = (id) => state.conversations.find((c) => c.id === id) || null;

function newConversation(persist = true) {
  const conv = {
    id: uid(),
    title: '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    providerId: state.settings.active.providerId,
    model: state.settings.active.model,
    messages: [],
  };
  state.conversations.unshift(conv);
  state.currentId = conv.id;
  if (persist) {
    renderConvList();
    renderMessages();
    save();
    els.input.focus();
  }
  return conv;
}

function renderConvList() {
  const list = state.conversations;
  els.convList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'pop-empty';
    empty.textContent = '还没有对话';
    els.convList.append(empty);
    return;
  }
  for (const conv of list) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.currentId ? ' active' : '');
    item.dataset.id = conv.id;

    const title = document.createElement('div');
    title.className = 'conv-title';
    title.textContent = conv.title || '新对话';
    item.append(title);

    const more = document.createElement('button');
    more.className = 'conv-more';
    more.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
    more.title = '更多';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openConvMenu(conv.id, more);
    });
    item.append(more);

    item.addEventListener('click', () => selectConversation(conv.id));
    els.convList.append(item);
  }
}

function selectConversation(id) {
  state.currentId = id;
  renderConvList();
  renderMessages();
  updateModelChip();
  updateSendState();
}

function openConvMenu(id, anchor) {
  closeMenus();
  const conv = getConv(id);
  if (!conv) return;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <button class="ctx-item" data-act="rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>重命名</button>
    <button class="ctx-item danger" data-act="delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>删除</button>`;
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 150) + 'px';
  menu.style.top = r.bottom + 4 + 'px';

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctx-item');
    if (!btn) return;
    const act = btn.dataset.act;
    closeMenus();
    if (act === 'rename') {
      if (id === state.currentId) startRename();
    } else if (act === 'delete') {
      deleteConversation(id);
    }
  });
}

function deleteConversation(id) {
  const idx = state.conversations.findIndex((c) => c.id === id);
  if (idx < 0) return;
  state.conversations.splice(idx, 1);
  if (state.currentId === id) {
    state.currentId = state.conversations[0]?.id || null;
    if (!state.currentId) newConversation(false);
  }
  renderConvList();
  renderMessages();
  updateModelChip();
  save();
  toast('已删除');
}

function startRename() {
  const conv = currentConv();
  if (!conv) return;
  const el = els.chatTitle;
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    el.contentEditable = 'false';
    const text = el.textContent.trim();
    if (commit && text) conv.title = text.slice(0, 60);
    el.textContent = conv.title || '新对话';
    renderConvList();
    save();
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('keydown', onKey);
  };
  const onBlur = () => finish(true);
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onKey);
}

/* ============================================================
   消息渲染
   ============================================================ */

function renderMessages() {
  const conv = currentConv();
  els.messages.innerHTML = '';
  els.chatTitle.textContent = conv ? conv.title || '新对话' : '新对话';

  if (!conv || !conv.messages.length) {
    els.messages.append(emptyState());
    return;
  }
  const frag = document.createDocumentFragment();
  for (const msg of conv.messages) frag.append(messageNode(msg));
  els.messages.append(frag);
  scrollToBottom(false);
}

function emptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <div class="empty-mark">
      <svg viewBox="0 0 24 24" fill="none"><path d="M12 3.2c.9 3.4 2.4 4.9 5.8 5.8-3.4.9-4.9 2.4-5.8 5.8-.9-3.4-2.4-4.9-5.8-5.8 3.4-.9 4.9-2.4 5.8-5.8Z" fill="currentColor"/><path d="M17.6 14.4c.5 1.9 1.3 2.7 3.2 3.2-1.9.5-2.7 1.3-3.2 3.2-.5-1.9-1.3-2.7-3.2-3.2 1.9-.5 2.7-1.3 3.2-3.2Z" fill="currentColor" opacity=".55"/></svg>
    </div>
    <div class="empty-title">有什么可以帮你的？</div>
    <div class="empty-sub">选择一个模型，然后开始对话</div>
    <div class="empty-tips">
      <button class="tip">帮我解释一段代码</button>
      <button class="tip">写一封得体的邮件</button>
      <button class="tip">把这段文字翻译成英文</button>
      <button class="tip tip-file">读一下这个文件，说说重点</button>
    </div>`;
  wrap.querySelectorAll('.tip').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.classList.contains('tip-file')) {
        pickFiles();
        return;
      }
      els.input.value = b.textContent + '：';
      els.input.focus();
      autoResize();
      updateSendState();
    });
  });
  return wrap;
}

function messageNode(msg) {
  const node = document.createElement('div');
  node.id = 'msg-' + msg.id;
  node.className = 'msg ' + (msg.role === 'user' ? 'user' : 'assistant') + (msg.error ? ' error' : '');

  if (msg.role === 'user') {
    if (msg.content) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = msg.content;
      node.append(bubble);
    }
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      const row = document.createElement('div');
      row.className = 'msg-attach';
      msg.attachments.forEach((f) => row.append(fileChip(f, null)));
      node.append(row);
    }
    node.append(msgTools(msg));
    return node;
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<span class="dot"></span>';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = msg.providerName ? `${msg.providerName} · ${msg.model || ''}` : msg.model || '助手';
  meta.append(nameSpan);
  node.append(meta);

  if (msg.thinking) node.append(thinkingNode(msg.thinking));

  const content = document.createElement('div');
  content.className = 'content';
  if (msg.error) {
    content.textContent = msg.error;
  } else {
    content.innerHTML = renderMarkdown(msg.content);
    enhanceContent(content, true);
  }
  node.append(content);
  node.append(msgTools(msg));
  return node;
}

function thinkingNode(text) {
  const d = document.createElement('details');
  d.className = 'thinking';
  d.innerHTML = `<summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg><span>思考过程</span></summary><div class="think-body"></div>`;
  d.querySelector('.think-body').textContent = text;
  return d;
}

function msgTools(msg) {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';

  const copy = document.createElement('button');
  copy.className = 'tool-btn';
  copy.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>复制</span>';
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(msg.content || '').then(() => toast('已复制'));
  });
  tools.append(copy);

  if (msg.role === 'assistant' && !state.streaming) {
    const regen = document.createElement('button');
    regen.className = 'tool-btn';
    regen.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2"/><path d="M18 3v5h-5M6 21v-5h5"/></svg><span>重新生成</span>';
    regen.addEventListener('click', () => regenerate(msg.id));
    tools.append(regen);
  }
  return tools;
}

/* ---------- Markdown ---------- */

if (window.marked) {
  marked.use({ gfm: true, breaks: true });
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = '';
  try {
    html = marked.parse(text);
  } catch (_) {
    html = escapeHtml(text).replace(/\n/g, '<br>');
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function enhanceContent(container, highlight) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-block')) return;
    const code = pre.querySelector('code');
    const cls = (code && code.className) || '';
    const m = cls.match(/language-([\w+#-]+)/);
    const lang = m ? m[1].toLowerCase() : 'text';

    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const langSpan = document.createElement('span');
    langSpan.textContent = lang === 'text' ? '代码' : lang;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      const raw = code ? code.textContent : '';
      navigator.clipboard.writeText(raw).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => (copyBtn.textContent = '复制'), 1400);
      });
    });
    head.append(langSpan, copyBtn);

    pre.replaceWith(wrap);
    wrap.append(head, pre);

    if (highlight && window.hljs && code) {
      try {
        if (lang !== 'text' && hljs.getLanguage(lang)) {
          code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
        }
      } catch (_) {
        /* ignore */
      }
    }
  });

  container.querySelectorAll('a[href]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      lumo.openExternal(a.getAttribute('href'));
    });
  });
}

/* ---------- 滚动 ---------- */

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}

function scrollToBottom(smooth) {
  const el = els.messages;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/* ============================================================
   模型选择
   ============================================================ */

function usableProviders() {
  return state.settings.providers.filter(
    (p) => p.enabled && p.models.length && (p.apiKey || p.type === 'ollama')
  );
}

function getProvider(id) {
  return state.settings.providers.find((p) => p.id === id) || null;
}

function activeTarget() {
  const conv = currentConv();
  let providerId = conv && conv.providerId ? conv.providerId : state.settings.active.providerId;
  let model = conv && conv.model ? conv.model : state.settings.active.model;
  let provider = getProvider(providerId);

  if (!provider || !provider.enabled) {
    const first = usableProviders()[0];
    if (first) {
      provider = first;
      providerId = first.id;
      model = first.models[0];
    }
  }
  if (provider && (!model || !provider.models.includes(model))) {
    model = provider.models[0];
  }
  return { provider, providerId, model };
}

function updateModelChip() {
  const { provider, model } = activeTarget();
  if (provider && model) {
    els.modelChipText.textContent = model;
    els.modelChip.querySelector('.dot').classList.remove('off');
    els.modelChip.title = `${provider.name} · ${model}`;
  } else {
    els.modelChipText.textContent = '未选择模型';
    els.modelChip.querySelector('.dot').classList.add('off');
    els.modelChip.title = '点击配置模型服务';
  }
}

function openModelPicker() {
  const pop = els.modelPopover;
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  closeMenus();
  const providers = usableProviders();
  pop.innerHTML = '';

  if (!providers.length) {
    pop.innerHTML =
      '<div class="pop-empty">还没有可用的模型<br>先到「设置」里填入 API Key 并启用服务</div>';
    const btn = document.createElement('button');
    btn.className = 'pop-item';
    btn.style.justifyContent = 'center';
    btn.style.color = 'var(--accent)';
    btn.textContent = '打开设置';
    btn.addEventListener('click', () => {
      pop.hidden = true;
      openDrawer();
    });
    pop.append(btn);
  } else {
    const cur = activeTarget();
    providers.forEach((p, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'pop-sep';
        pop.append(sep);
      }
      const group = document.createElement('div');
      group.className = 'pop-group';
      group.textContent = p.name;
      pop.append(group);

      p.models.forEach((m) => {
        const item = document.createElement('div');
        item.className = 'pop-item' + (cur.providerId === p.id && cur.model === m ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'mi-name';
        name.textContent = m;
        const check = document.createElement('span');
        check.className = 'check';
        check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 6 6L20 6"/></svg>';
        item.append(name, check);
        item.addEventListener('click', () => selectModel(p.id, m));
        pop.append(item);
      });
    });
  }

  pop.hidden = false;
  const r = els.modelChip.getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
}

function selectModel(providerId, model) {
  state.settings.active = { providerId, model };
  const conv = currentConv();
  if (conv) {
    conv.providerId = providerId;
    conv.model = model;
  }
  els.modelPopover.hidden = true;
  updateModelChip();
  updateSendState();
  save();
}

/* ============================================================
   文件上下文
   ============================================================ */

let pendingFiles = [];
let dragDepth = 0;

function hasFileDrag(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.includes('Files');
}

function fileBadge(f) {
  const ext = String(f.ext || '').toUpperCase();
  if (ext === 'DOCX' || ext === 'DOCM') return 'DOC';
  if (ext === 'XLSX' || ext === 'XLSM') return 'XLS';
  if (ext === 'PPTX' || ext === 'PPTM') return 'PPT';
  if (!ext) return 'FILE';
  return ext.slice(0, 4);
}

function fileChip(f, onRemove) {
  const chip = document.createElement('div');
  chip.className = 'attach-chip' + (f.warning ? ' warn' : '');
  chip.title = [
    f.name,
    f.sizeText,
    f.chars ? `${Number(f.chars).toLocaleString()} 个字符` : '无可用文本',
    f.warning || '',
  ]
    .filter(Boolean)
    .join('\n');

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = fileBadge(f);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'fname';
  name.textContent = f.name;
  const sub = document.createElement('div');
  sub.className = 'fsub';
  sub.textContent = f.warning
    ? '⚠ ' + f.warning
    : `${f.sizeText || ''} · ${Number(f.chars || 0).toLocaleString()} 字符`;
  meta.append(name, sub);
  chip.append(badge, meta);

  if (onRemove) {
    const x = document.createElement('button');
    x.className = 'x';
    x.title = '移除';
    x.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    x.addEventListener('click', onRemove);
    chip.append(x);
  }
  return chip;
}

function renderAttachList() {
  els.attachList.innerHTML = '';
  const label = els.attachBtn.querySelector('span');
  if (!pendingFiles.length) {
    els.attachList.hidden = true;
    if (label) label.textContent = '添加文件';
    return;
  }
  els.attachList.hidden = false;
  if (label) label.textContent = `添加文件 (${pendingFiles.length})`;

  pendingFiles.forEach((f) => {
    els.attachList.append(
      fileChip(f, () => {
        pendingFiles = pendingFiles.filter((x) => x !== f);
        renderAttachList();
        updateSendState();
      })
    );
  });

  const total = pendingFiles.reduce((n, f) => n + (f.chars || 0), 0);
  const totalEl = document.createElement('span');
  totalEl.className = 'attach-total';
  totalEl.textContent = `共 ${total.toLocaleString()} 字符`;
  els.attachList.append(totalEl);
}

function adoptFiles(files, errors) {
  let added = 0;
  for (const f of files || []) {
    if (!f || !f.name) continue;
    if (pendingFiles.some((x) => x.name === f.name && x.size === f.size)) continue;
    pendingFiles.push(Object.assign({}, f, { key: uid() }));
    added++;
  }
  if (added) {
    renderAttachList();
    updateSendState();
  }
  if (errors && errors.length) toast(errors[0]);
  else if (added) toast(`已添加 ${added} 个文件`);
}

async function pickFiles() {
  if (state.streaming) return;
  els.attachBtn.disabled = true;
  try {
    const res = await lumo.pickFiles();
    if (!res || !res.ok) {
      toast((res && res.error) || '添加文件失败');
      return;
    }
    if (!res.files || !res.files.length) {
      if (res.errors && res.errors.length) toast(res.errors[0]);
      return;
    }
    adoptFiles(res.files, res.errors);
  } catch (err) {
    toast('添加文件失败：' + String((err && err.message) || err));
  } finally {
    els.attachBtn.disabled = !!state.streaming;
  }
}

async function addFromFileList(list) {
  const arr = Array.from(list || []);
  if (!arr.length) return;
  const files = [];
  const errors = [];
  for (const file of arr) {
    try {
      if (file.size > 80 * 1024 * 1024) {
        errors.push(`${file.name}：超过 80MB`);
        continue;
      }
      const buf = await file.arrayBuffer();
      const res = await lumo.extractFile(file.name, buf);
      if (res && res.ok) files.push(res.file);
      else errors.push(`${file.name}：${(res && res.error) || '解析失败'}`);
    } catch (err) {
      errors.push(`${file.name}：${(err && err.message) || err}`);
    }
  }
  adoptFiles(files, errors);
}

function composeApiContent(text, files) {
  const blocks = files
    .map((f, i) => {
      const body = f.text || (f.warning ? `（未能提取到文字：${f.warning}）` : '（空文件）');
      return `【文件 ${i + 1}：${f.name}】\n${body}`;
    })
    .join('\n\n');
  const lead = text ? `${text}\n\n` : '';
  return `${lead}以下是用户提供的文件内容，请结合这些内容回答：\n\n${blocks}`;
}

/* ============================================================
   发送与流式
   ============================================================ */

function autoResize() {
  const t = els.input;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

function updateSendState() {
  const hasText = els.input.value.trim().length > 0 || pendingFiles.length > 0;
  const streaming = !!state.streaming;
  els.send.disabled = !hasText || streaming;
  els.send.hidden = streaming;
  els.stop.hidden = !streaming;
  els.input.disabled = streaming;
  if (els.attachBtn) els.attachBtn.disabled = streaming;
  els.composerNote.textContent = streaming
    ? '正在生成…'
    : pendingFiles.length
    ? `已附加 ${pendingFiles.length} 个文件 · Enter 发送`
    : 'Enter 发送 · Shift + Enter 换行 · 可拖入或粘贴文件';
}

async function send() {
  const text = els.input.value.trim();
  const files = pendingFiles.slice();
  if ((!text && !files.length) || state.streaming) return;

  const conv = currentConv();
  if (!conv) return;

  const target = activeTarget();
  if (!target.provider) {
    toast('请先在设置里配置模型服务');
    openDrawer();
    return;
  }

  conv.providerId = target.providerId;
  conv.model = target.model;
  state.settings.active = { providerId: target.providerId, model: target.model };

  const message = { id: uid(), role: 'user', content: text, createdAt: Date.now() };
  if (files.length) {
    message.attachments = files.map((f) => ({
      name: f.name,
      size: f.size,
      sizeText: f.sizeText,
      chars: f.chars,
      ext: f.ext,
      label: f.label,
      warning: f.warning,
    }));
    message.apiContent = composeApiContent(text, files);
  }
  conv.messages.push(message);

  if (!conv.title || conv.title === '新对话') {
    const seed = text || (files.length ? files[0].name : '新对话');
    conv.title = seed.replace(/\s+/g, ' ').slice(0, 26);
    els.chatTitle.textContent = conv.title;
  }
  conv.updatedAt = Date.now();

  els.input.value = '';
  pendingFiles = [];
  renderAttachList();
  autoResize();
  renderConvList();
  renderMessages();
  save();

  await runAssistant(conv);
}

async function regenerate(msgId) {
  if (state.streaming) return;
  const conv = currentConv();
  if (!conv) return;
  const idx = conv.messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  // 删除该条及其之后的消息
  conv.messages.splice(idx);
  renderMessages();
  save();
  await runAssistant(conv);
}

async function runAssistant(conv) {
  const provider = getProvider(conv.providerId) || activeTarget().provider;
  const model = conv.model || (provider && provider.models[0]);
  if (!provider || !model) {
    toast('请先选择模型');
    return;
  }

  const history = conv.messages
    .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant') && (m.content || m.apiContent))
    .slice(-80)
    .map((m) => ({ role: m.role, content: m.apiContent || m.content }));

  const msg = {
    id: uid(),
    role: 'assistant',
    content: '',
    thinking: '',
    model,
    providerName: provider.name,
    createdAt: Date.now(),
  };
  conv.messages.push(msg);
  conv.updatedAt = Date.now();

  const requestId = uid();
  state.streaming = { requestId, convId: conv.id, msgId: msg.id };

  renderMessages();
  updateSendState();
  scrollToBottom(false);

  const payload = {
    requestId,
    provider: {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    },
    model,
    messages: history,
    systemPrompt: state.settings.systemPrompt || '',
    temperature: Number(state.settings.temperature),
    maxTokens: Number(state.settings.maxTokens) || undefined,
  };

  try {
    await lumo.chat(payload);
  } catch (err) {
    msg.error = String(err && err.message ? err.message : err);
    finishStream();
  }
}

let streamTimer = null;
let pendingScroll = false;

function onStreamEvent(evt) {
  const st = state.streaming;
  if (!st || st.requestId !== evt.requestId) return;
  const conv = getConv(st.convId);
  if (!conv) return;
  const msg = conv.messages.find((m) => m.id === st.msgId);
  if (!msg) return;

  if (evt.type === 'delta') {
    msg.content += evt.text;
    scheduleStreamRender();
  } else if (evt.type === 'thinking') {
    msg.thinking += evt.text;
    scheduleStreamRender();
  } else if (evt.type === 'error') {
    msg.error = evt.message;
    msg.content = '';
    finishStream();
  } else if (evt.type === 'aborted') {
    if (!msg.content && !msg.error) msg.content = '（已停止）';
    finishStream();
  } else if (evt.type === 'done') {
    finishStream();
  }
}

function scheduleStreamRender() {
  if (streamTimer) return;
  pendingScroll = isNearBottom();
  streamTimer = setTimeout(() => {
    streamTimer = null;
    paintStreaming();
  }, 60);
}

function paintStreaming() {
  const st = state.streaming;
  if (!st || state.currentId !== st.convId) return;
  const conv = getConv(st.convId);
  const msg = conv && conv.messages.find((m) => m.id === st.msgId);
  const node = document.getElementById('msg-' + st.msgId);
  if (!msg || !node) return;

  const content = node.querySelector('.content');
  if (content && !msg.error) {
    content.innerHTML = renderMarkdown(msg.content);
    enhanceContent(content, false);
    const caret = document.createElement('span');
    caret.className = 'caret';
    content.append(caret);
  }

  if (msg.thinking) {
    let t = node.querySelector('.thinking');
    if (!t) {
      t = thinkingNode('');
      node.insertBefore(t, content);
      t.open = true;
    }
    const body = t.querySelector('.think-body');
    body.textContent = msg.thinking;
    body.scrollTop = body.scrollHeight;
  }

  if (pendingScroll) scrollToBottom(false);
}

function finishStream() {
  const st = state.streaming;
  if (!st) return;
  state.streaming = null;
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }

  const conv = getConv(st.convId);
  if (conv) {
    const msg = conv.messages.find((m) => m.id === st.msgId);
    if (msg) {
      if (msg.thinking && msg.thinking.trim()) {
        // 保留思考内容
      }
      if (!msg.content && !msg.error) msg.content = '（没有返回内容）';
    }
    conv.updatedAt = Date.now();
  }

  updateSendState();
  if (state.currentId === st.convId) {
    renderMessages();
    scrollToBottom(true);
  } else {
    renderConvList();
  }
  save();
}

async function stopStream() {
  const st = state.streaming;
  if (!st) return;
  await lumo.abort(st.requestId);
}

/* ============================================================
   设置
   ============================================================ */

function openDrawer() {
  closeMenus();
  els.drawer.hidden = false;
  els.scrim.hidden = false;
  renderSettings();
}

function closeDrawer() {
  els.drawer.hidden = true;
  els.scrim.hidden = true;
}

function renderSettings() {
  renderProviderList();
  els.tempRange.value = state.settings.temperature;
  els.tempVal.textContent = Number(state.settings.temperature).toFixed(1);
  els.maxTokens.value = state.settings.maxTokens || '';
  els.systemPrompt.value = state.settings.systemPrompt || '';
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === state.settings.theme));
}

function providerInitial(p) {
  if (p.type === 'ollama') return 'OL';
  return (p.name || '?').slice(0, 2);
}

function renderProviderList() {
  const list = els.providerList;
  const openIds = new Set(
    Array.from(list.querySelectorAll('.provider.open')).map((n) => n.dataset.id)
  );
  list.innerHTML = '';

  state.settings.providers.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'provider' + (openIds.has(p.id) ? ' open' : '');
    card.dataset.id = p.id;

    const head = document.createElement('div');
    head.className = 'provider-head';
    head.innerHTML = `
      <div class="provider-mark">${escapeHtml(providerInitial(p))}</div>
      <div class="provider-name">${escapeHtml(p.name)}
        <div class="provider-sub">${p.models.length} 个模型${p.apiKey ? ' · 已配置密钥' : ''}</div>
      </div>
      <div class="switch ${p.enabled ? 'on' : ''}" title="启用 / 停用"></div>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

    head.querySelector('.switch').addEventListener('click', (e) => {
      e.stopPropagation();
      p.enabled = !p.enabled;
      renderProviderList();
      updateModelChip();
      save();
    });
    head.addEventListener('click', () => {
      card.classList.toggle('open');
    });

    const body = document.createElement('div');
    body.className = 'provider-body';

    // API Key
    if (p.type !== 'ollama') {
      const keyField = document.createElement('div');
      keyField.className = 'field';
      keyField.innerHTML = `<label>API Key</label>`;
      const row = document.createElement('div');
      row.className = 'input-row';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.placeholder = 'sk-...';
      keyInput.value = p.apiKey || '';
      keyInput.addEventListener('change', () => {
        p.apiKey = keyInput.value.trim();
        save();
        renderProviderList();
        updateModelChip();
      });
      const eye = document.createElement('button');
      eye.className = 'mini-action';
      eye.textContent = '显示';
      eye.addEventListener('click', () => {
        const show = keyInput.type === 'password';
        keyInput.type = show ? 'text' : 'password';
        eye.textContent = show ? '隐藏' : '显示';
      });
      row.append(keyInput, eye);
      keyField.append(row);
      body.append(keyField);
    }

    // Base URL
    const urlField = document.createElement('div');
    urlField.className = 'field';
    urlField.innerHTML = `<label>Base URL</label>`;
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = p.baseUrl || '';
    urlInput.placeholder = 'https://...';
    urlInput.addEventListener('change', () => {
      p.baseUrl = urlInput.value.trim();
      save();
    });
    urlField.append(urlInput);
    body.append(urlField);

    // 模型
    const modelField = document.createElement('div');
    modelField.className = 'field';
    modelField.innerHTML = `<label>模型列表 <span class="val">逗号分隔</span></label>`;
    const modelRow = document.createElement('div');
    modelRow.className = 'input-row';
    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.value = (p.models || []).join(', ');
    modelInput.placeholder = 'model-a, model-b';
    modelInput.addEventListener('change', () => {
      p.models = modelInput.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      save();
      updateModelChip();
    });
    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'mini-action';
    fetchBtn.textContent = '拉取';
    fetchBtn.title = '从服务端获取可用模型列表';
    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = '…';
      const res = await lumo.listModels({
        id: p.id,
        type: p.type,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      });
      fetchBtn.disabled = false;
      fetchBtn.textContent = '拉取';
      if (res.ok && res.models && res.models.length) {
        p.models = res.models;
        modelInput.value = res.models.join(', ');
        save();
        updateModelChip();
        renderProviderList();
        toast(`已获取 ${res.models.length} 个模型`);
      } else {
        toast(res.error || '没有取到模型列表');
      }
    });
    modelRow.append(modelInput, fetchBtn);
    modelField.append(modelRow);
    body.append(modelField);

    // 底部操作
    const foot = document.createElement('div');
    foot.className = 'provider-foot';
    const typeLabel = document.createElement('span');
    typeLabel.className = 'hint';
    typeLabel.style.fontSize = '11.5px';
    typeLabel.style.color = 'var(--text-3)';
    typeLabel.textContent =
      p.type === 'openai'
        ? 'OpenAI 兼容协议'
        : p.type === 'anthropic'
        ? 'Anthropic Messages'
        : p.type === 'gemini'
        ? 'Google Gemini'
        : 'Ollama 本地服务';
    foot.append(typeLabel);

    if (!['openai', 'anthropic', 'gemini', 'ollama'].includes(p.id)) {
      const del = document.createElement('button');
      del.className = 'ghost-btn danger';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        state.settings.providers = state.settings.providers.filter((x) => x.id !== p.id);
        if (state.settings.active.providerId === p.id) {
          state.settings.active = { providerId: null, model: null };
        }
        renderProviderList();
        updateModelChip();
        save();
      });
      foot.append(del);
    }
    body.append(foot);

    card.append(head, body);
    list.append(card);
  });
}

function addProvider() {
  const id = 'custom-' + uid();
  state.settings.providers.push({
    id,
    type: 'openai',
    name: '自定义服务',
    baseUrl: 'https://',
    apiKey: '',
    models: [],
    enabled: true,
  });
  renderProviderList();
  save();
  const card = els.providerList.querySelector(`[data-id="${id}"]`);
  if (card) {
    card.classList.add('open');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ============================================================
   通用 UI
   ============================================================ */

function closeMenus() {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  els.modelPopover.hidden = true;
}

let toastTimer = null;
function toast(text) {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 1900);
}

/* ============================================================
   事件绑定
   ============================================================ */

async function reloadDataAfterDirChange() {
  let data = null;
  try {
    data = await lumo.load();
  } catch (_) {
    data = null;
  }
  if (data) {
    if (data.settings) {
      state.settings = Object.assign(state.settings, data.settings);
      if (!Array.isArray(state.settings.providers) || !state.settings.providers.length) {
        state.settings.providers = DEFAULT_PROVIDERS();
      }
    }
    if (Array.isArray(data.conversations)) state.conversations = data.conversations;
  }
  state.currentId = state.conversations[0] ? state.conversations[0].id : null;
  if (!state.currentId) newConversation(false);

  applyTheme(state.settings.theme);
  renderConvList();
  renderMessages();
  renderSettings();
  updateModelChip();
  updateSendState();
  applyDataInfo(await lumo.info().catch(() => ({})));
  save();
}

function bindEvents() {
  els.input.addEventListener('input', () => {
    autoResize();
    updateSendState();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  els.input.addEventListener('focus', () => els.composerBox.classList.add('focused'));
  els.input.addEventListener('blur', () => els.composerBox.classList.remove('focused'));

  els.send.addEventListener('click', send);
  els.stop.addEventListener('click', stopStream);

  els.attachBtn.addEventListener('click', pickFiles);

  els.input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      addFromFileList(files);
    }
  });

  // 拖拽文件到窗口任意位置
  els.main.addEventListener('dragenter', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    els.dropMask.hidden = false;
  });
  els.main.addEventListener('dragover', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  els.main.addEventListener('dragleave', (e) => {
    if (!hasFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropMask.hidden = true;
  });
  els.main.addEventListener('drop', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropMask.hidden = true;
    addFromFileList(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('#btnNewChat').addEventListener('click', () => newConversation());
  $('#btnSettings').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', closeDrawer);

  els.modelChip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker();
  });

  els.chatTitle.addEventListener('dblclick', startRename);

  $('#btnAddProvider').addEventListener('click', addProvider);

  $$('#themeSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      applyTheme(b.dataset.theme);
      save();
    });
  });

  els.tempRange.addEventListener('input', () => {
    state.settings.temperature = Number(els.tempRange.value);
    els.tempVal.textContent = state.settings.temperature.toFixed(1);
    save();
  });

  els.maxTokens.addEventListener('change', () => {
    state.settings.maxTokens = Number(els.maxTokens.value) || 0;
    save();
  });

  els.systemPrompt.addEventListener('change', () => {
    state.settings.systemPrompt = els.systemPrompt.value;
    save();
  });

  els.btnChangeDataDir.addEventListener('click', async () => {
    if (!confirm('选择一个目录存放聊天记录和设置（可以放在任意磁盘）。\n切换会立即生效，现有数据会自动复制过去。')) return;
    await lumo.save({ settings: state.settings, conversations: state.conversations }).catch(() => {});
    const res = await lumo.chooseDataDir();
    if (!res || res.canceled) return;
    if (!res.ok) {
      toast('切换失败：' + (res.error || '未知错误'));
      return;
    }
    await reloadDataAfterDirChange();
    toast('数据目录已切换到 ' + res.dir);
  });

  els.btnOpenDataDir.addEventListener('click', () => {
    lumo.openDataDir().catch(() => {});
  });

  els.btnResetDataDir.addEventListener('click', async () => {
    if (!confirm('恢复为程序目录下的 LumoData？现有数据会自动复制回去。')) return;
    await lumo.save({ settings: state.settings, conversations: state.conversations }).catch(() => {});
    const res = await lumo.resetDataDir();
    if (!res || !res.ok) {
      toast('恢复失败：' + ((res && res.error) || '未知错误'));
      return;
    }
    await reloadDataAfterDirChange();
    toast('已恢复默认目录');
  });

  $('#btnClearAll').addEventListener('click', () => {
    if (!confirm('确定要清空全部对话吗？此操作无法撤销。')) return;
    state.conversations = [];
    state.currentId = null;
    newConversation(false);
    renderConvList();
    renderMessages();
    updateModelChip();
    save();
    toast('已清空');
  });

  document.addEventListener('click', (e) => {
    if (!els.modelPopover.hidden && !els.modelPopover.contains(e.target) && !els.modelChip.contains(e.target)) {
      els.modelPopover.hidden = true;
    }
    if (!e.target.closest('.ctx-menu') && !e.target.closest('.conv-more')) {
      document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.modelPopover.hidden) {
        els.modelPopover.hidden = true;
        return;
      }
      if (!els.drawer.hidden) {
        closeDrawer();
        return;
      }
      if (state.streaming) stopStream();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newConversation();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openDrawer();
    }
  });

  lumo.onChatEvent(onStreamEvent);

  window.addEventListener('resize', () => {
    if (!els.modelPopover.hidden) els.modelPopover.hidden = true;
  });
}

boot();
