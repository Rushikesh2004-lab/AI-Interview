# API Specification

Implements the contract required by `technical-spec.md`, plus a small set of
additive helper endpoints used by the bundled frontend.

Base URL (local): `http://localhost:3000`

---

## Required endpoint

### `POST /api/interview`

Single stateful endpoint. Behavior branches on session existence and payload shape, exactly per spec.

#### 1. Start a session

Request:
```json
{
  "sessionId": "abc-123",
  "candidate": {
    "member": { "id": "CAND-002", "name": "Alex Turner", "jobRole": "Backend Software Engineer", "yearsExperience": 5, "education": "B.Tech Computer Science", "status": "COMPLETED" },
    "missions": [
      { "day": 7, "title": "Embeddings Explained", "passed": true, "attempts": 3 },
      { "day": 8, "title": "Vector Databases Overview", "passed": true, "attempts": 2 }
    ],
    "signals": { "commitDays": 22, "missionsCompleted": 29, "missionsFirstTry": 10 }
  }
}
```

Response `200`:
```json
{
  "reply": "Welcome, Alex Turner! Let's begin your technical interview for the Backend Software Engineer track. I'll ask you 12 questions across 6 curriculum days, based on your progress. Take your time.\n\nLet's talk about Day 7: \"Embeddings Explained\". In your own words, walk me through ...",
  "done": false,
  "meta": {
    "day": 7,
    "dayTitle": "Embeddings Explained",
    "questionIndex": 1,
    "totalQuestions": 12,
    "planDays": [7, 10, 12, 13, 22, 31]
  }
}
```
> `meta` is additive (not in the required spec) and only used by the bundled frontend to render live progress. Any consumer that only reads `reply`/`done`/`feedback` is unaffected.

#### 2. Conversation turn

Request:
```json
{ "sessionId": "abc-123", "message": "Embeddings turn text into vectors that capture semantic meaning..." }
```

Response `200` (mid-interview):
```json
{
  "reply": "Still on \"Embeddings Explained\" (Day 7) — you worked with Sentence Transformers, OpenAI Embeddings. Describe a concrete scenario where you'd apply this, and what could go wrong if you got it wrong.",
  "done": false,
  "meta": { "day": 7, "dayTitle": "Embeddings Explained", "questionIndex": 1, "totalQuestions": 12 }
}
```

#### 3. End of interview

Response `200` (final turn):
```json
{
  "reply": "Interview completed. Thank you for your time — here is your feedback.",
  "done": true,
  "feedback": {
    "summary": "Alex Turner covered 6 curriculum day(s) across 12 question(s) for the \"Backend Software Engineer\" track...",
    "strengths": ["Strong command of \"Embeddings Explained\" (Day 7) — answered clearly with concrete detail."],
    "gaps": ["\"Prompt Engineering Fundamentals\" (Day 12) answers were thin or needed follow-up prompting."],
    "next": ["Revisit Day 12 material and practice explaining it with a concrete example."]
  }
}
```

#### Error responses

| Condition | Status | Body |
|---|---|---|
| Missing `sessionId` | 400 | `{ "reply": "Missing required field: sessionId", "done": false }` |
| New session without `candidate` | 400 | `{ "reply": "Starting a new session requires a \"candidate\" object...", "done": false }` |
| Turn on existing session missing `message` | 400 | `{ "reply": "Missing required field: message", "done": false }` |
| Turn sent after interview already completed | 409 | `{ "reply": "This interview session has already completed.", "done": true }` |
| Unexpected server error | 500 | `{ "reply": "Internal error processing interview turn.", "done": false }` |

---

## Feedback is keyed by `session_id`

The four required feedback fields never change shape — `summary` (string),
`strengths`/`gaps`/`next` (string arrays, empty when nothing applies). The
feedback object returned in the final `POST /api/interview` response is
additionally stamped with `session_id`, so it can be stored, looked up, or
displayed per-session rather than per-candidate-name (a candidate can run
multiple interview sessions over time):

```json
{
  "session_id": "sess-A",
  "summary": "Sarah Johnson covered 5 curriculum day(s) across 15 question(s)...",
  "strengths": ["Strong command of \"Embeddings Explained\" (Day 7)..."],
  "gaps": [],
  "next": []
}
```

## Helper endpoints (additive, not required by spec)

### `GET /health`
```json
{ "status": "ok", "llmEnabled": false, "candidates": 20, "curriculumDays": 31 }
```

### `GET /api/candidates`
Lightweight list for populating a picker UI.
```json
{ "candidates": [{ "id": "CAND-001", "name": "Sarah Johnson", "jobRole": "Senior Data Engineer" }, ...] }
```

### `GET /api/candidates/:id`
Returns the full candidate object (matches `candidate.json` schema) for the given id, straight from `data/candidates.json`.

### `GET /api/curriculum`
Returns the full 31-day curriculum object from `data/curriculum.json`.

### `GET /api/sessions`
Lists all sessions in memory, keyed by `session_id` — powers the Feedback Dashboard's session list.
```json
{
  "sessions": [
    {
      "session_id": "sess-A",
      "candidateId": "CAND-001",
      "candidateName": "Sarah Johnson",
      "jobRole": "Senior Data Engineer",
      "status": "completed",
      "questionIndex": 16,
      "totalQuestions": 15,
      "startedAt": "2026-08-09T08:44:32.687Z",
      "completedAt": "2026-08-09T08:44:32.722Z"
    }
  ]
}
```

### `GET /api/sessions/:sessionId`
Full detail for one session, including the transcript and feedback (`feedback: null` while still in progress).
```json
{
  "session_id": "sess-A",
  "candidate": { "id": "CAND-001", "name": "Sarah Johnson", "jobRole": "Senior Data Engineer" },
  "status": "completed",
  "transcript": [ { "day": 7, "dayTitle": "Embeddings Explained", "question": "...", "answer": "...", "evaluation": { "words": 42, "coverage": 0.2, "score": "strong" }, "followUpCount": 0 } ],
  "feedback": { "session_id": "sess-A", "summary": "...", "strengths": [], "gaps": [], "next": [] },
  "startedAt": "2026-08-09T08:44:32.687Z",
  "completedAt": "2026-08-09T08:44:32.722Z"
}
```

---

## Adaptivity model (how questions/follow-ups are chosen)

1. **Plan build (on session start):** the candidate's `missions` are cross-referenced against `curriculum.json`. Passed days are ranked by attempts (struggle signal) and spread across modules to guarantee ≥4 distinct days; each selected day contributes a conceptual question + an applied/practical question, plus a probing "what made attempt N work" question if the candidate needed 3+ attempts. One skipped day (if any) becomes a gap-check question. The plan always contains ≥8 questions.
2. **Per-turn scoring:** each answer is scored on length and keyword overlap with the day's `tools`/`objectives` → `weak` / `adequate` / `strong`.
3. **Follow-ups:** a `weak`/`adequate` answer triggers exactly one follow-up question (LLM-generated if `GROQ_API_KEY` is set, otherwise a deterministic template) before moving on. A `strong` answer moves straight to the next planned question.
4. **Final feedback:** synthesized from the full transcript — LLM (Groq) if configured, otherwise a heuristic pass over per-day scores and the candidate's own `signals` (first-try ratio, commit days).
