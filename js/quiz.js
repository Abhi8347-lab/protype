/**
 * Skill Diagnostic Quiz Controller (quiz.html):
 * - Mandatory gate: ALL selected skills must be completed before analyzer/courses unlock.
 * - Runs one skill test at a time (3 Easy → 2 Hard, shuffled options).
 * - Per-question 60-second timer; auto-marks wrong on timeout.
 * - Tab-visibility warning ("Stay on this tab during the test") + switch count logged per attempt.
 * - Resume on refresh at exact same question (same shuffled options, same answers).
 * - Retakes allowed only AFTER the whole gate is cleared; full attempt history kept.
 * - Next button disabled until an option is selected; no skip, no going back.
 * - Shows overall progress ("Skill 2 of 3: Power BI") and per-skill checklist
 *   (Pending / In progress / Completed + level badge).
 */
(async function () {
  const Data = window.SkillPathData;
  const Questions = window.SkillSyncQuestions;
  const Storage = window.SkillPathStorage;
  const Engine = window.SkillPathEngine;
  const Nav = window.SkillPathNav;
  const { escapeHtml } = Nav;

  const QUESTION_TIMER_SECONDS = 60;

  let appState = await Storage.initState();

  const queueEl = document.getElementById("quiz-skill-queue");
  const stageEl = document.getElementById("quiz-stage-card");
  const historyCardEl = document.getElementById("quiz-history-card");
  const historyTitleEl = document.getElementById("quiz-history-title");
  const historyListEl = document.getElementById("quiz-history-list");
  const modePillEl = document.getElementById("quiz-mode-pill");
  const aiModeToggle = document.getElementById("toggle-ai-quiz-mode");
  const gateProgressEl = document.getElementById("gate-overall-progress");
  const topContinueBtn = document.getElementById("quiz-top-continue-btn");

  const LEVEL_MEANINGS = {
    Expert:
      "You mastered both core foundations and tricky scenario edge cases (5/5). Mapped to 90% verified score.",
    Intermediate:
      "You have solid core understanding (3–4/5 with strong foundations). Mapped to 60% verified score.",
    Beginner:
      "Foundational concepts need reinforcement before advanced topics. Mapped to 30% verified score.",
  };

  function getEmpId() {
    return appState.currentEmployeeId || "emp_current";
  }

  function getVerifiedMap() {
    return appState.verifiedLevels?.[getEmpId()] || {};
  }

  function getGateSkillList() {
    const profile = appState.profile;
    if (!profile || !Array.isArray(profile.selectedSkills)) return [];
    return profile.selectedSkills.filter((id) => Questions.hasQuestions(id));
  }

  function getTargetSkillsList() {
    const gate = getGateSkillList();
    const gateCleared = Engine.isGateCleared(appState);

    // While employee gate is NOT cleared and user has selected skills, keep checklist focused on required skills.
    if (gate.length > 0 && !gateCleared) {
      return gate.slice();
    }

    const extra = new Set(gate);
    const profile = appState.profile;
    if (profile && profile.targetRole && Data.ROLE_MAP[profile.targetRole]) {
      Data.ROLE_MAP[profile.targetRole].skills.forEach((s) => extra.add(s.skillId));
    }
    if (extra.size === 0) {
      ["sql", "power_bi", "statistics", "python", "excel", "javascript"].forEach(
        (id) => extra.add(id)
      );
    }
    return Array.from(extra).filter((id) => Questions.hasQuestions(id));
  }

  function isSkillCompleted(skillId) {
    const completed = Array.isArray(appState.gate?.completed)
      ? appState.gate.completed
      : [];
    return completed.includes(skillId);
  }

  function isGateSkill(skillId) {
    return gateSkills.includes(skillId);
  }

  function canRetake() {
    return Engine.isGateCleared(appState);
  }

  const params = new URLSearchParams(window.location.search);
  const requestedSkill = params.get("skill");

  let gateSkills = getGateSkillList();
  let skillList = getTargetSkillsList();

  // If a started required test is in progress, force-resume that test (cannot skip started test).
  const activeInProgSkill =
    appState.inProgress &&
    appState.inProgress.skill &&
    Questions.hasQuestions(appState.inProgress.skill) &&
    (!isSkillCompleted(appState.inProgress.skill) || Engine.isGateCleared(appState))
      ? appState.inProgress.skill
      : null;

  let activeSkillId = activeInProgSkill
    ? activeInProgSkill
    : requestedSkill && Questions.hasQuestions(requestedSkill)
      ? requestedSkill
      : gateSkills.find((id) => !isSkillCompleted(id)) ||
        gateSkills[0] ||
        skillList[0] ||
        "sql";

  if (!skillList.includes(activeSkillId) && Questions.hasQuestions(activeSkillId)) {
    skillList.unshift(activeSkillId);
  }

  let session = null;
  let timerInterval = null;
  let timerRemaining = QUESTION_TIMER_SECONDS;
  let tabSwitchCount = 0;
  let isPageUnloading = false;

  // ── Persistence Helper for Resume ────────────────────────────────────────────
  function buildShuffledOrder(questions) {
    return questions.map((q) => ({
      id: q.id,
      optionOrder: Array.isArray(q.optionOrder) ? q.optionOrder : [0, 1, 2, 3],
    }));
  }

  function persistInProgressState() {
    if (!session || session.finished) return;
    appState = Storage.saveInProgress({
      skill: session.skillId,
      questionIndex: session.currentIndex,
      shuffledOrder: buildShuffledOrder(session.questions),
      shuffledQuestions: session.questions,
      answers: session.answersLog.slice(),
      source: session.source,
      tabSwitchCount,
      timerRemaining,
    });
  }

  // ── Page Unload / Tab-Visibility Deterrent ───────────────────────────────────
  window.addEventListener("beforeunload", () => {
    isPageUnloading = true;
    if (session && !session.finished) {
      persistInProgressState();
    }
  });

  window.addEventListener("pagehide", () => {
    isPageUnloading = true;
    if (session && !session.finished) {
      persistInProgressState();
    }
  });

  window.addEventListener("pageshow", () => {
    isPageUnloading = false;
    appState = Storage.readLocal();
    gateSkills = getGateSkillList();
  });

  document.addEventListener("visibilitychange", () => {
    if (isPageUnloading || !session || session.finished || session.answered) return;
    if (document.hidden) {
      tabSwitchCount += 1;
      session.tabSwitchWarned = true;
      persistInProgressState();
      Nav.showToast(
        `Stay on this tab during the test! (Tab switches: ${tabSwitchCount})`,
        "warning"
      );
      const warn = document.getElementById("quiz-tab-warning");
      if (warn) {
        warn.hidden = false;
        warn.textContent = `⚠ Stay on this tab during the test. Tab switches recorded: ${tabSwitchCount}.`;
      }
    }
  });

  // ── Shuffle Helpers ──────────────────────────────────────────────────────────
  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function shuffleOptions(question) {
    const tagged = question.options.map((text, idx) => ({
      text,
      origIdx: idx,
      isCorrect: idx === question.correctAnswer,
    }));
    const shuffled = shuffleArray(tagged);
    return {
      ...question,
      options: shuffled.map((t) => t.text),
      correctAnswer: shuffled.findIndex((t) => t.isCorrect),
      optionOrder: shuffled.map((t) => t.origIdx),
    };
  }

  function restoreFromShuffledOrder(skillId, shuffledOrder) {
    const baseQuestions = Questions.getQuestionsForSkill(skillId);
    if (
      !Array.isArray(shuffledOrder) ||
      shuffledOrder.length !== baseQuestions.length
    ) {
      return null;
    }
    const byId = Object.fromEntries(baseQuestions.map((q) => [q.id, q]));
    const restored = [];
    for (let i = 0; i < shuffledOrder.length; i++) {
      const entry = shuffledOrder[i];
      const orig = byId[entry?.id] || baseQuestions[i];
      if (!orig || !Array.isArray(entry?.optionOrder)) return null;
      const newOpts = entry.optionOrder.map((origIdx) => orig.options[origIdx]);
      const newCorrect = entry.optionOrder.indexOf(orig.correctAnswer);
      if (newOpts.some((o) => o === undefined) || newCorrect < 0) return null;
      restored.push({
        ...orig,
        options: newOpts,
        correctAnswer: newCorrect,
        optionOrder: entry.optionOrder.slice(),
      });
    }
    return restored;
  }

  // ── Load Questions ───────────────────────────────────────────────────────────
  async function loadQuestionsForSession(skillId) {
    const skillName = Data.SKILL_MAP[skillId]?.name || skillId;
    const useAi = Boolean(aiModeToggle && aiModeToggle.checked);
    const canCallHttp =
      window.location.protocol === "http:" ||
      window.location.protocol === "https:";

    if (useAi && canCallHttp) {
      try {
        const resp = await window.fetch("/api/ai-quiz", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skillId, skillName }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data.questions) && data.questions.length === 5) {
            return {
              source:
                data.source === "ai" ? "AI Generated" : "Offline Bank (Fallback)",
              questions: data.questions.map(shuffleOptions),
            };
          }
        }
      } catch (_err) {
        // Silently fall back to offline bank.
      }
    }

    const offline = Questions.getQuestionsForSkill(skillId).map(shuffleOptions);
    return { source: "Offline Bank", questions: offline };
  }

  // ── Timer ────────────────────────────────────────────────────────────────────
  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function updateTimerDisplay() {
    const timerEl = document.getElementById("quiz-timer");
    if (!timerEl) return;
    const pct = Math.max(
      0,
      Math.round((timerRemaining / QUESTION_TIMER_SECONDS) * 100)
    );
    const urgent = timerRemaining <= 10;
    timerEl.innerHTML = `
      <span class="quiz-timer-label ${urgent ? "is-urgent" : ""}">⏱ ${timerRemaining}s remaining</span>
      <div class="quiz-timer-track">
        <div class="quiz-timer-fill ${urgent ? "is-urgent" : ""}" style="width:${pct}%"></div>
      </div>
    `;
  }

  function startTimer(initialSeconds) {
    clearTimer();
    timerRemaining =
      typeof initialSeconds === "number" && initialSeconds > 0
        ? Math.min(QUESTION_TIMER_SECONDS, initialSeconds)
        : QUESTION_TIMER_SECONDS;
    updateTimerDisplay();

    timerInterval = setInterval(() => {
      timerRemaining -= 1;
      updateTimerDisplay();
      if (timerRemaining % 5 === 0 && session && !session.answered && !session.finished) {
        persistInProgressState();
      }
      if (timerRemaining <= 0) {
        clearTimer();
        if (session && !session.answered && !session.finished) {
          Nav.showToast("Time expired — question marked wrong.", "warning");
          autoMarkWrong();
        }
      }
    }, 1000);
  }

  function autoMarkWrong() {
    if (!session || session.answered || session.finished) return;
    const q = session.questions[session.currentIndex];
    session.selectedOption = -1;
    session.answered = true;
    session.answersLog.push({
      questionId: q.id,
      difficulty: q.difficulty,
      selectedOption: -1,
      isCorrect: false,
      timedOut: true,
    });
    persistInProgressState();
    renderStage();
  }

  // ── Start / Resume a Skill Test ──────────────────────────────────────────────
  async function startSkillTest(skillId) {
    // Do not allow abandoning an already-started active test
    const inProg = appState.inProgress;
    if (
      inProg &&
      inProg.skill &&
      inProg.skill !== skillId &&
      !isSkillCompleted(inProg.skill)
    ) {
      Nav.showToast(
        "Finish your in-progress test before starting another skill.",
        "warning"
      );
      return;
    }

    if (isGateSkill(skillId) && isSkillCompleted(skillId) && !canRetake()) {
      Nav.showToast("Complete all skill tests first to unlock retakes.", "warning");
      return;
    }

    activeSkillId = skillId;
    clearTimer();

    stageEl.innerHTML = `<div class="quiz-loading">Preparing 5 diagnostic questions for ${escapeHtml(Data.SKILL_MAP[skillId]?.name || skillId)}...</div>`;

    const isResuming = Boolean(inProg && inProg.skill === skillId);
    let questions = null;
    let source = "Offline Bank";

    if (isResuming) {
      if (
        Array.isArray(inProg.shuffledQuestions) &&
        inProg.shuffledQuestions.length === 5
      ) {
        questions = inProg.shuffledQuestions;
        source = inProg.source || "Offline Bank";
      } else if (Array.isArray(inProg.shuffledOrder)) {
        questions = restoreFromShuffledOrder(skillId, inProg.shuffledOrder);
        source = inProg.source || "Offline Bank";
      }
    }

    if (!questions) {
      const loaded = await loadQuestionsForSession(skillId);
      questions = loaded.questions;
      source = loaded.source;
    }

    if (modePillEl) {
      modePillEl.textContent = `Question Source: ${source}`;
    }

    const resumeIndex = isResuming
      ? Math.max(0, Math.min(questions.length - 1, Number(inProg.questionIndex) || 0))
      : 0;
    const resumeAnswers =
      isResuming && Array.isArray(inProg.answers)
        ? inProg.answers.slice(0, questions.length)
        : [];
    tabSwitchCount = isResuming ? Number(inProg.tabSwitchCount || 0) : 0;

    // Recompute score tallies strictly from saved answers
    let easyCorrect = 0;
    let hardCorrect = 0;
    resumeAnswers.forEach((ans, idx) => {
      if (ans && ans.isCorrect) {
        if (questions[idx]?.difficulty === "easy") easyCorrect += 1;
        else hardCorrect += 1;
      }
    });

    // If the user already answered the current question before refreshing,
    // keep them on its feedback view so previous answers cannot be changed.
    const existingAnswerForCurrent = resumeAnswers[resumeIndex] || null;
    const alreadyAnsweredCurrent = Boolean(existingAnswerForCurrent);

    session = {
      skillId,
      skillName: Data.SKILL_MAP[skillId]?.name || skillId,
      source,
      questions,
      currentIndex: resumeIndex,
      selectedOption: alreadyAnsweredCurrent
        ? existingAnswerForCurrent.selectedOption ?? -1
        : null,
      answered: alreadyAnsweredCurrent,
      easyCorrect,
      hardCorrect,
      answersLog: resumeAnswers,
      tabSwitchWarned: tabSwitchCount > 0,
      finished: false,
      resultData: null,
    };

    const initialTimer =
      isResuming && typeof inProg.timerRemaining === "number" && inProg.timerRemaining > 0
        ? inProg.timerRemaining
        : QUESTION_TIMER_SECONDS;

    persistInProgressState();

    renderQueue();
    renderGateProgress();
    renderStage();
    renderHistory();

    if (!session.answered) {
      startTimer(initialTimer);
    }
  }

  // ── Render: Skill Checklist Queue ────────────────────────────────────────────
  function renderQueue() {
    gateSkills = getGateSkillList();
    skillList = getTargetSkillsList();
    if (!skillList.includes(activeSkillId)) skillList.unshift(activeSkillId);

    const verifiedMap = getVerifiedMap();
    const gateCompleted = Array.isArray(appState.gate?.completed)
      ? appState.gate.completed
      : [];
    const inProgSkill =
      session && !session.finished
        ? session.skillId
        : appState.inProgress?.skill || null;
    const activeUnfinishedLock =
      inProgSkill && !isSkillCompleted(inProgSkill) ? inProgSkill : null;

    if (!queueEl) return;

    queueEl.innerHTML = skillList
      .map((skillId) => {
        const name = Data.SKILL_MAP[skillId]?.name || skillId;
        const ver = verifiedMap[skillId];
        const isActive = skillId === activeSkillId;
        const isGate = isGateSkill(skillId);
        const isDone = gateCompleted.includes(skillId);
        const isInProg =
          inProgSkill === skillId && (!isDone || (session && !session.finished));

        let statusBadge = "";
        if (isGate) {
          if (isInProg) {
            statusBadge = `<span class="gate-status-pill gate-in-progress">▶ In progress</span>`;
          } else if (isDone && ver) {
            statusBadge = `<span class="gate-status-pill gate-completed">✓ Completed · <span class="ver-mini-pill level-${ver.level.toLowerCase()}">${escapeHtml(ver.level)}</span></span>`;
          } else if (isDone) {
            statusBadge = `<span class="gate-status-pill gate-completed">✓ Completed</span>`;
          } else {
            statusBadge = `<span class="gate-status-pill gate-pending">⬤ Pending</span>`;
          }
        } else {
          statusBadge = ver
            ? `<span class="ver-mini-pill level-${ver.level.toLowerCase()}">${escapeHtml(ver.level)} (${ver.score}/5)</span>`
            : `<span class="ver-mini-pill level-unverified">Unverified</span>`;
        }

        const retakeBlocked = isGate && isDone && !canRetake();
        const switchBlocked =
          Boolean(activeUnfinishedLock) && activeUnfinishedLock !== skillId;
        const isLocked = retakeBlocked || switchBlocked;
        const lockTooltip = switchBlocked
          ? "Finish the currently started skill test first"
          : retakeBlocked
            ? "Complete all required tests first to unlock retakes"
            : "";

        return `
          <button
            type="button"
            class="quiz-queue-btn ${isActive ? "is-active" : ""} ${isGate ? "is-gate-skill" : ""} ${isDone && isGate ? "is-gate-done" : ""}"
            data-quiz-skill="${escapeHtml(skillId)}"
            ${isLocked ? "disabled" : ""}
            ${lockTooltip ? `title="${escapeHtml(lockTooltip)}"` : ""}
          >
            <span class="quiz-queue-name">${escapeHtml(name)}</span>
            ${isGate ? `<span class="gate-required-dot" title="Required for diagnostic gate">${isDone ? "✓" : "🔒"}</span>` : ""}
            ${statusBadge}
          </button>
        `;
      })
      .join("");

    queueEl.querySelectorAll("[data-quiz-skill]:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-quiz-skill");
        if (sid === activeSkillId && session && !session.finished) return;
        startSkillTest(sid);
      });
    });
  }

  // ── Render: Gate Overall Progress Bar ────────────────────────────────────────
  function renderGateProgress() {
    if (!gateProgressEl) return;

    const gate = appState.gate || {};
    const required = Array.isArray(gate.required) ? gate.required : [];
    const completed = Array.isArray(gate.completed) ? gate.completed : [];
    const total = required.length;
    const done = required.filter((s) => completed.includes(s)).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const isCleared = Engine.isGateCleared(appState);

    if (topContinueBtn) {
      topContinueBtn.hidden = !isCleared;
    }

    if (!appState.profile) {
      gateProgressEl.innerHTML = `
        <div class="gate-progress-top">
          <div>
            <span class="mini-label">Diagnostic Gate</span>
            <h3 class="gate-progress-label">Complete Profile Setup to unlock your personalized skill queue</h3>
          </div>
          <a href="index.html" class="btn-primary">Go to Profile Setup →</a>
        </div>
        <p class="gate-hint">Save your role and selected skills first; then complete the 5-question diagnostic for each skill.</p>
      `;
      return;
    }

    if (total === 0 && isCleared) {
      gateProgressEl.innerHTML = `
        <div class="gate-progress-top">
          <div>
            <span class="mini-label">Diagnostic Gate Progress</span>
            <h3 class="gate-progress-label">0 skills selected on Profile Setup</h3>
          </div>
          <span class="gate-progress-pct gate-cleared">✓ Ready</span>
        </div>
        <div class="gate-cleared-banner">
          ✦ Your profile is ready! <a href="analyzer.html" class="btn-primary gate-continue-btn">Continue to Skill-Gap Analysis →</a>
        </div>
      `;
      return;
    }

    const activeIdx = required.indexOf(activeSkillId);
    const skillLabel = isCleared
      ? `All ${total} of ${total} required skills tested`
      : total > 0 && activeIdx >= 0
        ? `Skill ${activeIdx + 1} of ${total}: ${Data.SKILL_MAP[activeSkillId]?.name || activeSkillId}`
        : total > 0
          ? `${done} of ${total} skills tested`
          : "No required skills selected yet";

    gateProgressEl.innerHTML = `
      <div class="gate-progress-top">
        <div>
          <span class="mini-label">Diagnostic Gate Progress</span>
          <h3 class="gate-progress-label">${escapeHtml(skillLabel)}</h3>
        </div>
        <span class="gate-progress-pct ${isCleared ? "gate-cleared" : ""}">${done}/${total} ${isCleared ? "✓ Cleared" : "Completed"}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${isCleared ? "progress-fill-emerald" : ""}" style="width:${pct}%"></div>
      </div>
      ${
        isCleared
          ? `<div class="gate-cleared-banner">
              <span>✦ All ${total} selected skill tests are complete!</span>
              <a href="analyzer.html" class="btn-primary gate-continue-btn">Continue to Skill-Gap Analysis →</a>
            </div>`
          : `<p class="gate-hint">Complete all ${total} selected skill test${total === 1 ? "" : "s"} to unlock Skill-Gap Analysis, Courses, and your 6-Week Plan.</p>`
      }
    `;
  }

  // ── Render: Active Quiz Stage ────────────────────────────────────────────────
  function renderStage() {
    if (!session) {
      const skillName = Data.SKILL_MAP[activeSkillId]?.name || activeSkillId;
      const existing = getVerifiedMap()[activeSkillId];
      const isGate = isGateSkill(activeSkillId);
      const isDone = isSkillCompleted(activeSkillId);
      const gateCleared = Engine.isGateCleared(appState);

      stageEl.innerHTML = `
        <div class="quiz-intro-box">
          <div class="ai-mini-badge">5-Question Skill Verification</div>
          <h2>${escapeHtml(skillName)} Diagnostic Test</h2>
          <p>
            You will answer <strong>3 Easy</strong> questions followed by <strong>2 Hard</strong> questions.
            Options are shuffled on every attempt, with instant feedback after each answer.
          </p>
          <p class="quiz-timer-hint">⏱ <strong>${QUESTION_TIMER_SECONDS} seconds</strong> per question (auto-marked wrong if time runs out) · No skipping or going back.</p>
          ${
            existing
              ? `<p class="quiz-prev-note">Current Verified Level: <strong>${escapeHtml(existing.level)}</strong> (${existing.score}/5 · ${existing.verifiedPct}%)</p>`
              : `<p class="quiz-prev-note">Status: <strong>${isGate ? "Pending (Required)" : "Unverified"}</strong></p>`
          }
          ${
            isGate && isDone && !gateCleared
              ? `<p class="quiz-gate-note">🔒 Retakes are unlocked once you complete all remaining required tests.</p>`
              : ""
          }
          <button type="button" id="btn-start-quiz-now" class="btn-primary"
            ${isGate && isDone && !gateCleared ? "disabled" : ""}>
            ${existing ? `Retake ${escapeHtml(skillName)} Test →` : `Start ${escapeHtml(skillName)} Test →`}
          </button>
        </div>
      `;

      const startBtn = document.getElementById("btn-start-quiz-now");
      if (startBtn && !startBtn.disabled) {
        startBtn.addEventListener("click", () => startSkillTest(activeSkillId));
      }
      return;
    }

    if (session.finished && session.resultData) {
      clearTimer();
      renderResultScreen();
      return;
    }

    const q = session.questions[session.currentIndex];
    const qNum = session.currentIndex + 1;
    const total = session.questions.length;
    const pct = Math.round((qNum / total) * 100);
    const diffLabel =
      q.difficulty === "easy" ? "Easy (Foundation)" : "Hard (Scenario)";

    const optionsHtml = q.options
      .map((optText, idx) => {
        let cls = "quiz-option-btn";
        if (session.answered) {
          if (idx === q.correctAnswer) cls += " is-correct";
          else if (idx === session.selectedOption) cls += " is-wrong";
        } else if (session.selectedOption === idx) {
          cls += " is-selected";
        }
        return `
          <button
            type="button"
            class="${cls}"
            data-option-idx="${idx}"
            ${session.answered ? "disabled" : ""}
            aria-label="Option ${idx + 1}: ${escapeHtml(optText)}"
          >
            <span class="quiz-option-key">${idx + 1}</span>
            <span class="quiz-option-text">${escapeHtml(optText)}</span>
          </button>
        `;
      })
      .join("");

    let feedbackHtml = "";
    if (session.answered) {
      const timedOut = session.selectedOption === -1;
      const wasRight = !timedOut && session.selectedOption === q.correctAnswer;
      feedbackHtml = `
        <div class="quiz-feedback ${wasRight ? "is-correct" : "is-wrong"}" role="status">
          <strong>${timedOut ? "⏱ Time expired!" : wasRight ? "✓ Correct!" : "✕ Incorrect."}</strong>
          <span>${escapeHtml(q.explanation)}</span>
        </div>
      `;
    }

    const tabWarnVisible = Boolean(session.tabSwitchWarned && tabSwitchCount > 0);

    stageEl.innerHTML = `
      <div class="quiz-active-wrap">
        <div id="quiz-tab-warning" class="quiz-tab-warning" ${tabWarnVisible ? "" : "hidden"}>
          ${tabWarnVisible ? `⚠ Stay on this tab during the test. Tab switches recorded: ${tabSwitchCount}.` : ""}
        </div>

        <div class="quiz-top-meta">
          <span class="quiz-skill-pill">${escapeHtml(session.skillName)}</span>
          <span class="quiz-diff-pill diff-${q.difficulty}">${diffLabel}</span>
          <span class="quiz-counter">Question ${qNum} of ${total}</span>
        </div>

        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
          <div class="progress-fill" style="width: ${pct}%"></div>
        </div>

        <div id="quiz-timer" class="quiz-timer"></div>

        <h2 class="quiz-question-text">${escapeHtml(q.question)}</h2>

        <div class="quiz-options-list" role="radiogroup" aria-label="Answer choices">
          ${optionsHtml}
        </div>

        ${feedbackHtml}

        <div class="quiz-actions-row">
          <span class="quiz-kbd-hint">Tip: Press keys 1–4 to answer, Enter to continue (no going back or skipping).</span>
          ${
            session.answered
              ? `<button type="button" id="btn-quiz-next" class="btn-primary">
                  ${qNum === total ? "Finish &amp; See Level →" : "Next Question →"}
                </button>`
              : `<button type="button" id="btn-quiz-next" class="btn-primary" disabled>
                  ${qNum === total ? "Finish &amp; See Level →" : "Next Question →"}
                </button>`
          }
        </div>
      </div>
    `;

    updateTimerDisplay();

    if (!session.answered) {
      stageEl.querySelectorAll("[data-option-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          selectAnswer(Number(btn.getAttribute("data-option-idx")));
        });
      });
    } else {
      clearTimer();
      const nextBtn = document.getElementById("btn-quiz-next");
      if (nextBtn) {
        nextBtn.addEventListener("click", advanceQuestion);
        nextBtn.focus();
      }
    }
  }

  // ── Select Answer ────────────────────────────────────────────────────────────
  function selectAnswer(idx) {
    if (!session || session.answered || session.finished) return;
    clearTimer();

    const q = session.questions[session.currentIndex];
    session.selectedOption = idx;
    session.answered = true;

    const isCorrect = idx === q.correctAnswer;
    if (isCorrect) {
      if (q.difficulty === "easy") session.easyCorrect += 1;
      else session.hardCorrect += 1;
    }

    session.answersLog.push({
      questionId: q.id,
      difficulty: q.difficulty,
      selectedOption: idx,
      isCorrect,
      timedOut: false,
    });

    persistInProgressState();
    renderStage();
  }

  // ── Advance to Next Question ─────────────────────────────────────────────────
  async function advanceQuestion() {
    if (!session || !session.answered) return;
    if (session.currentIndex < session.questions.length - 1) {
      session.currentIndex += 1;
      session.selectedOption = null;
      session.answered = false;
      timerRemaining = QUESTION_TIMER_SECONDS;
      persistInProgressState();
      renderStage();
      startTimer(QUESTION_TIMER_SECONDS);
      return;
    }
    await finishQuiz();
  }

  // ── Finish Quiz ──────────────────────────────────────────────────────────────
  async function finishQuiz() {
    clearTimer();
    const easy = session.easyCorrect;
    const hard = session.hardCorrect;
    const totalScore = easy + hard;
    const level = Engine.getLevel(easy, hard);
    const verifiedPct = Engine.getLevelPct(level);

    const empId = getEmpId();
    const prevLevel =
      appState.verifiedLevels?.[empId]?.[session.skillId]?.level || null;

    const attemptRecord = {
      date: new Date().toISOString(),
      skillId: session.skillId,
      skillName: session.skillName,
      score: totalScore,
      easyCorrect: easy,
      hardCorrect: hard,
      level,
      verifiedPct,
      source: session.source,
      tabSwitchCount,
    };

    appState = await Storage.recordTestAttempt(
      empId,
      session.skillId,
      attemptRecord
    );

    let updatedPlanSummary = "";
    if (appState.profile) {
      const newAnalysis = Engine.analyzeProfile(
        appState.profile,
        appState.courseProgress,
        appState
      );
      if (newAnalysis && newAnalysis.sixWeekPlan.length > 0) {
        updatedPlanSummary = newAnalysis.sixWeekPlan
          .map((p) => `${p.weeksLabel}: ${p.title}`)
          .join(" | ");
      }
      const reasonText =
        prevLevel && prevLevel !== level
          ? `${session.skillName} diagnostic updated ${prevLevel} → ${level} (${verifiedPct}%)`
          : `${session.skillName} verified at ${level} (${verifiedPct}%)`;

      appState = await Storage.addReplanEntry({
        employeeId: empId,
        skillId: session.skillId,
        reason: reasonText,
        summary:
          updatedPlanSummary || "Re-evaluated role roadmap and priority ranking.",
      });
    }

    const selfRatedPct = appState.profile
      ? Engine.resolveInitialPct(appState.profile, session.skillId)
      : 0;

    session.finished = true;
    session.resultData = {
      totalScore,
      easy,
      hard,
      level,
      verifiedPct,
      selfRatedPct,
      prevLevel,
      updatedPlanSummary,
      tabSwitchCount,
    };

    Nav.render({ activePage: "quiz", state: appState });
    gateSkills = getGateSkillList();
    renderQueue();
    renderGateProgress();
    renderStage();
    renderHistory();

    if (Engine.isGateCleared(appState)) {
      Nav.showToast(
        "All skill tests completed! Continue to Skill-Gap Analysis.",
        "success"
      );
    } else {
      Nav.showToast("Test completed. Proceed to your next required skill.", "success");
    }
  }

  // ── Render: Result Screen ────────────────────────────────────────────────────
  function renderResultScreen() {
    const res = session.resultData;
    const gate = appState.gate || {};
    const gateRequired = Array.isArray(gate.required) ? gate.required : [];
    const gateCompleted = Array.isArray(gate.completed) ? gate.completed : [];
    const gateCleared = Engine.isGateCleared(appState);

    const nextGatePending = gateRequired.find(
      (sid) => !gateCompleted.includes(sid) && sid !== session.skillId
    );

    const selfVsVerifiedHtml =
      res.selfRatedPct > 0
        ? `<div class="quiz-self-vs-verified">Self-rated <strong>${res.selfRatedPct}%</strong> vs Verified <strong>${escapeHtml(res.level)} (${res.verifiedPct}%)</strong></div>`
        : `<div class="quiz-self-vs-verified">Verified Score Applied to Analyzer: <strong>${res.verifiedPct}%</strong></div>`;

    let nextBtnHtml;
    if (gateCleared) {
      nextBtnHtml = `<a href="analyzer.html" class="btn-primary">Continue to Skill-Gap Analysis →</a>`;
    } else if (nextGatePending) {
      nextBtnHtml = `<button type="button" id="btn-quiz-next-skill" class="btn-primary">
          Next Required Test: ${escapeHtml(Data.SKILL_MAP[nextGatePending]?.name || nextGatePending)} →
        </button>`;
    } else {
      nextBtnHtml = `<span class="btn-primary is-locked" aria-disabled="true" title="Complete your diagnostic test to unlock">
          🔒 Continue to Skill-Gap Analysis
        </span>`;
    }

    const tabWarningHtml =
      res.tabSwitchCount > 0
        ? `<div class="quiz-tab-warn-note">⚠ ${res.tabSwitchCount} tab switch(es) recorded during this attempt.</div>`
        : "";

    stageEl.innerHTML = `
      <div class="quiz-result-card">
        <div class="quiz-result-top">
          <div>
            <span class="ai-mini-badge">${escapeHtml(session.skillName)} Verification Result</span>
            <h2>Score: ${res.totalScore} / 5</h2>
          </div>
          <span class="level-badge-lg level-${res.level.toLowerCase()}">${escapeHtml(res.level)}</span>
        </div>

        <div class="quiz-breakdown-grid">
          <div class="quiz-break-box">
            <span>Easy Questions</span>
            <strong>${res.easy} / 3</strong>
          </div>
          <div class="quiz-break-box">
            <span>Hard Questions</span>
            <strong>${res.hard} / 2</strong>
          </div>
          <div class="quiz-break-box">
            <span>Verified Score</span>
            <strong>${res.verifiedPct}%</strong>
          </div>
        </div>

        ${selfVsVerifiedHtml}
        ${tabWarningHtml}

        <p class="quiz-level-meaning">${escapeHtml(LEVEL_MEANINGS[res.level])}</p>

        ${
          res.updatedPlanSummary
            ? `<div class="quiz-replan-banner">
                <strong>✦ Adaptive Re-Plan Updated:</strong> ${escapeHtml(res.updatedPlanSummary)}
              </div>`
            : ""
        }

        <div class="quiz-result-actions">
          ${nextBtnHtml}
          ${
            gateCleared
              ? `<button type="button" id="btn-quiz-retake" class="btn-secondary">
                  Retake ${escapeHtml(session.skillName)} Test
                </button>`
              : `<span class="gate-lock-note">🔒 Retakes unlock after all required skill tests are completed.</span>`
          }
        </div>
      </div>
    `;

    const nextSkillBtn = document.getElementById("btn-quiz-next-skill");
    if (nextSkillBtn && nextGatePending) {
      nextSkillBtn.addEventListener("click", () => startSkillTest(nextGatePending));
    }

    const retakeBtn = document.getElementById("btn-quiz-retake");
    if (retakeBtn) {
      retakeBtn.addEventListener("click", () => startSkillTest(session.skillId));
    }
  }

  // ── Render: Attempt History ──────────────────────────────────────────────────
  function renderHistory() {
    const empId = getEmpId();
    const attempts = appState.testResults?.[empId]?.[activeSkillId] || [];
    const skillName = Data.SKILL_MAP[activeSkillId]?.name || activeSkillId;

    if (attempts.length === 0) {
      historyCardEl.hidden = true;
      return;
    }

    historyCardEl.hidden = false;
    historyTitleEl.textContent = `${skillName} Diagnostic Attempt History (${attempts.length})`;

    historyListEl.innerHTML = `
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Date</th>
              <th>Score</th>
              <th>Easy / Hard</th>
              <th>Verified Level</th>
              <th>Tab Switches</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            ${attempts
              .slice()
              .reverse()
              .map(
                (att, idx) => `
              <tr>
                <td>#${attempts.length - idx}</td>
                <td>${escapeHtml(String(att.date || "").slice(0, 16).replace("T", " "))}</td>
                <td><strong>${att.score} / 5</strong> (${att.verifiedPct}%)</td>
                <td>${att.easyCorrect}/3 · ${att.hardCorrect}/2</td>
                <td><span class="ver-mini-pill level-${att.level.toLowerCase()}">${escapeHtml(att.level)}</span></td>
                <td>${att.tabSwitchCount != null ? att.tabSwitchCount : "—"}</td>
                <td>${escapeHtml(att.source || "Offline Bank")}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (!session || session.finished) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
      return;
    }
    if (!session.answered && ["1", "2", "3", "4"].includes(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < session.questions[session.currentIndex].options.length) {
        selectAnswer(idx);
      }
    } else if (session.answered && e.key === "Enter") {
      e.preventDefault();
      advanceQuestion();
    }
  });

  // ── Init ─────────────────────────────────────────────────────────────────────
  Nav.render({
    activePage: "quiz",
    state: appState,
    onReset: () => window.location.reload(),
  });

  renderGateProgress();
  renderQueue();

  if (activeInProgSkill) {
    startSkillTest(activeInProgSkill);
  } else if (requestedSkill && Questions.hasQuestions(requestedSkill)) {
    startSkillTest(requestedSkill);
  } else {
    renderStage();
    renderHistory();
  }
})();
