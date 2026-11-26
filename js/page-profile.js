/**
 * Page 1 Controller: Multi-step Profile Setup Wizard + Demo Employee Loader.
 */
(async function () {
  const Data = window.SkillPathData;
  const Storage = window.SkillPathStorage;
  const Engine = window.SkillPathEngine;
  const Nav = window.SkillPathNav;
  const { escapeHtml } = Nav;

  const TOTAL_STEPS = 4;

  let appState = await Storage.initState();

  function createDraftFromProfile(profile) {
    const defaultRole =
      Data.ROLE_MAP["ai_ml_engineer"]?.id || Data.ROLES_CATALOG[0].id;
    const rawType = profile?.userType ?? profile?.status;
    const userType = rawType === "other" ? "other" : "employee";
    return {
      name: profile?.name || "",
      isDemo: Boolean(profile?.isDemo),
      userType,
      previousField:
        userType === "other" && typeof profile?.previousField === "string"
          ? profile.previousField
          : "",
      backgroundDetail:
        profile?.backgroundDetail || Data.BACKGROUND_OPTIONS[userType].choices[0],
      targetRole: profile?.targetRole || defaultRole,
      companyPriority:
        profile?.companyPriority || Data.COMPANY_PRIORITIES[0].id,
      selectedSkills: Array.isArray(profile?.selectedSkills)
        ? [...profile.selectedSkills]
        : [],
      skillRatings: { ...(profile?.skillRatings || {}) },
      skillScores: { ...(profile?.skillScores || {}) },
      experience: profile?.experience || "0",
      learningSlotsPerWeek: Number(profile?.learningSlotsPerWeek || 3),
      weeklyHours: profile?.weeklyHours || "5-10",
    };
  }

  let draft = createDraftFromProfile(appState.profile);
  let currentStep = 1;
  let maxVisitedStep = appState.profile ? TOTAL_STEPS : 1;
  let activeSkillFilter = "all";

  // DOM References
  const stepCounterEl = document.getElementById("wizard-step-counter");
  const progressPctEl = document.getElementById("wizard-progress-pct");
  const progressBarEl = document.getElementById("wizard-progressbar");
  const progressFillEl = document.getElementById("wizard-progress-fill");
  const tabsEl = document.getElementById("wizard-tabs");
  const panels = Array.from(document.querySelectorAll(".wizard-panel"));
  const errorBox = document.getElementById("wizard-error");
  const btnPrev = document.getElementById("btn-prev");
  const btnNext = document.getElementById("btn-next");

  const loadDemoBtn = document.getElementById("btn-load-demo-employee");
  const demoGoGapBtn = document.getElementById("btn-demo-go-gap");
  const verifySkillsTopBtn = document.getElementById("btn-verify-skills-top");

  const nameInput = document.getElementById("input-name");
  const userTypeSelectEl = document.getElementById("select-user-type");
  const userTypeHelperEl = document.getElementById("user-type-helper");
  const backgroundLabelEl = document.getElementById("background-label");
  const backgroundSelectEl = document.getElementById("select-background");
  const previousFieldGroupEl = document.getElementById("previous-field-group");
  const previousFieldInputEl = document.getElementById("input-previous-field");
  const roleSelectEl = document.getElementById("select-role");
  const prioritySelectEl = document.getElementById("select-priority");
  const rolePreviewEl = document.getElementById("role-preview-card");
  const skillFiltersEl = document.getElementById("skill-category-filters");
  const skillChipsEl = document.getElementById("skills-chip-grid");
  const ratingsListEl = document.getElementById("selected-ratings-list");
  const clearSkillsBtn = document.getElementById("btn-clear-skills");
  const expOptionsEl = document.getElementById("experience-options");
  const slotsOptionsEl = document.getElementById("slots-options");
  const summaryPreviewEl = document.getElementById("wizard-summary-preview");

  const RATING_LABELS = {
    1: "Basic",
    2: "Beginner",
    3: "Intermediate",
    4: "Proficient",
    5: "Expert",
  };

  function showError(msg) {
    if (!msg) {
      errorBox.hidden = true;
      errorBox.textContent = "";
      return;
    }
    errorBox.hidden = false;
    errorBox.textContent = msg;
  }

  function renderUserTypeSelect() {
    userTypeSelectEl.innerHTML = Data.STATUS_OPTIONS.map(
      (opt) =>
        `<option value="${escapeHtml(opt.id)}" ${draft.userType === opt.id ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
    ).join("");
    userTypeSelectEl.value = draft.userType;

    const selectedOpt =
      Data.STATUS_OPTIONS.find((opt) => opt.id === draft.userType) ||
      Data.STATUS_OPTIONS[0];
    if (userTypeHelperEl && selectedOpt) {
      userTypeHelperEl.textContent = selectedOpt.description;
    }

    if (previousFieldGroupEl) {
      previousFieldGroupEl.hidden = draft.userType !== "other";
    }
    if (previousFieldInputEl) {
      previousFieldInputEl.value = draft.previousField || "";
    }
  }

  function renderBackgroundDropdown() {
    const config =
      Data.BACKGROUND_OPTIONS[draft.userType] || Data.BACKGROUND_OPTIONS.other;
    backgroundLabelEl.innerHTML = `${escapeHtml(config.label)} <span class="req">*</span>`;

    if (!config.choices.includes(draft.backgroundDetail)) {
      draft.backgroundDetail = config.choices[0];
    }

    backgroundSelectEl.innerHTML = config.choices
      .map(
        (choice) =>
          `<option value="${escapeHtml(choice)}" ${choice === draft.backgroundDetail ? "selected" : ""}>${escapeHtml(choice)}</option>`
      )
      .join("");
  }

  function renderRoleAndPrioritySelects() {
    roleSelectEl.innerHTML = Data.ROLES_CATALOG.map(
      (role) =>
        `<option value="${escapeHtml(role.id)}" ${role.id === draft.targetRole ? "selected" : ""}>${escapeHtml(role.name)}</option>`
    ).join("");

    prioritySelectEl.innerHTML = Data.COMPANY_PRIORITIES.map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === draft.companyPriority ? "selected" : ""}>${escapeHtml(p.label)} — ${escapeHtml(p.description)}</option>`
    ).join("");

    renderRolePreview();
  }

  function renderRolePreview() {
    const role = Data.ROLE_MAP[draft.targetRole] || Data.ROLES_CATALOG[0];
    const pills = role.skills
      .map((s) => {
        const name = Data.SKILL_MAP[s.skillId]?.name || s.skillId;
        const targetPct =
          s.requiredPct !== undefined ? s.requiredPct : s.required * 20;
        const tags = Data.SKILL_PRIORITY_TAGS[s.skillId] || [];
        const priorityMatch = tags.includes(draft.companyPriority);
        return `<span class="preview-skill-pill ${priorityMatch ? "is-priority-pill" : ""}">
          ${escapeHtml(name)} <em>(${targetPct}% target)</em>
          ${priorityMatch ? `<span class="mini-priority-dot">★ Priority</span>` : ""}
        </span>`;
      })
      .join("");

    rolePreviewEl.innerHTML = `
      <div class="role-preview-top">
        <div>
          <span class="ai-mini-badge">AI Role Blueprint</span>
          <h3>${escapeHtml(role.name)}</h3>
          <p>${escapeHtml(role.tagline)}</p>
        </div>
        <div class="role-skill-count">${role.skills.length} core skills</div>
      </div>
      <div class="role-preview-skills">${pills}</div>
    `;
  }

  function renderSkillCategoryFilters() {
    const role = Data.ROLE_MAP[draft.targetRole] || Data.ROLES_CATALOG[0];
    const filters = [
      { id: "all", label: "All Skills" },
      { id: "role", label: `For ${role.name}` },
      ...Data.SKILL_CATEGORIES.map((c) => ({ id: c, label: c })),
    ];

    skillFiltersEl.innerHTML = filters
      .map(
        (f) => `
        <button
          type="button"
          class="filter-pill ${activeSkillFilter === f.id ? "is-active" : ""}"
          data-filter="${escapeHtml(f.id)}"
        >${escapeHtml(f.label)}</button>
      `
      )
      .join("");

    skillFiltersEl.querySelectorAll(".filter-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeSkillFilter = btn.getAttribute("data-filter");
        renderSkillCategoryFilters();
        renderSkillChips();
      });
    });
  }

  function renderSkillChips() {
    const role = Data.ROLE_MAP[draft.targetRole] || Data.ROLES_CATALOG[0];
    const roleSkillIds = new Set(role.skills.map((s) => s.skillId));

    const visibleSkills = Data.SKILLS_CATALOG.filter((skill) => {
      if (activeSkillFilter === "all") return true;
      if (activeSkillFilter === "role") return roleSkillIds.has(skill.id);
      return skill.category === activeSkillFilter;
    });

    skillChipsEl.innerHTML = visibleSkills
      .map((skill) => {
        const isSelected = draft.selectedSkills.includes(skill.id);
        const isTargetSkill = roleSkillIds.has(skill.id);
        return `
          <button
            type="button"
            class="skill-chip ${isSelected ? "is-selected" : ""} ${isTargetSkill ? "is-target-match" : ""}"
            data-skill-id="${escapeHtml(skill.id)}"
            aria-pressed="${isSelected}"
          >
            <span class="chip-check" aria-hidden="true">${isSelected ? "✓" : "+"}</span>
            <span>${escapeHtml(skill.name)}</span>
            ${isTargetSkill ? `<span class="chip-goal-dot" title="Core skill for ${escapeHtml(role.name)}">★</span>` : ""}
          </button>
        `;
      })
      .join("");

    skillChipsEl.querySelectorAll(".skill-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const skillId = chip.getAttribute("data-skill-id");
        toggleSkill(skillId);
      });
    });
  }

  function toggleSkill(skillId) {
    draft.isDemo = false;
    const idx = draft.selectedSkills.indexOf(skillId);
    if (idx >= 0) {
      draft.selectedSkills.splice(idx, 1);
      delete draft.skillRatings[skillId];
      delete draft.skillScores[skillId];
    } else {
      draft.selectedSkills.push(skillId);
      if (!draft.skillRatings[skillId]) {
        draft.skillRatings[skillId] = 3;
      }
      if (draft.skillScores[skillId] === undefined) {
        draft.skillScores[skillId] = draft.skillRatings[skillId] * 20;
      }
    }
    renderSkillChips();
    renderSelectedRatings();
    renderSummaryPreview();
  }

  function renderSelectedRatings() {
    if (draft.selectedSkills.length === 0) {
      ratingsListEl.innerHTML = `
        <div class="ratings-empty">
          No current skills selected yet — click any skill chips above to score yourself,
          or click <strong>Next</strong> for a complete beginner roadmap from Step 1!
        </div>
      `;
      return;
    }

    const empId = appState.currentEmployeeId || "emp_current";
    const verifiedMap = appState.verifiedLevels?.[empId] || {};

    ratingsListEl.innerHTML = draft.selectedSkills
      .map((skillId) => {
        const skill = Data.SKILL_MAP[skillId];
        if (!skill) return "";
        const scorePct =
          draft.skillScores[skillId] !== undefined
            ? Number(draft.skillScores[skillId])
            : Number(draft.skillRatings[skillId] || 3) * 20;
        const starVal =
          draft.skillRatings[skillId] ||
          Math.max(1, Math.min(5, Math.round(scorePct / 20)));
        const ver = verifiedMap[skillId];
        const gateCleared = Engine.isGateCleared(appState);
        const gateCompleted = Array.isArray(appState.gate?.completed)
          ? appState.gate.completed
          : [];
        const isSkillDoneInGate = gateCompleted.includes(skillId);
        const verBadge = ver
          ? `<span class="ver-mini-pill level-${ver.level.toLowerCase()}">Verified ${escapeHtml(ver.level)} (${ver.verifiedPct}%)</span>`
          : `<span class="ver-mini-pill level-unverified">Pending diagnostic</span>`;

        const diagControlHtml =
          isSkillDoneInGate && !gateCleared
            ? `<span class="gate-status-pill gate-completed" title="Complete all remaining skills first to unlock retakes">✓ Tested</span>`
            : `<button
                type="button"
                class="btn-ghost-sm btn-diagnostic-inline"
                data-take-quiz="${escapeHtml(skillId)}"
                title="Run 5-question diagnostic test for ${escapeHtml(skill.name)}"
              >${ver && gateCleared ? "Retake test" : "Take diagnostic test"}</button>`;

        const starsHtml = [1, 2, 3, 4, 5]
          .map(
            (star) => `
            <button
              type="button"
              class="star-btn ${star <= starVal ? "is-filled" : ""}"
              data-skill-id="${escapeHtml(skillId)}"
              data-rating="${star}"
              aria-label="Rate ${escapeHtml(skill.name)} ${star} out of 5 (${star * 20}%)"
              title="${star}/5 (${star * 20}%) — ${RATING_LABELS[star]}"
            >★</button>
          `
          )
          .join("");

        return `
          <div class="rating-row">
            <div class="rating-skill-info">
              <span class="rating-skill-name">${escapeHtml(skill.name)}</span>
              <span class="rating-level-badge">${scorePct}% · ${RATING_LABELS[starVal]}</span>
              ${verBadge}
            </div>
            <div class="rating-controls">
              <div class="star-group" role="group" aria-label="Rating for ${escapeHtml(skill.name)}">
                ${starsHtml}
              </div>
              ${diagControlHtml}
              <button
                type="button"
                class="rating-remove-btn"
                data-remove-skill="${escapeHtml(skillId)}"
                aria-label="Remove ${escapeHtml(skill.name)}"
                title="Remove skill"
              >✕</button>
            </div>
          </div>
        `;
      })
      .join("");

    ratingsListEl.querySelectorAll("[data-take-quiz]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const skillId = btn.getAttribute("data-take-quiz");
        const clean = buildCleanProfile();
        if (!clean.name) clean.name = "Employee";
        try {
          await Storage.saveProfile(clean);
          window.location.href = `quiz.html?skill=${encodeURIComponent(skillId)}`;
        } catch (err) {
          showError(err?.message || "Invalid profile details.");
        }
      });
    });

    ratingsListEl.querySelectorAll(".star-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const skillId = btn.getAttribute("data-skill-id");
        const rating = Number(btn.getAttribute("data-rating"));
        draft.isDemo = false;
        draft.skillRatings[skillId] = rating;
        draft.skillScores[skillId] = rating * 20;
        renderSelectedRatings();
        renderSummaryPreview();
      });
    });

    ratingsListEl.querySelectorAll(".rating-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const skillId = btn.getAttribute("data-remove-skill");
        toggleSkill(skillId);
      });
    });
  }

  function renderExperienceOptions() {
    expOptionsEl.innerHTML = Data.EXPERIENCE_OPTIONS.map((opt) => {
      const selected = draft.experience === opt.id;
      return `
        <button
          type="button"
          class="choice-card choice-card-compact ${selected ? "is-selected" : ""}"
          data-exp="${escapeHtml(opt.id)}"
          aria-pressed="${selected}"
        >
          <span class="choice-title">${escapeHtml(opt.label)}</span>
          <span class="choice-desc">${escapeHtml(opt.sublabel)}</span>
        </button>
      `;
    }).join("");

    expOptionsEl.querySelectorAll("[data-exp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        draft.experience = btn.getAttribute("data-exp");
        renderExperienceOptions();
        renderSummaryPreview();
      });
    });
  }

  function renderSlotsOptions() {
    slotsOptionsEl.innerHTML = Data.LEARNING_SLOTS_OPTIONS.map((opt) => {
      const selected = Number(draft.learningSlotsPerWeek) === opt.slotsPerWeek;
      return `
        <button
          type="button"
          class="choice-card choice-card-compact ${selected ? "is-selected" : ""}"
          data-slots="${opt.slotsPerWeek}"
          data-hours-id="${escapeHtml(opt.weeklyHoursId)}"
          aria-pressed="${selected}"
        >
          <span class="choice-title">${escapeHtml(opt.label)}</span>
          <span class="choice-desc">${escapeHtml(opt.sublabel)}</span>
        </button>
      `;
    }).join("");

    slotsOptionsEl.querySelectorAll("[data-slots]").forEach((btn) => {
      btn.addEventListener("click", () => {
        draft.learningSlotsPerWeek = Number(btn.getAttribute("data-slots"));
        draft.weeklyHours = btn.getAttribute("data-hours-id");
        renderSlotsOptions();
        renderSummaryPreview();
      });
    });
  }

  function renderSummaryPreview() {
    const role = Data.ROLE_MAP[draft.targetRole] || Data.ROLES_CATALOG[0];
    const exp = Data.EXPERIENCE_OPTIONS.find((e) => e.id === draft.experience);
    const displayName = draft.name.trim() || "You";
    const typeLabel =
      draft.userType === "other" ? "New joiner / Other" : "Employee";
    const prevFieldNote =
      draft.userType === "other" && draft.previousField.trim()
        ? ` · Previous field: ${draft.previousField.trim()}`
        : "";
    const demoNote = draft.isDemo
      ? `<span class="sample-label-tag">Sample data for demonstration</span>`
      : "";

    summaryPreviewEl.innerHTML = `
      <div class="summary-preview-top">
        <div class="summary-preview-badge">Next: Complete Skill Diagnostic (${draft.selectedSkills.length} test${draft.selectedSkills.length === 1 ? "" : "s"})</div>
        ${demoNote}
      </div>
      <p>
        <strong>${escapeHtml(displayName)}</strong> (${escapeHtml(typeLabel)} · ${escapeHtml(draft.backgroundDetail)}${escapeHtml(prevFieldNote)})
        → targeting <strong>${escapeHtml(role.name)}</strong> · Priority:
        <strong>${escapeHtml(draft.companyPriority)}</strong> ·
        <strong>${draft.selectedSkills.length}</strong> selected skill${draft.selectedSkills.length === 1 ? "" : "s"} ·
        <strong>${escapeHtml(exp ? exp.label : "")}</strong> ·
        <strong>${draft.learningSlotsPerWeek} learning slots/week</strong>.
      </p>
    `;
  }

  function validateStep(step) {
    if (step === 1) {
      if (!draft.name.trim()) {
        showError("Please enter the employee or learner name before continuing.");
        nameInput.focus();
        return false;
      }
      if (!Storage.isValidUserType(draft.userType)) {
        showError("Please select a valid user type: Employee or Other.");
        userTypeSelectEl.focus();
        return false;
      }
      if (!draft.backgroundDetail) {
        showError("Please select a current role or onboarding focus.");
        return false;
      }
    }
    if (step === 2 && (!draft.targetRole || !draft.companyPriority)) {
      showError("Please choose your target role and company priority.");
      return false;
    }
    if (step === 4 && (!draft.experience || !draft.learningSlotsPerWeek)) {
      showError("Please pick both your experience level and weekly learning slots.");
      return false;
    }
    showError("");
    return true;
  }

  function goToStep(step) {
    currentStep = Math.max(1, Math.min(TOTAL_STEPS, step));
    maxVisitedStep = Math.max(maxVisitedStep, currentStep);

    const pct = Math.round((currentStep / TOTAL_STEPS) * 100);
    stepCounterEl.textContent = `Step ${currentStep} of ${TOTAL_STEPS}`;
    progressPctEl.textContent = `${pct}%`;
    progressBarEl.setAttribute("aria-valuenow", String(pct));
    progressFillEl.style.width = `${pct}%`;

    panels.forEach((panel) => {
      const pStep = Number(panel.getAttribute("data-panel"));
      const active = pStep === currentStep;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });

    tabsEl.querySelectorAll(".wizard-tab").forEach((tab) => {
      const tStep = Number(tab.getAttribute("data-step"));
      tab.classList.toggle("is-active", tStep === currentStep);
      tab.classList.toggle("is-complete", tStep < currentStep);
      tab.disabled = tStep > maxVisitedStep;
    });

    btnPrev.hidden = currentStep === 1;
    btnNext.textContent =
      currentStep === TOTAL_STEPS ? "Save & Start Diagnostic →" : "Next →";

    if (currentStep === 3) {
      renderSkillCategoryFilters();
      renderSkillChips();
      renderSelectedRatings();
    } else if (currentStep === 4) {
      renderSummaryPreview();
    }

    showError("");
  }

  function buildCleanProfile() {
    const cleanScores = {};
    draft.selectedSkills.forEach((skillId) => {
      if (draft.skillScores[skillId] !== undefined) {
        cleanScores[skillId] = Number(draft.skillScores[skillId]);
      } else {
        cleanScores[skillId] = Number(draft.skillRatings[skillId] || 3) * 20;
      }
    });

    return {
      name: draft.name.trim(),
      isDemo: Boolean(draft.isDemo),
      userType: draft.userType,
      status: draft.userType,
      previousField:
        draft.userType === "other" ? draft.previousField.trim() : "",
      backgroundDetail: draft.backgroundDetail,
      targetRole: draft.targetRole,
      companyPriority: draft.companyPriority,
      companyPriorities: [draft.companyPriority],
      learningSlotsPerWeek: Number(draft.learningSlotsPerWeek),
      selectedSkills: draft.selectedSkills.slice(),
      skillRatings: { ...draft.skillRatings },
      skillScores: cleanScores,
      experience: draft.experience,
      weeklyHours: draft.weeklyHours,
    };
  }

  async function submitProfile() {
    if (!validateStep(1)) {
      goToStep(1);
      validateStep(1);
      return;
    }
    if (!validateStep(2)) {
      goToStep(2);
      validateStep(2);
      return;
    }
    if (!validateStep(4)) {
      return;
    }

    btnNext.disabled = true;
    btnNext.textContent = "Saving...";
    const cleanProfile = buildCleanProfile();
    try {
      await Storage.saveProfile(cleanProfile);
      // Always redirect to quiz for mandatory diagnostic gate
      window.location.href = "quiz.html";
    } catch (err) {
      btnNext.disabled = false;
      btnNext.textContent = "Save & Start Diagnostic →";
      goToStep(1);
      showError(err?.message || "Invalid user type. Please choose Employee or Other.");
    }
  }

  function syncDemoBannerButtons(state) {
    const hasProfile = Boolean(state && state.profile);
    const gateCleared = Boolean(state && Engine.isGateCleared(state));
    if (verifySkillsTopBtn) {
      verifySkillsTopBtn.hidden = !hasProfile;
      verifySkillsTopBtn.textContent = gateCleared
        ? "✓ Review / Retake Diagnostics"
        : "Start Diagnostic Tests →";
    }
    if (demoGoGapBtn) {
      demoGoGapBtn.hidden = !(hasProfile && gateCleared);
    }
  }

  function renderAllWizardSections() {
    nameInput.value = draft.name;
    renderUserTypeSelect();
    renderBackgroundDropdown();
    renderRoleAndPrioritySelects();
    renderSkillCategoryFilters();
    renderSkillChips();
    renderSelectedRatings();
    renderExperienceOptions();
    renderSlotsOptions();
    renderSummaryPreview();
  }

  // Demo Employee Button Handler
  loadDemoBtn.addEventListener("click", async () => {
    await Storage.resetState();
    const demoProfile = Nav.getSampleProfile();
    appState = await Storage.saveProfile(demoProfile);
    draft = createDraftFromProfile(demoProfile);
    maxVisitedStep = TOTAL_STEPS;

    renderAllWizardSections();
    goToStep(4);
    syncDemoBannerButtons(appState);

    Nav.render({
      activePage: "profile",
      state: appState,
      onReset: () => window.location.reload(),
    });
    Nav.showToast(
      "Loaded Demo Employee — click 'Save & Start Diagnostic' to begin skill tests.",
      "success"
    );
  });

  // Bind inputs & events
  nameInput.addEventListener("input", (e) => {
    draft.name = e.target.value;
    draft.isDemo = false;
    if (draft.name.trim()) showError("");
  });

  userTypeSelectEl.addEventListener("change", (e) => {
    const nextType = e.target.value;
    if (!Storage.isValidUserType(nextType)) {
      showError("Invalid user type. Please choose Employee or Other.");
      return;
    }
    draft.userType = nextType;
    const bgConfig =
      Data.BACKGROUND_OPTIONS[nextType] || Data.BACKGROUND_OPTIONS.other;
    draft.backgroundDetail = bgConfig.choices[0];
    draft.isDemo = false;
    showError("");
    renderUserTypeSelect();
    renderBackgroundDropdown();
    renderSummaryPreview();
  });

  if (previousFieldInputEl) {
    previousFieldInputEl.addEventListener("input", (e) => {
      draft.previousField = e.target.value;
      draft.isDemo = false;
      renderSummaryPreview();
    });
  }

  backgroundSelectEl.addEventListener("change", (e) => {
    draft.backgroundDetail = e.target.value;
    draft.isDemo = false;
    renderSummaryPreview();
  });

  roleSelectEl.addEventListener("change", (e) => {
    draft.targetRole = e.target.value;
    draft.isDemo = false;
    renderRolePreview();
    renderSkillCategoryFilters();
    renderSkillChips();
    renderSummaryPreview();
  });

  prioritySelectEl.addEventListener("change", (e) => {
    draft.companyPriority = e.target.value;
    draft.isDemo = false;
    renderRolePreview();
    renderSummaryPreview();
  });

  clearSkillsBtn.addEventListener("click", () => {
    draft.selectedSkills = [];
    draft.skillRatings = {};
    draft.skillScores = {};
    draft.isDemo = false;
    renderSkillChips();
    renderSelectedRatings();
    renderSummaryPreview();
    Nav.showToast("Cleared selected skills — ready for a fresh-start roadmap.");
  });

  tabsEl.querySelectorAll(".wizard-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = Number(tab.getAttribute("data-step"));
      if (
        target <= maxVisitedStep &&
        (target < currentStep || validateStep(currentStep))
      ) {
        goToStep(target);
      }
    });
  });

  btnPrev.addEventListener("click", () => {
    if (currentStep > 1) goToStep(currentStep - 1);
  });

  btnNext.addEventListener("click", () => {
    if (!validateStep(currentStep)) return;
    if (currentStep < TOTAL_STEPS) {
      goToStep(currentStep + 1);
    } else {
      submitProfile();
    }
  });

  // Initial render
  Nav.render({
    activePage: "profile",
    state: appState,
    onReset: () => window.location.reload(),
    onRoleChange: (_role, nextState) => {
      appState = nextState;
      syncDemoBannerButtons(appState);
      Nav.render({
        activePage: "profile",
        state: appState,
        onReset: () => window.location.reload(),
      });
    },
  });
  syncDemoBannerButtons(appState);
  renderAllWizardSections();
  goToStep(1);
})();
