# AI Interview Agent

An AI agent that conducts multi-turn technical interviews automatically,
generated from a candidate's real curriculum progress (`candidate.json` +
`curriculum.json`), with adaptive follow-ups and structured final feedback.

Built for the hackathon per `technical-spec.md` — exposes a single stateful
`POST /api/interview` endpoint and a lightweight chat frontend to demo it.

---

## Why it's built this way

- **Zero-dependency by default.** The backend runs with nothing but
  `node server/index.js` — no `npm install`, no registry access required.
  This matters at a hackathon where wifi/registry access is never guaranteed.
  If `express`/`cors`/`dotenv` happen to be installed, the server detects and
  uses them automatically (identical behavior) — see `server/miniHttp.js`.
- **LLM is optional, not required.** Every interview works fully offline
  with deterministic, curriculum-grounded question templates. Set
  `GROQ_API_KEY` to unlock LLM-generated follow-up questions and richer
  natural-language final feedback — the app gracefully falls back if the key
  is missing or the API call fails for any reason.
- **Questions are generated from real data, not hardcoded.** The interview
  plan is built per-candidate by cross-referencing their `missions` against
  `curriculum.json`, biased toward days that took multiple attempts (richer
  to probe) and spread across modules for breadth.

---

## Project structure

```
ai-interview-agent/
├── package.json
├── .env.example
├── README.md
├── API_SPEC.md
├── data/
│   ├── candidates.json      # provided: 20 sample candidates
│   └── curriculum.json      # provided: 31-day / 8-module curriculum
├── server/
│   ├── index.js             # HTTP routes, incl. required POST /api/interview
│   ├── miniHttp.js           # zero-dependency router (used if Express isn't installed)
│   ├── interviewEngine.js   # plan building, scoring, follow-ups, feedback
│   ├── llmClient.js         # optional Groq (OpenAI-compatible) integration
│   └── sessionStore.js      # in-memory session state
└── public/
    ├── index.html           # chat console UI
    ├── styles.css
    └── app.js
```

---

## Run it locally

**Requirements:** Node.js 18+ (uses the global `fetch` API). No other tools required.

```bash
cd ai-interview-agent

# optional — only needed if you want LLM-enhanced follow-ups/feedback
cp .env.example .env
# edit .env and set GROQ_API_KEY=your_key (get one free at https://console.groq.com)

node server/index.js
```

You should see:
```
AI Interview Agent listening on http://localhost:3000
HTTP layer: zero-dependency miniHttp (no npm install required)
LLM (Groq) integration: disabled (using deterministic templates)
```

Open **http://localhost:3000** — pick a sample candidate from the dropdown and click **Start interview**.

> If you *do* have registry access and prefer Express, `npm install` first (a
> standard `package.json` is included) — the server auto-detects and uses it.

---

## Sample run scenario (start → final feedback)

This mirrors exactly what the grader/demo will see hitting the required endpoint directly.

```bash
# 1. Start a session for CAND-002 (Alex Turner, Backend Software Engineer)
curl -s -X POST http://localhost:3000/api/interview \
  -H "Content-Type: application/json" \
  -d @<(python3 -c "
import json
c = json.load(open('data/candidates.json'))['candidates'][1]
print(json.dumps({'sessionId': 'demo-1', 'candidate': c}))
")
```
```json
{
  "reply": "Welcome, Alex Turner! Let's begin your technical interview for the Backend Software Engineer track. I'll ask you 12 questions across 6 curriculum days, based on your progress. Take your time.\n\nLet's talk about Day 7: \"Embeddings Explained\". In your own words, walk me through ...",
  "done": false,
  "meta": { "day": 7, "dayTitle": "Embeddings Explained", "questionIndex": 1, "totalQuestions": 12, "planDays": [7,10,12,13,22,31] }
}
```

```bash
# 2. Answer it — the agent scores the answer and either follows up or advances
curl -s -X POST http://localhost:3000/api/interview \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-1","message":"Embeddings map text into dense vectors so semantically similar text ends up close together. I used OpenAI embeddings with cosine similarity for a retrieval pipeline; a real pitfall is embedding drift after a model upgrade without re-indexing."}'
```
```json
{
  "reply": "Still on \"Embeddings Explained\" (Day 7) — you worked with Sentence Transformers, OpenAI Embeddings, Scikit-learn. Describe a concrete scenario where you'd apply this, and what could go wrong if you got it wrong.",
  "done": false,
  "meta": { "day": 7, "dayTitle": "Embeddings Explained", "questionIndex": 1, "totalQuestions": 12 }
}
```

