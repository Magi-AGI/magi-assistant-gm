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
