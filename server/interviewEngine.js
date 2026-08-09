'use strict';

const { chatComplete, safeParseJson } = require('./llmClient');

const MIN_QUESTIONS = 8;
const MIN_DAYS = 4;
const MAX_FOLLOWUPS_PER_QUESTION = 1;
const SHORT_ANSWER_WORD_THRESHOLD = 12;

// ---------------------------------------------------------------------------
// 1. INTERVIEW PLAN BUILDING
// ---------------------------------------------------------------------------

/**
 * Build an ordered list of "planned questions" from the candidate's mission
 * history cross-referenced against the curriculum, biased toward:
 *  - days the candidate actually completed (relevant, provable knowledge)
 *  - days that took multiple attempts or were skipped (good probing depth)
 *  - broad module coverage (>= 4 distinct days, >= 8 questions overall)
 */
function buildInterviewPlan(candidate, curriculum) {
  const curriculumByDay = new Map(curriculum.days.map((d) => [d.day, d]));
  const missions = candidate.missions || [];

  const passedDays = missions
    .filter((m) => m.passed)
    .map((m) => ({
      ...m,
      curriculum: curriculumByDay.get(m.day)
    }))
    .filter((m) => m.curriculum);

  const skippedDays = missions
    .filter((m) => m.skipped)
    .map((m) => ({ ...m, curriculum: curriculumByDay.get(m.day) }))
    .filter((m) => m.curriculum);

  // Rank passed days: struggle signal (more attempts = richer to probe) first,
  // then spread across later/advanced modules.
  const ranked = [...passedDays].sort((a, b) => {
    const attemptsDiff = (b.attempts || 1) - (a.attempts || 1);
    if (attemptsDiff !== 0) return attemptsDiff;
    return b.day - a.day;
  });

  // Ensure day diversity: pick a spread across module ranges rather than
  // clustering, then fill remaining slots by rank.
  const selectedDays = [];
  const seenDays = new Set();
  const targetDayCount = Math.max(MIN_DAYS, Math.min(6, ranked.length));

  // Spread pass: take every Nth ranked day to diversify modules
  const step = Math.max(1, Math.floor(ranked.length / targetDayCount));
  for (let i = 0; i < ranked.length && selectedDays.length < targetDayCount; i += step) {
    const item = ranked[i];
    if (!seenDays.has(item.day)) {
      selectedDays.push(item);
      seenDays.add(item.day);
    }
  }
  // Fill pass: top up if spread pass came up short
  for (const item of ranked) {
    if (selectedDays.length >= targetDayCount) break;
    if (!seenDays.has(item.day)) {
      selectedDays.push(item);
      seenDays.add(item.day);
    }
  }
  selectedDays.sort((a, b) => a.day - b.day);

  const plan = [];
  for (const dayInfo of selectedDays) {
    const c = dayInfo.curriculum;
    const struggled = (dayInfo.attempts || 1) >= 3;

    // Question 1: conceptual, grounded in the day's core objective
    plan.push({
      day: c.day,
      dayTitle: c.title,
      kind: 'concept',
      tools: c.tools,
      objectives: c.objectives,
      attempts: dayInfo.attempts || 1,
      prompt: buildConceptQuestion(c)
    });

    // Question 2: applied/practical, grounded in tools used that day
    plan.push({
      day: c.day,
      dayTitle: c.title,
      kind: 'applied',
      tools: c.tools,
      objectives: c.objectives,
      attempts: dayInfo.attempts || 1,
      prompt: buildAppliedQuestion(c)
    });

    // Bonus probing question if the candidate struggled (multiple attempts)
    if (struggled) {
      plan.push({
        day: c.day,
        dayTitle: c.title,
        kind: 'probe',
        tools: c.tools,
        objectives: c.objectives,
        attempts: dayInfo.attempts || 1,
        prompt: buildProbeQuestion(c, dayInfo.attempts)
      });
    }
  }

  // Gap-check question: one skipped day, if any, to see if the candidate
  // can still speak to material they didn't formally complete.
  if (skippedDays.length > 0) {
    const c = skippedDays[0].curriculum;
    plan.push({
      day: c.day,
      dayTitle: c.title,
      kind: 'gap-check',
      tools: c.tools,
      objectives: c.objectives,
      attempts: 0,
      prompt: `I see "${c.title}" (Day ${c.day}) was marked as skipped in your curriculum. ` +
        `Even without formally completing it, what's your understanding of ${firstObjectiveLower(c)}?`
    });
  }

  // Guarantee minimum count by recycling additional applied angles on
  // whichever days we already selected (rare edge case for very short profiles).
  let guardIterations = 0;
  while (plan.length < MIN_QUESTIONS && guardIterations < 20) {
    const c = selectedDays[guardIterations % selectedDays.length]?.curriculum;
    if (!c) break;
    plan.push({
      day: c.day,
      dayTitle: c.title,
      kind: 'applied',
      tools: c.tools,
      objectives: c.objectives,
      attempts: 1,
      prompt: buildAppliedQuestion(c, guardIterations)
    });
    guardIterations++;
  }

  return plan;
}

