const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Миграции для добавления недостающих колонок и таблиц
async function migrateTables() {
  try {
    // Проверка колонки avatar в users
    const avatarColumn = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='avatar'`);
    if (avatarColumn.rows.length === 0) await pool.query('ALTER TABLE users ADD COLUMN avatar TEXT');

    // Проверка колонки avatar в messages
    const msgAvatarColumn = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name='avatar'`);
    if (msgAvatarColumn.rows.length === 0) await pool.query('ALTER TABLE messages ADD COLUMN avatar TEXT');

    // Проверка колонки username в messages
    const usernameColumn = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name='username'`);
    if (usernameColumn.rows.length === 0) await pool.query('ALTER TABLE messages ADD COLUMN username VARCHAR(50) REFERENCES users(username) ON DELETE SET NULL');

    // Проверка колонки is_read в mails
    const isReadColumn = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='mails' AND column_name='is_read'`);
    if (isReadColumn.rows.length === 0) await pool.query('ALTER TABLE mails ADD COLUMN is_read BOOLEAN NOT NULL DEFAULT FALSE');

    // Создание таблицы для реакций, если её нет
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        username VARCHAR(50) REFERENCES users(username) ON DELETE CASCADE,
        emoji VARCHAR(10) NOT NULL,
        UNIQUE(message_id, username)
      )
    `);
    console.log('✅ Таблица реакций проверена/создана');
  } catch (err) { console.error('❌ Ошибка миграции:', err); }
}

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (username VARCHAR(50) PRIMARY KEY, password VARCHAR(100) NOT NULL, avatar TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_settings (username VARCHAR(50) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE, settings JSONB NOT NULL DEFAULT '{}')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL, password VARCHAR(100), type VARCHAR(20) NOT NULL DEFAULT 'private', created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS room_participants (room_id VARCHAR(50) REFERENCES rooms(id) ON DELETE CASCADE, username VARCHAR(50) REFERENCES users(username) ON DELETE CASCADE, deleted BOOLEAN NOT NULL DEFAULT FALSE, joined_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (room_id, username))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, room_id VARCHAR(50) REFERENCES rooms(id) ON DELETE CASCADE, username VARCHAR(50) REFERENCES users(username) ON DELETE SET NULL, sender VARCHAR(50) NOT NULL, avatar TEXT, text TEXT NOT NULL, timestamp TIMESTAMP NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mails (id SERIAL PRIMARY KEY, from_user VARCHAR(50) REFERENCES users(username) ON DELETE CASCADE, to_user VARCHAR(50) REFERENCES users(username) ON DELETE CASCADE, text TEXT NOT NULL, timestamp TIMESTAMP NOT NULL DEFAULT NOW(), is_read BOOLEAN NOT NULL DEFAULT FALSE)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS reactions (id SERIAL PRIMARY KEY, message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, username VARCHAR(50) REFERENCES users(username) ON DELETE CASCADE, emoji VARCHAR(10) NOT NULL, UNIQUE(message_id, username))`);
    await pool.query(`INSERT INTO rooms (id, name, password, type) VALUES ('public', 'Public Chat', NULL, 'public') ON CONFLICT (id) DO NOTHING`);
    console.log('✅ База инициализирована');
    await migrateTables();
  } catch (err) { console.error('❌ Ошибка инициализации БД:', err); }
}
initDB();

const activeUsers = new Map(); // roomId -> Set of usernames