```bash
# 3. ... continue answering (repeat step 2 with new "message" values) ...
# The interview automatically walks through 12 questions across 6 distinct
# curriculum days (7, 10, 12, 13, 22, 31), inserting a follow-up whenever an
# answer is short or misses the day's key terms.
```

```bash
# 4. Final turn returns done:true with structured feedback
```
```json
{
  "reply": "Interview completed. Thank you for your time — here is your feedback.",
  "done": true,
  "feedback": {
    "summary": "Alex Turner covered 6 curriculum day(s) across 12 question(s) for the \"Backend Software Engineer\" track. Overall the interview showed solid, demonstrable understanding of the material...",
    "strengths": ["Strong command of \"Embeddings Explained\" (Day 7) — answered clearly with concrete detail."],
    "gaps": ["\"Prompt Engineering Fundamentals\" (Day 12) answers were thin or needed follow-up prompting to get specifics."],
    "next": ["Revisit Day 12 (\"Prompt Engineering Fundamentals\") material and practice explaining it with a concrete example."]
  }
}
```

Full field reference and error responses: see `API_SPEC.md`.

---

## Feedback Dashboard

A second tab in the UI ("Feedback Dashboard") lists interview **sessions**
(not candidate names) and renders structured feedback per `session_id` —
open `http://localhost:3000`, click **Feedback Dashboard** in the top nav.

**Data shape the frontend consumes** (`GET /api/sessions/:sessionId`):
```json
{
  "session_id": "sess-A",
  "summary": "Brief, high-level assessment of the candidate.",
  "strengths": ["Strength A", "Strength B"],
  "gaps": ["Gap 1", "Gap 2"],
  "next": ["Recommended action 1", "Recommended action 2"]
}
```
Empty categories come back as `[]` and render as "None noted" rather than being backfilled with filler text.

**Component tree** (implemented in vanilla JS in `public/app.js`; maps directly to a React tree if you port it):
```
FeedbackDashboard                  (#pageDashboard)
├── SessionList                    (#sessionList — <ul>, one <button> per session)
│     └── SessionCard              (.session-card — session_id, name, role, status)
└── FeedbackCard                   (#feedbackDetail — <section aria-labelledby>)
      ├── Header                   (session_id heading + candidate name/role)
      ├── Summary                  (role="region" aria-label="Summary")
      └── StrengthsGapsNext grid   (3× <section aria-labelledby> each with a <ul>)
```

**Accessibility:**
- Tabs use `role="tablist"`/`role="tab"`/`aria-selected`, panels use `role="tabpanel"`.
- Each session button uses `aria-pressed` to reflect selection state.
- The feedback detail is a `<section aria-labelledby="feedbackDetailHeading">` so screen readers announce which session it's for.
- Strengths/gaps/next are real `<ul>/<li>` lists with `<h3 id=...>` + `aria-labelledby` on each section — never color-only distinctions (each column also has a text heading).

**Fetching + states:** `loadSessions()` fetches `/api/sessions` on tab switch; `selectSession(id)` fetches `/api/sessions/:id`. An in-progress session shows a "still in progress" message instead of the feedback grid; a 404 is handled by the `if (!res.ok) return;` guard (extend this with a visible error state if you need one).

**React port (pseudo-code)**, if you'd rather build this as components instead of vanilla JS:
```jsx
function FeedbackDashboard() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => { fetch('/api/sessions').then(r => r.json()).then(d => setSessions(d.sessions)); }, []);

  return (
    <div className="dashboard" role="tabpanel">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      {selectedId && <FeedbackCard sessionId={selectedId} />}
    </div>
  );
}

function FeedbackCard({ sessionId }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'error' | 'ready'

  useEffect(() => {
    setStatus('loading');
    fetch(`/api/sessions/${sessionId}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setData(d); setStatus('ready'); })
      .catch(() => setStatus('error'));
  }, [sessionId]);

  if (status === 'loading') return <p>Loading feedback…</p>;
  if (status === 'error') return <p role="alert">Couldn't load this session.</p>;
  if (!data.feedback) return <p>Session in progress — feedback appears once it's done.</p>;

  const { summary, strengths, gaps, next } = data.feedback;
  return (
    <section aria-labelledby="fc-heading">
      <h2 id="fc-heading">{data.session_id}</h2>
      <p>{summary}</p>
      <FeedbackList title="Strengths" items={strengths} />
      <FeedbackList title="Gaps" items={gaps} />
      <FeedbackList title="Next steps" items={next} />
    </section>
  );
}

