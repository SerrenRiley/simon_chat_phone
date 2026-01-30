'use strict';

const STORAGE_KEYS = {
  settings: 'serren_settings',
  apiProfiles: 'serren_api_profiles',
  conversations: 'serren_conversations',
  characters: 'serren_characters',
  modelsCache: 'models_cache_v1',
  modelsCacheTs: 'models_cache_ts_v1',
  lastSyncAt: 'cloud_last_sync_at'
};

const DEFAULT_CHARACTER = {
  id: 'char-default',
  name: '柔光助手',
  prompt: '你是一个温柔、简洁、可爱的聊天助手，用轻柔的语气回答。',
  avatarKey: 'character:char-default'
};

const DEFAULT_PROFILE = {
  id: 'api-openrouter',
  name: 'OpenRouter',
  apiKey: '',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/auto',
  fallbackModels: ['openrouter/auto']
};

const DEFAULT_SETTINGS = {
  theme: 'theme-glass',
  globalPrompt: '请保持回答简洁、清晰，并优先用中文回复。',
  temperature: 0.7,
  showModel: true,
  showTokens: false,
  showTimestamp: true,
  streaming: false,
  activeApiProfileId: DEFAULT_PROFILE.id,
  supabaseUrl: '',
  supabaseAnonKey: '',
  userProfile: {
    name: '我',
    avatarKey: 'user-avatar'
  }
};

const state = {
  currentTab: 'conversations',
  activeConversationId: null,
  activeCharacterId: null,
  settings: null,
  apiProfiles: [],
  conversationsIndex: [],
  charactersIndex: [],
  messagesCache: new Map(),
  loading: false,
  longPressActive: false,
  models: [],
  supabase: null,
  session: null,
  syncStatus: 'idle'
};