function firstObjectiveLower(curriculumDay) {
  const obj = curriculumDay.objectives?.[0] || curriculumDay.title;
  return obj.charAt(0).toLowerCase() + obj.slice(1);
}

function buildConceptQuestion(c) {
  const objective = c.objectives?.[0] || c.title;
  return `Let's talk about Day ${c.day}: "${c.title}". In your own words, walk me through ${firstObjectiveLower(c)}. What's the core idea, and why does it matter?`;
}

function buildAppliedQuestion(c, variantSeed = 0) {
  const tools = c.tools && c.tools.length ? c.tools : ['the tools from that module'];
  const toolList = tools.slice(0, 3).join(', ');
  const objective = c.objectives?.[Math.min(1, (c.objectives?.length || 1) - 1)] || c.title;
  const variants = [
    `Still on "${c.title}" (Day ${c.day}) — you worked with ${toolList}. Describe a concrete scenario where you'd apply this, and what could go wrong if you got it wrong.`,
    `If you had to explain "${c.title}" to a teammate using ${toolList}, what's one pitfall or edge case you'd warn them about?`,
    `Thinking about ${objective.charAt(0).toLowerCase() + objective.slice(1)} — how would you validate that your implementation using ${toolList} actually works correctly?`
  ];
  return variants[variantSeed % variants.length];
}

function buildProbeQuestion(c, attempts) {
  return `Your records show "${c.title}" (Day ${c.day}) took ${attempts} attempts before passing. ` +
    `What was the trickiest part to get right, and what changed between your first attempt and the one that worked?`;
}

// ---------------------------------------------------------------------------
// 2. ANSWER EVALUATION + ADAPTIVE FOLLOW-UPS
// ---------------------------------------------------------------------------

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Rough keyword-overlap heuristic: does the answer engage with the day's tools/objectives? */
function keywordCoverage(answer, question) {
  const haystack = (answer || '').toLowerCase();
  const keywords = [
    ...(question.tools || []),
    ...(question.objectives || [])
  ]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4);

  if (keywords.length === 0) return 1; // nothing to check against
  const uniqueKeywords = [...new Set(keywords)];
  const hits = uniqueKeywords.filter((k) => haystack.includes(k));
  return hits.length / uniqueKeywords.length;
}

function scoreAnswer(answer, question) {
  const words = wordCount(answer);
  const coverage = keywordCoverage(answer, question);
  let score = 'weak';
  if (words >= 40 && coverage >= 0.15) score = 'strong';
  else if (words >= SHORT_ANSWER_WORD_THRESHOLD) score = 'adequate';
  return { words, coverage, score };
}

/** Deterministic fallback follow-up when no LLM key is configured or LLM fails. */
function templatedFollowUp(question, answer, evaluation) {
  if (evaluation.words < 5) {
    return `Could you expand on that a bit? Specifically, what's an example from your own experience with "${question.dayTitle}"?`;
  }
  if (evaluation.score === 'weak') {
    const kw = (question.tools && question.tools[0]) || 'the underlying concept';
    return `Let's go one level deeper — how does ${kw} specifically factor into your answer? What would break if you skipped it?`;
  }
  return `Good — one follow-up: what's a trade-off or limitation of that approach that you'd flag to a teammate?`;
}

/**
 * Decide whether a follow-up is warranted and generate it. Returns null if
 * the candidate's answer is solid enough to move on.
 */
async function maybeGenerateFollowUp(question, answer, followUpsAskedForThisQuestion) {
  const evaluation = scoreAnswer(answer, question);

  if (followUpsAskedForThisQuestion >= MAX_FOLLOWUPS_PER_QUESTION) {
    return { followUp: null, evaluation };
  }
  if (evaluation.score === 'strong') {
    return { followUp: null, evaluation };
  }

  // Try LLM for a sharper, context-aware follow-up.
  const llmText = await chatComplete(
    [
      {
        role: 'system',
        content:
          'You are a sharp, friendly senior technical interviewer. Given a question and the ' +
          "candidate's answer, write ONE short, specific follow-up question (max 30 words) that " +
          'probes deeper into a gap or vague part of their answer. Do not restate the original question. ' +
          'Return ONLY the follow-up question text, no preamble.'
      },
      {
        role: 'user',
        content: `Topic: Day ${question.day} - "${question.dayTitle}"\nOriginal question: ${question.prompt}\nCandidate's answer: ${answer}`
      }
    ],
    { maxTokens: 80, temperature: 0.7 }
  );

  const followUp = (llmText && llmText.trim()) || templatedFollowUp(question, answer, evaluation);
  return { followUp, evaluation };
}

// ---------------------------------------------------------------------------
// 3. FINAL FEEDBACK GENERATION
// ---------------------------------------------------------------------------