function FeedbackList({ title, items }) {
  return (
    <section aria-labelledby={`${title}-heading`}>
      <h3 id={`${title}-heading`}>{title}</h3>
      {items.length === 0
        ? <p className="empty">None noted</p>
        : <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
    </section>
  );
}
```

**Styling/responsive behavior:** desktop uses a 320px session-list sidebar + main detail pane (2-column grid); below 860px it stacks into a top session list (scrollable, max-height 35vh) and a full-width detail pane below — same breakpoint and pattern already used for the interview console sidebar.

---

## Testing steps

### A. Automated end-to-end simulation

A quick way to exercise the full flow (start → N turns → feedback) without clicking through the UI:

```bash
node server/index.js &            # start the server
sleep 1
python3 - <<'PY'
import json, urllib.request

BASE = "http://localhost:3000"
def post(body):
    req = urllib.request.Request(BASE + "/api/interview", data=json.dumps(body).encode(),
                                  headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

candidate = json.load(urllib.request.urlopen(BASE + "/api/candidates/CAND-003"))
resp = post({"sessionId": "test-1", "candidate": candidate})
print("Q:", resp["reply"][:100])

good_answer = ("This concept centers on turning raw input into a structured representation "
               "that a downstream system can reason over — I've implemented this in production "
               "using the relevant tools, and the main trade-off is latency vs. accuracy.")

while not resp.get("done"):
    resp = post({"sessionId": "test-1", "message": good_answer})
    print(("FOLLOWUP " if resp.get("meta", {}).get("isFollowUp") else "Q: ") + resp["reply"][:100])

print("\nFEEDBACK:")
print(json.dumps(resp["feedback"], indent=2))
PY
kill %1
```

Sanity checks to confirm:
- The plan covers **≥ 8 questions across ≥ 4 distinct curriculum days** (`meta.planDays.length >= 4`, `meta.totalQuestions >= 8`).
- Short/vague answers trigger a follow-up (`meta.isFollowUp: true`) before advancing.
- The final response has `done: true` and a `feedback` object with all four required fields (`summary`, `strengths`, `gaps`, `next`).

### B. Manual UI test

1. `node server/index.js`
2. Open `http://localhost:3000`
3. Select any candidate (try **Alex Turner** — has several multi-attempt days, so you'll see probing questions and follow-ups) → **Start interview**
4. Answer a couple of questions tersely (e.g. "not sure") to see the adaptive follow-up trigger, then answer one thoroughly to see it skip straight to the next question.
5. Finish the interview and confirm the feedback panel renders `summary` / `strengths` / `gaps` / `next`.

### C. Error-path checks

```bash
curl -s -X POST http://localhost:3000/api/interview -H "Content-Type: application/json" -d '{}'
# → 400, { "reply": "Missing required field: sessionId", "done": false }

curl -s -X POST http://localhost:3000/api/interview -H "Content-Type: application/json" -d '{"sessionId":"x"}'
# → 400, { "reply": "Starting a new session requires a \"candidate\" object...", "done": false }
```

---

## Sample data population

`data/candidates.json` and `data/curriculum.json` are the exact files provided
by the hackathon organizers, copied in as-is — no transformation needed. The
server reads them once at boot. To point the app at different data, just
replace those two files (same schema) and restart.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js, zero-dep HTTP router (Express-compatible fallback) | No install step required for the demo |
| LLM | Groq API (OpenAI-compatible `/chat/completions`) | Optional — templated fallback always available |
| Frontend | Vanilla HTML/CSS/JS | No build step, single page |
| Persistence | In-memory session `Map` | Swap `server/sessionStore.js` for SQLite/Redis for production use |

---

## Extending

- **Persistence:** implement `server/sessionStore.js`'s four functions (`createSession`, `getSession`, `saveSession`, `deleteSession`) against SQLite/Redis — nothing else needs to change.
- **More question variety:** add more phrasing variants to `buildAppliedQuestion`/`buildConceptQuestion` in `server/interviewEngine.js`.
- **Different LLM provider:** `server/llmClient.js` targets Groq's OpenAI-compatible endpoint; point `GROQ_API_URL`/`GROQ_MODEL` at any compatible provider (OpenAI, Together, etc.) without code changes.
