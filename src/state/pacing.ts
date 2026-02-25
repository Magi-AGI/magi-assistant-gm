import {
  AssistantState,
  PacingState,
  FreshnessMetadata,
  EngagementLevel,
  SeparationStatus,
  ClimaxProximity,
  ActivationSource,
  CacheBuildStatus,
} from '../types/index.js';

/** Creates a fresh pacing state with defaults. */
export function createInitialPacingState(): PacingState {
  return {
    session_start: null,
    current_act: 1,
    current_scene: '',
    current_thread: '',
    act_timing: { started_at: null, planned_max_minutes: 0, elapsed_minutes: 0 },
    scene_timing: { started_at: null, planned_max_minutes: 0, elapsed_minutes: 0 },
    next_planned_beat: '',
    spotlight_debt: {},
    players_without_recent_spotlight: [],
    engagement_signals: {},
    separation_status: 'NORMAL',
    climax_proximity: 'NORMAL',
    planted_seeds: [],
    open_threads: [],
    assistant_state: AssistantState.PREGAME,
    activation_source: null,
    session_end_time: null,
    npc_cache_status: 'idle',
    scene_index_status: 'idle',
  };
}

/** Creates fresh freshness metadata. */
export function createInitialFreshness(staleThresholdSeconds = 30): FreshnessMetadata {
  return {
    transcript_cursor: 0,
    transcript_latest_ts: null,
    foundry_state_ts: null,
    wiki_last_fetch_ts: null,
    state_assembled_at: null,
    npc_cache_built_at: null,
    scene_index_built_at: null,
    stale_threshold_seconds: staleThresholdSeconds,
  };
}

interface PacingSnapshot {
  state: PacingState;
  freshness: FreshnessMetadata;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Manages pacing state lifecycle - timer computation, state transitions,
 * GM command application, and freshness tracking.
 */
export class PacingStateManager {
  private _state: PacingState;
  private _freshness: FreshnessMetadata;
  /** Set of scenes that have already fired an overrun alert (P3 fires once per scene). */
  private _sceneOverrunFired = new Set<string>();

  constructor(staleThresholdSeconds = 30) {
    this._state = createInitialPacingState();
    this._freshness = createInitialFreshness(staleThresholdSeconds);
  }

  get state(): Readonly<PacingState> { return this._state; }
  get freshness(): Readonly<FreshnessMetadata> { return this._freshness; }

  // State transitions

  get assistantState(): AssistantState { return this._state.assistant_state; }

  transitionTo(newState: AssistantState): void {
    this._state.assistant_state = newState;
  }

  setActivationSource(source: ActivationSource): void {
    this._state.activation_source = source;
  }

  setSessionEndTime(sessionEndTime: string | null): void {
    this._state.session_end_time = sessionEndTime;
  }

  setNpcCacheStatus(status: CacheBuildStatus): void {
    this._state.npc_cache_status = status;
  }

  setSceneIndexStatus(status: CacheBuildStatus): void {
    this._state.scene_index_status = status;
  }

  startSession(): void {
    this._state.session_start = new Date().toISOString();
    this._state.assistant_state = AssistantState.PREGAME;
    this._state.activation_source = null;
    this._state.npc_cache_status = 'idle';
    this._state.scene_index_status = 'idle';
  }

  // Timer computation

  /** Recompute elapsed minutes for act/scene from their started_at timestamps. */
  updateElapsed(now: Date = new Date()): void {
    if (this._state.act_timing.started_at) {
      const start = new Date(this._state.act_timing.started_at).getTime();
      this._state.act_timing.elapsed_minutes = Math.round((now.getTime() - start) / 60_000);
    }
    if (this._state.scene_timing.started_at) {
      const start = new Date(this._state.scene_timing.started_at).getTime();
      this._state.scene_timing.elapsed_minutes = Math.round((now.getTime() - start) / 60_000);
    }
  }

  /** Returns true if the current scene has exceeded its planned time by the given threshold. */
  isSceneOverrun(thresholdMinutes: number): boolean {
    const { planned_max_minutes, elapsed_minutes } = this._state.scene_timing;
    if (planned_max_minutes <= 0) return false;
    return elapsed_minutes > planned_max_minutes + thresholdMinutes;
  }

  /** Returns true if a P3 overrun alert has already been fired for the current scene. */
  hasOverrunFired(): boolean {
    return this._sceneOverrunFired.has(this._state.current_scene);
  }

