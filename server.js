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
    // Полностью удаляем все таблицы, чтобы точно не осталось старой схемы
    await pool.query(`DROP TABLE IF EXISTS users CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS messages CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS reactions CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS room_participants CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS rooms CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS user_settings CASCADE`);

    // Создаём таблицу пользователей с id
    await pool.query(`CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(100) NOT NULL,
      avatar TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);

    // Создаём таблицу сообщений, связь через user_id
    await pool.query(`CREATE TABLE messages (
      id SERIAL PRIMARY KEY,
      room_id VARCHAR(50) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sender VARCHAR(50) NOT NULL,
      avatar TEXT,
      text TEXT NOT NULL,
      timestamp TIMESTAMP NOT NULL DEFAULT NOW()
    )`);

    console.log('✅ База данных полностью пересоздана');
  } catch (err) { console.error('❌ Ошибка инициализации БД:', err); }
}
initDB();

const activeUsers = new Map();
activeUsers.set('public', new Set());

// ----- API аккаунтов -----
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const exist = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exist.rows.length > 0) return res.status(409).json({ error: 'Пользователь уже существует' });
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
  try {
    const user = await pool.query('SELECT id, username, password, avatar FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== password) return res.status(401).json({ error: 'Неверное имя или пароль' });
    res.json({ success: true, id: user.rows[0].id, username: user.rows[0].username, avatar: user.rows[0].avatar });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/change-password', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  if (!username || !oldPassword || !newPassword) return res.status(400).json({ error: 'Не все поля' });
  try {
    const user = await pool.query('SELECT id, password FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== oldPassword) return res.status(401).json({ error: 'Неверный старый пароль' });
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [newPassword, user.rows[0].id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/change-username', async (req, res) => {
  const { userId, password, newUsername } = req.body;
  if (!userId || !password || !newUsername) return res.status(400).json({ error: 'Не все поля' });
  try {
    const user = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.rows[0].password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    const exist = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [newUsername, userId]);
    if (exist.rows.length > 0) return res.status(409).json({ error: 'Это имя уже занято' });
    await pool.query('UPDATE users SET username = $1 WHERE id = $2', [newUsername, userId]);
    res.json({ success: true, newUsername });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/delete-account', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Не все поля' });
  try {
    const user = await pool.query('SELECT id, password FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0 || user.rows[0].password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    await pool.query('DELETE FROM users WHERE id = $1', [user.rows[0].id]);
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

// Участники паблика
app.get('/api/rooms/participants/public', (req, res) => {
  const users = activeUsers.get('public');
  res.json(users ? Array.from(users) : []);
});

// ----- Сокеты -----
io.on('connection', (socket) => {
  console.log('🔗', socket.id);
  socket.on('joinRoom', async ({ roomId, username }) => {
    if (roomId !== 'public') return socket.emit('roomError', { message: 'Нет такой комнаты' });
    socket.join('public');
    socket.data.roomId = 'public';
    socket.data.username = username;
    activeUsers.get('public').add(username);
    const messages = await pool.query(
      `SELECT m.id, u.username AS sender, m.text, m.timestamp, u.avatar 
       FROM messages m 
       JOIN users u ON m.user_id = u.id 
       WHERE m.room_id = 'public' 
       ORDER BY m.timestamp ASC`
    );
    socket.emit('roomJoined', { roomId: 'public', messages: messages.rows, userCount: activeUsers.get('public').size });
    io.to('public').emit('userCount', { count: activeUsers.get('public').size });
  });

  socket.on('sendMessage', async ({ roomId, username, text }) => {
    if (roomId !== 'public' || !username) return;
    const user = await pool.query('SELECT id, avatar FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return;
    const userId = user.rows[0].id;
    const avatar = user.rows[0].avatar || null;
    const result = await pool.query(
      'INSERT INTO messages (room_id, user_id, sender, avatar, text) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      ['public', userId, username, avatar, text]
    );
    const msg = { id: result.rows[0].id, roomId: 'public', sender: username, avatar, text, timestamp: new Date().toISOString() };
    io.to('public').emit('newMessage', msg);
  });

  socket.on('leaveRoom', ({ roomId }) => {
    if (roomId === 'public' && socket.data.username) {
      activeUsers.get('public').delete(socket.data.username);
      io.to('public').emit('userCount', { count: activeUsers.get('public').size });
      socket.leave('public');
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId === 'public' && socket.data.username) {
      activeUsers.get('public').delete(socket.data.username);
      io.to('public').emit('userCount', { count: activeUsers.get('public').size });
    }
  });
});

app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Порт ${PORT}`));
