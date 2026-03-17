# mac-bridge

A lightweight REST bridge that exposes macOS-only services over HTTP. Designed to run on a Mac and be accessed remotely — e.g., from a Linux desktop over [Tailscale](https://tailscale.com).

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

### Run

```bash
npm start        # production
npm run dev      # development (auto-restart on changes)
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
