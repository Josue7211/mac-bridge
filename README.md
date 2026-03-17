# mac-bridge

A lightweight REST bridge that exposes macOS-only services over HTTP — built for [Mission Control](https://github.com/Josue7211/mission-control).

Mission Control is a cross-platform desktop app (Linux, macOS, Windows) that integrates iMessage, AI chat, task management, and more. Since Apple services like Reminders, Notes, Contacts, and Find My only have APIs on macOS, this bridge runs on a Mac and makes them available to Mission Control over the network via [Tailscale](https://tailscale.com).

```
┌──────────────────────┐         Tailscale          ┌─────────────────┐
│  Any Desktop         │◄──────────────────────────►│  Mac             │
│  (Linux/macOS/Win)   │          HTTP               │                 │
│                      │                             │  mac-bridge      │
│  Mission Control     │  GET /reminders ──────────► │  ├─ Reminders    │
│  (Tauri app)         │  GET /notes ──────────────► │  ├─ Notes        │
│                      │  GET /contacts ───────────► │  ├─ Contacts     │
│                      │  GET /findmy/devices ─────► │  ├─ Find My      │
│                      │  POST /messages/mark-read ► │  └─ Messages     │
└──────────────────────┘                             └─────────────────┘
```

## Services

| Endpoint | Source | Description |
|---|---|---|
| `GET /reminders` | [remindctl](https://github.com/keith/reminders-cli) | List, create, complete, delete Apple Reminders |
| `GET /notes` | JXA (AppleScript) | Search, list, read, create Apple Notes |
| `GET /contacts` | JXA (AppleScript) | Search contacts, get details, serve contact photos |
| `GET /findmy/devices` | Find My cache | List devices with location, battery, model |
| `POST /messages/mark-read` | sqlite3 on chat.db | Mark iMessage conversations as read |
| `GET /messages/attachment-raw` | Messages attachments dir | Serve raw attachments with HEIC→PNG conversion |

## Setup

```bash
git clone https://github.com/Josue7211/mac-bridge.git
cd mac-bridge
npm install
cp .env.example .env
```

Edit `.env`:
```
BRIDGE_PORT=4100
BRIDGE_API_KEY=your-secret-key-here
```

> **Important:** Always set `BRIDGE_API_KEY` in production. Without it, the server runs with no authentication.

### Prerequisites

- **macOS** (uses AppleScript, JXA, `sips`, and macOS-specific file paths)
- **Node.js** 18+
- **[remindctl](https://github.com/keith/reminders-cli)** for Reminders support
- **Find My** app must be open/synced for device location
- **Full Disk Access** granted to your terminal (for Messages chat.db access)

### Run as a persistent service (recommended)

The bridge should run permanently on your Mac. Use the included install script to set it up as a **launchd** service that starts on boot and restarts on failure:

```bash
./install.sh
```

This creates a launchd plist at `~/Library/LaunchAgents/com.mac-bridge.plist` that:
- Starts automatically on login
- Restarts if the process crashes
- Logs to `/tmp/mac-bridge.log`

#### Manual control

```bash
# Stop the service
launchctl unload ~/Library/LaunchAgents/com.mac-bridge.plist

# Start the service
launchctl load ~/Library/LaunchAgents/com.mac-bridge.plist

# Check status
launchctl list | grep mac-bridge

# View logs
tail -f /tmp/mac-bridge.log
```

#### Run manually (development only)

```bash
npm run dev      # auto-restart on file changes
```

### Connecting to Mission Control

In Mission Control, go to **Settings → Connections** and set the mac-bridge URL to your Mac's Tailscale IP:

```
http://100.x.x.x:4100
```

## API

All endpoints return JSON. If `BRIDGE_API_KEY` is set, every request must include:
- Header: `X-API-Key: <key>`, or
- Query param: `?api_key=<key>`

### Reminders

```
GET    /reminders              # list all (or ?filter=incomplete)
GET    /reminders/lists        # list all reminder lists
GET    /reminders/lists/:name  # reminders in a specific list
POST   /reminders              # create: { title, list?, due? }
POST   /reminders/complete     # complete: { ids: [...] }
DELETE /reminders/:id          # delete a reminder
```

### Notes

```
GET    /notes                  # list notes (?search=, ?folder=, ?limit=50)
GET    /notes/folders          # list folders with note counts
GET    /notes/:id              # full note content (plaintext + html)
POST   /notes                  # create: { title, body?, folder? }
```

### Contacts

```
GET    /contacts               # list contacts (?search=, ?limit=30)
GET    /contacts/photo         # contact photo (?address=+15551234567)
GET    /contacts/:id           # full contact details
```

### Find My

```
GET    /findmy/devices         # all devices with location + battery
```

### Messages

```
POST   /messages/mark-read         # mark as read: { chatGuid }
GET    /messages/attachment-raw     # serve attachment: ?guid=&name=
```

## Security

- **Set `BRIDGE_API_KEY`** — without it, anyone who can reach the server can access your data
- The server binds to `0.0.0.0` (all interfaces) so it's reachable over Tailscale. If you're on a shared network, consider binding to your Tailscale IP instead, or use firewall rules
- Messages mark-read validates `chatGuid` format to prevent SQL injection
- User inputs in JXA/AppleScript are sanitized via `safeJxaString()`
- Attachment serving is path-restricted to `~/Library/Messages/Attachments/`

## License

MIT