function heuristicFeedback(candidate, transcript) {
  const byDay = new Map();
  for (const turn of transcript) {
    if (!byDay.has(turn.day)) byDay.set(turn.day, []);
    byDay.get(turn.day).push(turn);
  }

  const strengths = [];
  const gaps = [];
  const next = [];

  for (const [day, turns] of byDay) {
    const dayTitle = turns[0].dayTitle;
    const avgScore = turns.reduce((acc, t) => acc + (t.evaluation?.score === 'strong' ? 2 : t.evaluation?.score === 'adequate' ? 1 : 0), 0) / turns.length;
    const hadFollowUp = turns.some((t) => t.followUpCount > 0);

    if (avgScore >= 1.5) {
      strengths.push(`Strong command of "${dayTitle}" (Day ${day}) — answered clearly with concrete detail.`);
    } else if (avgScore <= 0.5 || hadFollowUp) {
      gaps.push(`"${dayTitle}" (Day ${day}) answers were thin or needed follow-up prompting to get specifics.`);
      next.push(`Revisit Day ${day} ("${dayTitle}") material and practice explaining it with a concrete example.`);
    }
  }

  const firstTryRatio = candidate.signals?.missionsCompleted
    ? (candidate.signals.missionsFirstTry || 0) / candidate.signals.missionsCompleted
    : null;

  if (firstTryRatio !== null) {
    if (firstTryRatio >= 0.7) {
      strengths.push(`High first-try mission pass rate (${Math.round(firstTryRatio * 100)}%), indicating solid independent problem-solving.`);
    } else if (firstTryRatio <= 0.3) {
      gaps.push(`Low first-try mission pass rate (${Math.round(firstTryRatio * 100)}%) suggests concepts may not be fully internalized yet.`);
      next.push('Practice explaining core concepts out loud before attempting the graded mission, not just after.');
    }
  }

  if (candidate.signals?.commitDays && candidate.signals.commitDays < 20) {
    next.push('Increase consistency of daily practice — commit-day count was below the cohort norm.');
  }

  // Per spec: if a category genuinely has no items, leave it as an empty
  // array rather than backfilling with filler text.

  const summary =
    `${candidate.member?.name || 'The candidate'} covered ${byDay.size} curriculum day(s) across ${transcript.length} question(s) ` +
    `for the "${candidate.member?.jobRole || 'role'}" track. Overall the interview showed ` +
    `${strengths.length >= gaps.length ? 'solid, demonstrable' : 'partial, inconsistent'} understanding of the material, ` +
    `with the strongest performance on recently-covered advanced topics and the most room to grow on lower-confidence areas flagged below.`;

  return { summary, strengths: dedupe(strengths), gaps: dedupe(gaps), next: dedupe(next) };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/**
 * Produces the final feedback object.
 *
 * Field contract per technical-spec.md (unchanged, still exactly these four):
 *   summary: string, strengths: string[], gaps: string[], next: string[]
 *
 * `sessionId`, if provided, is stamped on as an additional `session_id` key
 * so feedback can be keyed/referenced by session in dashboards, storage, or
 * downstream systems — this is additive and never replaces the four
 * required fields above.
 */
async function generateFinalFeedback(candidate, transcript, sessionId = null) {
  const fallback = heuristicFeedback(candidate, transcript);

  const transcriptText = transcript
    .map((t, i) => `Q${i + 1} [Day ${t.day} - ${t.dayTitle}]: ${t.question}\nA: ${t.answer}`)
    .join('\n\n');

  const llmText = await chatComplete(
    [
      {
        role: 'system',
        content:
          'You are a senior technical interviewer writing final structured feedback for a candidate. ' +
          'Respond ONLY with a JSON object with exactly these keys: summary (string, 2-4 sentences), ' +
          'strengths (array of concise strings), gaps (array of concise strings), next (array of concise, ' +
          'actionable strings). Each array should contain concise, actionable points. If a category ' +
          'genuinely has no items, return an empty array for it rather than inventing filler. ' +
          'Base your assessment strictly on the transcript provided. Be specific and fair.'
      },
      {
        role: 'user',
        content: `Candidate: ${candidate.member?.name}, role: ${candidate.member?.jobRole}, experience: ${candidate.member?.yearsExperience} years.\n\nTranscript:\n${transcriptText}`
      }
    ],
    { json: true, maxTokens: 600, temperature: 0.4 }
  );

  const parsed = safeParseJson(llmText);
  const feedback =
    parsed && parsed.summary && Array.isArray(parsed.strengths) && Array.isArray(parsed.gaps) && Array.isArray(parsed.next)
      ? parsed
      : fallback;

  return sessionId ? { session_id: sessionId, ...feedback } : feedback;
}

module.exports = {
  buildInterviewPlan,
  maybeGenerateFollowUp,
  scoreAnswer,
  generateFinalFeedback,
  MIN_QUESTIONS,
  MIN_DAYS
};