const view = document.getElementById('view');
const modal = document.getElementById('modal');
const menu = document.getElementById('menu');

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(16).slice(2)}`;
}

function saveLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadLocal(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('serren_chat_phone', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('conversationId', 'conversationId', { unique: false });
      }
      if (!db.objectStoreNames.contains('avatars')) {
        db.createObjectStore('avatars', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('pending_ops')) {
        db.createObjectStore('pending_ops', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function getMessages(conversationId) {
  return withStore('messages', 'readonly', (store) => {
    return new Promise((resolve) => {
      const index = store.index('conversationId');
      const request = index.getAll(conversationId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  });
}

async function saveMessages(conversationId, messages) {
  await withStore('messages', 'readwrite', (store) => {
    const index = store.index('conversationId');
    const request = index.getAllKeys(conversationId);
    request.onsuccess = () => {
      (request.result || []).forEach((key) => store.delete(key));
      messages.forEach((message) => store.put(message));
    };
  });
}

async function setAvatar(key, dataUrl) {
  await withStore('avatars', 'readwrite', (store) => store.put({ key, dataUrl }));
}

async function getAvatar(key) {
  return withStore('avatars', 'readonly', (store) => {
    return new Promise((resolve) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.dataUrl || null);
      request.onerror = () => resolve(null);
    });
  });
}

async function addPendingOp(op) {
  await withStore('pending_ops', 'readwrite', (store) => store.put(op));
}

async function getPendingOps() {
  return withStore('pending_ops', 'readonly', (store) => {
    return new Promise((resolve) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  });
}

async function clearPendingOp(id) {
  await withStore('pending_ops', 'readwrite', (store) => store.delete(id));
}

function formatTime(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  const date = new Date(ts);
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function shorten(text, limit = 32) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizeBaseUrl(url) {
  if (!url) return '';
  return url.replace(/\/+$/, '');
}

function loadModelsCache() {
  const cache = loadLocal(STORAGE_KEYS.modelsCache, null);
  const ts = Number(localStorage.getItem(STORAGE_KEYS.modelsCacheTs) || 0);
  return { cache, ts };
}

function saveModelsCache(baseUrl, models) {
  saveLocal(STORAGE_KEYS.modelsCache, { baseUrl, models });
  localStorage.setItem(STORAGE_KEYS.modelsCacheTs, String(Date.now()));
}

async function fetchModels(baseUrl, apiKey, forceRefresh = false) {
  const normalized = normalizeBaseUrl(baseUrl || DEFAULT_PROFILE.baseUrl);
  const { cache, ts } = loadModelsCache();
  const now = Date.now();
  if (!forceRefresh && cache?.models && cache.baseUrl === normalized && now - ts < 24 * 60 * 60 * 1000) {
    return cache.models;
  }

  try {
    const response = await fetch(`${normalized}/models`, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
    });
    if (!response.ok) {
      console.error('模型列表请求失败', response.status);
      return cache?.models || [];
    }
    const data = await response.json();
    const models = data?.data || data?.models || data || [];
    saveModelsCache(normalized, models);
    return models;
  } catch (error) {
    console.error('模型列表请求异常', error);
    return cache?.models || [];
  }
}

function normalizeFallbackModels(primaryModel, fallbackModels) {
  const clean = (fallbackModels || [])
    .map((model) => model?.trim())
    .filter(Boolean)
    .filter((model) => model !== primaryModel);
  if (!clean.includes('openrouter/auto') && primaryModel !== 'openrouter/auto') {
    clean.push('openrouter/auto');
  }
  return [...new Set(clean)];
}

function buildModelFallbacks(profile) {
  const primary = profile?.model || 'openrouter/auto';
  const fallbacks = normalizeFallbackModels(primary, profile?.fallbackModels || []);
  return [primary, ...fallbacks];
}

function shouldRetryWithoutModelsParam(errorText) {
  if (!errorText) return false;
  return /models/i.test(errorText) && /(unknown|unrecognized|unsupported|invalid)/i.test(errorText);
}

function buildChatRequestBody({ model, models, systemPrompt, history, temperature, stream }) {
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...history],
    temperature,
    stream
  };
  if (models && models.length > 1) {
    body.models = models;
  }
  return body;
}

function applyTheme() {
  document.body.className = state.settings.theme;
}

function setSyncStatus(status) {
  state.syncStatus = status;
  const badge = document.querySelector('[data-role="cloud-status"]');
  if (badge) badge.textContent = status;
}

function initSupabase() {
  if (!state.settings.supabaseUrl || !state.settings.supabaseAnonKey) {
    state.supabase = null;
    return null;
  }
  const client = window.supabase?.createClient(state.settings.supabaseUrl, state.settings.supabaseAnonKey);
  state.supabase = client;
  return client;
}

async function refreshSession() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase.auth.getSession();
  if (error) {
    console.error('supabase session error', error);
    return;
  }
  state.session = data.session;
  setSyncStatus(state.session ? 'synced' : 'signed-out');
}

async function signInWithOtp(email) {
  if (!state.supabase) return;
  const { error } = await state.supabase.auth.signInWithOtp({ email });
  if (error) {
    console.error('supabase signIn error', error);
    alert(`登录失败：${error.message}`);
    return;
  }
  alert('已发送登录链接，请检查邮箱。');
}

async function signOutSupabase() {
  if (!state.supabase) return;
  const { error } = await state.supabase.auth.signOut();
  if (error) {
    console.error('supabase signOut error', error);
  }
  state.session = null;
  render();
}

function getLastSyncAt() {
  return Number(localStorage.getItem(STORAGE_KEYS.lastSyncAt) || 0);
}

function setLastSyncAt(ts) {
  localStorage.setItem(STORAGE_KEYS.lastSyncAt, String(ts));
}

function mapConversationToCloud(conversation) {
  return {
    id: conversation.id,
    user_id: state.session?.user?.id,
    title: conversation.title,
    updated_at: new Date(conversation.updatedAt).toISOString(),
    preview: conversation.preview || '',
    character_id: conversation.characterId,
    api_profile_id: conversation.apiProfileId,
    is_deleted: Boolean(conversation.isDeleted)
  };
}

function mapMessageToCloud(message) {
  return {
    id: message.id,
    user_id: state.session?.user?.id,
    conversation_id: message.conversationId,
    role: message.role,
    content: message.content,
    model: message.model || '',
    tokens: message.tokens || null,
    created_at: new Date(message.createdAt).toISOString(),
    updated_at: new Date(message.createdAt).toISOString(),
    is_deleted: Boolean(message.isDeleted)
  };
}

function mergeConversationsFromCloud(rows) {
  rows.forEach((row) => {
    const existing = state.conversationsIndex.find((item) => item.id === row.id);
    const merged = {
      id: row.id,
      title: row.title,
      updatedAt: Date.parse(row.updated_at) || Date.now(),
      preview: row.preview || '',
      characterId: row.character_id,
      apiProfileId: row.api_profile_id,
      isDeleted: row.is_deleted
    };
    if (existing) {
      Object.assign(existing, merged);
    } else {
      state.conversationsIndex.push(merged);
    }
  });
  saveLocal(STORAGE_KEYS.conversations, state.conversationsIndex);
}

async function mergeMessagesFromCloud(rows) {
  const grouped = rows.reduce((acc, row) => {
    if (!acc[row.conversation_id]) acc[row.conversation_id] = [];
    acc[row.conversation_id].push(row);
    return acc;
  }, {});
  for (const [conversationId, messages] of Object.entries(grouped)) {
    await ensureMessagesLoaded(conversationId);
    const local = state.messagesCache.get(conversationId) || [];
    const map = new Map(local.map((msg) => [msg.id, msg]));
    messages.forEach((row) => {
      map.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        model: row.model || '',
        tokens: row.tokens || null,
        createdAt: Date.parse(row.created_at) || Date.now(),
        isDeleted: row.is_deleted
      });
    });
    const merged = Array.from(map.values());
    state.messagesCache.set(conversationId, merged);
    await saveMessages(conversationId, merged);
  }
}

async function pushPendingOps() {
  if (!state.supabase || !state.session) return;
  const ops = await getPendingOps();
  for (const op of ops) {
    try {
      if (op.table === 'conversations') {
        if (op.action === 'delete') {
          await state.supabase.from('conversations').update({ is_deleted: true }).eq('id', op.payload.id);
        } else {
          await state.supabase.from('conversations').upsert(mapConversationToCloud(op.payload));
        }
      }
      if (op.table === 'messages') {
        if (op.action === 'delete') {
          await state.supabase.from('messages').update({ is_deleted: true }).eq('id', op.payload.id);
        } else {
          await state.supabase.from('messages').upsert(mapMessageToCloud(op.payload));
        }
      }
      await clearPendingOp(op.id);
    } catch (error) {
      console.error('pending op failed', op, error);
      throw error;
    }
  }
}

async function pullRemoteChanges() {
  if (!state.supabase || !state.session) return;
  const since = getLastSyncAt();
  const sinceIso = new Date(since || 0).toISOString();
  const { data: conversations, error: convoError } = await state.supabase
    .from('conversations')
    .select('*')
    .gte('updated_at', sinceIso);
  if (convoError) throw convoError;
  const { data: messages, error: msgError } = await state.supabase
    .from('messages')
    .select('*')
    .gte('updated_at', sinceIso);
  if (msgError) throw msgError;
  mergeConversationsFromCloud(conversations || []);
  await mergeMessagesFromCloud(messages || []);
  setLastSyncAt(Date.now());
}

async function runCloudSync() {
  if (!state.supabase || !state.session) return;
  try {
    setSyncStatus('syncing');
    await pushPendingOps();
    await pullRemoteChanges();
    setSyncStatus('synced');
  } catch (error) {
    console.error('sync error', error);
    setSyncStatus('error');
  }
}

function getActiveProfile(conversation) {
  const profileId = conversation?.apiProfileId || state.settings.activeApiProfileId;
  return state.apiProfiles.find((item) => item.id === profileId) || state.apiProfiles[0];
}

function getCharacter(characterId) {
  return state.charactersIndex.find((item) => item.id === characterId) || state.charactersIndex[0];
}

function getConversation(conversationId) {
  return state.conversationsIndex.find((item) => item.id === conversationId);
}

function updateConversationPreview(conversationId, message) {
  const convo = getConversation(conversationId);
  if (!convo) return;
  convo.preview = shorten(message.content, 40);
  convo.updatedAt = message.createdAt || Date.now();
  saveLocal(STORAGE_KEYS.conversations, state.conversationsIndex);
  queueConversationSync(convo, 'update');
}

function queueConversationSync(conversation, action) {
  const op = {
    id: uuid(),
    table: 'conversations',
    action,
    payload: {
      ...conversation,
      isDeleted: Boolean(conversation.isDeleted)
    },
    createdAt: Date.now()
  };
  addPendingOp(op);
  if (state.session) runCloudSync();
}

function queueMessageSync(message, action) {
  const op = {
    id: uuid(),
    table: 'messages',
    action,
    payload: {
      ...message,
      isDeleted: Boolean(message.isDeleted)
    },
    createdAt: Date.now()
  };
  addPendingOp(op);
  if (state.session) runCloudSync();
}

function render() {
  if (state.currentTab === 'conversations') {
    renderConversations();
  }
  if (state.currentTab === 'characters') {
    renderCharacters();
  }
  if (state.currentTab === 'settings') {
    renderSettings();
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', tab.dataset.tab === state.currentTab ? 'true' : 'false');
  });
}

async function renderConversations() {
  if (state.activeConversationId) {
    await renderChatView();
    return;
  }
  const items = await Promise.all(
    state.conversationsIndex
      .filter((item) => !item.isDeleted)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(async (item) => {
        const character = getCharacter(item.characterId);
        const preview = item.preview || '暂无消息';
        return `
          <div class="list-item glass" data-action="open-conversation" data-id="${item.id}">
            <div class="avatar">${await renderAvatar(character.avatarKey, character.name)}</div>
            <div class="chat-list-item">
              <div class="meta">
                <strong>${item.title}</strong>
                <div class="preview">${preview}</div>
              </div>
              <time>${formatDate(item.updatedAt)}</time>
            </div>
          </div>
        `;
      })
  );

  view.innerHTML = `
    <section class="section">
      <div class="row">
        <h2>对话</h2>
        <button class="icon-button" data-action="new-conversation">＋</button>
      </div>
      <div class="list">
        ${items.join('') || '<div class="card">还没有对话，点右上角新建吧。</div>'}
      </div>
    </section>
  `;
}

async function renderChatView() {
  const conversation = getConversation(state.activeConversationId);
  if (!conversation) {
    state.activeConversationId = null;
    render();
    return;
  }
  const character = getCharacter(conversation.characterId);
  const profile = getActiveProfile(conversation);
  const messages = (state.messagesCache.get(conversation.id) || []).filter((msg) => !msg.isDeleted);

  const messageHtml = await Promise.all(
    messages.map(async (message) => {
      const avatarKey = message.role === 'user'
        ? state.settings.userProfile.avatarKey
        : character.avatarKey;
      const meta = [];
      if (state.settings.showTimestamp) meta.push(formatTime(message.createdAt));
      if (state.settings.showModel && message.model) meta.push(message.model);
      if (state.settings.showTokens) {
        const tokens = message.tokens?.total ?? '—';
        meta.push(`tokens:${tokens}`);
      }
      return `
        <div class="message ${message.role}" data-action="message-menu" data-id="${message.id}">
          <div class="row" style="gap:8px; align-items:flex-start;">
            <div class="avatar" style="width:32px;height:32px;">${await renderAvatar(avatarKey, message.role === 'user' ? '我' : character.name)}</div>
            <div style="flex:1;">
              <div>${escapeHtml(message.content)}</div>
              ${meta.length ? `<div class="message-meta">${meta.map((item) => `<span>${item}</span>`).join('')}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    })
  );

  view.innerHTML = `
    <section class="section chat-page">
      <div class="chat-header card">
        <div class="avatar">${await renderAvatar(character.avatarKey, character.name)}</div>
        <div>
          <h2>${character.name}</h2>
          <div class="badge">${profile?.name || '未选择 API'} · ${profile?.model || '未设置模型'}</div>
        </div>
      </div>
      <div class="chat-area" data-role="chat-area">
        ${messageHtml.join('') || '<div class="notice">开始和角色聊聊吧～</div>'}
      </div>
      <div class="chat-composer">
        <textarea class="message-input" placeholder="输入消息..." data-role="message-input"></textarea>
        <button class="primary" data-action="send-message" ${state.loading ? 'disabled' : ''}>发送</button>
      </div>
      <button class="outline" data-action="back-to-conversations">← 返回对话列表</button>
    </section>
  `;
  scrollChatToBottom();
}

async function renderCharacters() {
  if (state.activeCharacterId) {
    const character = getCharacter(state.activeCharacterId);
    const avatar = await renderAvatar(character.avatarKey, character.name);
    view.innerHTML = `
      <section class="section">
        <div class="row">
          <h2>编辑角色</h2>
          <button class="icon-button" data-action="close-character">✕</button>
        </div>
        <div class="card form-grid">
          <label>名称
            <input type="text" value="${character.name}" data-role="character-name" />
          </label>
          <label>头像上传
            <input type="file" accept="image/*" data-role="character-avatar" />
            <div class="avatar" style="margin-top:8px;">${avatar}</div>
          </label>
          <label>Prompt
            <textarea data-role="character-prompt">${character.prompt || ''}</textarea>
          </label>
          <button class="primary" data-action="save-character">保存</button>
        </div>
      </section>
    `;
    return;
  }

  const userAvatar = await renderAvatar(state.settings.userProfile.avatarKey, state.settings.userProfile.name);
  const characterItems = await Promise.all(
    state.charactersIndex.map(async (item) => `
      <div class="list-item" data-action="edit-character" data-id="${item.id}">
        <div class="avatar">${await renderAvatar(item.avatarKey, item.name)}</div>
        <div>
          <strong>${item.name}</strong>
          <div class="notice">${shorten(item.prompt, 28)}</div>
        </div>
      </div>
    `)
  );

  view.innerHTML = `
    <section class="section">
      <div class="row">
        <h2>用户设定</h2>
        <button class="icon-button" data-action="edit-user-profile">编辑</button>
      </div>
      <div class="card">
        <div class="row">
          <div class="avatar">${userAvatar}</div>
          <div>
            <strong>${state.settings.userProfile.name}</strong>
            <div class="notice">用户头像将用于你的消息气泡。</div>
          </div>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="row">
        <h2>角色列表</h2>
        <button class="icon-button" data-action="new-character">＋</button>
      </div>
      <div class="list">
        ${characterItems.join('')}
      </div>
    </section>
  `;
}

function renderSettings() {
  const profileItems = state.apiProfiles.map((profile) => `
    <div class="list-item">
      <div>
        <strong>${profile.name}</strong>
        <div class="notice">${profile.baseUrl}</div>
        <div class="notice">${profile.model}</div>
      </div>
      <div class="badge-group">
        <button class="icon-button" data-action="edit-profile" data-id="${profile.id}">编辑</button>
        <button class="icon-button" data-action="delete-profile" data-id="${profile.id}">删除</button>
      </div>
    </div>
  `);

  view.innerHTML = `
    <section class="section">
      <div class="row">
        <h2>主题</h2>
      </div>
      <div class="badge-group">
        ${renderThemeButton('theme-glass', '玻璃')}
        ${renderThemeButton('theme-blush', '奶油粉')}
        ${renderThemeButton('theme-mint', '薄荷')}
        ${renderThemeButton('theme-dusk', '暮光')}
      </div>
    </section>

    <section class="section">
      <div class="row">
        <h2>API Profiles</h2>
        <button class="icon-button" data-action="new-profile">＋</button>
      </div>
      <div class="list">
        ${profileItems.join('') || '<div class="card">暂无 API Profile</div>'}
      </div>
    </section>

    <section class="section">
      <div class="row">
        <h2>聊天设置</h2>
      </div>
      <div class="card form-grid">
        <label>全局 Prompt
          <textarea data-role="global-prompt">${state.settings.globalPrompt}</textarea>
        </label>
        <label>Temperature
          <input type="range" min="0" max="2" step="0.1" value="${state.settings.temperature}" data-role="temperature" />
          <div class="notice">当前: ${state.settings.temperature}</div>
        </label>
        <div class="toggle">
          <input type="checkbox" data-role="toggle-model" ${state.settings.showModel ? 'checked' : ''} />
          <label>显示模型名</label>
        </div>
        <div class="toggle">
          <input type="checkbox" data-role="toggle-tokens" ${state.settings.showTokens ? 'checked' : ''} />
          <label>显示 Tokens</label>
        </div>
        <div class="toggle">
          <input type="checkbox" data-role="toggle-time" ${state.settings.showTimestamp ? 'checked' : ''} />
          <label>显示时间</label>
        </div>
        <div class="toggle">
          <input type="checkbox" data-role="toggle-stream" ${state.settings.streaming ? 'checked' : ''} />
          <label>流式输出 Streaming</label>
        </div>
        <div class="footer-note">导出到 Gmail / 云端保存：TODO（后续阶段）</div>
      </div>
    </section>

    <section class="section">
      <div class="row">
        <h2>云同步</h2>
        <span class="badge" data-role="cloud-status">${state.syncStatus}</span>
      </div>
      <div class="card form-grid">
        <label>Supabase URL
          <input type="text" data-role="supabase-url" value="${state.settings.supabaseUrl}" />
        </label>
        <label>Supabase Anon Key
          <input type="password" data-role="supabase-anon" value="${state.settings.supabaseAnonKey}" />
        </label>
        <label>登录邮箱
          <input type="email" data-role="supabase-email" placeholder="you@example.com" />
        </label>
        <div class="row">
          <button class="outline" data-action="save-supabase">保存配置</button>
          <button class="outline" data-action="login-supabase">登录</button>
          <button class="outline" data-action="logout-supabase">退出</button>
        </div>
        <div class="notice">不会上传或存储 OpenRouter API Key。</div>
      </div>
    </section>
  `;
}

function renderThemeButton(theme, label) {
  const active = state.settings.theme === theme;
  return `<button class="icon-button" data-action="set-theme" data-theme="${theme}">${active ? '✅ ' : ''}${label}</button>`;
}

function openModal(content) {
  modal.innerHTML = `<div class="panel">${content}</div>`;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = '';
}

function openMenu(content) {
  menu.innerHTML = `<div class="panel">${content}</div>`;
  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');
}

function closeMenu() {
  menu.classList.add('hidden');
  menu.setAttribute('aria-hidden', 'true');
  menu.innerHTML = '';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderAvatar(avatarKey, fallbackText) {
  const dataUrl = await getAvatar(avatarKey);
  if (dataUrl) {
    return `<img src="${dataUrl}" alt="avatar" />`;
  }
  return fallbackText ? fallbackText.slice(0, 1) : '🙂';
}

function buildSystemPrompt(character) {
  const userProfile = state.settings.userProfile;
  const userProfileText = userProfile?.name
    ? `用户信息：${userProfile.name}`
    : '';
  return [
    state.settings.globalPrompt,
    character?.prompt,
    userProfileText
  ].filter(Boolean).join('\n\n');
}

async function ensureMessagesLoaded(conversationId) {
  if (state.messagesCache.has(conversationId)) return;
  const messages = await getMessages(conversationId);
  state.messagesCache.set(conversationId, messages);
}

function scrollChatToBottom() {
  const area = document.querySelector('[data-role="chat-area"]');
  if (area) {
    area.scrollTop = area.scrollHeight;
  }
}

async function parseErrorResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  let bodyText = '';
  try {
    if (contentType.includes('application/json')) {
      const data = await response.json();
      bodyText = JSON.stringify(data);
    } else {
      bodyText = await response.text();
    }
  } catch (error) {
    bodyText = `无法解析错误响应：${error.message}`;
  }
  return `HTTP ${response.status} ${response.statusText}\n${bodyText}`;
}

async function attemptChatCompletion({
  profile,
  history,
  systemPrompt,
  model,
  models,
  stream
}) {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildChatRequestBody({
      model,
      models,
      systemPrompt,
      history,
      temperature: state.settings.temperature,
      stream
    }))
  });
  return response;
}

async function handleSendMessage() {
  const input = document.querySelector('[data-role="message-input"]');
  if (!input) return;
  const text = input.value.trim();
  if (!text || state.loading) return;
  input.value = '';

  const conversation = getConversation(state.activeConversationId);
  if (!conversation) return;

  const messages = state.messagesCache.get(conversation.id) || [];
  const userMessage = {
    id: uuid(),
    conversationId: conversation.id,
    role: 'user',
    content: text,
    createdAt: Date.now()
  };
  messages.push(userMessage);
  queueMessageSync(userMessage, 'create');
  updateConversationPreview(conversation.id, userMessage);
  await saveMessages(conversation.id, messages);
  await requestAssistant(conversation, messages);
}

async function requestAssistant(conversation, messages) {
  const typingMessage = {
    id: uuid(),
    conversationId: conversation.id,
    role: 'assistant',
    content: '正在输入…',
    createdAt: Date.now(),
    temp: true
  };
  messages.push(typingMessage);
  state.messagesCache.set(conversation.id, messages);
  await saveMessages(conversation.id, messages);
  state.loading = true;
  await renderChatView();

  const profile = getActiveProfile(conversation);
  if (!profile?.apiKey) {
    typingMessage.content = '⚠️ 未设置 API Key，请在设置中填写。';
    typingMessage.temp = false;
    state.loading = false;
    await saveMessages(conversation.id, messages);
    await renderChatView();
    return;
  }

  const history = messages
    .filter((msg) => !msg.temp && !msg.isDeleted)
    .map((msg) => ({ role: msg.role, content: msg.content }));

  const systemPrompt = buildSystemPrompt(getCharacter(conversation.characterId));
  const modelsList = buildModelFallbacks(profile);
  let allowModelsParam = true;
  let lastError = '';

  try {
    for (let attemptIndex = 0; attemptIndex < modelsList.length; attemptIndex += 1) {
      const model = modelsList[attemptIndex];
      const response = await attemptChatCompletion({
        profile,
        history,
        systemPrompt,
        model,
        models: allowModelsParam ? modelsList : null,
        stream: state.settings.streaming
      });

      if (!response.ok) {
        const errorText = await parseErrorResponse(response);
        lastError = errorText;
        console.error('chat/completions error', errorText);
        if (allowModelsParam && shouldRetryWithoutModelsParam(errorText)) {
          allowModelsParam = false;
          attemptIndex = -1;
          continue;
        }
        continue;
      }

      if (state.settings.streaming) {
        await handleStreamingResponse(response, typingMessage, model);
      } else {
        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content || '（没有回复内容）';
        const usage = data?.usage;
        typingMessage.content = reply;
        typingMessage.model = model;
        if (usage) {
          typingMessage.tokens = {
            prompt: usage.prompt_tokens,
            completion: usage.completion_tokens,
            total: usage.total_tokens
          };
        }
      }
      typingMessage.temp = false;
      state.loading = false;
      updateConversationPreview(conversation.id, typingMessage);
      queueMessageSync(typingMessage, 'create');
      await saveMessages(conversation.id, messages);
      await renderChatView();
      return;
    }
  } catch (error) {
    lastError = `${error.name}: ${error.message}`;
    console.error('chat/completions exception', error);
  }

  typingMessage.content = `请求失败：${lastError || '未知错误'}`;
  typingMessage.temp = false;
  state.loading = false;
  updateConversationPreview(conversation.id, typingMessage);
  queueMessageSync(typingMessage, 'create');
  await saveMessages(conversation.id, messages);
  await renderChatView();
}

async function handleStreamingResponse(response, typingMessage, modelName) {
  const reader = response.body?.getReader();
  if (!reader) {
    typingMessage.content = '请求失败：未获得可读流。';
    typingMessage.temp = false;
    return;
  }
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  typingMessage.content = typingMessage.content || '正在输入…';
  typingMessage.model = modelName;
  typingMessage.temp = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.replace(/^data:\s*/, '');
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content || '';
        if (delta) {
          if (typingMessage.content === '正在输入…') {
            typingMessage.content = '';
          }
          typingMessage.content += delta;
          await renderChatView();
        }
      } catch (error) {
        console.error('流式解析失败', error);
      }
    }
  }
}

function openNewConversationModal() {
  const characterOptions = state.charactersIndex.map((item) =>
    `<option value="${item.id}">${item.name}</option>`
  ).join('');
  const profileOptions = state.apiProfiles.map((item) =>
    `<option value="${item.id}">${item.name}</option>`
  ).join('');

  openModal(`
    <h3>新建对话</h3>
    <div class="form-grid">
      <label>选择角色
        <select data-role="conversation-character">${characterOptions}</select>
      </label>
      <label>选择 API Profile
        <select data-role="conversation-profile">${profileOptions}</select>
      </label>
      <div class="row">
        <button class="outline" data-action="close-modal">取消</button>
        <button class="primary" data-action="confirm-new-conversation">创建</button>
      </div>
    </div>
  `);
}

function createConversation(characterId, profileId) {
  const nextIndex = state.conversationsIndex.length + 1;
  const conversation = {
    id: uuid(),
    title: `新对话 ${nextIndex}`,
    updatedAt: Date.now(),
    preview: '暂无消息',
    characterId: characterId || state.charactersIndex[0].id,
    apiProfileId: profileId || state.settings.activeApiProfileId,
    isDeleted: false
  };
  state.conversationsIndex.push(conversation);
  saveLocal(STORAGE_KEYS.conversations, state.conversationsIndex);
  queueConversationSync(conversation, 'create');
  state.activeConversationId = conversation.id;
  state.messagesCache.set(conversation.id, []);
  render();
}

function openConversationMenu(conversationId) {
  openMenu(`
    <button class="icon-button" data-action="rename-conversation" data-id="${conversationId}">重命名</button>
    <button class="icon-button" data-action="delete-conversation" data-id="${conversationId}">删除</button>
    <button class="icon-button" data-action="close-menu">关闭</button>
  `);
}

function openMessageMenu(messageId) {
  const conversation = getConversation(state.activeConversationId);
  const messages = state.messagesCache.get(conversation.id) || [];
  const message = messages.find((item) => item.id === messageId);
  if (!message || message.temp) return;
  const actions = message.role === 'assistant'
    ? `
      <button class="icon-button" data-action="copy-message" data-id="${messageId}">复制</button>
      <button class="icon-button" data-action="regenerate-message" data-id="${messageId}">重新生成</button>
      <button class="icon-button" data-action="delete-message" data-id="${messageId}">删除</button>
    `
    : `
      <button class="icon-button" data-action="copy-message" data-id="${messageId}">复制</button>
      <button class="icon-button" data-action="edit-message" data-id="${messageId}">编辑</button>
      <button class="icon-button" data-action="delete-message" data-id="${messageId}">删除</button>
    `;
  openMenu(`${actions}<button class="icon-button" data-action="close-menu">关闭</button>`);
}

async function handleDeleteConversation(conversationId) {
  if (!confirm('确定删除该对话吗？')) return;
  const convo = getConversation(conversationId);
  if (convo) {
    convo.isDeleted = true;
    convo.updatedAt = Date.now();
    queueConversationSync(convo, 'delete');
  }
  saveLocal(STORAGE_KEYS.conversations, state.conversationsIndex);
  const messages = state.messagesCache.get(conversationId) || await getMessages(conversationId);
  messages.forEach((message) => {
    message.isDeleted = true;
    queueMessageSync(message, 'delete');
  });
  state.messagesCache.set(conversationId, messages);
  await saveMessages(conversationId, messages);
  if (state.activeConversationId === conversationId) {
    state.activeConversationId = null;
  }
  closeMenu();
  render();
}

async function handleRenameConversation(conversationId) {
  const convo = getConversation(conversationId);
  if (!convo) return;
  const name = prompt('输入新的对话名称', convo.title);
  if (!name) return;
  convo.title = name;
  convo.updatedAt = Date.now();
  queueConversationSync(convo, 'update');
  saveLocal(STORAGE_KEYS.conversations, state.conversationsIndex);
  closeMenu();
  render();
}

async function handleCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    alert('复制失败，请手动复制。');
  }
}

async function handleDeleteMessage(messageId) {
  const conversation = getConversation(state.activeConversationId);
  const messages = state.messagesCache.get(conversation.id) || [];
  const target = messages.find((item) => item.id === messageId);
  if (target) {
    target.isDeleted = true;
    queueMessageSync(target, 'delete');
  }
  state.messagesCache.set(conversation.id, messages);
  await saveMessages(conversation.id, messages);
  closeMenu();
  render();
}

async function handleEditMessage(messageId) {
  const conversation = getConversation(state.activeConversationId);
  const messages = state.messagesCache.get(conversation.id) || [];
  const messageIndex = messages.findIndex((item) => item.id === messageId);
  if (messageIndex < 0) return;
  const message = messages[messageIndex];
  const content = prompt('编辑消息（编辑会影响后续回复）', message.content);
  if (!content) return;
  const confirmEdit = confirm('编辑会影响后续回复，将删除该条之后的回复，继续吗？');
  if (!confirmEdit) return;
  message.content = content;
  queueMessageSync(message, 'update');
  const trimmed = messages.map((item, index) => {
    if (index > messageIndex && item.role === 'assistant') {
      item.isDeleted = true;
      queueMessageSync(item, 'delete');
    }
    return item;
  });
  state.messagesCache.set(conversation.id, trimmed);
  await saveMessages(conversation.id, trimmed);
  closeMenu();
  render();
}

async function handleRegenerateMessage(messageId) {
  const conversation = getConversation(state.activeConversationId);
  const messages = state.messagesCache.get(conversation.id) || [];
  const index = messages.findIndex((item) => item.id === messageId);
  if (index < 0) return;
  const trimmed = messages.map((item, idx) => {
    if (idx >= index) {
      item.isDeleted = true;
      queueMessageSync(item, 'delete');
    }
    return item;
  });
  state.messagesCache.set(conversation.id, trimmed);
  await saveMessages(conversation.id, trimmed);
  closeMenu();
  render();
  await requestAssistant(conversation, trimmed);
}

function openCharacterEditor(characterId) {
  state.activeCharacterId = characterId;
  render();
}

async function saveCharacter() {
  const nameInput = document.querySelector('[data-role="character-name"]');
  const promptInput = document.querySelector('[data-role="character-prompt"]');
  const fileInput = document.querySelector('[data-role="character-avatar"]');
  const character = getCharacter(state.activeCharacterId);
  if (!character) return;
  character.name = nameInput.value.trim() || character.name;
  character.prompt = promptInput.value.trim();
  if (fileInput.files[0]) {
    const file = fileInput.files[0];
    const dataUrl = await fileToDataUrl(file);
    await setAvatar(character.avatarKey, dataUrl);
  }
  saveLocal(STORAGE_KEYS.characters, state.charactersIndex);
  state.activeCharacterId = null;
  render();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function openUserProfileModal() {
  openModal(`
    <h3>用户设定</h3>
    <div class="form-grid">
      <label>用户名
        <input type="text" data-role="user-name" value="${state.settings.userProfile.name}" />
      </label>
      <label>头像上传
        <input type="file" accept="image/*" data-role="user-avatar" />
      </label>
      <div class="row">
        <button class="outline" data-action="close-modal">取消</button>
        <button class="primary" data-action="save-user-profile">保存</button>
      </div>
    </div>
  `);
}

async function populateModelList(forceRefresh) {
  const baseInput = modal.querySelector('[data-role="profile-base"]');
  const keyInput = modal.querySelector('[data-role="profile-key"]');
  const list = modal.querySelector('#model-options');
  const status = modal.querySelector('[data-role="models-status"]');
  if (!baseInput || !list || !status) return;
  status.textContent = '正在加载模型列表...';
  const models = await fetchModels(baseInput.value, keyInput?.value, forceRefresh);
  state.models = models;
  list.innerHTML = models.map((model) => {
    const name = model.name || model.id || 'unknown';
    const context = model.context_length ? ` · ${model.context_length} ctx` : '';
    const label = `${name} (${model.id})${context}`;
    return `<option value="${model.id}">${label}</option>`;
  }).join('');
  status.textContent = models.length ? `已加载 ${models.length} 个模型` : '未获取到模型列表';
}

function getFallbackModelsFromModal() {
  return Array.from(modal.querySelectorAll('[data-role="fallback-model"]'))
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function renderFallbackList(models) {
  const container = modal.querySelector('[data-role="fallback-list"]');
  if (!container) return;
  container.innerHTML = models.map((model, index) => `
    <div class="row">
      <input type="text" list="model-options" data-role="fallback-model" value="${model}" />
      <div class="badge-group">
        <button class="icon-button" data-action="move-fallback-up" data-index="${index}">↑</button>
        <button class="icon-button" data-action="move-fallback-down" data-index="${index}">↓</button>
        <button class="icon-button" data-action="remove-fallback" data-index="${index}">移除</button>
      </div>
    </div>
  `).join('');
}

async function saveUserProfile() {
  const nameInput = modal.querySelector('[data-role="user-name"]');
  const fileInput = modal.querySelector('[data-role="user-avatar"]');
  state.settings.userProfile.name = nameInput.value.trim() || '我';
  if (fileInput.files[0]) {
    const dataUrl = await fileToDataUrl(fileInput.files[0]);
    await setAvatar(state.settings.userProfile.avatarKey, dataUrl);
  }
  saveLocal(STORAGE_KEYS.settings, state.settings);
  closeModal();
  render();
}

async function openProfileModal(profileId) {
  const profile = profileId
    ? state.apiProfiles.find((item) => item.id === profileId)
    : { id: uuid(), name: '', apiKey: '', baseUrl: DEFAULT_PROFILE.baseUrl, model: DEFAULT_PROFILE.model };
  const modelValue = profile.model || 'openrouter/auto';
  const fallbackModels = normalizeFallbackModels(modelValue, profile.fallbackModels || []);
  openModal(`
    <h3>${profileId ? '编辑' : '新建'} API Profile</h3>
    <div class="form-grid">
      <label>API 名称
        <input type="text" data-role="profile-name" value="${profile.name}" />
      </label>
      <label>API Key
        <input type="password" data-role="profile-key" value="${profile.apiKey}" />
      </label>
      <label>API Base URL
        <input type="text" data-role="profile-base" value="${profile.baseUrl}" />
      </label>
      <label>模型
        <input type="text" list="model-options" data-role="profile-model" value="${modelValue}" />
        <datalist id="model-options"></datalist>
        <div class="notice" data-role="models-status">正在加载模型列表...</div>
        <button class="outline" type="button" data-action="refresh-models">刷新模型列表</button>
        <div class="inline-inputs">
          <button class="outline" data-action="fill-model" data-model="openrouter/auto">openrouter/auto</button>
          <button class="outline" data-action="fill-model" data-model="openai/gpt-4o-mini">gpt-4o-mini</button>
          <button class="outline" data-action="fill-model" data-model="openai/gpt-4o">gpt-4o</button>
          <button class="outline" data-action="fill-model" data-model="anthropic/claude-3.5-sonnet">claude-3.5</button>
        </div>
      </label>
      <label>Fallback 模型列表
        <div class="form-grid" data-role="fallback-list"></div>
        <button class="outline" type="button" data-action="add-fallback">添加备用模型</button>
      </label>
      <div class="notice" data-role="profile-test-result"></div>
      <input type="hidden" data-role="profile-id" value="${profile.id}" />
      <div class="row">
        <button class="outline" data-action="close-modal">取消</button>
        <button class="outline" data-action="test-profile">测试</button>
        <button class="primary" data-action="save-profile">保存</button>
      </div>
    </div>
  `);
  await populateModelList(false);
  renderFallbackList(fallbackModels);
}

function saveProfile() {
  const id = modal.querySelector('[data-role="profile-id"]').value;
  const name = modal.querySelector('[data-role="profile-name"]').value.trim() || '未命名 API';
  const apiKey = modal.querySelector('[data-role="profile-key"]').value.trim();
  const baseUrl = normalizeBaseUrl(modal.querySelector('[data-role="profile-base"]').value.trim() || DEFAULT_PROFILE.baseUrl);
  const model = modal.querySelector('[data-role="profile-model"]').value.trim() || 'openrouter/auto';
  const fallbackModels = normalizeFallbackModels(model, getFallbackModelsFromModal());

  const existing = state.apiProfiles.find((item) => item.id === id);
  if (existing) {
    Object.assign(existing, { name, apiKey, baseUrl, model, fallbackModels });
  } else {
    state.apiProfiles.push({ id, name, apiKey, baseUrl, model, fallbackModels });
  }
  saveLocal(STORAGE_KEYS.apiProfiles, state.apiProfiles);
  closeModal();
  render();
}

async function testProfileConnection() {
  const result = modal.querySelector('[data-role="profile-test-result"]');
  if (!result) return;
  result.textContent = '测试中...';
  const apiKey = modal.querySelector('[data-role="profile-key"]')?.value.trim();
  const baseUrl = normalizeBaseUrl(modal.querySelector('[data-role="profile-base"]')?.value.trim() || DEFAULT_PROFILE.baseUrl);
  const model = modal.querySelector('[data-role="profile-model"]')?.value.trim() || 'openrouter/auto';
  const fallbackModels = normalizeFallbackModels(model, getFallbackModelsFromModal());
  const profile = { apiKey, baseUrl, model, fallbackModels };
  const modelsList = buildModelFallbacks(profile);
  const history = [{ role: 'user', content: 'ping' }];
  const systemPrompt = 'You are a helpful assistant.';
  let allowModelsParam = true;
  let lastError = '';

  try {
    for (let attemptIndex = 0; attemptIndex < modelsList.length; attemptIndex += 1) {
      const response = await attemptChatCompletion({
        profile,
        history,
        systemPrompt,
        model: modelsList[attemptIndex],
        models: allowModelsParam ? modelsList : null,
        stream: false
      });
      if (!response.ok) {
        const errorText = await parseErrorResponse(response);
        lastError = errorText;
        console.error('profile test error', errorText);
        if (allowModelsParam && shouldRetryWithoutModelsParam(errorText)) {
          allowModelsParam = false;
          attemptIndex = -1;
          continue;
        }
        continue;
      }
      const data = await response.json();
      const reply = data?.choices?.[0]?.message?.content || '（无回复内容）';
      result.textContent = `✅ HTTP ${response.status} ${response.statusText}: ${shorten(reply, 60)}`;
      return;
    }
  } catch (error) {
    lastError = `${error.name}: ${error.message}`;
    console.error('profile test exception', error);
  }

  result.textContent = `❌ 请求失败：${lastError || '未知错误'}`;
}

function deleteProfile(profileId) {
  if (!confirm('确定删除该 API Profile 吗？')) return;
  state.apiProfiles = state.apiProfiles.filter((item) => item.id !== profileId);
  if (state.settings.activeApiProfileId === profileId) {
    state.settings.activeApiProfileId = state.apiProfiles[0]?.id || '';
    saveLocal(STORAGE_KEYS.settings, state.settings);
  }
  saveLocal(STORAGE_KEYS.apiProfiles, state.apiProfiles);
  render();
}

function handleSettingsChange() {
  const globalPrompt = document.querySelector('[data-role="global-prompt"]');
  if (globalPrompt) {
    state.settings.globalPrompt = globalPrompt.value;
  }
  const tempInput = document.querySelector('[data-role="temperature"]');
  if (tempInput) {
    state.settings.temperature = Number(tempInput.value);
    const notice = tempInput.parentElement?.querySelector('.notice');
    if (notice) notice.textContent = `当前: ${state.settings.temperature}`;
  }
  const showModel = document.querySelector('[data-role="toggle-model"]');
  if (showModel) state.settings.showModel = showModel.checked;
  const showTokens = document.querySelector('[data-role="toggle-tokens"]');
  if (showTokens) state.settings.showTokens = showTokens.checked;
  const showTime = document.querySelector('[data-role="toggle-time"]');
  if (showTime) state.settings.showTimestamp = showTime.checked;
  const streaming = document.querySelector('[data-role="toggle-stream"]');
  if (streaming) state.settings.streaming = streaming.checked;
  saveLocal(STORAGE_KEYS.settings, state.settings);
}

function saveSupabaseSettings() {
  const urlInput = document.querySelector('[data-role="supabase-url"]');
  const anonInput = document.querySelector('[data-role="supabase-anon"]');
  if (urlInput) state.settings.supabaseUrl = urlInput.value.trim();
  if (anonInput) state.settings.supabaseAnonKey = anonInput.value.trim();
  saveLocal(STORAGE_KEYS.settings, state.settings);
  initSupabase();
  setSyncStatus(state.supabase ? 'signed-out' : 'not-configured');
}

function init() {
  state.settings = loadLocal(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  state.apiProfiles = loadLocal(STORAGE_KEYS.apiProfiles, [DEFAULT_PROFILE]).map((profile) => ({
    ...profile,
    baseUrl: normalizeBaseUrl(profile.baseUrl || DEFAULT_PROFILE.baseUrl),
    model: profile.model || 'openrouter/auto',
    fallbackModels: normalizeFallbackModels(profile.model || 'openrouter/auto', profile.fallbackModels || [])
  }));
  state.charactersIndex = loadLocal(STORAGE_KEYS.characters, [DEFAULT_CHARACTER]);
  state.conversationsIndex = loadLocal(STORAGE_KEYS.conversations, []);
  if (!state.apiProfiles.length) {
    state.apiProfiles = [DEFAULT_PROFILE];
  }
  if (!state.charactersIndex.length) {
    state.charactersIndex = [DEFAULT_CHARACTER];
  }
  applyTheme();
  initSupabase();
  if (state.supabase) {
    state.supabase.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      setSyncStatus(session ? 'synced' : 'signed-out');
      render();
      if (session) {
        runCloudSync();
      }
    });
  } else {
    setSyncStatus('not-configured');
  }
  render();
  refreshSession().then(() => {
    if (state.session) {
      runCloudSync();
    }
  });
  registerServiceWorker();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
  }
}

let longPressTimer;

document.addEventListener('pointerdown', (event) => {
  const item = event.target.closest('[data-action="open-conversation"]');
  if (!item) return;
  const conversationId = item.dataset.id;
  longPressTimer = setTimeout(() => {
    state.longPressActive = true;
    openConversationMenu(conversationId);
  }, 500);
});

document.addEventListener('pointerup', () => {
  clearTimeout(longPressTimer);
  setTimeout(() => {
    state.longPressActive = false;
  }, 0);
});

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const { action: actionName, id, tab, theme, model } = action.dataset;

  switch (actionName) {
    case 'open-settings':
      state.currentTab = 'settings';
      state.activeConversationId = null;
      render();
      break;
    case 'new-conversation':
      openNewConversationModal();
      break;
    case 'confirm-new-conversation': {
      const characterId = modal.querySelector('[data-role="conversation-character"]').value;
      const profileId = modal.querySelector('[data-role="conversation-profile"]').value;
      createConversation(characterId, profileId);
      closeModal();
      break;
    }
    case 'open-conversation':
      if (state.longPressActive) return;
      state.activeConversationId = id;
      await ensureMessagesLoaded(id);
      render();
      break;
    case 'back-to-conversations':
      state.activeConversationId = null;
      render();
      break;
    case 'set-theme':
      state.settings.theme = theme;
      saveLocal(STORAGE_KEYS.settings, state.settings);
      applyTheme();
      render();
      break;
    case 'send-message':
      await handleSendMessage();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'close-menu':
      closeMenu();
      break;
    case 'rename-conversation':
      await handleRenameConversation(id);
      break;
    case 'delete-conversation':
      await handleDeleteConversation(id);
      break;
    case 'message-menu':
      openMessageMenu(id);
      break;
    case 'copy-message': {
      const conversation = getConversation(state.activeConversationId);
      const messages = state.messagesCache.get(conversation.id) || [];
      const message = messages.find((item) => item.id === id);
      if (message) await handleCopy(message.content);
      closeMenu();
      break;
    }
    case 'delete-message':
      await handleDeleteMessage(id);
      break;
    case 'edit-message':
      await handleEditMessage(id);
      break;
    case 'regenerate-message':
      await handleRegenerateMessage(id);
      break;
    case 'new-character': {
      const newCharacter = {
        id: uuid(),
        name: '新角色',
        prompt: '',
        avatarKey: `character:${uuid()}`
      };
      state.charactersIndex.push(newCharacter);
      saveLocal(STORAGE_KEYS.characters, state.charactersIndex);
      openCharacterEditor(newCharacter.id);
      break;
    }
    case 'edit-character':
      openCharacterEditor(id);
      break;
    case 'save-character':
      await saveCharacter();
      break;
    case 'close-character':
      state.activeCharacterId = null;
      render();
      break;
    case 'edit-user-profile':
      openUserProfileModal();
      break;
    case 'save-user-profile':
      await saveUserProfile();
      break;
    case 'new-profile':
      await openProfileModal();
      break;
    case 'edit-profile':
      await openProfileModal(id);
      break;
    case 'save-profile':
      saveProfile();
      break;
    case 'test-profile':
      await testProfileConnection();
      break;
    case 'save-supabase':
      saveSupabaseSettings();
      render();
      break;
    case 'login-supabase': {
      saveSupabaseSettings();
      const email = document.querySelector('[data-role="supabase-email"]')?.value.trim();
      if (email) {
        await signInWithOtp(email);
      } else {
        alert('请输入邮箱。');
      }
      break;
    }
    case 'logout-supabase':
      await signOutSupabase();
      break;
    case 'delete-profile':
      deleteProfile(id);
      break;
    case 'fill-model': {
      const input = modal.querySelector('[data-role="profile-model"]');
      if (input) input.value = model;
      break;
    }
    case 'add-fallback': {
      const current = getFallbackModelsFromModal();
      current.push('openrouter/auto');
      renderFallbackList(current);
      break;
    }
    case 'remove-fallback': {
      const index = Number(action.dataset.index);
      const current = getFallbackModelsFromModal();
      current.splice(index, 1);
      renderFallbackList(current);
      break;
    }
    case 'move-fallback-up': {
      const index = Number(action.dataset.index);
      const current = getFallbackModelsFromModal();
      if (index > 0) {
        [current[index - 1], current[index]] = [current[index], current[index - 1]];
        renderFallbackList(current);
      }
      break;
    }
    case 'move-fallback-down': {
      const index = Number(action.dataset.index);
      const current = getFallbackModelsFromModal();
      if (index < current.length - 1) {
        [current[index + 1], current[index]] = [current[index], current[index + 1]];
        renderFallbackList(current);
      }
      break;
    }
    case 'refresh-models':
      await populateModelList(true);
      break;
    case 'switch-tab':
      if (tab) {
        state.currentTab = tab;
        state.activeConversationId = null;
        render();
      }
      break;
    default:
      break;
  }
});

document.addEventListener('input', (event) => {
  if (event.target.closest('[data-role="global-prompt"]') ||
      event.target.closest('[data-role="temperature"]') ||
      event.target.closest('[data-role="toggle-model"]') ||
      event.target.closest('[data-role="toggle-tokens"]') ||
      event.target.closest('[data-role="toggle-time"]') ||
      event.target.closest('[data-role="toggle-stream"]')) {
    handleSettingsChange();
  }
});

document.addEventListener('focusin', (event) => {
  if (event.target.matches('input, textarea, select')) {
    document.body.classList.add('keyboard-open');
  }
});

document.addEventListener('focusout', (event) => {
  if (event.target.matches('input, textarea, select')) {
    document.body.classList.remove('keyboard-open');
  }
});

window.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
  if (event.target === menu) closeMenu();
});

window.addEventListener('load', init);
