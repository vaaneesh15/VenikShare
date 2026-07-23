const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_TOKEN = 'vaaneesh-secret-token-2024';

app.use(express.json());
app.use(express.static(__dirname));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      description TEXT NOT NULL,
      age INTEGER NOT NULL,
      gender TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Актуально',
      created_at TEXT NOT NULL,
      reason TEXT,
      review_request_reason TEXT
    );
  `);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS review_request_reason TEXT;`).catch(() => {});
}
initDB().catch(console.error);

const STATUS_ORDER = [
  'Актуально',
  'Отклонено',
  'Принято',
  'Принята после пересмотра',
  'Отклонена после пересмотра',
  'Запрошен пересмотр после отказа',
  'Повторно отклонена',
  'Отозвано',
  'Отозвано после отказа',
  'Ожидание ответа от Администрации'
];

function getMoscowTime() {
  const now = new Date();
  const mskOffset = 3 * 60 * 60 * 1000;
  const msk = new Date(now.getTime() + mskOffset);
  const hh = String(msk.getUTCHours()).padStart(2, '0');
  const mm = String(msk.getUTCMinutes()).padStart(2, '0');
  const dd = String(msk.getUTCDate()).padStart(2, '0');
  const MM = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = msk.getUTCFullYear();
  return `${hh}:${mm} (МСК), ${dd}.${MM}.${yyyy}`;
}

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
      description: row.description,
      reason: row.reason,
      reviewRequestReason: row.review_request_reason
    }));

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
      if (isAdmin) {
        base.description = app.description;
        base.reason = app.reason;
        base.reviewRequestReason = app.reviewRequestReason;
      }
      return base;
    });

    res.json(sanitized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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
      createdAt: app.created_at,
      reason: app.reason,
      reviewRequestReason: app.review_request_reason
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/applications', async (req, res) => {
  const { nickname, description, age, gender, rulesConfirmed } = req.body;
  if (!nickname || !description || !age || !gender || rulesConfirmed === undefined) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }
  if (description.length < 20 || description.length > 350) {
    return res.status(400).json({ error: 'Описание должно быть от 20 до 350 символов' });
  }
  const ageNum = parseInt(age, 10);
  if (isNaN(ageNum) || ageNum < 1 || ageNum > 99) {
    return res.status(400).json({ error: 'Возраст должен быть от 1 до 99' });
  }

  const status = rulesConfirmed ? 'Актуально' : 'Ожидание ответа от Администрации';
  const formattedDate = getMoscowTime();
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO applications (id, nickname, description, age, gender, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, nickname, description, ageNum, gender, status, formattedDate]
    );
    res.status(201).json({ id, nickname, description, age: ageNum, gender, status, createdAt: formattedDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка при создании анкеты' });
  }
});

app.patch('/api/applications/:id/withdraw', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    const app = result.rows[0];
    const disallow = ['Принято', 'Принята после пересмотра', 'Ожидание ответа от Администрации', 'Повторно отклонена'];
    if (disallow.includes(app.status)) {
      return res.status(400).json({ error: 'Нельзя отозвать эту анкету' });
    }
    let newStatus = 'Отозвано';
    if (app.status === 'Отклонено' || app.status === 'Отклонена после пересмотра') {
      newStatus = 'Отозвано после отказа';
    }
    await pool.query('UPDATE applications SET status = $1 WHERE id = $2', [newStatus, req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at,
      reason: updated.reason,
      reviewRequestReason: updated.review_request_reason
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Запрос пересмотра от пользователя
app.post('/api/applications/:id/request-review', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    const app = result.rows[0];
    if (app.status !== 'Отклонено') {
      return res.status(400).json({ error: 'Пересмотр можно запросить только для отклонённой анкеты' });
    }
    const { reason: requestReason } = req.body;
    await pool.query('UPDATE applications SET status = $1, review_request_reason = $2 WHERE id = $3',
      ['Запрошен пересмотр после отказа', requestReason || null, req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at,
      reason: updated.reason,
      reviewRequestReason: updated.review_request_reason
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

// Пересмотр админом
app.post('/api/applications/:id/review', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    const app = result.rows[0];
    const { decision, reason: reviewReason } = req.body; // decision = 'accept' или 'reject'
    let newStatus;
    if (app.status === 'Принято' || app.status === 'Принята после пересмотра') {
      if (decision === 'reject') newStatus = 'Отклонена после пересмотра';
      else return res.status(400).json({ error: 'Некорректное решение' });
    } else if (app.status === 'Отклонено' || app.status === 'Отклонена после пересмотра' || app.status === 'Запрошен пересмотр после отказа' || app.status === 'Повторно отклонена') {
      if (decision === 'accept') newStatus = 'Принята после пересмотра';
      else if (decision === 'reject') {
        if (app.status === 'Запрошен пересмотр после отказа') newStatus = 'Повторно отклонена';
        else newStatus = 'Отклонена после пересмотра';
      } else {
        return res.status(400).json({ error: 'Некорректное решение' });
      }
    } else {
      return res.status(400).json({ error: 'Эту анкету нельзя пересмотреть' });
    }

    await pool.query('UPDATE applications SET status = $1, reason = $2, review_request_reason = NULL WHERE id = $3',
      [newStatus, reviewReason || null, req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at,
      reason: updated.reason,
      reviewRequestReason: updated.review_request_reason
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/applications/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM applications WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.patch('/api/applications/:id/accept', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    await pool.query('UPDATE applications SET status = $1, reason = NULL, review_request_reason = NULL WHERE id = $2',
      ['Принято', req.params.id]);
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at,
      reason: updated.reason,
      reviewRequestReason: updated.review_request_reason
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.patch('/api/applications/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Анкета не найдена' });
    const app = result.rows[0];
    // Если админ отклоняет запрос пересмотра
    if (app.status === 'Запрошен пересмотр после отказа') {
      await pool.query('UPDATE applications SET status = $1, reason = $2 WHERE id = $3',
        ['Повторно отклонена', reason || null, req.params.id]);
    } else {
      await pool.query('UPDATE applications SET status = $1, reason = $2 WHERE id = $3',
        ['Отклонено', reason || null, req.params.id]);
    }
    const updated = (await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id])).rows[0];
    res.json({
      id: updated.id,
      nickname: updated.nickname,
      description: updated.description,
      age: updated.age,
      gender: updated.gender,
      status: updated.status,
      createdAt: updated.created_at,
      reason: updated.reason,
      reviewRequestReason: updated.review_request_reason
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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