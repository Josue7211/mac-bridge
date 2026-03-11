import express from 'express'
import { execFile, exec as execCb } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { join } from 'path'

const execFileP = promisify(execFile)
const execP = promisify(execCb)
const app = express()
app.use(express.json())

const PORT = process.env.BRIDGE_PORT || 4100
const API_KEY = process.env.BRIDGE_API_KEY || ''
const HOME = homedir()

// ── Auth middleware ─────────────────────────────────────────────────

if (API_KEY) {
  app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.api_key
    if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
    next()
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

async function remindctl(...args) {
  const { stdout } = await execFileP('remindctl', [...args, '--json'], { timeout: 10000 })
  return JSON.parse(stdout)
}

async function osascript(script) {
  const { stdout } = await execP(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 })
  return stdout.trim()
}

async function jxa(script) {
  const { stdout } = await execP(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 })
  return JSON.parse(stdout)
}


// ── Health ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, services: ['reminders', 'notes', 'contacts', 'findmy'] })
})

// ═══════════════════════════════════════════════════════════════════
// REMINDERS
// ═══════════════════════════════════════════════════════════════════

app.get('/reminders', async (req, res) => {
  try {
    const filter = req.query.filter || 'all'
    res.json(await remindctl(filter))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/reminders/lists', async (_req, res) => {
  try { res.json(await remindctl('list')) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/reminders/lists/:name', async (req, res) => {
  try { res.json(await remindctl('list', req.params.name)) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/reminders', async (req, res) => {
  try {
    const { title, list, due } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const args = ['add', title]
    if (list) args.push('--list', list)
    if (due) args.push('--due', due)
    res.json(await remindctl(...args))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/reminders/complete', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids?.length) return res.status(400).json({ error: 'ids required' })
    res.json(await remindctl('complete', ...ids))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/reminders/:id', async (req, res) => {
  try { res.json(await remindctl('delete', req.params.id, '--force')) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// ═══════════════════════════════════════════════════════════════════
// NOTES
// ═══════════════════════════════════════════════════════════════════

app.get('/notes', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const folder = req.query.folder || ''
    const search = req.query.search || ''

    let script
    if (search) {
      script = `
        const Notes = Application("Notes");
        const results = Notes.notes.whose({name: {_contains: "${search.replace(/"/g, '\\"')}"}})();
        JSON.stringify(results.slice(0, ${limit}).map(n => ({
          id: n.id(), name: n.name(), body: n.plaintext().substring(0, 200),
          folder: n.container().name(), created: n.creationDate().toISOString(),
          modified: n.modificationDate().toISOString()
        })))
      `
    } else if (folder) {
      script = `
        const Notes = Application("Notes");
        const f = Notes.folders.byName("${folder.replace(/"/g, '\\"')}");
        const notes = f.notes();
        JSON.stringify(notes.slice(0, ${limit}).map(n => ({
          id: n.id(), name: n.name(), body: n.plaintext().substring(0, 200),
          folder: "${folder}", created: n.creationDate().toISOString(),
          modified: n.modificationDate().toISOString()
        })))
      `
    } else {
      script = `
        const Notes = Application("Notes");
        const notes = Notes.notes();
        JSON.stringify(notes.slice(0, ${limit}).map(n => ({
          id: n.id(), name: n.name(), body: n.plaintext().substring(0, 200),
          folder: n.container().name(), created: n.creationDate().toISOString(),
          modified: n.modificationDate().toISOString()
        })))
      `
    }
    res.json(await jxa(script))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/notes/folders', async (_req, res) => {
  try {
    const script = `
      const Notes = Application("Notes");
      JSON.stringify(Notes.folders().map(f => ({ name: f.name(), count: f.notes().length })))
    `
    res.json(await jxa(script))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/notes/:id', async (req, res) => {
  try {
    const id = req.params.id.replace(/"/g, '\\"')
    const script = `
      const Notes = Application("Notes");
      const n = Notes.notes.byId("${id}");
      JSON.stringify({
        id: n.id(), name: n.name(), body: n.plaintext(),
        html: n.body(), folder: n.container().name(),
        created: n.creationDate().toISOString(),
        modified: n.modificationDate().toISOString()
      })
    `
    res.json(await jxa(script))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/notes', async (req, res) => {
  try {
    const { title, body, folder } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const safeTitle = title.replace(/"/g, '\\"')
    const safeBody = (body || '').replace(/"/g, '\\"')
    const target = folder
      ? `folder "${folder.replace(/"/g, '\\"')}" of application "Notes"`
      : 'default account of application "Notes"'
    await osascript(`tell application "Notes" to make new note at ${target} with properties {name:"${safeTitle}", body:"${safeBody}"}`)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ═══════════════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════════════

app.get('/contacts', async (req, res) => {
  try {
    const search = req.query.search || ''
    const limit = parseInt(req.query.limit) || 30
    let script
    if (search) {
      const safe = search.replace(/"/g, '\\"')
      script = `
        const Contacts = Application("Contacts");
        const people = Contacts.people.whose({_or: [
          {firstName: {_contains: "${safe}"}},
          {lastName: {_contains: "${safe}"}}
        ]})();
        JSON.stringify(people.slice(0, ${limit}).map(p => ({
          id: p.id(), name: p.name(),
          phones: p.phones().map(ph => ({label: ph.label(), value: ph.value()})),
          emails: p.emails().map(e => ({label: e.label(), value: e.value()}))
        })))
      `
    } else {
      script = `
        const Contacts = Application("Contacts");
        const people = Contacts.people();
        JSON.stringify(people.slice(0, ${limit}).map(p => ({
          id: p.id(), name: p.name(),
          phones: p.phones().map(ph => ({label: ph.label(), value: ph.value()})),
          emails: p.emails().map(e => ({label: e.label(), value: e.value()}))
        })))
      `
    }
    res.json(await jxa(script))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Contact photos (must be before /contacts/:id) ────────────────

// Map: last 7 digits → /tmp/mc-avatar-XXXXXXX.tiff
const photoMap = new Map()

async function buildPhotoCache() {
  // Use AppleScript to export all contact photos to /tmp
  const script = `
    tell application "Contacts"
      set output to ""
      repeat with p in every person
        try
          set img to image of p
          if img is not missing value then
            set phoneList to value of every phone of p
            repeat with ph in phoneList
              set rawNum to ph as text
              set digits to do shell script "echo " & quoted form of rawNum & " | tr -cd '0-9'"
              if length of digits >= 7 then
                set last7 to text ((length of digits) - 6) thru (length of digits) of digits
                set filePath to "/tmp/mc-avatar-" & last7 & ".tiff"
                try
                  set fRef to open for access POSIX file filePath with write permission
                  set eof fRef to 0
                  write img to fRef
                  close access fRef
                  set output to output & last7 & linefeed
                end try
              end if
            end repeat
          end if
        end try
      end repeat
      return output
    end tell
  `
  try {
    const result = await osascript(script)
    const keys = result.split('\n').filter(k => k.length === 7)
    for (const key of keys) {
      photoMap.set(key, `/tmp/mc-avatar-${key}.tiff`)
    }
    console.log(`Photo cache built: ${photoMap.size} contact photos`)
  } catch (err) {
    console.warn('Photo cache build failed:', err.message)
  }
}

// Build in background on startup (can take 30-60s with many contacts)
buildPhotoCache()

app.get('/contacts/photo', (req, res) => {
  const address = req.query.address
  if (!address) return res.status(400).json({ error: 'address required' })

  const digits = String(address).replace(/\D/g, '')
  const last7 = digits.length >= 7 ? digits.slice(-7) : digits
  if (!last7) return res.status(404).json({ error: 'invalid address' })

  const photoPath = photoMap.get(last7)
  if (photoPath) {
    return res.sendFile(photoPath)
  }
  res.status(404).json({ error: 'no_photo' })
})

app.get('/contacts/:id', async (req, res) => {
  try {
    const id = req.params.id.replace(/"/g, '\\"')
    const script = `
      const Contacts = Application("Contacts");
      const p = Contacts.people.byId("${id}");
      JSON.stringify({
        id: p.id(), name: p.name(),
        firstName: p.firstName(), lastName: p.lastName(),
        organization: p.organization(),
        phones: p.phones().map(ph => ({label: ph.label(), value: ph.value()})),
        emails: p.emails().map(e => ({label: e.label(), value: e.value()})),
        addresses: p.addresses().map(a => ({
          label: a.label(), street: a.street(), city: a.city(),
          state: a.state(), zip: a.zip(), country: a.country()
        }))
      })
    `
    res.json(await jxa(script))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ═══════════════════════════════════════════════════════════════════
// FIND MY
// ═══════════════════════════════════════════════════════════════════

app.get('/findmy/devices', async (_req, res) => {
  try {
    // Read from Find My cache (requires Find My app to be running/synced)
    const cachePath = join(HOME, 'Library/Caches/com.apple.findmy.fmipcore/Items.data')
    const { readFile } = await import('fs/promises')
    const raw = await readFile(cachePath, 'utf-8')
    const items = JSON.parse(raw)
    const devices = items.map(d => ({
      id: d.identifier || d.serialNumber,
      name: d.name,
      model: d.productType?.type,
      battery: d.batteryLevel,
      batteryStatus: d.batteryStatus,
      location: d.location ? {
        lat: d.location.latitude,
        lng: d.location.longitude,
        accuracy: d.location.horizontalAccuracy,
        timestamp: d.location.timeStamp,
      } : null,
    }))
    res.json(devices)
  } catch (err) {
    // Fallback: try Devices.data
    try {
      const cachePath = join(HOME, 'Library/Caches/com.apple.findmy.fmipcore/Devices.data')
      const { readFile } = await import('fs/promises')
      const raw = await readFile(cachePath, 'utf-8')
      const items = JSON.parse(raw)
      const devices = items.map(d => ({
        id: d.baUUID || d.deviceDiscoveryId,
        name: d.name,
        model: d.deviceDisplayName,
        battery: d.batteryLevel,
        batteryStatus: d.batteryStatus,
        location: d.location ? {
          lat: d.location.latitude,
          lng: d.location.longitude,
          accuracy: d.location.horizontalAccuracy,
          timestamp: d.location.timeStamp,
        } : null,
      }))
      res.json(devices)
    } catch (err2) {
      res.status(500).json({ error: 'Find My cache not available. Open Find My app on this Mac first. ' + err2.message })
    }
  }
})

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`mac-bridge listening on 0.0.0.0:${PORT}`)
  console.log('Services: reminders, notes, contacts, messages, findmy')
  if (!API_KEY) console.warn('Warning: No BRIDGE_API_KEY set — running without auth')
})
