// Assistant State Machine

export enum AssistantState {
  /** Pre-game social chat - suppress all except P1. */
  PREGAME = 'PREGAME',
  /** Active play - full trigger detection. */
  ACTIVE = 'ACTIVE',
  /** No speech detected for SLEEP_SILENCE_MINUTES - P1 only. */
  SLEEP = 'SLEEP',
}

// Trigger Priority (lower number = higher priority)

export enum TriggerPriority {
  /** GM explicitly asks for help. Immediate flush, no cooldown. */
  P1 = 1,
  /** Scene/act transition and high-priority pacing events. */
  P2 = 2,
  /** Pacing advisory and creative escalation. */
  P3 = 3,
  /** Silence detection (GM quiet > threshold). */
  P4 = 4,
}

export type TriggerType =
  | 'gm_question' // P1
  | 'gm_hesitation' // P1-H (v3)
  | 'scene_transition' // P2 explicit (keyword + Foundry event)
  | 'scene_transition_detected' // P2 inferred from scene index (v3)
  | 'npc_first_appearance' // P2 (v3)
  | 'act_transition' // P2
  | 'pacing_gate_convergence' // P2 (v3)
  | 'pacing_gate_denouement' // P2 (v3)
  | 'pacing_alert' // P3 scene overrun
  | 'epic_success' // P3 (v3)
  | 'silence_detection'; // P4

export interface TriggerEvent {
  type: TriggerType;
  priority: TriggerPriority;
  source: string;
  data: Record<string, unknown>;
  timestamp: string; // ISO 8601
}

export interface TriggerBatch {
  events: TriggerEvent[];
  flushedAt: string; // ISO 8601
}

// Advice Envelope

export type AdviceCategory =
  | 'script'
  | 'gap-fill'
  | 'pacing'
  | 'continuity'
  | 'spotlight'
  | 'mechanics'
  | 'technical'
  | 'creative'
  | 'none';

export interface ImageSuggestion {
  /** Relative path within Foundry data directory (e.g. "worlds/dominos-fall/maps/concourse-hub.webp"). */
  path: string;
  description: string;
  /** Discord channel to post to (optional - defaults to session text channel). */
  post_to?: string;
}

export interface AdviceEnvelope {
  category: AdviceCategory;
  tag: string;
  priority: TriggerPriority;
  /** <=15 word summary. */
  summary: string;
  /** Full advice body (null for NO_ADVICE). */
  body: string | null;
  /** 0.0 - 1.0 */
  confidence: number;
  /** Wiki card names referenced. */
  source_cards: string[];
  /** Optional image suggestion (requires GM confirmation). */
  image?: ImageSuggestion;
}

// Pacing State

export interface ActTiming {
  started_at: string | null;
  planned_max_minutes: number;
  elapsed_minutes: number;
}

export interface SceneTiming {
  started_at: string | null;
  planned_max_minutes: number;
  elapsed_minutes: number;
}

export type EngagementLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type SeparationStatus = 'NORMAL' | 'SPLIT' | 'CRITICAL';
export type ClimaxProximity = 'NORMAL' | 'APPROACHING' | 'ESCALATING' | 'CLIMAX';
export type ActivationSource = 'foundry' | 'command' | 'transcript' | null;
export type CacheBuildStatus = 'idle' | 'building' | 'ready' | 'error';

export interface PlantedSeed {
  name: string;
  planted_in_scene: string;
  revealed: boolean;
}

export interface NpcCacheEntry {
  /** Canonical lowercase key used for matching. */
  key: string;
  display_name: string;
  pronunciation: string;
  brief: string;
  full_card: string;
  aliases: string[];
  served: boolean;
  last_served_at: string | null;
}

export interface SceneIndexEntry {
  id: string;
  title: string;
  card: string;
  keywords: string[];
  npcs: string[];
  served: boolean;
  served_at: string | null;
}

export interface PacingState {
  session_start: string | null;
  current_act: number;
  current_scene: string;
  current_thread: string;
  act_timing: ActTiming;
  scene_timing: SceneTiming;
  next_planned_beat: string;
  spotlight_debt: Record<string, number>;
  players_without_recent_spotlight: string[];
  engagement_signals: Record<string, EngagementLevel>;
  separation_status: SeparationStatus;
  climax_proximity: ClimaxProximity;
  planted_seeds: PlantedSeed[];
  open_threads: string[];
  assistant_state: AssistantState;
  activation_source: ActivationSource;
  session_end_time: string | null;
  npc_cache_status: CacheBuildStatus;
  scene_index_status: CacheBuildStatus;
}

// Freshness Metadata

export interface FreshnessMetadata {
  transcript_cursor: number;
  transcript_latest_ts: string | null;
  foundry_state_ts: string | null;
  wiki_last_fetch_ts: string | null;
  state_assembled_at: string | null;
  npc_cache_built_at: string | null;
  scene_index_built_at: string | null;
  /** Seconds before a source is considered stale. */
  stale_threshold_seconds: number;
}

// Advice Memory

export interface AdviceMemoryEntry {
  timestamp: string;
  category: AdviceCategory;
  tag: string;
  summary: string;
  full_text: string;
}

export interface AdviceMemory {
  entries: AdviceMemoryEntry[];
  max_size: number;
}

// Assembled Context

export interface AssembledContext {
  systemPrompt: string;
  triggerSummary: string;
  recentTranscript: string;
  gameState: string;
  pacingState: PacingState;
  freshness: FreshnessMetadata;
  alreadyAdvised: AdviceMemoryEntry[];
  npcCache?: NpcCacheEntry[];
  sceneIndex?: SceneIndexEntry[];
  tools: unknown[];
  estimatedTokens: number;
}

// GM Command (from Foundry chat)

export type GmCommandType =
  | 'act'
  | 'scene'
  | 'spotlight'
  | 'engagement'
  | 'separation'
  | 'climax'
  | 'seed'
  | 'sleep'
  | 'wake'
  | 'endtime'  // v3: set session end time for pacing gates
  | 'npc';     // v3: /npc refresh, /npc serve [name]

export interface GmCommand {
  type: GmCommandType;
  args: string[];
  raw: string;
  timestamp: string;
}
