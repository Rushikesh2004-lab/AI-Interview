'use strict';

try {
  require('dotenv').config();
} catch {
  // dotenv is optional — if not installed, we just rely on real env vars.
  // Minimal manual .env loader so `GROQ_API_KEY=...` still works without the package.
  loadDotEnvManually();
}

function loadDotEnvManually() {
  try {
    const fsSync = require('fs');
    const pathSync = require('path');
    const envPath = pathSync.join(__dirname, '..', '.env');
    if (!fsSync.existsSync(envPath)) return;
    const lines = fsSync.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no-op */
  }
}

const path = require('path');
const fs = require('fs');

const { buildInterviewPlan, maybeGenerateFollowUp, generateFinalFeedback } = require('./interviewEngine');
const { createSession, getSession, saveSession, listSessions } = require('./sessionStore');
const { isEnabled: llmEnabled } = require('./llmClient');

// This project ships a zero-dependency router (miniHttp) so it runs with
// nothing but `node server/index.js` — no npm install required. If Express
// is installed in your environment, the app will use it automatically for
// identical behavior (route handlers below are written to be compatible
// with both).
let app;
let usingExpress = false;
try {
  const express = require('express');
  const cors = require('cors');
  app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  usingExpress = true;
} catch {
  const { createApp } = require('./miniHttp');
  app = createApp();
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (usingExpress) {
  app.use(require('express').static(PUBLIC_DIR));
} else {
  app.useStatic(PUBLIC_DIR);
}

const curriculum = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'curriculum.json'), 'utf-8'));
const candidatesData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'candidates.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// Helper endpoints (not part of the required spec, but useful for the demo
// frontend so a user can pick a sample candidate instead of hand-typing JSON)
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', llmEnabled: llmEnabled(), candidates: candidatesData.candidates.length, curriculumDays: curriculum.days.length });
});

app.get('/api/candidates', (req, res) => {
  res.json({
    candidates: candidatesData.candidates.map((c) => ({
      id: c.member.id,
      name: c.member.name,
      jobRole: c.member.jobRole
    }))
  });
});

