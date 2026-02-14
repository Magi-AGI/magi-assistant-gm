# Magi Assistant GM

## Project
AI GM Assistant — uses Claude to provide real-time Fate Core GM advice by consuming session data from three MCP servers (Discord bot, Foundry bridge, Magi Archive wiki). Delivers advice as whispered Foundry chat messages.

## Tech Stack
- TypeScript + Node.js
- @anthropic-ai/sdk for Claude reasoning with tool use
- @modelcontextprotocol/sdk for MCP client connections (SSE transport)

## Build & Run
- `npm run build` — compile TypeScript
- `npm run dev` — run with tsx (development)
- `npm start` — run compiled JS (production)

## Project Structure
- `src/index.ts` — entry point, wires MCP → triggers → engine → delivery
- `src/config.ts` — config loader (.env), all timing/token budget settings
- `src/logger.ts` — log sanitizer with secret redaction
- `src/types/index.ts` — GmAdvice, TriggerEvent, TriggerBatch, AssembledContext
- `src/mcp/` — MCP client layer
  - `client.ts` — McpAggregator: connects to Discord, Foundry, Wiki MCP servers
  - `tool-converter.ts` — MCP tool schema → Anthropic API tool format, name prefixing
- `src/reasoning/` — AI reasoning pipeline
  - `triggers.ts` — TriggerDetector: question detection, game event classification, heartbeat, batching, rate limiting
  - `context.ts` — ContextAssembler: fetches state from all MCPs, builds system prompt, token budget management
  - `engine.ts` — ReasoningEngine: Claude tool-use loop (max 5 iterations), NO_ADVICE sentinel, single-threaded
- `src/output/` — Advice delivery
  - `foundry-sidebar.ts` — FoundryAdviceOutput: sends via foundry__send_whisper MCP tool
  - `discord-channel.ts` — DiscordChannelOutput: posts to Discord webhook (backup)
  - `index.ts` — AdviceDelivery: orchestrates parallel delivery to all outputs
- `prompts/system.md` — System prompt template with {{GAME_STATE}} and {{CAMPAIGN_CONTEXT}} placeholders

## Architecture
- Connects to 3 MCP servers: Discord (transcripts), Foundry (game state), Wiki (campaign lore)
- Tool names are prefixed by server: discord__, foundry__, wiki__
- Trigger system batches events with 30s window, immediate flush for high priority (>=4)
- Rate limited: minimum 60s between advice invocations (deferred, not dropped)
- Transcript polling: every 10s from Discord MCP
- Heartbeat: configurable (default 5 min) for periodic check-ins
- Claude can return NO_ADVICE to indicate nothing noteworthy

## Key Conventions
- Wiki MCP failure is non-fatal (optional server)
- System prompt loaded from file (prompts/system.md), fallback to built-in default
- Token budget: truncates older transcript to fit maxContextTokens (default 100k)
- Single-threaded reasoning: new triggers queue during active processing
