# Agenda WFlow — Chat de Agendamento

Chat público de agendamento de reuniões com banco de dados SQLite persistente.

---

## Stack

- **Node.js** + Express (servidor)
- **SQLite** via `better-sqlite3` (banco de dados)
- **HTML/CSS/JS** puro no frontend

---

## Como subir no Railway (passo a passo)

### 1. Crie uma conta em railway.app

### 2. Instale o Railway CLI (opcional, mas mais rápido)
```bash
npm install -g @railway/cli
railway login
```

### 3. Suba o projeto via GitHub (recomendado)
1. Crie um repositório no GitHub e faça push desta pasta
2. No Railway, clique em **New Project → Deploy from GitHub repo**
3. Selecione o repositório
4. Railway detecta automaticamente o Node.js e faz o deploy

### 4. Configure o Volume (IMPORTANTE para persistência)
No painel do Railway:
1. Vá em **Settings → Volumes**
2. Crie um volume com mount path: `/app/data`
3. Defina a variável de ambiente: `DB_PATH=/app/data/agenda.db`

Sem isso, o banco reseta a cada novo deploy.

### 5. Acesse o link público
Railway gera automaticamente um domínio no formato:
`https://agenda-wflow-production.up.railway.app`

---

## Variáveis de ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `PORT` | Porta do servidor | `3000` |
| `DB_PATH` | Caminho do banco SQLite | `./data/agenda.db` |

---

## API endpoints

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/slots?date=YYYY-MM-DD` | Horários disponíveis de um dia |
| GET | `/api/slots/week?date=YYYY-MM-DD` | Disponibilidade da semana |
| POST | `/api/check` | Verifica disponibilidade sem agendar |
| POST | `/api/agendamentos` | Cria agendamento |
| GET | `/api/agendamentos` | Lista todos os agendamentos |
| DELETE | `/api/agendamentos/:id` | Cancela um agendamento |

---

## Rodar localmente

```bash
npm install
npm start
# Acesse: http://localhost:3000
```
