# Magi Assistant GM (v2)

## Project
AI GM Assistant v2 — event-driven, stage-manager-style Fate Core GM advisor. Consumes session data from three MCP servers (Discord bot, Foundry bridge, Magi Archive wiki). Delivers structured JSON advice envelopes as whispered Foundry chat messages.

## Tech Stack
- TypeScript + Node.js
- @anthropic-ai/sdk for Claude reasoning with tool use
- @modelcontextprotocol/sdk for MCP client connections (SSE transport)

## Build & Run
- `npm run build` — compile TypeScript
- `npm run dev` — run with tsx (development)
- `npm start` — run compiled JS (production)

## Project Structure
- `src/index.ts` — event-driven orchestrator, startup sequence, polling loops
- `src/config.ts` — config loader (.env), v2 timing/trigger/budget settings
- `src/logger.ts` — log sanitizer with secret redaction
- `src/types/index.ts` — v2 type system: AssistantState, TriggerPriority, AdviceEnvelope, PacingState, etc.
- `src/state/` — State management (pure data, no I/O)
  - `pacing.ts` — PacingStateManager: timer computation, state transitions, freshness tracking
  - `advice-memory.ts` — AdviceMemoryBuffer: rolling buffer of last N advice, dedup checking
  - `gm-commands.ts` — parseGmCommand(): parses /act, /scene, /spotlight, etc. from Foundry chat
- `src/mcp/` — MCP client layer
  - `client.ts` — McpAggregator: connects to all 3 servers (wiki = hard gate), healthCheck()
  - `tool-converter.ts` — MCP tool schema → Anthropic API tool format, name prefixing
- `src/reasoning/` — AI reasoning pipeline
  - `triggers.ts` — TriggerDetector: P1-P4 priority system, PREGAME/ACTIVE/SLEEP state machine, flowing-RP suppression
  - `context.ts` — ContextAssembler: 20k token budget, compressed roster, freshness warnings, ALREADY ADVISED injection
  - `engine.ts` — ReasoningEngine: Claude tool-use loop, JSON envelope parsing, dedup, memory push
  - `envelope-parser.ts` — parseAdviceEnvelope(), wrapFreeTextAsEnvelope(), isNoAdvice()
- `src/output/` — Advice delivery
  - `foundry-sidebar.ts` — FoundryAdviceOutput: category-colored [TAG] format
  - `discord-channel.ts` — DiscordChannelOutput: **[TAG]** Markdown format
  - `image-queue.ts` — ImageQueue: single-slot, 2-minute TTL, confirm/reject
  - `index.ts` — AdviceDelivery: orchestrates parallel delivery
- `prompts/system.md` — Stage manager role, JSON envelope output format, category definitions

## Architecture (v2)
- **State machine:** PREGAME → ACTIVE → SLEEP, driven by speech/scene events and GM commands
- **Priority triggers:** P1 (GM question, immediate), P2 (scene/act transition), P3 (pacing overrun), P4 (GM silence)
- **Flowing-RP suppression:** P3/P4 suppressed during active player dialogue
- **Rate limiting:** 180s minimum between advice (P1 exempt)
- **20k token ceiling:** system ~3k, episode plan ~1.5k, pacing ~300, roster ~1.5k, transcript ~10k, ALREADY ADVISED ~1.5k
- **Wiki = hard gate:** cannot start without wiki MCP connection
- **Advice envelopes:** JSON with category, tag, priority, summary, body, confidence, source_cards, optional image
- **Image queue:** GM confirms via /yes in Discord; 2-minute TTL
- **Dedup:** rolling buffer of last 5 advice; same tag or summary = suppressed
- Tool names prefixed by server: discord__, foundry__, wiki__
- Single-threaded reasoning: new triggers queue during active processing

## Key Env Vars (v2)
- `WIKI_MCP_URL` — **Required** (hard gate)
- `MIN_ADVICE_INTERVAL_SECONDS=180` — P1 exempt
- `MAX_CONTEXT_TOKENS=20000` — down from v1's 100k
- `SCENE_OVERRUN_THRESHOLD_MINUTES=3`
- `ACTIVE_SILENCE_SECONDS=90`
- `SLEEP_SILENCE_MINUTES=15`
- `TRANSCRIPT_WINDOW_MINUTES=20`
- `ADVICE_MEMORY_SIZE=5`
- `HEARTBEAT_INTERVAL_MINUTES` — deprecated, ignored with warning
