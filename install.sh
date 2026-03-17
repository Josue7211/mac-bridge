#!/bin/bash
set -e

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.mac-bridge.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"
NODE_PATH="$(which node)"

if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH. Install Node.js 18+ first."
  exit 1
fi

# Load .env if it exists
if [ -f "$BRIDGE_DIR/.env" ]; then
  BRIDGE_PORT=$(grep -E '^BRIDGE_PORT=' "$BRIDGE_DIR/.env" | cut -d= -f2)
  BRIDGE_API_KEY=$(grep -E '^BRIDGE_API_KEY=' "$BRIDGE_DIR/.env" | cut -d= -f2)
fi
BRIDGE_PORT="${BRIDGE_PORT:-4100}"

# Warn if no API key
if [ -z "$BRIDGE_API_KEY" ]; then
  echo "Warning: BRIDGE_API_KEY is not set in .env — the bridge will run without authentication."
  echo "Set it in $BRIDGE_DIR/.env before running in production."
  echo ""
fi

# Install dependencies if needed
if [ ! -d "$BRIDGE_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$BRIDGE_DIR" && npm install)
fi

# Unload existing service if present
if launchctl list 2>/dev/null | grep -q mac-bridge; then
  echo "Stopping existing mac-bridge service..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Write the plist
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mac-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$BRIDGE_DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BRIDGE_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>BRIDGE_PORT</key>
        <string>$BRIDGE_PORT</string>
        <key>BRIDGE_API_KEY</key>
        <string>${BRIDGE_API_KEY}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/mac-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mac-bridge.log</string>
</dict>
</plist>
EOF

# Load the service
launchctl load "$PLIST_PATH"

echo ""
echo "mac-bridge installed and running."
echo "  Port: $BRIDGE_PORT"
echo "  Logs: /tmp/mac-bridge.log"
echo "  Plist: $PLIST_PATH"
echo ""
echo "The bridge will start automatically on login and restart if it crashes."
echo "To stop: launchctl unload $PLIST_PATH"
