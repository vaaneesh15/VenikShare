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
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(100) NOT NULL,
      avatar_emoji VARCHAR(10) DEFAULT '',
      avatar_color VARCHAR(7) DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id VARCHAR(50) NOT NULL DEFAULT 'public',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sender VARCHAR(50) NOT NULL,
      avatar_emoji VARCHAR(10) DEFAULT '',
      avatar_color VARCHAR(7) DEFAULT '',
      text TEXT NOT NULL,
      timestamp TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
    console.log('✅ БД готова');
  } catch (err) { console.error('❌ Ошибка БД:', err); }
}
initDB();

const activeUsers = new Map();
activeUsers.set('public', new Set());

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
    const user = await pool.query(
      'SELECT username, avatar_emoji, avatar_color FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (user.rows.length === 0) return res.status(401).json({ error: 'Неверное имя или пароль' });
    res.json({
      success: true,
      username: user.rows[0].username,
      avatar_emoji: user.rows[0].avatar_emoji,
      avatar_color: user.rows[0].avatar_color
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/update-avatar', async (req, res) => {
  const { username, emoji, color } = req.body;
  if (!username || !emoji || !color) return res.status(400).json({ error: 'Не все поля' });
  try {
    await pool.query('UPDATE users SET avatar_emoji = $1, avatar_color = $2 WHERE username = $3', [emoji, color, username]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/avatar/:username', async (req, res) => {
  const user = await pool.query('SELECT avatar_emoji, avatar_color FROM users WHERE username = $1', [req.params.username]);
  if (user.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
  res.json({ emoji: user.rows[0].avatar_emoji, color: user.rows[0].avatar_color });
});

app.get('/api/rooms/participants/public', (req, res) => {
  const users = activeUsers.get('public');
  res.json(users ? Array.from(users) : []);
});

io.on('connection', (socket) => {
  console.log('🔗', socket.id);
  socket.on('joinRoom', async ({ roomId, username }) => {
    if (roomId !== 'public') return socket.emit('roomError', { message: 'Нет такой комнаты' });
    socket.join('public');
    socket.data.roomId = 'public';
    socket.data.username = username;
    activeUsers.get('public').add(username);
    const messages = await pool.query(
      `SELECT m.id, u.username AS sender, m.text, m.timestamp, m.avatar_emoji, m.avatar_color 
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
    const user = await pool.query('SELECT id, avatar_emoji, avatar_color FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return;
    const userId = user.rows[0].id;
    const emoji = user.rows[0].avatar_emoji || '';
    const color = user.rows[0].avatar_color || '';
    await pool.query(
      'INSERT INTO messages (room_id, user_id, sender, avatar_emoji, avatar_color, text) VALUES ($1, $2, $3, $4, $5, $6)',
      ['public', userId, username, emoji, color, text]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM messages WHERE room_id = $1', ['public']);
    const count = parseInt(countRows[0].count);
    if (count > 40) {
      await pool.query(
        'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE room_id = $1 ORDER BY timestamp ASC LIMIT $2)',
        ['public', count - 40]
      );
    }
    const msg = {
      roomId: 'public',
      sender: username,
      avatar_emoji: emoji,
      avatar_color: color,
      text,
      timestamp: new Date().toISOString()
    };
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
