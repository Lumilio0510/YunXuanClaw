# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**YunXuanClaw** (branded as ClawX) is an Electron desktop application that provides a GUI for OpenClaw AI agents. It embeds the OpenClaw runtime and manages the gateway process lifecycle.

## Development Commands

```bash
# Initialize project (install deps + download uv)
pnpm run init

# Development with hot reload
pnpm dev

# Quality checks
pnpm lint              # ESLint
pnpm typecheck         # TypeScript validation

# Testing
pnpm test              # Unit tests (Vitest)
pnpm run test:e2e      # E2E tests (Playwright Electron)

# Build
pnpm run build:vite    # Frontend only
pnpm build             # Full production build
pnpm package           # Package for current platform
pnpm package:win       # Package for Windows
pnpm package:mac       # Package for macOS
pnpm package:linux     # Package for Linux
```

## Architecture

### Dual-Process Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron Main Process                       │
│  • Window & app lifecycle                                       │
│  • Gateway process supervision (electron/gateway/)              │
│  • Provider/account sync (electron/services/providers/)         │
│  • IPC handlers (electron/main/ipc-handlers.ts)                 │
└─────────────────────────────────────────────────────────────────┘
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    React Renderer Process                       │
│  • UI components (src/pages/, src/components/)                  │
│  • State management with Zustand (src/stores/)                  │
│  • API client (src/lib/api-client.ts)                           │
└─────────────────────────────────────────────────────────────────┘
                              │ WS/HTTP/IPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                            │
│  • AI agent runtime                                             │
│  • Channel management                                           │
│  • Skill/plugin execution                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Key Directories

- **electron/main/**: App entry point, window management, IPC registration
- **electron/gateway/**: OpenClaw Gateway process lifecycle management
- **electron/services/providers/**: Provider/account model and sync logic
- **electron/utils/openclaw-auth.ts**: Auth profiles and openclaw.json config
- **src/lib/api-client.ts**: Unified frontend API with transport fallback (IPC → WS → HTTP)
- **src/stores/**: Zustand stores for state management
- **src/pages/**: Main UI pages (Chat, Agents, Channels, Cron, Skills, Settings)

### Configuration Paths

The app uses `~/.yuanxuanclaw/` as the config directory (configurable via `OPENCLAW_CONFIG_DIR` env var):

- `~/.yuanxuanclaw/openclaw.json`: Main OpenClaw config (providers, agents, gateway settings)
- `~/.yuanxuanclaw/agents/main/agent/models.json`: Per-agent provider/model config
- `~/.yuanxuanclaw/agents/main/agent/auth-profiles.json`: API keys for providers

**Important**: The config directory is defined in `electron/utils/paths.ts` → `getOpenClawConfigDir()`. Default is `~/.yuanxuanclaw`.

### Transport Layer

The frontend uses a unified API client (`src/lib/api-client.ts`) with transport fallback:
1. **IPC** (default): Direct Electron IPC to main process
2. **WebSocket**: Direct connection to Gateway WS (when diagnostic mode enabled)
3. **HTTP**: Proxied through main process to Gateway HTTP endpoint

Gateway RPC calls go through `gateway:rpc` channel, which routes via IPC by default.

### Provider System

Providers are defined in `electron/shared/providers/registry.ts`. Each provider has:
- `id`: Provider identifier (e.g., 'anthropic', 'openai', 'minimax-portal')
- `defaultModelId`: Default model for the provider
- `providerConfig`: API base URL, auth mode, etc.

Provider accounts are synced between:
1. Electron store (for UI state)
2. `openclaw.json` (for Gateway config)
3. `auth-profiles.json` (for API keys)

### Gateway Lifecycle

Gateway management is in `electron/gateway/`:
- `manager.ts`: Main GatewayManager class
- `config-sync.ts`: Syncs config to openclaw.json and prepares launch context
- `supervisor.ts`: Process supervision (find, terminate, repair)
- `process-launcher.ts`: Spawns the gateway process

The gateway is spawned with `OPENCLAW_CONFIG_DIR` env var set to ensure it reads the correct config.

## Important Patterns

### When adding a new provider:

1. Add definition to `electron/shared/providers/registry.ts`
2. Add UI handling in `src/lib/providers.ts` (frontend provider list)
3. Ensure auth flow is handled in `electron/utils/openclaw-auth.ts`

### When modifying config sync:

1. Config changes must go through `withConfigLock()` mutex (`electron/utils/config-mutex.ts`)
2. Both `openclaw.json` and `models.json` may need updates
3. Gateway must be restarted for config changes to take effect

### When working on chat/runtime:

1. Chat state is in `src/stores/chat.ts`
2. Runtime actions are in `src/stores/chat/runtime-*.ts`
3. Gateway events are dispatched via `src/lib/host-events.ts`
