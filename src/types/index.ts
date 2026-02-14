export interface GmAdvice {
  trigger: 'question' | 'game_event' | 'heartbeat' | 'on_demand';
  context: string;
  advice: string;
  confidence: number;
  sources: string[];
  createdAt: string;
}

export interface TriggerEvent {
  type: 'question' | 'game_event' | 'heartbeat' | 'on_demand';
  source: string;
  priority: number;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface TriggerBatch {
  events: TriggerEvent[];
  flushedAt: string;
}

export interface AssembledContext {
  systemPrompt: string;
  triggerSummary: string;
  recentTranscript: string;
  gameState: string;
  tools: unknown[];
  estimatedTokens: number;
}
