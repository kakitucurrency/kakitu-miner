# Kakitu Miner

Desktop proof-of-work miner for the KSHS cryptocurrency. Contribute CPU power to the Kakitu network and earn KSHS tokens for each work unit completed.

Built with [Tauri v2](https://v2.tauri.app/) (Rust backend + React frontend).

## How It Works

1. Enter your KSHS wallet address (`kshs_1...` or `kshs_3...`)
2. Click **Start Mining** — the app connects to `wss://work.kakitu.org`
3. The work server sends PoW challenges (block hashes needing computation)
4. Your CPU solves them using multi-threaded Blake2b hashing across all available cores
5. Completed work is submitted back and you receive KSHS micropayments

## Features

- Multi-core CPU mining (uses all available threads)
- Real-time stats: work completed, KSHS earned, connected workers
- Work log with clickable transaction hashes (opens block explorer)
- Auto-reconnect with exponential backoff
- 120-second work timeout to discard stale challenges

## Platforms

| Platform | Status |
|----------|--------|
| macOS    | Supported |
| Windows  | Supported |
| Linux    | Supported |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable)
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

### Linux additional dependencies

```bash
# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libxdo-devel libappindicator-gtk3-devel librsvg2-devel
```

## Development

```bash
# Install frontend dependencies
npm install

# Run in development mode (hot-reload)
npm run tauri dev
```

## Building

```bash
# Build for current platform
npm run tauri build
```

Build outputs are in `src-tauri/target/release/bundle/`:
- **macOS**: `.dmg` and `.app`
- **Windows**: `.msi` and `.exe`
- **Linux**: `.deb`, `.rpm`, and `.AppImage`

## Network

| Endpoint | Purpose |
|----------|---------|
| `wss://work.kakitu.org/worker/ws` | WebSocket — receives work, submits solutions |
| `https://work.kakitu.org/stats` | Network stats (workers, total paid, reward per work) |
| `https://explorer.kakitu.org` | Block explorer for transaction hashes |

## Technical Details

- **Hashing**: Blake2b (same as Nano protocol)
- **Default threshold**: `0xfffff00000000000` (~64x lower difficulty than Nano mainnet)
- **Difficulty bounds**: `0xffffe00000000000` to `0xfffff80000000000`
- **Reconnect**: Exponential backoff, 1s to 60s, max 10 retries
- **Liveness**: Ping/pong with 90-second timeout

## Project Structure

```
kakitu-miner/
├── src/                  # React frontend
│   ├── App.tsx           # Main UI (stats, work log, controls)
│   └── App.css           # Dark theme styling
├── src-tauri/            # Rust backend
│   ├── src/lib.rs        # PoW worker, WebSocket, multi-threading
│   ├── tauri.conf.json   # App config (window, CSP, bundle)
│   └── icons/            # App icons (all platforms)
├── package.json
└── vite.config.ts
```

## License

Part of the [Kakitu Currency](https://github.com/kakitucurrency) project.