// -------------------- API аккаунтов --------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const existing = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Пользователь уже существует' });
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
    await pool.query('INSERT INTO user_settings (username, settings) VALUES ($1, $2)', [username, JSON.stringify({ requirePassword: false, passwordTimeout: 0 })]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const user = await pool.query('SELECT password, avatar FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== password) return res.status(401).json({ error: 'Неверное имя или пароль' });
    res.json({ success: true, username, avatar: user.rows[0].avatar });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/change-password', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  if (!username || !oldPassword || !newPassword) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    const user = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== oldPassword) return res.status(401).json({ error: 'Неверный старый пароль' });
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [newPassword, username]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/delete-account', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    const user = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// -------------------- API для аватарок --------------------
app.post('/api/upload-avatar', async (req, res) => {
  const { username, avatar } = req.body;
  if (!username || !avatar) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    await pool.query('UPDATE users SET avatar = $1 WHERE username = $2', [avatar, username]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/avatar/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const user = await pool.query('SELECT avatar FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ avatar: user.rows[0].avatar });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// -------------------- API для настроек --------------------
app.get('/api/user-settings', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Не указан пользователь' });
  try {
    let settings = await pool.query('SELECT settings FROM user_settings WHERE username = $1', [username]);
    if (settings.rows.length === 0) {
      const defaultSettings = { requirePassword: false, passwordTimeout: 0 };
      await pool.query('INSERT INTO user_settings (username, settings) VALUES ($1, $2)', [username, JSON.stringify(defaultSettings)]);
      return res.json(defaultSettings);
    }
    res.json(settings.rows[0].settings);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/user-settings', async (req, res) => {
  const { username, settings } = req.body;
  if (!username || !settings) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    await pool.query('INSERT INTO user_settings (username, settings) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET settings = $2', [username, JSON.stringify(settings)]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// -------------------- API для писем --------------------
app.get('/api/mails', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Не указан пользователь' });
  try {
    const mails = await pool.query('SELECT id, from_user, text, timestamp, is_read FROM mails WHERE to_user = $1 ORDER BY timestamp DESC', [username]);
    res.json(mails.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/mails/send', async (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    const recipient = await pool.query('SELECT username FROM users WHERE username = $1', [to]);
    if (recipient.rows.length === 0) return res.status(404).json({ error: 'Получатель не найден' });
    const result = await pool.query('INSERT INTO mails (from_user, to_user, text) VALUES ($1, $2, $3) RETURNING id', [from, to, text]);
    const mailId = result.rows[0].id;
    const recipientSockets = await io.fetchSockets();
    recipientSockets.forEach(socket => { if (socket.data.username === to) socket.emit('newMail', { id: mailId, from_user: from, text, timestamp: new Date() }); });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/mails/mark-read', async (req, res) => {
  const { username, ids } = req.body;
  if (!username || !Array.isArray(ids)) return res.status(400).json({ error: 'Неверные данные' });
  try {
    await pool.query('UPDATE mails SET is_read = TRUE WHERE id = ANY($1::int[]) AND to_user = $2', [ids, username]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/mails/:id', async (req, res) => {
  const { id } = req.params;
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    const result = await pool.query('DELETE FROM mails WHERE id = $1 AND to_user = $2 RETURNING id', [id, username]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Письмо не найдено' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// -------------------- API для комнат --------------------
app.post('/api/rooms/create', async (req, res) => {
  const { roomId, roomName, password, creator } = req.body;
  if (!roomId || !roomName || !password || !creator) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    const existing = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Комната с таким ID уже существует' });
    await pool.query('INSERT INTO rooms (id, name, password, type) VALUES ($1, $2, $3, $4)', [roomId, roomName, password, 'private']);
    await pool.query('INSERT INTO room_participants (room_id, username, deleted) VALUES ($1, $2, false)', [roomId, creator]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/rooms/check-password', async (req, res) => {
  const { roomId, password } = req.body;
  try {
    const room = await pool.query('SELECT password FROM rooms WHERE id = $1 AND type = $2', [roomId, 'private']);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Комната не найдена' });
    if (room.rows[0].password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/rooms/join', async (req, res) => {
  const { roomId, username } = req.body;
  try {
    await pool.query('INSERT INTO room_participants (room_id, username, deleted) VALUES ($1, $2, false) ON CONFLICT (room_id, username) DO UPDATE SET deleted = false', [roomId, username]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/rooms/rename', async (req, res) => {
  const { roomId, username, newName } = req.body;
  if (!roomId || !username || !newName) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    const participant = await pool.query('SELECT * FROM room_participants WHERE room_id = $1 AND username = $2', [roomId, username]);
    if (participant.rows.length === 0) return res.status(403).json({ error: 'Вы не участник этой комнаты' });
    await pool.query('UPDATE rooms SET name = $1 WHERE id = $2', [newName, roomId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/rooms/delete', async (req, res) => {
  const { roomId, username } = req.body;
  try {
    await pool.query('UPDATE room_participants SET deleted = true WHERE room_id = $1 AND username = $2', [roomId, username]);
    const remaining = await pool.query('SELECT COUNT(*) FROM room_participants WHERE room_id = $1 AND deleted = false', [roomId]);
    if (parseInt(remaining.rows[0].count) === 0) await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/rooms/list/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const rooms = await pool.query(`SELECT r.id, r.name, r.type FROM rooms r JOIN room_participants p ON r.id = p.room_id WHERE p.username = $1 AND p.deleted = false AND r.type = 'private'`, [username]);
    res.json(rooms.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/rooms/info/:roomId', async (req, res) => {
  const { roomId } = req.params;
  try {
    const room = await pool.query('SELECT id, name, password FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Комната не найдена' });
    res.json(room.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Эндпоинт для получения сообщений комнаты (без присоединения)
app.get('/api/rooms/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    const room = await pool.query('SELECT type FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Room not found' });
    if (room.rows[0].type === 'private') {
      const participant = await pool.query('SELECT * FROM room_participants WHERE room_id = $1 AND username = $2', [roomId, username]);
      if (participant.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
    }
    const messages = await pool.query(
      `SELECT m.id, m.sender, m.text, m.timestamp, u.avatar 
       FROM messages m
       LEFT JOIN users u ON m.username = u.username
       WHERE m.room_id = $1 
       ORDER BY m.timestamp ASC`,
      [roomId]
    );
    res.json(messages.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/rooms/participants/:roomId', (req, res) => {
  const users = activeUsers.get(req.params.roomId);
  res.json(users ? Array.from(users) : []);
});

app.get('/api/rooms/participants/public', (req, res) => {
  const users = activeUsers.get('public');
  res.json(users ? Array.from(users) : []);
});

// -------------------- API для реакций --------------------
// Получить все реакции для сообщения
app.get('/api/messages/:messageId/reactions', async (req, res) => {
  const { messageId } = req.params;
  try {
    const reactions = await pool.query(
      'SELECT username, emoji FROM reactions WHERE message_id = $1',
      [messageId]
    );
    res.json(reactions.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Добавить/удалить реакцию (toggle)
app.post('/api/messages/:messageId/react', async (req, res) => {
  const { messageId } = req.params;
  const { username, emoji } = req.body;
  if (!username || !emoji) return res.status(400).json({ error: 'Missing fields' });
  try {
    // Проверяем, существует ли уже такая реакция от этого пользователя
    const existing = await pool.query(
      'SELECT id FROM reactions WHERE message_id = $1 AND username = $2',
      [messageId, username]
    );
    if (existing.rows.length > 0) {
      // Если уже есть, удаляем (независимо от эмодзи – пользователь может иметь только одну реакцию)
      await pool.query('DELETE FROM reactions WHERE message_id = $1 AND username = $2', [messageId, username]);
      res.json({ action: 'removed' });
    } else {
      // Добавляем
      await pool.query(
        'INSERT INTO reactions (message_id, username, emoji) VALUES ($1, $2, $3)',
        [messageId, username, emoji]
      );
      res.json({ action: 'added' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Получить список пользователей, поставивших конкретную реакцию на сообщение
app.get('/api/messages/:messageId/reactions/:emoji/users', async (req, res) => {
  const { messageId, emoji } = req.params;
  try {
    const users = await pool.query(
      'SELECT username FROM reactions WHERE message_id = $1 AND emoji = $2',
      [messageId, emoji]
    );
    res.json(users.rows.map(r => r.username));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// -------------------- Socket.IO --------------------
io.on('connection', (socket) => {
  console.log('🔗 Клиент подключился:', socket.id);

  socket.on('joinRoom', async ({ roomId, username }) => {
    try {
      const room = await pool.query('SELECT id, type FROM rooms WHERE id = $1', [roomId]);
      if (room.rows.length === 0) { socket.emit('roomError', { message: 'Комната не существует' }); return; }
      if (room.rows[0].type === 'private') {
        const participant = await pool.query('SELECT * FROM room_participants WHERE room_id = $1 AND username = $2', [roomId, username]);
        if (participant.rows.length === 0) { socket.emit('roomError', { message: 'Вы не участник' }); return; }
      }
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = username;
      if (!activeUsers.has(roomId)) activeUsers.set(roomId, new Set());
      activeUsers.get(roomId).add(username);
      const messages = await pool.query(
        `SELECT m.id, m.sender, m.text, m.timestamp, u.avatar 
         FROM messages m
         LEFT JOIN users u ON m.username = u.username
         WHERE m.room_id = $1 
         ORDER BY m.timestamp ASC`,
        [roomId]
      );
      // Загружаем реакции для этих сообщений (можно отдельно, но для простоты вернём сразу)
      // Однако реакции лучше загружать отдельно, чтобы не усложнять. Но можно и так.
      // Пока оставим как есть, а реакции будут запрашиваться при открытии контекстного меню.
      socket.emit('roomJoined', { roomId, messages: messages.rows, userCount: activeUsers.get(roomId).size });
      io.to(roomId).emit('userCount', { count: activeUsers.get(roomId).size });
    } catch (err) { console.error(err); socket.emit('roomError', { message: 'Ошибка сервера: ' + err.message }); }
  });

  socket.on('sendMessage', async ({ roomId, sender, text }) => {
    try {
      const user = await pool.query('SELECT avatar FROM users WHERE username = $1', [sender]);
      const avatar = user.rows[0]?.avatar || null;
      const result = await pool.query('INSERT INTO messages (room_id, username, sender, avatar, text) VALUES ($1, $2, $3, $4, $5) RETURNING id', [roomId, sender, sender, avatar, text]);
      const messageId = result.rows[0].id;
      const newMessage = { id: messageId, roomId, sender, avatar, text, timestamp: new Date().toISOString() };
      io.to(roomId).emit('newMessage', newMessage);
    } catch (err) { console.error(err); }
  });

  socket.on('leaveRoom', ({ roomId }) => {
    if (roomId && socket.data.username) {
      const roomUsers = activeUsers.get(roomId);
      if (roomUsers) {
        roomUsers.delete(socket.data.username);
        if (roomUsers.size === 0) activeUsers.delete(roomId);
        else io.to(roomId).emit('userCount', { count: roomUsers.size });
      }
      socket.leave(roomId);
    }
  });

  socket.on('disconnect', () => {
    const { roomId, username } = socket.data;
    if (roomId && username) {
      const roomUsers = activeUsers.get(roomId);
      if (roomUsers) {
        roomUsers.delete(username);
        if (roomUsers.size === 0) activeUsers.delete(roomId);
        else io.to(roomId).emit('userCount', { count: roomUsers.size });
      }
    }
  });
});

app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
