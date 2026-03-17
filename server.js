import express from 'express'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { join, resolve, extname } from 'path'
import { createHash, timingSafeEqual } from 'crypto'

const execFileP = promisify(execFile)
const app = express()

// ── Input limits ────────────────────────────────────────────────────
const MAX_STRING_LENGTH = 10000
const MAX_ARRAY_LENGTH = 100

// Sanitize user input for safe interpolation into JXA/AppleScript double-quoted strings
function safeJxaString(s) {
  return String(s)
    .slice(0, MAX_STRING_LENGTH)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/\0/g, '')     // strip null bytes
}

app.use(express.json({ limit: '1mb' }))

const PORT = process.env.BRIDGE_PORT || 4100
const API_KEY = process.env.BRIDGE_API_KEY || ''
const HOME = homedir()

// ── Auth middleware ─────────────────────────────────────────────────

if (!API_KEY) {
  console.error('FATAL: BRIDGE_API_KEY is not set. Refusing to start without auth.')
  process.exit(1)
}

// Simple in-memory rate limiter
const rateBuckets = new Map()
function rateLimit(key, maxPerMinute) {
  const now = Date.now()
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + 60000 }
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60000 }
  bucket.count++
  rateBuckets.set(key, bucket)
  return bucket.count > maxPerMinute
}

app.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key || ''
  // Constant-time comparison to prevent timing attacks
  if (typeof key !== 'string' || key.length === 0) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  try {
    const keyBuf = Buffer.from(key, 'utf-8')
    const expectedBuf = Buffer.from(API_KEY, 'utf-8')
    // timingSafeEqual requires same length — hash both to normalize
    const keyHash = createHash('sha256').update(keyBuf).digest()
    const expectedHash = createHash('sha256').update(expectedBuf).digest()
    if (!timingSafeEqual(keyHash, expectedHash)) {
      return res.status(401).json({ error: 'unauthorized' })
    }
  } catch {
    return res.status(401).json({ error: 'unauthorized' })
  }
  // Rate limit: 60 requests per minute per IP
  const clientIp = req.ip || 'unknown'
  if (rateLimit(clientIp, 60)) {
    return res.status(429).json({ error: 'rate limit exceeded' })
  }
  next()
})

// ── Helpers ─────────────────────────────────────────────────────────

// Sanitize error messages to prevent internal detail leakage
function safeError(err) {
  const msg = String(err?.message || 'unknown error')
  // Strip file paths and stack traces
  return msg.replace(/\/Users\/[^\s:]+/g, '<redacted-path>').slice(0, 200)
}

async function remindctl(...args) {
  const { stdout } = await execFileP('remindctl', [...args, '--json'], { timeout: 10000 })
  return JSON.parse(stdout)
}

async function osascript(script) {
  const { stdout } = await execFileP('osascript', ['-e', script], { timeout: 15000 })
  return stdout.trim()
}

