/**
 * QA report quality regression suite.
 *
 * Covers the post-session QA report fixes from the 2026-05-04 handoff:
 *   - #32/#33 phonetic-discovery noise floor (PR 1)
 *   - #35 suppression bins + per-candidate sampling (PR 2)
 *   - #36 + Pattern 40 speaker enumeration / final-only / time-weighted share (PR 3b)
 *   - #34 Discord-channel advice fallback documentation (PR 4)
 *
 * Cases are synthetic but grounded in the contamination shapes called out in the
 * BG Session 9 Review Assistant subcard. Real S8/S9 snapshots, when captured,
 * land in test/fixtures/qa-regressions/<session-id>.json and are exercised at
 * the bottom of this file.
 *
 * Run: npm run test:qa  (or npx tsx test/qa-regressions.ts)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { isLikelyPhoneticDiscovery } from '../src/reasoning/triggers.js';
import type { PhoneticMatch } from '../src/matching/phonetic.js';
import {
  createSessionStats,
  recordSuppression,
  SUPPRESSED_SAMPLE_CAP,
  type SuppressedSample,
} from '../src/qa/session-stats.js';
import { formatQaReport, computeSpeakerStats, type QaReport } from '../src/qa/post-session.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function pm(input: string, canonical: string, similarity: number, matchType: 'metaphone' | 'jaro-winkler' = 'metaphone'): PhoneticMatch {
  return { input, canonical, similarity, matchType };
}

// ═══════════════════════════════════════════════════════════════════════════
// PR 1 — phonetic discovery noise floor (#32 + #33)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── PR 1: phonetic-discovery predicate ──────────────────────');

// True positives — these should be recorded.

assert(
  isLikelyPhoneticDiscovery(
    'so the lyzooli pronounced lie zoo lee is what the penshral call them',
    pm('liezoolee', 'lyzooli', 0.78),
  ) === false,
  'true canonical present in segment is suppressed (canonical-verbatim guard)',
);

assert(
  isLikelyPhoneticDiscovery(
    'the lizoli is hunting them through the corridor',
    pm('lizoli', 'lyzooli', 0.82, 'metaphone'),
  ),
  'metaphone match ≥0.7 with no contamination is recorded',
);

assert(
  isLikelyPhoneticDiscovery(
    'i think we should call the vykore for backup',
    pm('vykore', 'vaelkor', 0.74, 'metaphone'),
  ),
  'metaphone match in clean prose is recorded',
);

// Threshold rejections.

assert(
  !isLikelyPhoneticDiscovery(
    'maybe the librari can help us',
    pm('librari', 'lyzooli', 0.68, 'metaphone'),
  ),
  'metaphone match below 0.7 floor is rejected',
);

assert(
  !isLikelyPhoneticDiscovery(
    'penny is going to the market today',
    pm('penny', 'penshral', 0.81, 'jaro-winkler'),
  ),
  'jaro-winkler-only match below 0.85 floor is rejected',
);

assert(
  isLikelyPhoneticDiscovery(
    'penshrol elder is approaching',
    pm('penshrol', 'penshral', 0.88, 'jaro-winkler'),
  ),
  'jaro-winkler-only match ≥0.85 is recorded',
);

// Spelling cue rejections (S9 contamination class 1: name-spelling aside).

assert(
  !isLikelyPhoneticDiscovery(
    'the name is spelled l y z o o l i',
    pm('lizoli', 'lyzooli', 0.80, 'metaphone'),
  ),
  '"spelled" cue suppresses discovery',
);

assert(
  !isLikelyPhoneticDiscovery(
    "that's l y z o o l i in the rulebook",
    pm('lizoli', 'lyzooli', 0.80, 'metaphone'),
  ),
  '"that\'s X Y Z" letter-by-letter cue suppresses discovery',
);

assert(
  !isLikelyPhoneticDiscovery(
    'l-y-z-o-o-l-i is the canonical spelling',
    pm('lizoli', 'lyzooli', 0.80, 'metaphone'),
  ),
  'dash-separated letter sequence suppresses discovery',
);

// Fate readout rejections (S9 contamination class 2).

assert(
  !isLikelyPhoneticDiscovery(
    "i'm gonna roll fight plus 2 against the vaelker",
    pm('vaelker', 'vaelkor', 0.83, 'metaphone'),
  ),
  '"plus 2" Fate readout suppresses discovery',
);

assert(
  !isLikelyPhoneticDiscovery(
    'rolling at minus 1 to engage the lizoli',
    pm('lizoli', 'lyzooli', 0.80, 'metaphone'),
  ),
  '"minus 1" Fate readout suppresses discovery',
);

assert(
  !isLikelyPhoneticDiscovery(
    'the fate ladder says good for plus 3',
    pm('lader', 'leader', 0.82, 'metaphone'),
  ),
  '"ladder" suppresses discovery (Fate context)',
);

// Non-Fate plus-number false positives — make sure innocent text still records.

assert(
  isLikelyPhoneticDiscovery(
    'we found the vykore artifact in the ruins',
    pm('vykore', 'vaelkor', 0.74, 'metaphone'),
  ),
  'clean fiction text without Fate cues still records',
);

// ═══════════════════════════════════════════════════════════════════════════
// PR 2 — suppression bins + reservoir sampling (#35)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── PR 2: recordSuppression and reservoir sampling ──────────');

function sample(reason: SuppressedSample['reason'], extra: Partial<SuppressedSample> = {}): SuppressedSample {
  return {
    reason,
    timestamp: '2026-05-05T12:00:00.000Z',
    eventTypes: ['gm_question'],
    priority: 1,
    ...extra,
  };
}

{
  const stats = createSessionStats();
  recordSuppression(stats, sample('already_covered', { adviceTag: 'PACING' }));
  recordSuppression(stats, sample('duplicate'));
  recordSuppression(stats, sample('timing_window', { gateValues: { gate: 'flowing_rp' } }));
  recordSuppression(stats, sample('below_confidence'));
  recordSuppression(stats, sample('already_covered'));

  assert(stats.adviceSuppressed === 5, 'adviceSuppressed counts every recorded suppression');
  assert(stats.suppressedByReason.already_covered === 2, 'already_covered bin sums correctly');
  assert(stats.suppressedByReason.duplicate === 1, 'duplicate bin');
  assert(stats.suppressedByReason.timing_window === 1, 'timing_window bin');
  assert(stats.suppressedByReason.below_confidence === 1, 'below_confidence bin');
  assert(
    stats.adviceSuppressed === Object.values(stats.suppressedByReason).reduce((a, b) => a + b, 0),
    'adviceSuppressed equals sum of bins',
  );
  assert(stats.suppressedSamples.length === 5, 'all samples kept under cap');
}

{
  // Reservoir sampling: under cap, every sample retained.
  const stats = createSessionStats();
  for (let i = 0; i < SUPPRESSED_SAMPLE_CAP; i++) {
    recordSuppression(stats, sample('duplicate', { adviceTag: `T${i}` }));
  }
  assert(
    stats.suppressedSamples.length === SUPPRESSED_SAMPLE_CAP,
    `under-cap fill keeps all ${SUPPRESSED_SAMPLE_CAP} samples`,
  );

  // Beyond cap: reservoir size stays at cap, count keeps growing.
  for (let i = 0; i < 50; i++) {
    recordSuppression(stats, sample('duplicate', { adviceTag: `O${i}` }));
  }
  assert(
    stats.suppressedSamples.length === SUPPRESSED_SAMPLE_CAP,
    'over-cap reservoir stays at cap size',
  );
  assert(stats.suppressedSeenCount === SUPPRESSED_SAMPLE_CAP + 50, 'suppressedSeenCount tracks all suppressions');
  assert(stats.adviceSuppressed === SUPPRESSED_SAMPLE_CAP + 50, 'adviceSuppressed continues counting past cap');
}

{
  // Determinism: with random=()=>0 the first cap entries are filled, then every
  // subsequent suppression replaces index 0 (since floor(0 * seenCount) === 0).
  const stats = createSessionStats();
  for (let i = 0; i < SUPPRESSED_SAMPLE_CAP; i++) {
    recordSuppression(stats, sample('duplicate', { adviceTag: `under_${i}` }), () => 0);
  }
  recordSuppression(stats, sample('duplicate', { adviceTag: 'overflow' }), () => 0);
  assert(
    stats.suppressedSamples[0].adviceTag === 'overflow',
    'random=0 → overflow replaces index 0 (Algorithm R)',
  );
  assert(
    stats.suppressedSamples[1].adviceTag === 'under_1',
    'random=0 → indices ≥1 untouched on overflow',
  );
}

// formatQaReport surfaces bins and sampled suppressions.

console.log('\n── PR 2: formatQaReport bin/sample lines ───────────────────');

{
  const stats = createSessionStats();
  stats.adviceDelivered = 7;
  stats.adviceViaFoundry = 7;
  recordSuppression(stats, sample('already_covered', { adviceTag: 'PACING', adviceText: 'consider intercut' }));
  recordSuppression(stats, sample('already_covered'));
  recordSuppression(stats, sample('duplicate', { adviceTag: 'NPC' }));
  recordSuppression(stats, sample('timing_window', { eventTypes: ['gm_hesitation'], priority: 3, gateValues: { gate: 'flowing_rp' } }));
  recordSuppression(stats, sample('below_confidence'));

  const report: QaReport = {
    durationMinutes: 240,
    segmentCount: 1500,
    speakerCount: 4,
    speakerDistribution: { GM: 100, P1: 50, P2: 30, P3: 20 },
    stats,
    phoneticDiscoveries: [],
    fuzzyTableDelta: {},
    fuzzyTablePersisted: false,
  };

  const formatted = formatQaReport(report);
  assert(formatted.includes('Suppressed: 5'), 'report shows total suppression count');
  assert(formatted.includes('already-covered: 2'), 'report shows already-covered bin');
  assert(formatted.includes('duplicate: 1'), 'report shows duplicate bin');
  assert(formatted.includes('timing-window: 1'), 'report shows timing-window bin');
  assert(formatted.includes('below-confidence: 1'), 'report shows below-confidence bin');
  assert(formatted.includes('Sampled suppressions:'), 'report includes sampled suppression header');
  assert(formatted.includes('flowing_rp'), 'sample renders gate value');
  assert(formatted.includes('[PACING]'), 'sample renders advice tag when present');
  assert(formatted.includes('"consider intercut"'), 'sample renders advice text snippet');
}

// ═══════════════════════════════════════════════════════════════════════════
// PR 3b — speaker enumeration + final-only + time-weighted (#36 + Pattern 40)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── PR 3b: computeSpeakerStats ──────────────────────────────');

function transcriptRow(
  speaker: { displayName?: string; userId?: string },
  startSec: number,
  durSec: number,
  isFinal: boolean,
): any {
  const start = new Date(Date.UTC(2026, 4, 5, 21, 0, startSec)).toISOString();
  const end = new Date(Date.UTC(2026, 4, 5, 21, 0, startSec + durSec)).toISOString();
  return {
    type: 'transcript',
    timestamp: start,
    segmentEnd: end,
    userId: speaker.userId ?? null,
    displayName: speaker.displayName ?? null,
    content: 'sample',
    isFinal,
  };
}

{
  // Pattern 40: same speaker emits 1 final and 4 interims for the same phrase.
  // segmentsAll inflates 5x; segmentsFinal stays accurate; speakingMs uses
  // the final's duration only.
  const lake = { displayName: 'Lake' };
  const honeybear = { displayName: 'Honeybear' };
  const timeline = [
    transcriptRow(lake, 0, 10, false),
    transcriptRow(lake, 0, 10, false),
    transcriptRow(lake, 0, 10, false),
    transcriptRow(lake, 0, 10, false),
    transcriptRow(lake, 0, 10, true),
    transcriptRow(honeybear, 11, 5, false),
    transcriptRow(honeybear, 11, 5, true),
  ];

  const stats = computeSpeakerStats(timeline);
  assert(stats.Lake.segmentsAll === 5, 'Lake all-segments inflated by interims (5)');
  assert(stats.Lake.segmentsFinal === 1, 'Lake final-only is 1');
  assert(stats.Lake.speakingMs === 10_000, 'Lake speakingMs from final segment duration');
  assert(stats.Honeybear.segmentsAll === 2, 'Honeybear all-segments (2)');
  assert(stats.Honeybear.segmentsFinal === 1, 'Honeybear final-only is 1');
  assert(stats.Honeybear.speakingMs === 5_000, 'Honeybear speakingMs from final segment duration');
}

{
  // QA #36 early-leaver: Rachel speaks during the first half then disconnects.
  // She should still appear in the speaker enumeration (not filtered by an
  // end-of-session active check).
  const rachel = { displayName: 'Rachel' };
  const russell = { displayName: 'Russell' };
  const timeline = [
    transcriptRow(rachel, 0, 8, true),
    transcriptRow(rachel, 30, 6, true),
    // Rachel disconnects here.
    transcriptRow(russell, 60, 10, true),
    transcriptRow(russell, 90, 10, true),
    transcriptRow(russell, 120, 10, true),
  ];

  const stats = computeSpeakerStats(timeline);
  assert('Rachel' in stats, 'early-leaver Rachel still enumerated post-session');
  assert(stats.Rachel.segmentsFinal === 2, 'Rachel final segment count is correct');
  assert(stats.Rachel.speakingMs === 14_000, 'Rachel airtime sums her final-segment durations');
}

{
  // Rows missing segmentEnd contribute 0 ms airtime, but still count toward
  // segmentsFinal — so the airtime metric degrades gracefully on legacy data
  // without polluting segment counts.
  const lake = { displayName: 'Lake' };
  const timeline: any[] = [
    transcriptRow(lake, 0, 10, true),
    { type: 'transcript', timestamp: new Date().toISOString(), segmentEnd: null, userId: 'u', displayName: 'Lake', content: 'x', isFinal: true },
  ];
  const stats = computeSpeakerStats(timeline);
  assert(stats.Lake.segmentsFinal === 2, 'final segments counted even when segmentEnd is null');
  assert(stats.Lake.speakingMs === 10_000, 'segmentEnd=null contributes 0 ms airtime');
}

{
  // Text events should be ignored when computing speaker stats.
  const lake = { displayName: 'Lake' };
  const timeline: any[] = [
    transcriptRow(lake, 0, 5, true),
    { type: 'text', timestamp: new Date().toISOString(), userId: 'u', displayName: 'Lake', content: 'typed' },
  ];
  const stats = computeSpeakerStats(timeline);
  assert(stats.Lake.segmentsAll === 1, 'text-channel rows do not increment segmentsAll');
}

// formatQaReport renders three-metric rows when speakerStats is present.

console.log('\n── PR 3b: formatQaReport speaker block ─────────────────────');

{
  const stats = createSessionStats();
  stats.adviceDelivered = 7;
  const report: QaReport = {
    durationMinutes: 240,
    segmentCount: 9,
    speakerCount: 3,
    speakerDistribution: { Lake: 5, Honeybear: 2, Russell: 2 },
    speakerStats: {
      Lake:      { segmentsAll: 5, segmentsFinal: 1, speakingMs: 30_000 },
      Honeybear: { segmentsAll: 2, segmentsFinal: 1, speakingMs: 25_000 },
      Russell:   { segmentsAll: 2, segmentsFinal: 1, speakingMs: 25_000 },
    },
    speakerStatsSource: 'mcp_timeline',
    stats,
    phoneticDiscoveries: [],
    fuzzyTableDelta: {},
    fuzzyTablePersisted: false,
  };

  const formatted = formatQaReport(report);
  assert(formatted.includes('all-seg / final-only / airtime'), 'speaker header lists all three metrics');
  assert(formatted.includes('Lake: 56% / 33% / 38%'), 'Lake renders three percentages');
  assert(!formatted.includes('source: mcp_timeline'), 'mcp_timeline source label suppressed (preferred path)');

  // Fallback path surfaces the source label so a reader knows the metric is
  // running on the legacy in-memory accumulator (single column).
  const fallback: QaReport = { ...report, speakerStats: undefined, speakerStatsSource: 'realtime_stats' };
  const fallbackFormatted = formatQaReport(fallback);
  assert(fallbackFormatted.includes('Speakers:'), 'fallback renders single-metric Speakers row');
  assert(!fallbackFormatted.includes('all-seg / final-only / airtime'), 'fallback omits three-metric header');
}

// ═══════════════════════════════════════════════════════════════════════════
// PR 4 — Discord-channel advice fallback documentation (#34)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── PR 4: Discord-fallback row in formatQaReport ────────────');

function reportWith(
  adviceDelivered: number,
  adviceViaFoundry: number,
  adviceViaDiscord: number,
): QaReport {
  const stats = createSessionStats();
  stats.adviceDelivered = adviceDelivered;
  stats.adviceViaFoundry = adviceViaFoundry;
  stats.adviceViaDiscord = adviceViaDiscord;
  return {
    durationMinutes: 240,
    segmentCount: 100,
    speakerCount: 1,
    speakerDistribution: { GM: 100 },
    stats,
    phoneticDiscoveries: [],
    fuzzyTableDelta: {},
    fuzzyTablePersisted: false,
  };
}

{
  // BG S8/S9 healthy case: Foundry stayed up the whole session, Discord 0.
  const formatted = formatQaReport(reportWith(7, 7, 0));
  assert(formatted.includes('Foundry: 7'), 'Foundry count rendered');
  assert(!formatted.includes('Discord:'), 'zero Discord-fallback count is suppressed (healthy state)');
  assert(!formatted.includes('Discord (fallback): 0'), 'no Discord (fallback): 0 line');
}

{
  // Foundry-down session: fallback fired, label it explicitly.
  const formatted = formatQaReport(reportWith(5, 2, 3));
  assert(formatted.includes('Foundry: 2'), 'Foundry count rendered');
  assert(formatted.includes('Discord (fallback): 3'), 'non-zero Discord renders with (fallback) label');
}

{
  // No advice delivered at all: row is omitted entirely.
  const formatted = formatQaReport(reportWith(0, 0, 0));
  assert(!formatted.includes('Foundry:'), 'no advice delivered → row omitted');
}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot-driven regressions (real session data, when captured)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── snapshots: real session data ────────────────────────────');

const FIXTURE_DIR = path.resolve(process.cwd(), 'test', 'fixtures', 'qa-regressions');

interface PhoneticDiscoveryFixture {
  sessionId: string;
  expectedMaxContaminationPct: number;
  cases: Array<{
    label: string;
    textLower: string;
    pm: PhoneticMatch;
    /** true = handoff says this should be recorded; false = contamination, predicate must reject. */
    isTruePositive: boolean;
  }>;
}

if (!existsSync(FIXTURE_DIR)) {
  console.log('  (no fixtures captured yet — skipping; see test/fixtures/qa-regressions/README.md)');
} else {
  const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('  (no fixtures captured yet)');
  }
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as PhoneticDiscoveryFixture;
    let kept = 0;
    let truePositiveKept = 0;
    let falsePositiveKept = 0;
    for (const c of fixture.cases) {
      const recorded = isLikelyPhoneticDiscovery(c.textLower, c.pm);
      if (recorded) {
        kept++;
        if (c.isTruePositive) truePositiveKept++;
        else falsePositiveKept++;
      }
    }
    const contaminationPct = kept > 0 ? Math.round((falsePositiveKept / kept) * 100) : 0;
    assert(
      contaminationPct <= fixture.expectedMaxContaminationPct,
      `${fixture.sessionId}: contamination ${contaminationPct}% ≤ ${fixture.expectedMaxContaminationPct}% (kept ${kept}, of which ${truePositiveKept} TP / ${falsePositiveKept} FP)`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
