(() => {
  'use strict';

  const el = (id) => document.getElementById(id);

  const candidateSelect = el('candidateSelect');
  const startBtn = el('startBtn');
  const candidateCard = el('candidateCard');
  const profileName = el('profileName');
  const profileRole = el('profileRole');
  const profileMeta = el('profileMeta');
  const coverageSection = el('coverageSection');
  const coverageCount = el('coverageCount');
  const dayLedger = el('dayLedger');
  const sessionIdDisplay = el('sessionIdDisplay');
  const llmStatus = el('llmStatus');
  const stageTitle = el('stageTitle');
  const stageSubtitle = el('stageSubtitle');
  const transcript = el('transcript');
  const emptyState = el('emptyState');
  const composer = el('composer');
  const answerInput = el('answerInput');
  const sendBtn = el('sendBtn');
  const feedbackPanel = el('feedbackPanel');

  // Dashboard elements
  const tabInterview = el('tabInterview');
  const tabDashboard = el('tabDashboard');
  const pageInterview = el('pageInterview');
  const pageDashboard = el('pageDashboard');
  const sessionList = el('sessionList');
  const sessionListEmpty = el('sessionListEmpty');
  const sessionCount = el('sessionCount');
  const dashboardEmpty = el('dashboardEmpty');
  const feedbackDetail = el('feedbackDetail');
  const feedbackDetailHeading = el('feedbackDetailHeading');
  const feedbackDetailCandidate = el('feedbackDetailCandidate');
  const feedbackDetailSummary = el('feedbackDetailSummary');
  const fdStrengths = el('fdStrengths');
  const fdGaps = el('fdGaps');
  const fdNext = el('fdNext');

  let candidatesIndex = [];
  let selectedCandidateFull = null;
  let sessionId = null;
  let planDays = [];
  let visitedDays = new Set();

  function uuid() {
    return 'sess-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function loadCandidates() {
    const res = await fetch('/api/candidates');
    const data = await res.json();
    candidatesIndex = data.candidates;
    candidateSelect.innerHTML =
      '<option value="">Select a candidate…</option>' +
      candidatesIndex.map((c) => `<option value="${c.id}">${c.name} — ${c.jobRole}</option>`).join('');
  }

  async function loadHealth() {
    try {
      const res = await fetch('/health');
      const data = await res.json();
      llmStatus.textContent = data.llmEnabled ? 'groq (enabled)' : 'template mode';
    } catch {
      llmStatus.textContent = 'offline?';
    }
  }

  candidateSelect.addEventListener('change', async () => {
    const id = candidateSelect.value;
    if (!id) {
      startBtn.disabled = true;
      candidateCard.hidden = true;
      return;
    }
    const res = await fetch(`/api/candidates/${id}`);
    selectedCandidateFull = await res.json();
    renderProfile(selectedCandidateFull);
    startBtn.disabled = false;
  });

  function renderProfile(candidate) {
    const { member, missions, signals } = candidate;
    profileName.textContent = member.name;
    profileRole.textContent = `${member.jobRole} · ${member.yearsExperience}y exp`;
    profileMeta.textContent =
      `${member.education}\n` +
      `commit-days: ${signals?.commitDays ?? '—'}  |  first-try: ${signals?.missionsFirstTry ?? '—'}/${signals?.missionsCompleted ?? '—'}`;
    candidateCard.hidden = false;
  }

  function renderDayLedger(days) {
    dayLedger.innerHTML = days
      .map((d) => `<span class="day-chip" data-day="${d}">D${d}</span>`)
      .join('');
    coverageSection.hidden = false;
    coverageCount.textContent = `(${days.length} days)`;
  }

  function markDayVisited(day, active) {
    visitedDays.add(day);
    document.querySelectorAll('.day-chip').forEach((chip) => {
      const d = Number(chip.dataset.day);
      chip.classList.toggle('is-done', visitedDays.has(d) && d !== day);
      chip.classList.toggle('is-active', d === day);
    });
  }

  function addTurn(role, text) {
    emptyState.remove?.();
    const wrap = document.createElement('div');
    wrap.className = `turn turn--${role === 'agent' ? 'agent' : 'candidate'}`;
    const tag = document.createElement('div');
    tag.className = 'turn__tag';
    tag.textContent = role === 'agent' ? 'Interviewer' : 'You';
    const bubble = document.createElement('div');
    bubble.className = 'turn__bubble';
    bubble.textContent = text;
    wrap.appendChild(tag);
    wrap.appendChild(bubble);
    transcript.appendChild(wrap);
    transcript.scrollTop = transcript.scrollHeight;
  }

  async function startInterview() {
    if (!selectedCandidateFull) return;
    sessionId = uuid();
    sessionIdDisplay.textContent = sessionId;
    visitedDays = new Set();
    transcript.innerHTML = '';
    feedbackPanel.hidden = true;
    feedbackPanel.innerHTML = '';

    stageTitle.textContent = `Interview in progress — ${selectedCandidateFull.member.name}`;
    stageSubtitle.textContent = 'Answer honestly and in your own words — the agent adapts its follow-ups.';

    startBtn.disabled = true;
    candidateSelect.disabled = true;

    const res = await fetch('/api/interview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, candidate: selectedCandidateFull })
    });
    const data = await res.json();

    if (data.meta?.planDays) {
      planDays = data.meta.planDays;
      renderDayLedger(planDays);
      markDayVisited(data.meta.day);
    }

    addTurn('agent', data.reply);
    composer.hidden = false;
    answerInput.focus();
  }

  async function sendAnswer() {
    const text = answerInput.value.trim();
    if (!text || !sessionId) return;
    addTurn('candidate', text);
    answerInput.value = '';
    sendBtn.disabled = true;

    const res = await fetch('/api/interview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: text })
    });
    const data = await res.json();
    sendBtn.disabled = false;

    if (data.meta?.day) {
      markDayVisited(data.meta.day);
    }

    if (data.done) {
      addTurn('agent', data.reply);
      composer.hidden = true;
      renderFeedback(data.feedback);
      stageTitle.textContent = `Interview complete — ${selectedCandidateFull.member.name}`;
      stageSubtitle.textContent = 'Structured feedback below.';
      candidateSelect.disabled = false;
      startBtn.disabled = false;
    } else {
      addTurn('agent', data.reply);
      answerInput.focus();
    }
  }

  function renderFeedback(feedback) {
    if (!feedback) return;
    feedbackPanel.hidden = false;
    feedbackPanel.innerHTML = `
      <h2>Final Feedback</h2>
      <div class="feedback-summary">${escapeHtml(feedback.summary || '')}</div>
      <div class="feedback-grid">
        ${feedbackCard('strengths', 'Strengths', feedback.strengths)}
        ${feedbackCard('gaps', 'Gaps', feedback.gaps)}
        ${feedbackCard('next', 'Next steps', feedback.next)}
      </div>
      <a href="#/dashboard/${encodeURIComponent(sessionId)}" class="btn btn--secondary feedback-panel__dashboard-link">
        View in Feedback Dashboard →
      </a>
    `;
  }

  function feedbackCard(cls, title, items) {
    const lis = (items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
    return `<div class="feedback-card feedback-card--${cls}"><h3>${title}</h3><ul>${lis || '<li>—</li>'}</ul></div>`;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  startBtn.addEventListener('click', startInterview);
  sendBtn.addEventListener('click', sendAnswer);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAnswer();
    }
  });

  // ===========================================================
  // Feedback Dashboard — session_id-keyed list + detail view
  // ===========================================================

  // ---------------------------------------------------------------
  // Hash router: #/interview  or  #/dashboard  or  #/dashboard/<id>
  // Gives the Feedback view a real, linkable URL instead of relying
  // on in-memory tab state, so a click always lands on the right
  // session and a reload/deep-link/back-button all work correctly.
  // ---------------------------------------------------------------
  function switchTab(target, { updateHash = true } = {}) {
    const showInterview = target === 'interview';
    pageInterview.hidden = !showInterview;
    pageDashboard.hidden = showInterview;
    tabInterview.classList.toggle('is-active', showInterview);
    tabInterview.setAttribute('aria-selected', String(showInterview));
    tabDashboard.classList.toggle('is-active', !showInterview);
    tabDashboard.setAttribute('aria-selected', String(!showInterview));
    if (!showInterview) loadSessions();
    if (updateHash) {
      const current = window.location.hash.slice(2).split('/')[0];
      if (current !== target) window.location.hash = `/${target}`;
    }
  }

  function parseHash() {
    // '#/dashboard/sess-abc123' -> { view: 'dashboard', id: 'sess-abc123' }
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [view, id] = raw.split('/');
    return { view: view || 'interview', id: id ? decodeURIComponent(id) : null };
  }

  function handleHashChange() {
    const { view, id } = parseHash();
    if (view === 'dashboard') {
      switchTab('dashboard', { updateHash: false });
      if (id) selectSession(id, { updateHash: false });
    } else {
      switchTab('interview', { updateHash: false });
    }
  }

  window.addEventListener('hashchange', handleHashChange);

  tabInterview.addEventListener('click', () => switchTab('interview'));
  tabDashboard.addEventListener('click', () => switchTab('dashboard'));

  let selectedSessionId = null;

  async function loadSessions() {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    const sessions = data.sessions || [];

    sessionCount.textContent = `(${sessions.length})`;

    if (sessions.length === 0) {
      sessionList.innerHTML = '';
      sessionList.appendChild(sessionListEmpty);
      return;
    }

    sessionList.innerHTML = '';
    for (const s of sessions) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'session-card' + (s.session_id === selectedSessionId ? ' is-selected' : '');
      btn.setAttribute('aria-pressed', String(s.session_id === selectedSessionId));
      btn.innerHTML = `
        <div class="session-card__id">${escapeHtml(s.session_id)}</div>
        <div class="session-card__name">${escapeHtml(s.candidateName)}</div>
        <div class="session-card__role">${escapeHtml(s.jobRole || '')}</div>
        <span class="session-card__status session-card__status--${s.status}">${s.status === 'completed' ? 'completed' : `in progress · ${s.questionIndex}/${s.totalQuestions}`}</span>
      `;
      btn.addEventListener('click', () => selectSession(s.session_id));
      li.appendChild(btn);
      sessionList.appendChild(li);
    }
  }

  async function selectSession(sessionIdToLoad, { updateHash = true } = {}) {
    selectedSessionId = sessionIdToLoad;
    document.querySelectorAll('.session-card').forEach((c) => c.classList.remove('is-selected'));
    await loadSessions(); // re-render to reflect selection highlight

    if (updateHash) {
      window.location.hash = `/dashboard/${encodeURIComponent(sessionIdToLoad)}`;
    }

    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionIdToLoad)}`);
    if (!res.ok) {
      dashboardEmpty.hidden = false;
      feedbackDetail.hidden = true;
      dashboardEmpty.querySelector('p').textContent = `Session "${sessionIdToLoad}" was not found — it may have been cleared.`;
      return;
    }
    const data = await res.json();

    dashboardEmpty.hidden = true;

    if (!data.feedback) {
      feedbackDetail.hidden = true;
      dashboardEmpty.hidden = false;
      dashboardEmpty.querySelector('p').textContent =
        `Session "${sessionIdToLoad}" is still in progress (question ${data.transcript.length + 1}) — feedback appears once it's done.`;
      return;
    }

    feedbackDetail.hidden = false;
    feedbackDetailHeading.textContent = data.session_id;
    feedbackDetailCandidate.textContent = `${data.candidate.name} · ${data.candidate.jobRole}`;
    feedbackDetailSummary.textContent = data.feedback.summary || '';

    renderFeedbackList(fdStrengths, data.feedback.strengths);
    renderFeedbackList(fdGaps, data.feedback.gaps);
    renderFeedbackList(fdNext, data.feedback.next);
  }

  function renderFeedbackList(ulEl, items) {
    ulEl.innerHTML = '';
    if (!items || items.length === 0) {
      const li = document.createElement('li');
      li.className = 'feedback-card__empty';
      li.textContent = 'None noted';
      ulEl.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      ulEl.appendChild(li);
    }
  }

  loadCandidates();
  loadHealth();
  handleHashChange(); // respect a deep link like #/dashboard/<sessionId> on first load
})();
