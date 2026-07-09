const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (username VARCHAR(50) PRIMARY KEY, password VARCHAR(100) NOT NULL, avatar TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, room_id VARCHAR(50) NOT NULL, username VARCHAR(50) REFERENCES users(username) ON DELETE SET NULL, sender VARCHAR(50) NOT NULL, avatar TEXT, text TEXT NOT NULL, timestamp TIMESTAMP NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS reactions (id SERIAL PRIMARY KEY, message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, username VARCHAR(50) REFERENCES users(username) ON DELETE CASCADE, emoji VARCHAR(10) NOT NULL, UNIQUE(message_id, username))`);
    console.log('✅ База готова');
  } catch (err) { console.error('❌ Ошибка БД:', err); }
}
initDB();

const activeUsers = new Map(); // только для public

// API аккаунтов
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const existing = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Пользователь уже существует' });
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const user = await pool.query('SELECT password, avatar FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== password) return res.status(401).json({ error: 'Неверное имя или пароль' });
    res.json({ success: true, avatar: user.rows[0].avatar });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/change-password', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  if (!username || !oldPassword || !newPassword) return res.status(400).json({ error: 'Не все поля' });
  try {
    const user = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== oldPassword) return res.status(401).json({ error: 'Неверный старый пароль' });
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [newPassword, username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/delete-account', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Не все поля' });
  try {
    const user = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Аватар
app.post('/api/upload-avatar', async (req, res) => {
  const { username, avatar } = req.body;
  if (!username || !avatar) return res.status(400).json({ error: 'Нет данных' });
  await pool.query('UPDATE users SET avatar = $1 WHERE username = $2', [avatar, username]);
  res.json({ success: true });
});

app.get('/api/avatar/:username', async (req, res) => {
  const user = await pool.query('SELECT avatar FROM users WHERE username = $1', [req.params.username]);
  if (user.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
  res.json({ avatar: user.rows[0].avatar });
});

// Реакции
app.get('/api/messages/:messageId/reactions', async (req, res) => {
  const reactions = await pool.query('SELECT username, emoji FROM reactions WHERE message_id = $1', [req.params.messageId]);
  res.json(reactions.rows);
});

app.post('/api/messages/:messageId/react', async (req, res) => {
  const { username, emoji } = req.body;
  const { messageId } = req.params;
  if (!username || !emoji) return res.status(400).json({ error: 'Missing fields' });
  try {
    const existing = await pool.query('SELECT id FROM reactions WHERE message_id = $1 AND username = $2', [messageId, username]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM reactions WHERE message_id = $1 AND username = $2', [messageId, username]);
      res.json({ action: 'removed' });
    } else {
      await pool.query('INSERT INTO reactions (message_id, username, emoji) VALUES ($1, $2, $3)', [messageId, username, emoji]);
      res.json({ action: 'added' });
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Участники публичного чата
app.get('/api/rooms/participants/public', (req, res) => {
  const users = activeUsers.get('public');
  res.json(users ? Array.from(users) : []);
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('🔗', socket.id);

  socket.on('joinRoom', async ({ roomId, username }) => {
    if (roomId !== 'public') { socket.emit('roomError', { message: 'Комната не существует' }); return; }
    socket.join('public');
    socket.data.roomId = 'public';
    socket.data.username = username;
    if (!activeUsers.has('public')) activeUsers.set('public', new Set());
    activeUsers.get('public').add(username);
    const messages = await pool.query(
      `SELECT m.id, m.sender, m.text, m.timestamp, u.avatar FROM messages m LEFT JOIN users u ON m.username = u.username WHERE m.room_id = 'public' ORDER BY m.timestamp ASC`
    );
    socket.emit('roomJoined', { roomId: 'public', messages: messages.rows, userCount: activeUsers.get('public').size });
    io.to('public').emit('userCount', { count: activeUsers.get('public').size });
  });

  socket.on('sendMessage', async ({ roomId, sender, text }) => {
    if (roomId !== 'public' || !sender) return;
    const user = await pool.query('SELECT avatar FROM users WHERE username = $1', [sender]);
    const avatar = user.rows[0]?.avatar || null;
    const result = await pool.query('INSERT INTO messages (room_id, username, sender, avatar, text) VALUES ($1, $2, $3, $4, $5) RETURNING id', ['public', sender, sender, avatar, text]);
    const msg = { id: result.rows[0].id, roomId: 'public', sender, avatar, text, timestamp: new Date().toISOString() };
    io.to('public').emit('newMessage', msg);
  });

  socket.on('leaveRoom', ({ roomId }) => {
    if (roomId === 'public' && socket.data.username) {
      const users = activeUsers.get('public');
      if (users) { users.delete(socket.data.username); if (users.size === 0) activeUsers.delete('public'); else io.to('public').emit('userCount', { count: users.size }); }
      socket.leave('public');
    }
  });

  socket.on('disconnect', () => {
    const { roomId, username } = socket.data;
    if (roomId === 'public' && username) {
      const users = activeUsers.get('public');
      if (users) { users.delete(username); if (users.size === 0) activeUsers.delete('public'); else io.to('public').emit('userCount', { count: users.size }); }
    }
  });
});

app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Порт ${PORT}`));
