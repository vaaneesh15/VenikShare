(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const state = {
    api: '',
    token: localStorage.getItem('chatx_token') || '',
    me: null,
    chats: [],
    searchUsers: [],
    activeUser: null,
    messages: [],
    online: new Set(),
    ws: null,
    reconnectTimer: null,
    toastTimer: null
  };

  const setupView = $('#setupView');
  const authView = $('#authView');
  const appView = $('#appView');
  const chatView = $('#chatView');

  function cleanUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function determineApi() {
    const queryApi = new URLSearchParams(location.search).get('api');
    if (queryApi) {
      const cleaned = cleanUrl(queryApi);
      localStorage.setItem('chatx_api_url', cleaned);
      history.replaceState(null, '', location.pathname + location.hash);
      return cleaned;
    }
    const stored = cleanUrl(localStorage.getItem('chatx_api_url'));
    if (stored) return stored;
    const isGithub = location.hostname.endsWith('.github.io');
    const isFile = location.protocol === 'file:';
    if (isGithub || isFile) return '';
    return cleanUrl(location.origin);
  }

  state.api = determineApi();

  function showOnly(view) {
    [setupView, authView, appView].forEach(el => el.classList.add('hidden'));
    view.classList.remove('hidden');
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    let response;
    try {
      response = await fetch(`${state.api}${path}`, { ...options, headers });
    } catch {
      throw new Error('Не удалось подключиться к серверу');
    }

    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 401 && state.token) logout(false);
      throw new Error(body.error || `Ошибка ${response.status}`);
    }
    return body;
  }

  function setSession(token, user) {
    state.token = token;
    state.me = user;
    localStorage.setItem('chatx_token', token);
  }

  function clearSession() {
    state.token = '';
    state.me = null;
    localStorage.removeItem('chatx_token');
    if (state.ws) state.ws.close();
    state.ws = null;
  }

  function logout(showMessage = true) {
    clearSession();
    chatView.classList.add('hidden');
    showOnly(authView);
    if (showMessage) toast('Вы вышли из аккаунта');
  }

  function escapeInitial(user) {
    const source = (user?.name || user?.login || '?').trim();
    return source ? source[0].toUpperCase() : '?';
  }

  function setAvatar(el, user) {
    el.textContent = '';
    if (user?.avatar) {
      const img = document.createElement('img');
      img.src = user.avatar;
      img.alt = '';
      el.appendChild(img);
    } else {
      el.textContent = escapeInitial(user);
    }
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  function createUserRow(user, preview = '', time = '', onClick) {
    const button = document.createElement('button');
    button.className = 'list-row';
    button.type = 'button';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'avatar-wrap';
    const avatar = document.createElement('span');
    avatar.className = 'avatar avatar-md';
    setAvatar(avatar, user);
    avatarWrap.appendChild(avatar);
    if (state.online.has(user.id)) {
      const dot = document.createElement('span');
      dot.className = 'online-dot';
      avatarWrap.appendChild(dot);
    }

    const main = document.createElement('div');
    main.className = 'row-main';
    const top = document.createElement('div');
    top.className = 'row-top';
    const name = document.createElement('strong');
    name.textContent = user.name || user.login;
    top.appendChild(name);
    const prev = document.createElement('div');
    prev.className = 'row-preview';
    prev.textContent = preview || `@${user.login}`;
    main.append(top, prev);

    const timeEl = document.createElement('span');
    timeEl.className = 'row-time';
    timeEl.textContent = time;

    button.append(avatarWrap, main, timeEl);
    button.addEventListener('click', onClick);
    return button;
  }

  function renderChats() {
    const list = $('#chatList');
    list.textContent = '';
    const q = $('#chatSearch').value.trim().toLowerCase();
    const filtered = state.chats.filter(chat => {
      if (!q) return true;
      const user = chat.user;
      return (user.name || '').toLowerCase().includes(q) || user.login.toLowerCase().includes(q);
    });

    if (!filtered.length && !q) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Пока нет чатов. Найди пользователя через поиск и напиши ему.';
      list.appendChild(empty);
      return;
    }

    filtered.forEach(chat => {
      const mine = chat.lastMessage?.from === state.me?.id;
      const preview = `${mine ? 'Вы: ' : ''}${chat.lastMessage?.text || ''}`;
      list.appendChild(createUserRow(
        chat.user,
        preview,
        formatTime(chat.lastMessage?.createdAt),
        () => openChat(chat.user)
      ));
    });
  }

  function renderSearchUsers() {
    const block = $('#userSearchBlock');
    const list = $('#userSearchList');
    const q = $('#chatSearch').value.trim();
    if (!q) {
      block.classList.add('hidden');
      list.textContent = '';
      return;
    }
    block.classList.remove('hidden');
    list.textContent = '';
    if (!state.searchUsers.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Пользователи не найдены';
      list.appendChild(empty);
      return;
    }
    state.searchUsers.forEach(user => {
      list.appendChild(createUserRow(user, `@${user.login}`, state.online.has(user.id) ? 'в сети' : '', () => openChat(user)));
    });
  }

  async function loadChats() {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChats();
  }

  let searchTimer = null;
  $('#chatSearch').addEventListener('input', () => {
    renderChats();
    clearTimeout(searchTimer);
    const q = $('#chatSearch').value.trim();
    if (!q) {
      state.searchUsers = [];
      renderSearchUsers();
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/users?search=${encodeURIComponent(q)}`);
        state.searchUsers = data.users || [];
        renderSearchUsers();
      } catch (error) {
        toast(error.message);
      }
    }, 220);
  });

  function renderProfile() {
    if (!state.me) return;
    $('#profileName').value = state.me.name || state.me.login;
    $('#profileLogin').textContent = `@${state.me.login}`;
    setAvatar($('#profileAvatar'), state.me);
  }

  function updateChatHeader() {
    if (!state.activeUser) return;
    $('#chatHeaderName').textContent = state.activeUser.name || state.activeUser.login;
    $('#chatHeaderStatus').textContent = state.online.has(state.activeUser.id) ? 'в сети' : `@${state.activeUser.login}`;
    setAvatar($('#chatHeaderAvatar'), state.activeUser);
  }

  function dayLabel(date) {
    const today = new Date();
    const d = new Date(date);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function renderMessages() {
    const box = $('#messages');
    box.textContent = '';
    let lastDay = '';
    state.messages.forEach(message => {
      const currentDay = new Date(message.createdAt).toDateString();
      if (currentDay !== lastDay) {
        const chip = document.createElement('div');
        chip.className = 'day-chip';
        chip.textContent = dayLabel(message.createdAt);
        box.appendChild(chip);
        lastDay = currentDay;
      }
      const bubble = document.createElement('div');
      bubble.className = `message${message.from === state.me.id ? ' mine' : ''}`;
      const text = document.createElement('span');
      text.textContent = message.text;
      const time = document.createElement('small');
      time.className = 'message-time';
      time.textContent = new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      bubble.append(text, time);
      box.appendChild(bubble);
    });
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }

  async function openChat(user) {
    state.activeUser = user;
    updateChatHeader();
    chatView.classList.remove('hidden');
    $('#messages').innerHTML = '<div class="empty-state">Загрузка…</div>';
    try {
      const data = await api(`/api/messages/${encodeURIComponent(user.id)}`);
      state.activeUser = data.user;
      state.messages = data.messages || [];
      updateChatHeader();
      renderMessages();
      $('#messageInput').focus();
    } catch (error) {
      toast(error.message);
      chatView.classList.add('hidden');
    }
  }

  $('#closeChatBtn').addEventListener('click', () => {
    chatView.classList.add('hidden');
    state.activeUser = null;
    state.messages = [];
    loadChats().catch(() => {});
  });

  $('#messageForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#messageInput');
    const text = input.value.trim();
    if (!text || !state.activeUser) return;
    input.value = '';
    autoGrow(input);
    try {
      await api('/api/messages', {
        method: 'POST',
        body: JSON.stringify({ to: state.activeUser.id, text })
      });
    } catch (error) {
      input.value = text;
      autoGrow(input);
      toast(error.message);
    }
  });

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }
  $('#messageInput').addEventListener('input', event => autoGrow(event.currentTarget));
  $('#messageInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#messageForm').requestSubmit();
    }
  });

  function connectWebSocket() {
    if (!state.token || !state.api) return;
    if (state.ws) state.ws.close();
    clearTimeout(state.reconnectTimer);
    const wsBase = state.api.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;

    ws.onmessage = event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }

      if (payload.type === 'ready' || payload.type === 'presence') {
        state.online = new Set(payload.online || []);
        renderChats();
        renderSearchUsers();
        updateChatHeader();
      }

      if (payload.type === 'profile' && payload.user) {
        if (state.activeUser?.id === payload.user.id) state.activeUser = payload.user;
        state.chats = state.chats.map(chat => chat.user.id === payload.user.id ? { ...chat, user: payload.user } : chat);
        state.searchUsers = state.searchUsers.map(user => user.id === payload.user.id ? payload.user : user);
        renderChats();
        renderSearchUsers();
        updateChatHeader();
      }

      if (payload.type === 'message' && payload.message) {
        const m = payload.message;
        const belongsToOpenChat = state.activeUser && (
          (m.from === state.me.id && m.to === state.activeUser.id) ||
          (m.from === state.activeUser.id && m.to === state.me.id)
        );
        if (belongsToOpenChat && !state.messages.some(existing => existing.id === m.id)) {
          state.messages.push(m);
          renderMessages();
        }
        loadChats().catch(() => {});
      }
    };

    ws.onclose = event => {
      if (state.ws === ws) state.ws = null;
      if (state.token && event.code !== 4001) {
        state.reconnectTimer = setTimeout(connectWebSocket, 1800);
      }
    };
  }

  async function enterApp() {
    showOnly(appView);
    renderProfile();
    await loadChats();
    connectWebSocket();
  }

  async function bootstrap() {
    if (!state.api) {
      showOnly(setupView);
      return;
    }
    if (!state.token) {
      showOnly(authView);
      return;
    }
    try {
      const data = await api('/api/me');
      state.me = data.user;
      await enterApp();
    } catch {
      clearSession();
      showOnly(authView);
    }
  }

  $('#saveServerBtn').addEventListener('click', async () => {
    const value = cleanUrl($('#serverUrlInput').value);
    if (!/^https?:\/\//i.test(value)) {
      toast('Введи полный адрес, начиная с https://');
      return;
    }
    try {
      const response = await fetch(`${value}/health`);
      if (!response.ok) throw new Error();
      state.api = value;
      localStorage.setItem('chatx_api_url', value);
      showOnly(state.token ? appView : authView);
      if (state.token) bootstrap();
      toast('Сервер подключён');
    } catch {
      toast('Сервер не отвечает. Проверь адрес.');
    }
  });

  $$('[data-auth-tab]').forEach(button => {
    button.addEventListener('click', () => {
      $$('[data-auth-tab]').forEach(b => b.classList.toggle('active', b === button));
      const login = button.dataset.authTab === 'login';
      $('#loginForm').classList.toggle('hidden', !login);
      $('#registerForm').classList.toggle('hidden', login);
    });
  });

  $$('[data-eye-for]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.eyeFor);
      input.type = input.type === 'password' ? 'text' : 'password';
      button.textContent = input.type === 'password' ? '◉' : '◎';
    });
  });

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ login: $('#loginLogin').value, password: $('#loginPassword').value })
      });
      setSession(data.token, data.user);
      $('#loginForm').reset();
      await enterApp();
    } catch (error) {
      toast(error.message);
    }
  });

  $('#registerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('#registerPassword').value;
    if (password !== $('#registerRepeat').value) {
      toast('Пароли не совпадают');
      return;
    }
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ login: $('#registerLogin').value, password })
      });
      setSession(data.token, data.user);
      $('#registerForm').reset();
      await enterApp();
    } catch (error) {
      toast(error.message);
    }
  });

  $$('.tab-btn').forEach(button => {
    button.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.toggle('active', b === button));
      $$('.page').forEach(page => page.classList.toggle('active-page', page.id === button.dataset.page));
      if (button.dataset.page === 'profilePage') renderProfile();
      if (button.dataset.page === 'chatsPage') loadChats().catch(() => {});
    });
  });

  $('#saveProfileBtn').addEventListener('click', async () => {
    try {
      const data = await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: $('#profileName').value, avatar: state.me.avatar || '' })
      });
      state.me = data.user;
      renderProfile();
      toast('Профиль сохранён');
    } catch (error) {
      toast(error.message);
    }
  });

  $('#avatarButton').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Выбери изображение');
      return;
    }
    try {
      const avatar = await makeAvatar(file);
      const data = await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: $('#profileName').value.trim() || state.me.name, avatar })
      });
      state.me = data.user;
      renderProfile();
      toast('Аватар обновлён');
    } catch (error) {
      toast(error.message || 'Не удалось обработать изображение');
    } finally {
      event.target.value = '';
    }
  });

  function makeAvatar(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const size = 512;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL('image/jpeg', .82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  $('#changePasswordBtn').addEventListener('click', () => $('#passwordSheet').classList.remove('hidden'));
  $('#cancelPasswordBtn').addEventListener('click', () => {
    $('#passwordSheet').classList.add('hidden');
    $('#passwordForm').reset();
  });
  $('#passwordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const next = $('#newPassword').value;
    if (next !== $('#newPasswordRepeat').value) {
      toast('Новые пароли не совпадают');
      return;
    }
    try {
      await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: $('#oldPassword').value, newPassword: next })
      });
      $('#passwordSheet').classList.add('hidden');
      $('#passwordForm').reset();
      toast('Пароль изменён');
    } catch (error) {
      toast(error.message);
    }
  });

  $('#logoutBtn').addEventListener('click', () => $('#confirmBackdrop').classList.remove('hidden'));
  $('#cancelLogoutBtn').addEventListener('click', () => $('#confirmBackdrop').classList.add('hidden'));
  $('#confirmLogoutBtn').addEventListener('click', () => {
    $('#confirmBackdrop').classList.add('hidden');
    logout(true);
  });

  $('#changeServerBtn').addEventListener('click', () => {
    $('#serverUrlInput').value = state.api;
    clearSession();
    showOnly(setupView);
  });

  bootstrap();
})();
