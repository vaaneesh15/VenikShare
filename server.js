const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-render-environment';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'chatx-data.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

if (!process.env.JWT_SECRET) {
  console.warn('[ChatX] WARNING: JWT_SECRET is not set. Set it in Render Environment for production.');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Origin is not allowed by CORS'));
  }
}));

function emptyDb() {
  return { users: [], messages: [] };
}

function ensureDataDirectory() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function loadDb() {
  ensureDataDirectory();
  if (!fs.existsSync(DATA_FILE)) {
    const initial = emptyDb();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed.users) || !Array.isArray(parsed.messages)) return emptyDb();
    return parsed;
  } catch (error) {
    console.error('[ChatX] Failed to read data file:', error);
    return emptyDb();
  }
}

let db = loadDb();

function saveDb() {
  ensureDataDirectory();
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DATA_FILE);
}

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    name: user.name || user.login,
    avatar: user.avatar || '',
    createdAt: user.createdAt
  };
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

function userFromToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return db.users.find(u => u.id === payload.sub) || null;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  req.user = user;
  next();
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

function validateLogin(login) {
  return /^[a-z0-9_.-]{3,24}$/i.test(login);
}

function sortMessages(a, b) {
  return new Date(a.createdAt) - new Date(b.createdAt);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ChatX', time: new Date().toISOString() });
});

app.post('/api/register', async (req, res) => {
  const login = normalizeLogin(req.body.login);
  const password = String(req.body.password || '');

  if (!validateLogin(login)) {
    return res.status(400).json({ error: 'Логин: 3–24 символа, латиница, цифры, _, . или -' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Пароль должен содержать от 6 до 128 символов' });
  }
  if (db.users.some(u => u.login.toLowerCase() === login)) {
    return res.status(409).json({ error: 'Такой логин уже занят' });
  }

  const user = {
    id: crypto.randomUUID(),
    login,
    passwordHash: await bcrypt.hash(password, 10),
    name: login,
    avatar: '',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDb();
  res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const login = normalizeLogin(req.body.login);
  const password = String(req.body.password || '');
  const user = db.users.find(u => u.login.toLowerCase() === login);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put('/api/profile', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const avatar = String(req.body.avatar || '');
  if (name.length < 1 || name.length > 40) {
    return res.status(400).json({ error: 'Имя должно содержать от 1 до 40 символов' });
  }
  if (avatar && (!avatar.startsWith('data:image/') || avatar.length > 3_000_000)) {
    return res.status(400).json({ error: 'Аватар слишком большой или имеет неверный формат' });
  }
  req.user.name = name;
  req.user.avatar = avatar;
  saveDb();
  broadcast({ type: 'profile', user: publicUser(req.user) });
  res.json({ user: publicUser(req.user) });
});

app.post('/api/change-password', auth, async (req, res) => {
  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (!(await bcrypt.compare(oldPassword, req.user.passwordHash))) {
    return res.status(400).json({ error: 'Старый пароль указан неверно' });
  }
  if (!validatePassword(newPassword)) {
    return res.status(400).json({ error: 'Новый пароль должен содержать от 6 до 128 символов' });
  }
  req.user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveDb();
  res.json({ ok: true });
});

app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.search || '').trim().toLowerCase();
  const users = db.users
    .filter(u => u.id !== req.user.id)
    .filter(u => !q || u.login.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q))
    .slice(0, 50)
    .map(publicUser);
  res.json({ users });
});

app.get('/api/chats', auth, (req, res) => {
  const mine = db.messages
    .filter(m => m.from === req.user.id || m.to === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const seen = new Set();
  const chats = [];
  for (const message of mine) {
    const otherId = message.from === req.user.id ? message.to : message.from;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const user = db.users.find(u => u.id === otherId);
    if (!user) continue;
    chats.push({
      user: publicUser(user),
      lastMessage: {
        id: message.id,
        text: message.text,
        from: message.from,
        createdAt: message.createdAt
      }
    });
  }
  res.json({ chats });
});

app.get('/api/messages/:userId', auth, (req, res) => {
  const other = db.users.find(u => u.id === req.params.userId);
  if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

  const messages = db.messages
    .filter(m =>
      (m.from === req.user.id && m.to === other.id) ||
      (m.from === other.id && m.to === req.user.id)
    )
    .sort(sortMessages)
    .slice(-300);

  res.json({ user: publicUser(other), messages });
});

app.post('/api/messages', auth, (req, res) => {
  const to = String(req.body.to || '');
  const text = String(req.body.text || '').trim();
  if (!text || text.length > 4000) {
    return res.status(400).json({ error: 'Сообщение должно содержать от 1 до 4000 символов' });
  }
  if (to === req.user.id) return res.status(400).json({ error: 'Нельзя написать самому себе' });
  const recipient = db.users.find(u => u.id === to);
  if (!recipient) return res.status(404).json({ error: 'Получатель не найден' });

  const message = {
    id: crypto.randomUUID(),
    from: req.user.id,
    to,
    text,
    createdAt: new Date().toISOString()
  };
  db.messages.push(message);
  if (db.messages.length > 100000) db.messages = db.messages.slice(-100000);
  saveDb();

  sendToUsers([req.user.id, recipient.id], { type: 'message', message });
  res.status(201).json({ message });
});

// Flat project: explicitly expose only the three frontend files.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Метод API не найден' }));

const socketsByUser = new Map();

function addSocket(userId, ws) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(ws);
}

function removeSocket(userId, ws) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) socketsByUser.delete(userId);
}

function onlineIds() {
  return [...socketsByUser.keys()];
}

function rawSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  for (const client of wss.clients) rawSend(client, payload);
}

function sendToUsers(userIds, payload) {
  for (const id of new Set(userIds)) {
    const sockets = socketsByUser.get(id);
    if (!sockets) continue;
    for (const ws of sockets) rawSend(ws, payload);
  }
}

function broadcastPresence() {
  broadcast({ type: 'presence', online: onlineIds() });
}

wss.on('connection', (ws, req) => {
  let token = '';
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    token = url.searchParams.get('token') || '';
  } catch {}

  const user = userFromToken(token);
  if (!user) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  addSocket(user.id, ws);
  rawSend(ws, { type: 'ready', user: publicUser(user), online: onlineIds() });
  broadcastPresence();

  ws.on('close', () => {
    removeSocket(user.id, ws);
    broadcastPresence();
  });

  ws.on('error', () => {
    removeSocket(user.id, ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ChatX] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[ChatX] Data file: ${DATA_FILE}`);
});
