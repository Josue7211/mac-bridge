import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const API_KEY = 'test-key'

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function writeStub(binDir, name, source) {
  const path = join(binDir, name)
  await writeFile(path, source)
  await chmod(path, 0o755)
}

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'mac-bridge-test-'))
  const binDir = join(root, 'bin')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(binDir)
  const logPath = join(root, 'commands.jsonl')

  await writeStub(binDir, 'remindctl', `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.MAC_BRIDGE_TEST_LOG, JSON.stringify({ tool: 'remindctl', argv }) + '\\n')
process.stdout.write(JSON.stringify({ ok: true, argv }))
`)

  await writeStub(binDir, 'osascript', `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.MAC_BRIDGE_TEST_LOG, JSON.stringify({ tool: 'osascript', argv }) + '\\n')
if (argv.includes('-l')) {
  process.stdout.write(JSON.stringify({ ok: true, script: argv[argv.length - 1] }))
} else {
  process.stdout.write('')
}
`)

  const port = await freePort()
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRIDGE_API_KEY: API_KEY,
      BRIDGE_PORT: String(port),
      MAC_BRIDGE_TEST_LOG: logPath,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })

  const baseUrl = `http://127.0.0.1:${port}`
  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`)
    try {
      const response = await fetch(`${baseUrl}/health`, { headers: { 'X-API-Key': API_KEY } })
      if (response.ok) break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    const body = await response.json()
    assert.equal(response.status, options.expectedStatus || 200, JSON.stringify(body))
    return body
  }

  async function logs() {
    let raw = ''
    try { raw = await readFile(logPath, 'utf8') } catch { return [] }
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  return {
    request,
    logs,
    async close() {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    },
  }
}

test('Reminders list maps bridge filters to remindctl show filters', async () => {
  const harness = await createHarness()
  try {
    const body = await harness.request('/reminders?filter=incomplete&list=Work')
    assert.deepEqual(body.argv, ['show', 'open', '--list', 'Work', '--json', '--no-input'])
  } finally {
    await harness.close()
  }
})

test('Reminders create, update, complete, uncomplete, and delete use real remindctl commands', async () => {
  const harness = await createHarness()
  try {
    assert.deepEqual(
      (await harness.request('/reminders', {
        method: 'POST',
        body: JSON.stringify({ summary: 'Call mom', listName: 'Family', dueDate: 'tomorrow', notes: 'before noon', priority: 'high' }),
      })).argv,
      ['add', 'Call mom', '--list', 'Family', '--due', 'tomorrow', '--notes', 'before noon', '--priority', 'high', '--json', '--no-input'],
    )

    assert.deepEqual(
      (await harness.request('/reminders/r1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Call dad', due: null, completed: false }),
      })).argv,
      ['edit', 'r1', '--title', 'Call dad', '--clear-due', '--incomplete', '--json', '--no-input'],
    )

    assert.deepEqual(
      (await harness.request('/reminders/complete', {
        method: 'POST',
        body: JSON.stringify({ id: 'r1' }),
      })).argv,
      ['complete', 'r1', '--json', '--no-input'],
    )

    const uncomplete = await harness.request('/reminders/uncomplete', {
      method: 'POST',
      body: JSON.stringify({ ids: ['r1', 'r2'] }),
    })
    assert.deepEqual(uncomplete.results.map(result => result.argv), [
      ['edit', 'r1', '--incomplete', '--json', '--no-input'],
      ['edit', 'r2', '--incomplete', '--json', '--no-input'],
    ])

    assert.deepEqual(
      (await harness.request('/reminders/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: ['r1', 'r2'] }),
      })).argv,
      ['delete', 'r1', 'r2', '--force', '--json', '--no-input'],
    )
  } finally {
    await harness.close()
  }
})

test('Calendar accepts aliases and emits real EventKit update/delete scripts', async () => {
  const harness = await createHarness()
  try {
    const created = await harness.request('/calendar', {
      method: 'POST',
      body: JSON.stringify({ summary: 'Standup', startDate: '2026-05-10T13:00:00Z', endDate: '2026-05-10T13:30:00Z', calendarName: 'Work', isAllDay: false }),
    })
    assert.match(created.script, /Calendar\.calendars\.byName\("Work"\)/)
    assert.match(created.script, /summary: "Standup"/)

    const updated = await harness.request('/calendar/update', {
      method: 'POST',
      body: JSON.stringify({ objectUrl: 'x-apple-eventkit:///Event/123', name: 'Planning', startsAt: '2026-05-10T14:00:00Z' }),
    })
    assert.match(updated.script, /eventMatches\(event, id\)/)
    assert.match(updated.script, /event\.summary = nextTitle/)
    assert.match(updated.script, /event\.startDate = nextStart/)

    const deleted = await harness.request('/calendar/delete', {
      method: 'POST',
      body: JSON.stringify({ objectUrl: 'x-apple-eventkit:///Event/123' }),
    })
    assert.match(deleted.script, /eventMatches\(event, id\)/)
    assert.match(deleted.script, /event\.delete\(\)/)
  } finally {
    await harness.close()
  }
})

test('Calendar rejects invalid dates before invoking osascript', async () => {
  const harness = await createHarness()
  try {
    const before = (await harness.logs()).filter(entry => entry.tool === 'osascript').length
    await harness.request('/calendar', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad date', start: 'not-a-date' }),
      expectedStatus: 400,
    })
    const after = (await harness.logs()).filter(entry => entry.tool === 'osascript').length
    assert.equal(after, before)
  } finally {
    await harness.close()
  }
})
