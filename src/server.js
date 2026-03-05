const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 8080;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'agenda.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS agendamentos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    data            TEXT    NOT NULL,
    hora_inicio     REAL    NOT NULL,
    hora_fim        REAL    NOT NULL,
    titulo          TEXT    NOT NULL,
    duracao         REAL    NOT NULL,
    emails          TEXT    NOT NULL,
    google_event_id TEXT,
    criado_em       TEXT    DEFAULT (datetime('now','localtime'))
  )
`);

const CALENDAR_ID  = process.env.GOOGLE_CALENDAR_ID || 'sabrina@jtdkinvest.com';
const SENDER_EMAIL = process.env.SENDER_EMAIL       || 'sabrina@jtdkinvest.com';
const TIMEZONE     = 'America/Sao_Paulo';

function getGoogleAuth() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  }
  const keyPath = path.join(__dirname, '..', 'credentials.json');
  if (fs.existsSync(keyPath)) {
    return new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  }
  return null;
}

function toRFC3339(dateStr, hour) {
  const hh = String(Math.floor(hour)).padStart(2, '0');
  const mm = (hour % 1) === 0.5 ? '30' : '00';
  return `${dateStr}T${hh}:${mm}:00`;
}

async function getBusyFromGoogleCalendar(dateStart, dateEnd) {
  const auth = getGoogleAuth();
  if (!auth) return [];
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const calList = await calendar.calendarList.list();
    const calendarIds = calList.data.items.map(c => ({ id: c.id }));
    const freebusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: `${dateStart}T00:00:00-03:00`,
        timeMax: `${dateEnd}T23:59:59-03:00`,
        timeZone: TIMEZONE,
        items: calendarIds,
      },
    });
    const busy = [];
    const calendars = freebusyRes.data.calendars;
    for (const calId of Object.keys(calendars)) {
      const periods = calendars[calId].busy || [];
      for (const period of periods) {
        const start = new Date(period.start);
        const end   = new Date(period.end);
        const dateStr = start.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
        const startH  = start.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
        const endH    = end.toLocaleTimeString('pt-BR',   { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
        const toDecimal = t => { const [h, m] = t.split(':').map(Number); return h + m / 60; };
        busy.push({ data: dateStr, hora_inicio: toDecimal(startH), hora_fim: toDecimal(endH) });
      }
    }
    return busy;
  } catch (err) {
    console.error('Erro ao buscar freebusy:', err.message);
    return [];
  }
}

async function createGoogleCalendarEvent({ date, hora_inicio, hora_fim, titulo, emails }) {
  const auth = getGoogleAuth();
  if (!auth) { console.warn('Google Calendar nao configurado.'); return null; }
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const event = {
      summary: titulo,
      start:   { dateTime: toRFC3339(date, hora_inicio), timeZone: TIMEZONE },
      end:     { dateTime: toRFC3339(date, hora_fim),    timeZone: TIMEZONE },
      attendees: emails.map(email => ({ email })),
      organizer: { email: SENDER_EMAIL },
      sendUpdates: 'all',
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
    };
    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
      sendNotifications: true,
    });
    console.log('Evento criado:', res.data.id);
    return res.data.id;
  } catch (err) {
    console.error('Erro ao criar evento:', err.message);
    return null;
  }
}

async function deleteGoogleCalendarEvent(eventId) {
  const auth = getGoogleAuth();
  if (!auth || !eventId) return;
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    console.log('Evento removido:', eventId);
  } catch (err) {
    console.error('Erro ao remover evento:', err.message);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const CONFIG = { workStart: 9, workEnd: 18, lunchStart: 12, lunchEnd: 14 };

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return [0, 6].includes(new Date(y, m - 1, d).getDay());
}

function getWeekRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return Array.from({ length: 5 }, (_, i) => {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    return dd.toISOString().split('T')[0];
  });
}

function getAvailableSlots(dateStr, busyPeriods) {
  if (isWeekend(dateStr)) return [];
  const slots = [];
  for (const [from, to] of [[CONFIG.workStart, CONFIG.lunchStart], [CONFIG.lunchEnd, CONFIG.workEnd]]) {
    for (let h = from; h < to; h += 0.5) {
      const end = h + 0.5;
      if (!busyPeriods.some(b => b.data === dateStr && h < b.hora_fim && end > b.hora_inicio))
        slots.push(h);
    }
  }
  return slots;
}

app.get('/api/slots', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Parametro date invalido.' });
  if (isWeekend(date))
    return res.json({ date, slots: [], message: 'Fim de semana.' });
  const busy = await getBusyFromGoogleCalendar(date, date);
  res.json({ date, slots: getAvailableSlots(date, busy) });
});

app.get('/api/slots/week', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Parametro date invalido.' });
  const days = getWeekRange(date);
  const busy = await getBusyFromGoogleCalendar(days[0], days[4]);
  res.json({ week: days.map(d => ({ date: d, slots: getAvailableSlots(d, busy) })) });
});

app.post('/api/check', async (req, res) => {
  const { date, hora_inicio, duracao } = req.body;
  if (!date || hora_inicio == null || !duracao)
    return res.status(400).json({ error: 'Campos obrigatorios: date, hora_inicio, duracao.' });
  const hora_fim = hora_inicio + duracao;
  if (isWeekend(date))                                                return res.json({ disponivel: false, motivo: 'fim_de_semana' });
  if (hora_inicio < CONFIG.workStart || hora_fim > CONFIG.workEnd)   return res.json({ disponivel: false, motivo: 'fora_do_horario' });
  if (hora_inicio < CONFIG.lunchEnd && hora_fim > CONFIG.lunchStart) return res.json({ disponivel: false, motivo: 'horario_almoco' });
  const busy = await getBusyFromGoogleCalendar(date, date);
  const conflict = busy.some(b => b.data === date && hora_inicio < b.hora_fim && hora_fim > b.hora_inicio);
  res.json({ disponivel: !conflict, motivo: conflict ? 'conflito' : null });
});

app.post('/api/agendamentos', async (req, res) => {
  const { date, hora_inicio, duracao, titulo, emails } = req.body;
  if (!date || hora_inicio == null || !duracao || !titulo || !emails)
    return res.status(400).json({ error: 'Campos obrigatorios.' });
  const hora_fim = hora_inicio + duracao;
  if (isWeekend(date))                                                return res.status(409).json({ error: 'Fim de semana indisponivel.' });
  if (hora_inicio < CONFIG.workStart || hora_fim > CONFIG.workEnd)   return res.status(409).json({ error: 'Horario fora do periodo.' });
  if (hora_inicio < CONFIG.lunchEnd && hora_fim > CONFIG.lunchStart) return res.status(409).json({ error: 'Horario de almoco.' });
  const busy = await getBusyFromGoogleCalendar(date, date);
  const conflict = busy.some(b => b.data === date && hora_inicio < b.hora_fim && hora_fim > b.hora_inicio);
  if (conflict) return res.status(409).json({ error: 'Conflito de horario.' });
  const info = db.prepare(
    'INSERT INTO agendamentos (data, hora_inicio, hora_fim, titulo, duracao, emails) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, hora_inicio, hora_fim, titulo, duracao, JSON.stringify(emails));
  const eventId = await createGoogleCalendarEvent({ date, hora_inicio, hora_fim, titulo, emails });
  if (eventId) db.prepare('UPDATE agendamentos SET google_event_id = ? WHERE id = ?').run(eventId, info.lastInsertRowid);
  res.status(201).json({ id: info.lastInsertRowid, date, hora_inicio, hora_fim, titulo, emails, google_event_id: eventId });
});

app.get('/api/agendamentos', (req, res) => {
  const rows = db.prepare('SELECT * FROM agendamentos ORDER BY data, hora_inicio').all();
  res.json(rows.map(r => ({ ...r, emails: JSON.parse(r.emails) })));
});

app.delete('/api/agendamentos/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Agendamento nao encontrado.' });
  db.prepare('DELETE FROM agendamentos WHERE id = ?').run(req.params.id);
  if (row.google_event_id) await deleteGoogleCalendarEvent(row.google_event_id);
  res.json({ deleted: true, id: req.params.id });
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Agenda WFlow na porta ${PORT}`);
  console.log(`Banco: ${DB_PATH}`);
  console.log(`Google Calendar: ${CALENDAR_ID}`);
});