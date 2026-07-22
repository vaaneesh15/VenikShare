const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к PostgreSQL (Render автоматически задаёт DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_TOKEN = 'vaaneesh-secret-token-2024';

app.use(express.json());
app.use(express.static(__dirname));

// Инициализация таблицы
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      description TEXT NOT NULL,
      age INTEGER NOT NULL,
      gender TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Актуально',
      created_at TEXT NOT NULL
    );
  `);
}
initDB().catch(console.error);

const STATUS_ORDER = ['Актуально', 'Отклонено', 'Принято', 'Отозвано'];

// Получить все анкеты
app.get('/api/applications', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications');
    let apps = result.rows.map(row => ({
      id: row.id,
      nickname: row.nickname,
      gender: row.gender,
      age: row.age,
      status: row.status,
      createdAt: row.created_at,
      description: row.description
    }));

    // Сортировка
    apps.sort((a, b) => {
      const diff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      if (diff !== 0) return diff;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const isAdmin = req.headers['x-admin-token'] === ADMIN_TOKEN;
    const sanitized = apps.map(app => {
      const base = {
        id: app.id,
        nickname: app.nickname,
        gender: app.gender,
        age: app.age,
        status: app.status,
        createdAt: app.createdAt
      };
      if (isAdmin) base.description = app.description;
      return base;
    });

    res.json(sanitized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить конкретную анкету
app.get('/api/applications/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    const app = result.rows[0];
    res.json({
      id: app.id,
      nickname: app.nickname,
      description: app.description,
      age: app.age,
      gender: app.gender,
      status: app.status,
      createdAt: app.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать анкету
app.post('/api/applications', async (req, res) => {
  const { nickname, description, age, gender } = req.body;
  if (!nickname || !description || !age || !gender) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }
  if (description.length < 20 || description.length > 350) {
    return res.status(400).json({ error: 'Описание должно быть от 20 до 350 символов' });
  }
  const now = new Date();
  const formattedDate = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}, ${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth()+1).padStart(2, '0')}.${now.getFullYear()}`;
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO applications (id, nickname, description, age, gender, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, nickname, description, age, gender, 'Актуально', formattedDate]
    );
    res.status(201).json({ id, nickname, description, age, gender, status: 'Актуально', createdAt: formattedDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка при создании анкеты' });
  }
});

// Отозвать анкету
app.patch('/api/applications/:id/withdraw', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    if (result.rows[0].status === 'Принято') {
      return res.status(400).json({ error: 'Нельзя отозвать уже принятую анкету' });
    }
    await pool.query('UPDATE applications SET status = $1 WHERE id = $2', ['Отозвано', req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Middleware админа
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

// Принять
app.patch('/api/applications/:id/accept', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    await pool.query('UPDATE applications SET status = $1 WHERE id = $2', ['Принято', req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отклонить
app.patch('/api/applications/:id/reject', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    await pool.query('UPDATE applications SET status = $1 WHERE id = $2', ['Отклонено', req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход администратора
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'vaaneesh' && password === 'Serafima1410!!') {
    res.json({ token: ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: 'Неверные данные' });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});