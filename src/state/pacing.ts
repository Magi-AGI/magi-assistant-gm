import {
  AssistantState,
  PacingState,
  FreshnessMetadata,
  EngagementLevel,
  SeparationStatus,
  ClimaxProximity,
  PlantedSeed,
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
    stale_threshold_seconds: staleThresholdSeconds,
  };
}

/**
 * Manages pacing state lifecycle — timer computation, state transitions,
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

  // ── State Transitions ───────────────────────────────────────────────────

  get assistantState(): AssistantState { return this._state.assistant_state; }

  transitionTo(newState: AssistantState): void {
    this._state.assistant_state = newState;
  }

  startSession(): void {
    this._state.session_start = new Date().toISOString();
    this._state.assistant_state = AssistantState.PREGAME;
  }

  // ── Timer Computation ─────────────────────────────────────────────────

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

  /** Mark that P3 overrun has fired for the current scene (don't repeat). */
  markOverrunFired(): void {
    this._sceneOverrunFired.add(this._state.current_scene);
  }

  // ── Scene / Act Advancement ───────────────────────────────────────────

  advanceScene(sceneName: string, plannedMinutes = 0): void {
    const now = new Date().toISOString();
    this._state.current_scene = sceneName;
    this._state.scene_timing = {
      started_at: now,
      planned_max_minutes: plannedMinutes,
      elapsed_minutes: 0,
    };
    // Allow P3 to re-fire if GM revisits a scene (e.g. A1→A2→A1)
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

  // ── Spotlight / Engagement ────────────────────────────────────────────

  setSpotlight(player: string, debt: number): void {
    this._state.spotlight_debt[player] = debt;
    // Recalculate which players lack recent spotlight
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

  // ── Seeds / Threads ───────────────────────────────────────────────────

  addSeed(name: string, scene: string): void {
    this._state.planted_seeds.push({ name, planted_in_scene: scene, revealed: false });
  }

  revealSeed(name: string): void {
    const seed = this._state.planted_seeds.find(s => s.name === name);
    if (seed) seed.revealed = true;
  }

  addThread(thread: string): void {
    if (!this._state.open_threads.includes(thread)) {
      this._state.open_threads.push(thread);
    }
  }

  closeThread(thread: string): void {
    this._state.open_threads = this._state.open_threads.filter(t => t !== thread);
  }

  // ── Freshness ─────────────────────────────────────────────────────────

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
    // Wiki staleness is less critical — only warn if it's been a very long time
    return stale;
  }

  // ── Reset ─────────────────────────────────────────────────────────────

  reset(): void {
    this._state = createInitialPacingState();
    this._freshness = createInitialFreshness(this._freshness.stale_threshold_seconds);
    this._sceneOverrunFired.clear();
  }
}
