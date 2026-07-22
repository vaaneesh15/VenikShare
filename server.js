const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'applications.json');
const ADMIN_TOKEN = 'vaaneesh-secret-token-2024';

app.use(express.json());
app.use(express.static(path.join(__dirname)));

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]');
}

function readApplications() {
  const raw = fs.readFileSync(DATA_FILE);
  return JSON.parse(raw);
}

function writeApplications(apps) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(apps, null, 2));
}

const STATUS_ORDER = ['Актуально', 'Отклонено', 'Принято', 'Отозвано'];
function sortApplications(apps) {
  return apps.sort((a, b) => {
    const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

app.get('/api/applications', (req, res) => {
  const apps = readApplications();
  const sorted = sortApplications(apps);
  const sanitized = sorted.map(({ id, nickname, gender, age, status, createdAt }) => ({
    id,
    nickname,
    gender,
    age,
    status,
    createdAt
  }));
  res.json(sanitized);
});

app.get('/api/applications/:id', (req, res) => {
  const apps = readApplications();
  const app = apps.find(a => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'Анкета не найдена' });
  res.json(app);
});

app.post('/api/applications', (req, res) => {
  const { nickname, description, age, gender } = req.body;
  if (!nickname || !description || !age || !gender) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }
  if (description.length < 20 || description.length > 350) {
    return res.status(400).json({ error: 'Описание должно быть от 20 до 350 символов' });
  }
  const now = new Date();
  const formattedDate = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}, ${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth()+1).padStart(2, '0')}.${now.getFullYear()}`;
  const newApp = {
    id: uuidv4(),
    nickname,
    description,
    age,
    gender,
    status: 'Актуально',
    createdAt: formattedDate
  };
  const apps = readApplications();
  apps.push(newApp);
  writeApplications(apps);
  res.status(201).json(newApp);
});

app.patch('/api/applications/:id/withdraw', (req, res) => {
  const apps = readApplications();
  const index = apps.findIndex(a => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Анкета не найдена' });
  if (apps[index].status === 'Принято') {
    return res.status(400).json({ error: 'Нельзя отозвать уже принятую анкету' });
  }
  apps[index].status = 'Отозвано';
  writeApplications(apps);
  res.json(apps[index]);
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

app.patch('/api/applications/:id/accept', requireAdmin, (req, res) => {
  const apps = readApplications();
  const index = apps.findIndex(a => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Анкета не найдена' });
  apps[index].status = 'Принято';
  writeApplications(apps);
  res.json(apps[index]);
});

app.patch('/api/applications/:id/reject', requireAdmin, (req, res) => {
  const apps = readApplications();
  const index = apps.findIndex(a => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Анкета не найдена' });
  apps[index].status = 'Отклонено';
  writeApplications(apps);
  res.json(apps[index]);
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
  console.log(`Server running on port ${PORT}`);
});