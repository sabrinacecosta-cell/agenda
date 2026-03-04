const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── DATABASE SETUP ───────────────────────────────────────────────
// Railway persiste o filesystem em /data se configurado,
// mas para simplicidade usamos o diretório do projeto.
// Em Railway: configure um volume em /data para persistência real.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'agenda.db');

// garante que o diretório existe
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Cria tabela se não existir
db.exec(`
  CREATE TABLE IF NOT EXISTS agendamentos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    data        TEXT    NOT NULL,        -- formato YYYY-MM-DD
    hora_inicio REAL    NOT NULL,        -- ex: 14.0 = 14h, 14.5 = 14h30
    hora_fim    REAL    NOT NULL,
    titulo      TEXT    NOT NULL,
    duracao     REAL    NOT NULL,        -- 0.5 ou 1.0
    emails      TEXT    NOT NULL,        -- JSON array
    criado_em   TEXT    DEFAULT (datetime('now','localtime'))
  )
`);

// ─── MIDDLEWARE ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── CONFIG ───────────────────────────────────────────────────────
const CONFIG = {
  workStart:  9,
  workEnd:    18,
  lunchStart: 12,
  lunchEnd:   14,
};

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
}

function getWeekRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  const days = [];
  for (let i = 0; i < 5; i++) {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    const iso = dd.toISOString().split('T')[0];
    days.push(iso);
  }
  return days;
}

function getAvailableSlots(dateStr, bookedRows) {
  if (isWeekend(dateStr)) return [];
  const slots = [];
  const ranges = [
    [CONFIG.workStart, CONFIG.lunchStart],
    [CONFIG.lunchEnd,  CONFIG.workEnd],
  ];
  for (const [from, to] of ranges) {
    for (let h = from; h < to; h += 0.5) {
      const end = h + 0.5;
      const conflict = bookedRows.some(b =>
        b.data === dateStr && h < b.hora_fim && end > b.hora_inicio
      );
      if (!conflict) slots.push(h);
    }
  }
  return slots;
}

// ─── ROUTES ───────────────────────────────────────────────────────

// GET /api/slots?date=2026-03-10
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Parâmetro date inválido. Use YYYY-MM-DD.' });
  }
  if (isWeekend(date)) {
    return res.json({ date, slots: [], message: 'Fim de semana — sem agendamentos.' });
  }
  const booked = db.prepare('SELECT data, hora_inicio, hora_fim FROM agendamentos WHERE data = ?').all(date);
  const slots = getAvailableSlots(date, booked);
  res.json({ date, slots });
});

// GET /api/slots/week?date=2026-03-03
app.get('/api/slots/week', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Parâmetro date inválido. Use YYYY-MM-DD.' });
  }
  const days = getWeekRange(date);
  const booked = db.prepare(
    `SELECT data, hora_inicio, hora_fim FROM agendamentos WHERE data IN (${days.map(() => '?').join(',')})`
  ).all(...days);

  const result = days.map(d => ({
    date: d,
    slots: getAvailableSlots(d, booked),
  }));
  res.json({ week: result });
});

// POST /api/check — verifica disponibilidade sem agendar
app.post('/api/check', (req, res) => {
  const { date, hora_inicio, duracao } = req.body;
  if (!date || hora_inicio == null || !duracao) {
    return res.status(400).json({ error: 'Campos obrigatórios: date, hora_inicio, duracao.' });
  }
  const hora_fim = hora_inicio + duracao;

  if (isWeekend(date)) return res.json({ disponivel: false, motivo: 'fim_de_semana' });
  if (hora_inicio < CONFIG.workStart || hora_fim > CONFIG.workEnd)
    return res.json({ disponivel: false, motivo: 'fora_do_horario' });
  if (hora_inicio < CONFIG.lunchEnd && hora_fim > CONFIG.lunchStart)
    return res.json({ disponivel: false, motivo: 'horario_almoco' });

  const conflict = db.prepare(
    'SELECT id FROM agendamentos WHERE data = ? AND hora_inicio < ? AND hora_fim > ?'
  ).get(date, hora_fim, hora_inicio);

  res.json({ disponivel: !conflict, motivo: conflict ? 'conflito' : null });
});

// POST /api/agendamentos — cria agendamento
app.post('/api/agendamentos', (req, res) => {
  const { date, hora_inicio, duracao, titulo, emails } = req.body;
  if (!date || hora_inicio == null || !duracao || !titulo || !emails) {
    return res.status(400).json({ error: 'Campos obrigatórios: date, hora_inicio, duracao, titulo, emails.' });
  }
  const hora_fim = hora_inicio + duracao;

  // double-check conflito
  if (isWeekend(date)) return res.status(409).json({ error: 'Fim de semana indisponível.' });
  if (hora_inicio < CONFIG.workStart || hora_fim > CONFIG.workEnd)
    return res.status(409).json({ error: 'Horário fora do período permitido.' });
  if (hora_inicio < CONFIG.lunchEnd && hora_fim > CONFIG.lunchStart)
    return res.status(409).json({ error: 'Horário de almoço indisponível.' });

  const conflict = db.prepare(
    'SELECT id FROM agendamentos WHERE data = ? AND hora_inicio < ? AND hora_fim > ?'
  ).get(date, hora_fim, hora_inicio);
  if (conflict) return res.status(409).json({ error: 'Conflito de horário.' });

  const stmt = db.prepare(
    'INSERT INTO agendamentos (data, hora_inicio, hora_fim, titulo, duracao, emails) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const info = stmt.run(date, hora_inicio, hora_fim, titulo, duracao, JSON.stringify(emails));
  res.status(201).json({ id: info.lastInsertRowid, date, hora_inicio, hora_fim, titulo, emails });
});

// GET /api/agendamentos — lista todos (uso interno/admin)
app.get('/api/agendamentos', (req, res) => {
  const rows = db.prepare('SELECT * FROM agendamentos ORDER BY data, hora_inicio').all();
  res.json(rows.map(r => ({ ...r, emails: JSON.parse(r.emails) })));
});

// DELETE /api/agendamentos/:id — cancela agendamento
app.delete('/api/agendamentos/:id', (req, res) => {
  const { id } = req.params;
  const info = db.prepare('DELETE FROM agendamentos WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  res.json({ deleted: true, id });
});

// Fallback → serve o chat
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Agenda WFlow rodando na porta ${PORT}`);
  console.log(`📁 Banco de dados: ${DB_PATH}`);
});