async function jxa(script) {
  const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 })
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
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.get('/reminders/lists', async (_req, res) => {
  try { res.json(await remindctl('list')) }
  catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.get('/reminders/lists/:name', async (req, res) => {
  try { res.json(await remindctl('list', req.params.name)) }
  catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.post('/reminders', async (req, res) => {
  try {
    const { title, list, due } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const args = ['add', String(title).slice(0, MAX_STRING_LENGTH)]
    if (list) args.push('--list', String(list).slice(0, 200))
    if (due) args.push('--due', String(due).slice(0, 100))
    res.json(await remindctl(...args))
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.post('/reminders/complete', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids?.length) return res.status(400).json({ error: 'ids required' })
    const safeIds = ids.slice(0, MAX_ARRAY_LENGTH).map(id => String(id).slice(0, 200))
    res.json(await remindctl('complete', ...safeIds))
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.delete('/reminders/:id', async (req, res) => {
  try { res.json(await remindctl('delete', req.params.id, '--force')) }
  catch (err) { res.status(500).json({ error: safeError(err) }) }
})

// ═══════════════════════════════════════════════════════════════════
// NOTES
// ═══════════════════════════════════════════════════════════════════

app.get('/notes', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200)
    const folder = req.query.folder || ''
    const search = req.query.search || ''

    let script
    if (search) {
      script = `
        const Notes = Application("Notes");
        const results = Notes.notes.whose({name: {_contains: "${safeJxaString(search)}"}})();
        JSON.stringify(results.slice(0, ${limit}).map(n => ({
          id: n.id(), name: n.name(), body: n.plaintext().substring(0, 200),
          folder: n.container().name(), created: n.creationDate().toISOString(),
          modified: n.modificationDate().toISOString()
        })))
      `
    } else if (folder) {
      script = `
        const Notes = Application("Notes");
        const f = Notes.folders.byName("${safeJxaString(folder)}");
        const notes = f.notes();
        JSON.stringify(notes.slice(0, ${limit}).map(n => ({
          id: n.id(), name: n.name(), body: n.plaintext().substring(0, 200),
          folder: "${safeJxaString(folder)}", created: n.creationDate().toISOString(),
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
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.get('/notes/folders', async (_req, res) => {
  try {
    const script = `
      const Notes = Application("Notes");
      JSON.stringify(Notes.folders().map(f => ({ name: f.name(), count: f.notes().length })))
    `
    res.json(await jxa(script))
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.get('/notes/:id', async (req, res) => {
  try {
    const id = safeJxaString(req.params.id)
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
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

app.post('/notes', async (req, res) => {
  try {
    const { title, body, folder } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const safeTitle = safeJxaString(title)
    const safeBody = safeJxaString(body || '')
    const target = folder
      ? `folder "${safeJxaString(folder)}" of application "Notes"`
      : 'default account of application "Notes"'
    await osascript(`tell application "Notes" to make new note at ${target} with properties {name:"${safeTitle}", body:"${safeBody}"}`)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

// ═══════════════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════════════

app.get('/contacts', async (req, res) => {
  try {
    const search = req.query.search || ''
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 200)
    let script
    if (search) {
      const safe = safeJxaString(search)
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
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
})

// ── Contact photos (must be before /contacts/:id) ────────────────

// Map: last 7 digits → /tmp/mc-avatar-XXXXXXX.tiff
const photoMap = new Map()

async function buildPhotoCache() {
  // Use AppleScript to export all contact photos to /tmp as TIFF, then convert to JPEG
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
                set tiffPath to "/tmp/mc-avatar-" & last7 & ".tiff"
                try
                  set fRef to open for access POSIX file tiffPath with write permission
                  set eof fRef to 0
                  write img to fRef
                  close access fRef
                  -- Convert TIFF to JPEG using sips
                  do shell script "sips -s format jpeg " & quoted form of tiffPath & " --out /tmp/mc-avatar-" & last7 & ".jpg > /dev/null 2>&1 && rm -f " & quoted form of tiffPath
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
      photoMap.set(key, `/tmp/mc-avatar-${key}.jpg`)
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
    const id = safeJxaString(req.params.id)
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
  } catch (err) { res.status(500).json({ error: safeError(err) }) }
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
      res.status(500).json({ error: 'Find My cache not available. Open Find My app on this Mac first.' })
    }
  }
})

// ── Messages — mark chat as read via sqlite3 on chat.db ────────────

app.post('/messages/mark-read', async (req, res) => {
  const { chatGuid } = req.body
  if (!chatGuid || typeof chatGuid !== 'string') {
    return res.status(400).json({ error: 'chatGuid required' })
  }
  // Validate chatGuid format to prevent injection (only allow safe chars)
  if (!/^[a-zA-Z0-9_;+\-@.]+$/.test(chatGuid)) {
    return res.status(400).json({ error: 'Invalid chatGuid format' })
  }

  try {
    const { execFile: execFileCb } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFileCb)
    const dbPath = join(HOME, 'Library/Messages/chat.db')

    // date_read uses Apple Core Data nanoseconds since 2001-01-01
    // 978307200 = seconds between Unix epoch (1970) and Apple epoch (2001)
    const appleNow = (Math.floor(Date.now() / 1000) - 978307200) * 1000000000
    // chatGuid is already validated by regex above (safe chars only)
    const sql = `UPDATE message SET date_read = ${appleNow}
      WHERE ROWID IN (
        SELECT m.ROWID FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE c.guid = '${chatGuid}'
        AND m.is_from_me = 0
        AND m.date_read = 0
      );`

    await execFileAsync('sqlite3', [dbPath, sql])
    res.json({ ok: true })
  } catch (err) {
    console.error('mark-read error:', err.message)
    res.status(500).json({ error: safeError(err) })
  }
})

// ── Messages — serve raw attachment file by BB GUID (for HEIC/HEICS conversion) ──

app.get('/messages/attachment-raw', async (req, res) => {
  const guid = req.query.guid
  const originalName = req.query.name // original filename without .jpeg suffix
  if (!guid || typeof guid !== 'string') {
    return res.status(400).json({ error: 'guid required' })
  }
  // Validate guid format (e.g. at_0_UUID or at_UUID_UUID)
  if (!/^at_[a-zA-Z0-9_\-]+$/.test(guid)) {
    return res.status(400).json({ error: 'invalid guid' })
  }

  const attachDir = join(HOME, 'Library/Messages/Attachments')
  try {
    const { execFile: execFileCb } = await import('child_process')
    const { promisify: prom } = await import('util')
    const execAsync = prom(execFileCb)

    // Try to find the attachment file. macOS stores them at:
    // ~/Library/Messages/Attachments/XX/YY/<dir>/<filename>
    // The directory name may match the BB GUID or just be a UUID.

    // Strategy 1: search for directory matching BB GUID
    let foundFile = null
    const { stdout } = await execAsync('find', [attachDir, '-type', 'd', '-name', guid, '-maxdepth', '4'], { timeout: 5000 }).catch(() => ({ stdout: '' }))
    const dirs = stdout.trim().split('\n').filter(Boolean)

    if (dirs.length > 0) {
      const { readdir } = await import('fs/promises')
      const files = await readdir(dirs[0])
      const target = (originalName && files.includes(originalName)) ? originalName
        : files.find(f => /\.(heics|heic|apng|webp|gif|png)$/i.test(f)) || files[0]
      if (target) foundFile = join(dirs[0], target)
    }

    // Strategy 2: search by original filename directly
    if (!foundFile && originalName) {
      // Sanitize originalName to prevent path traversal in find
      const safeName = String(originalName).replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200)
      const { stdout: stdout2 } = await execAsync('find', [attachDir, '-type', 'f', '-name', safeName, '-maxdepth', '5'], { timeout: 5000 }).catch(() => ({ stdout: '' }))
      const files2 = stdout2.trim().split('\n').filter(Boolean)
      if (files2.length > 0) foundFile = files2[0]
    }

    if (!foundFile) return res.status(404).json({ error: 'attachment not found' })

    // Security: verify still under Attachments
    const resolved2 = resolve(foundFile)
    if (!resolved2.startsWith(attachDir + '/')) {
      return res.status(403).json({ error: 'path not allowed' })
    }

    const { readFile } = await import('fs/promises')
    const ext2 = extname(foundFile).toLowerCase()

    // HEIC/HEICS: convert to PNG using macOS sips (preserves alpha/transparency)
    if (ext2 === '.heic' || ext2 === '.heics') {
      const tmpPng = `/tmp/mc-sticker-${guid}.png`
      try {
        await execAsync('sips', ['-s', 'format', 'png', resolved2, '--out', tmpPng], { timeout: 10000 })
        const pngData = await readFile(tmpPng)
        // Clean up temp file
        import('fs/promises').then(fs => fs.unlink(tmpPng).catch(() => {}))
        res.set('Content-Type', 'image/png')
        return res.send(pngData)
      } catch {
        // sips failed, fall through to raw file
      }
    }

    const data = await readFile(resolved2)
    const types = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.apng': 'image/apng',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.caf': 'audio/x-caf',
    }
    res.set('Content-Type', types[ext2] || 'application/octet-stream')
    res.send(data)
  } catch {
    res.status(404).json({ error: 'attachment not found' })
  }
})

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`mac-bridge listening on 0.0.0.0:${PORT}`)
  console.log('Services: reminders, notes, contacts, messages, findmy')
})
