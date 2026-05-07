# QA regression fixtures

Snapshot inputs for `test/qa-regressions.ts`, captured from real prod sessions.
Each fixture lets the regression suite check that the QA-report predicates
behave as expected against a known session's actual data.

## Phonetic discovery fixtures

File shape (one per session, e.g. `bg-s9-8f61069f.json`):

```json
{
  "sessionId": "8f61069f-9c2c-4348-a221-6fa4911b1d76",
  "expectedMaxContaminationPct": 10,
  "cases": [
    {
      "label": "Lyzooli pronounced lie-zoo-lee",
      "textLower": "...transcript segment text, lowercase...",
      "pm": { "input": "liezoolee", "canonical": "lyzooli", "similarity": 0.78, "matchType": "metaphone" },
      "isTruePositive": true
    },
    {
      "label": "Lake spelling out the canonical (S9 contamination case 1)",
      "textLower": "the name is spelled l y z o o l i",
      "pm": { "input": "lizoli", "canonical": "lyzooli", "similarity": 0.80, "matchType": "metaphone" },
      "isTruePositive": false
    }
  ]
}
```

`isTruePositive: true` means the human review classified this as a real
phonetic discovery (predicate must keep it). `false` means contamination
(predicate must drop it). The suite asserts:

```
falsePositivesKept / totalKept ≤ expectedMaxContaminationPct
```

## Capturing a fixture

There is no automated snapshot writer yet. To capture S8/S9:

1. Pull the four phonetic discoveries logged by the post-session QA report for
   that session (from prod logs or the QA report message body).
2. For each, look up the source `transcript_segments.transcript` row that
   produced it (search by the `input` token) and copy the full segment text.
3. Mark each `isTruePositive` per the wiki review subcard (e.g., the
   `Session 9 Review Assistant` card classified 1 of 4 as a true discovery
   and 3 as contamination).
4. Save as `test/fixtures/qa-regressions/<session-key>.json` with
   `expectedMaxContaminationPct: 10` (per the handoff DoD).

The S9 review explicitly cites "Lyzooli pronounced 'lie-ZOO-lee'" as the only
true positive. Once that fixture lands, every PR 1 commit is gated against
real data instead of synthetic cases alone.