  /** Mark that P3 overrun has fired for the current scene (do not repeat). */
  markOverrunFired(): void {
    this._sceneOverrunFired.add(this._state.current_scene);
  }

  // Scene / Act advancement

  advanceScene(sceneName: string, plannedMinutes = 0): void {
    const now = new Date().toISOString();
    this._state.current_scene = sceneName;
    this._state.scene_timing = {
      started_at: now,
      planned_max_minutes: plannedMinutes,
      elapsed_minutes: 0,
    };
    // Allow P3 to re-fire if GM revisits a scene (e.g. A1->A2->A1)
    this._sceneOverrunFired.delete(sceneName);
  }

  advanceAct(actNumber: number, plannedMinutes = 0): void {
    const now = new Date().toISOString();
    this._state.current_act = actNumber;
    this._state.act_timing = {
      started_at: now,
      planned_max_minutes: plannedMinutes,
      elapsed_minutes: 0,
    };
    // Reset scene overrun tracking for the new act
    this._sceneOverrunFired.clear();
  }

  setThread(thread: string): void {
    this._state.current_thread = thread;
  }

  setNextBeat(beat: string): void {
    this._state.next_planned_beat = beat;
  }

  // Spotlight / engagement

  setSpotlight(player: string, debt: number): void {
    this._state.spotlight_debt[player] = debt;
    this._state.players_without_recent_spotlight = Object.entries(this._state.spotlight_debt)
      .filter(([, d]) => d > 0)
      .map(([name]) => name);
  }

  setEngagement(player: string, level: EngagementLevel): void {
    this._state.engagement_signals[player] = level;
  }

  setSeparation(status: SeparationStatus): void {
    this._state.separation_status = status;
  }

  setClimaxProximity(proximity: ClimaxProximity): void {
    this._state.climax_proximity = proximity;
  }

  // Seeds / threads

  addSeed(name: string, scene: string): void {
    this._state.planted_seeds.push({ name, planted_in_scene: scene, revealed: false });
  }

  revealSeed(name: string): void {
    const seed = this._state.planted_seeds.find((entry) => entry.name === name);
    if (seed) seed.revealed = true;
  }

  addThread(thread: string): void {
    if (!this._state.open_threads.includes(thread)) {
      this._state.open_threads.push(thread);
    }
  }

  closeThread(thread: string): void {
    this._state.open_threads = this._state.open_threads.filter((entry) => entry !== thread);
  }

  // Freshness

  updateTranscriptFreshness(cursor: number, latestTs: string): void {
    this._freshness.transcript_cursor = cursor;
    this._freshness.transcript_latest_ts = latestTs;
  }

  updateFoundryFreshness(ts: string): void {
    this._freshness.foundry_state_ts = ts;
  }

  updateWikiFreshness(ts: string): void {
    this._freshness.wiki_last_fetch_ts = ts;
  }

  markNpcCacheBuilt(ts: string = new Date().toISOString()): void {
    this._freshness.npc_cache_built_at = ts;
  }

  markSceneIndexBuilt(ts: string = new Date().toISOString()): void {
    this._freshness.scene_index_built_at = ts;
  }

  markAssembled(): void {
    this._freshness.state_assembled_at = new Date().toISOString();
  }

  /** Returns true if a freshness timestamp is older than the stale threshold. */
  isStale(ts: string | null, now: Date = new Date()): boolean {
    if (!ts) return true;
    const age = (now.getTime() - new Date(ts).getTime()) / 1000;
    return age > this._freshness.stale_threshold_seconds;
  }

  /** Returns list of sources that are currently stale. */
  staleSources(now: Date = new Date()): string[] {
    const stale: string[] = [];
    if (this.isStale(this._freshness.transcript_latest_ts, now)) stale.push('transcript');
    if (this.isStale(this._freshness.foundry_state_ts, now)) stale.push('foundry');
    return stale;
  }

  // Persistence snapshots

  snapshot(): PacingSnapshot {
    return {
      state: deepClone(this._state),
      freshness: deepClone(this._freshness),
    };
  }

  restore(snapshot: PacingSnapshot): void {
    this._state = deepClone(snapshot.state);
    this._freshness = deepClone(snapshot.freshness);
  }

  // Reset

  reset(): void {
    this._state = createInitialPacingState();
    this._freshness = createInitialFreshness(this._freshness.stale_threshold_seconds);
    this._sceneOverrunFired.clear();
  }
}
