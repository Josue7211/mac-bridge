import express from 'express'
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)
const app = express()
app.use(express.json())

const PORT = process.env.BRIDGE_PORT || 4100
const API_KEY = process.env.BRIDGE_API_KEY || ''

// ── Auth middleware ─────────────────────────────────────────────────

if (API_KEY) {
  app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.api_key
    if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
    next()
  })
}

// ── Health check ────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, services: ['reminders'] })
})

// ── Reminders ───────────────────────────────────────────────────────

async function remindctl(...args) {
  try {
    const { stdout } = await exec('remindctl', [...args, '--json'], { timeout: 10000 })
    return JSON.parse(stdout)
  } catch (err) {
    throw new Error(err.stderr || err.message)
  }
}

// List reminders (all, today, tomorrow, week, overdue, or specific date)
app.get('/reminders', async (req, res) => {
  try {
    const filter = req.query.filter || 'all' // all, today, tomorrow, week, overdue, YYYY-MM-DD
    const data = await remindctl(filter)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// List reminder lists
app.get('/reminders/lists', async (_req, res) => {
  try {
    const data = await remindctl('list')
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get reminders from a specific list
app.get('/reminders/lists/:name', async (req, res) => {
  try {
    const data = await remindctl('list', req.params.name)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create a reminder
app.post('/reminders', async (req, res) => {
  try {
    const { title, list, due } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const args = ['add', title]
    if (list) args.push('--list', list)
    if (due) args.push('--due', due)
    const data = await remindctl(...args)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Complete reminder(s)
app.post('/reminders/complete', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids?.length) return res.status(400).json({ error: 'ids required' })
    const data = await remindctl('complete', ...ids)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Delete a reminder
app.delete('/reminders/:id', async (req, res) => {
  try {
    const data = await remindctl('delete', req.params.id, '--force')
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`mac-bridge listening on 0.0.0.0:${PORT}`)
  if (!API_KEY) console.warn('⚠ No BRIDGE_API_KEY set — running without auth')
})