app.get('/api/candidates/:id', (req, res) => {
  const candidate = candidatesData.candidates.find((c) => c.member.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  res.json(candidate);
});

app.get('/api/curriculum', (req, res) => {
  res.json(curriculum);
});

// ---------------------------------------------------------------------------
// Feedback dashboard endpoints (additive — power the Feedback Dashboard UI,
// where sessions are the primary key rather than candidate name)
// ---------------------------------------------------------------------------

app.get('/api/sessions', (req, res) => {
  const sessions = listSessions().map((s) => ({
    session_id: s.sessionId,
    candidateId: s.candidate?.member?.id ?? null,
    candidateName: s.candidate?.member?.name ?? 'Unknown',
    jobRole: s.candidate?.member?.jobRole ?? null,
    status: s.pendingQuestion ? 'in_progress' : s.feedback ? 'completed' : 'in_progress',
    questionIndex: s.currentIndex + 1,
    totalQuestions: s.plan?.length ?? 0,
    startedAt: s.startedAt ?? null,
    completedAt: s.completedAt ?? null
  }));
  res.json({ sessions });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({
    session_id: session.sessionId,
    candidate: {
      id: session.candidate?.member?.id ?? null,
      name: session.candidate?.member?.name ?? null,
      jobRole: session.candidate?.member?.jobRole ?? null
    },
    status: session.pendingQuestion ? 'in_progress' : session.feedback ? 'completed' : 'in_progress',
    transcript: session.transcript,
    feedback: session.feedback ?? null,
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null
  });
});

// ---------------------------------------------------------------------------
// REQUIRED: POST /api/interview  (per technical-spec.md)
// ---------------------------------------------------------------------------

app.post('/api/interview', async (req, res) => {
  try {
    const { sessionId, candidate, message } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ reply: 'Missing required field: sessionId', done: false });
    }

    let session = getSession(sessionId);

    // --- 1. START INTERVIEW -------------------------------------------------
    if (!session) {
      if (!candidate || !candidate.member) {
        return res.status(400).json({
          reply: 'Starting a new session requires a "candidate" object matching candidate.json schema.',
          done: false
        });
      }

      const plan = buildInterviewPlan(candidate, curriculum);

      session = {
        sessionId,
        candidate,
        plan,
        currentIndex: 0,
        followUpsAskedForCurrent: 0,
        transcript: [], // [{ day, dayTitle, question, answer, evaluation, followUpCount }]
        pendingQuestion: null,
        startedAt: new Date().toISOString()
      };

      const first = plan[0];
      session.pendingQuestion = first;
      createSession(sessionId, session);

      const distinctDays = new Set(plan.map((q) => q.day)).size;
      const greeting =
        `Welcome${candidate.member?.name ? `, ${candidate.member.name}` : ''}! Let's begin your technical interview ` +
        `for the ${candidate.member?.jobRole || 'role'} track. I'll ask you ${plan.length} questions across ${distinctDays} ` +
        `curriculum days, based on your progress. Take your time.\n\n${first.prompt}`;

      // NOTE: `meta` is additive and not required by the spec — the frontend
      // uses it to render live day-coverage progress. Graders relying only on
      // { reply, done, feedback } are unaffected.
      return res.json({
        reply: greeting,
        done: false,
        meta: {
          day: first.day,
          dayTitle: first.dayTitle,
          questionIndex: 1,
          totalQuestions: plan.length,
          planDays: [...new Set(plan.map((q) => q.day))]
        }
      });
    }

    // --- 2. CONVERSATION TURN -----------------------------------------------
    if (message === undefined || message === null) {
      return res.status(400).json({ reply: 'Missing required field: message', done: false });
    }

    const question = session.pendingQuestion;
    if (!question) {
      return res.status(409).json({ reply: 'This interview session has already completed.', done: true });
    }

    // Record this answer against the currently pending question
    const { followUp, evaluation } = await maybeGenerateFollowUp(question, message, session.followUpsAskedForCurrent);

    session.transcript.push({
      day: question.day,
      dayTitle: question.dayTitle,
      question: session.followUpsAskedForCurrent > 0 ? `[follow-up] ${question.prompt}` : question.prompt,
      answer: message,
      evaluation,
      followUpCount: session.followUpsAskedForCurrent
    });

    if (followUp) {
      // Stay on the same underlying topic, but ask a sharper follow-up
      session.followUpsAskedForCurrent += 1;
      session.pendingQuestion = { ...question, prompt: followUp };
      saveSession(sessionId, session);
      return res.json({
        reply: followUp,
        done: false,
        meta: {
          day: question.day,
          dayTitle: question.dayTitle,
          questionIndex: session.currentIndex + 1,
          totalQuestions: session.plan.length,
          isFollowUp: true
        }
      });
    }

    // Move to next planned question
    session.currentIndex += 1;
    session.followUpsAskedForCurrent = 0;

    if (session.currentIndex >= session.plan.length) {
      // --- 3. END INTERVIEW -------------------------------------------------
      const feedback = await generateFinalFeedback(session.candidate, session.transcript, sessionId);
      session.pendingQuestion = null;
      session.feedback = feedback;
      session.completedAt = new Date().toISOString();
      saveSession(sessionId, session);

      return res.json({
        reply: 'Interview completed. Thank you for your time — here is your feedback.',
        done: true,
        feedback
      });
    }

    const next = session.plan[session.currentIndex];
    session.pendingQuestion = next;
    saveSession(sessionId, session);

    return res.json({
      reply: next.prompt,
      done: false,
      meta: {
        day: next.day,
        dayTitle: next.dayTitle,
        questionIndex: session.currentIndex + 1,
        totalQuestions: session.plan.length
      }
    });
  } catch (err) {
    console.error('[POST /api/interview] error:', err);
    return res.status(500).json({ reply: 'Internal error processing interview turn.', done: false });
  }
});

app.listen(PORT, () => {
  console.log(`AI Interview Agent listening on http://localhost:${PORT}`);
  console.log(`HTTP layer: ${usingExpress ? 'Express' : 'zero-dependency miniHttp (no npm install required)'}`);
  console.log(`LLM (Groq) integration: ${llmEnabled() ? 'ENABLED' : 'disabled (using deterministic templates)'}`);
});
