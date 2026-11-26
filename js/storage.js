/**
 * Browser localStorage persistence layer for SkillSync AI.
 * Stores all user profile data, diagnostic test attempts, verified levels,
 * course progress, nudges, notifications, HR priorities, and re-plan history
 * strictly in browser localStorage with automatic schema migration.
 */
window.SkillPathStorage = (function () {
  const STORAGE_KEY = "skillsync_ai_state_v2";
  const LEGACY_KEY_V1 = "skillsync_ai_state_v1";
  const LEGACY_KEY_OLD = "skillpath_ai_state_v1";
  const THEME_KEY = "skillsync_ai_theme";
  const CURRENT_EMP_ID = "emp_current";

  function defaultState() {
    const defaultPriorities =
      window.SkillPathData && window.SkillPathData.DEFAULT_ORG_PRIORITIES
        ? JSON.parse(JSON.stringify(window.SkillPathData.DEFAULT_ORG_PRIORITIES))
        : [{ skillId: "power_bi", weight: 5 }];

    return {
      schemaVersion: 3,
      activeRole: "employee",
      currentEmployeeId: CURRENT_EMP_ID,
      anonymiseHR: true,
      profile: null,
      courseProgress: {},
      testResults: {},
      verifiedLevels: {},
      notifications: [],
      nudges: [],
      priorities: defaultPriorities,
      replanHistory: [],
      updatedAt: null,
      gate: { required: [], completed: [], cleared: false, clearedAt: null },
      inProgress: null,
    };
  }

  function migrateState(parsed) {
    const base = defaultState();
    if (!parsed || typeof parsed !== "object") {
      return base;
    }

    const activeRole = ["employee", "manager", "hr"].includes(parsed.activeRole)
      ? parsed.activeRole
      : "employee";

    // Gate migration: existing users (schemaVersion < 3 or no gate field) with saved
    // data are treated as "gate not cleared" — they must take tests for selectedSkills.
    const isLegacySchema =
      !parsed.gate ||
      typeof parsed.gate !== "object" ||
      !parsed.schemaVersion ||
      Number(parsed.schemaVersion) < 3;

    const profileObj =
      parsed.profile && typeof parsed.profile === "object"
        ? parsed.profile
        : null;
    const profileSkills = Array.isArray(profileObj?.selectedSkills)
      ? profileObj.selectedSkills.slice()
      : [];

    let gate;
    if (isLegacySchema) {
      gate = {
        required: profileSkills,
        completed: [],
        cleared: false,
        clearedAt: null,
      };
    } else {
      const required = Array.isArray(parsed.gate.required)
        ? parsed.gate.required.slice()
        : profileSkills;
      const completed = Array.isArray(parsed.gate.completed)
        ? parsed.gate.completed.slice()
        : [];
      const isZeroSkillCleared =
        Boolean(parsed.gate.cleared) &&
        Boolean(profileObj) &&
        Array.isArray(profileObj.selectedSkills) &&
        profileObj.selectedSkills.length === 0 &&
        required.length === 0;
      const cleared =
        required.length > 0
          ? required.every((s) => completed.includes(s))
          : isZeroSkillCleared;
      gate = {
        required,
        completed,
        cleared,
        clearedAt: cleared ? parsed.gate.clearedAt || null : null,
      };
    }

    const inProgress =
      parsed.inProgress &&
      typeof parsed.inProgress === "object" &&
      parsed.inProgress.skill
        ? parsed.inProgress
        : null;

    return {
      schemaVersion: 3,
      activeRole,
      currentEmployeeId: parsed.currentEmployeeId || CURRENT_EMP_ID,
      anonymiseHR:
        typeof parsed.anonymiseHR === "boolean" ? parsed.anonymiseHR : true,
      profile: profileObj,
      courseProgress:
        parsed.courseProgress && typeof parsed.courseProgress === "object"
          ? parsed.courseProgress
          : {},
      testResults:
        parsed.testResults && typeof parsed.testResults === "object"
          ? parsed.testResults
          : {},
      verifiedLevels:
        parsed.verifiedLevels && typeof parsed.verifiedLevels === "object"
          ? parsed.verifiedLevels
          : {},
      notifications: Array.isArray(parsed.notifications)
        ? parsed.notifications
        : [],
      nudges: Array.isArray(parsed.nudges) ? parsed.nudges : [],
      priorities: Array.isArray(parsed.priorities)
        ? parsed.priorities
        : base.priorities,
      replanHistory: Array.isArray(parsed.replanHistory)
        ? parsed.replanHistory
        : [],
      updatedAt: parsed.updatedAt || null,
      gate,
      inProgress,
    };
  }

  function readLocal() {
    try {
      let raw = window.localStorage.getItem(STORAGE_KEY);
      let needsMigrationSave = false;
      if (!raw) {
        // Try v1 key (previous version)
        const legacyV1 = window.localStorage.getItem(LEGACY_KEY_V1);
        if (legacyV1) {
          raw = legacyV1;
          needsMigrationSave = true;
        }
      }
      if (!raw) {
        // Try oldest key
        const legacyOld = window.localStorage.getItem(LEGACY_KEY_OLD);
        if (legacyOld) {
          raw = legacyOld;
          needsMigrationSave = true;
        }
      }
      if (!raw) {
        return defaultState();
      }
      const parsed = JSON.parse(raw);
      const migrated = migrateState(parsed);
      if (needsMigrationSave || !parsed.schemaVersion || parsed.schemaVersion < 3) {
        writeLocal(migrated);
      }
      return migrated;
    } catch (_err) {
      return defaultState();
    }
  }

  function writeLocal(state) {
    const payload = {
      ...migrateState(state),
      updatedAt: state.updatedAt || new Date().toISOString(),
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_err) {
      // Ignore storage quota errors in restricted environments.
    }
    return payload;
  }

  async function initState() {
    return readLocal();
  }

  async function saveProfile(profile) {
    const local = readLocal();
    const newSelected = Array.isArray(profile?.selectedSkills)
      ? profile.selectedSkills.slice()
      : [];

    const prevGate = local.gate || {
      required: [],
      completed: [],
      cleared: false,
      clearedAt: null,
    };
    const prevCompleted = Array.isArray(prevGate.completed)
      ? prevGate.completed
      : [];

    // Keep completed only if still in new selection; drop removed skills
    const newCompleted = prevCompleted.filter((s) => newSelected.includes(s));
    const newRequired = newSelected.slice();

    // Cleared if all selected skills are completed (or 0 skills selected on profile)
    const isCleared =
      newRequired.length > 0
        ? newRequired.every((s) => newCompleted.includes(s))
        : Boolean(profile && Array.isArray(profile.selectedSkills));

    const gate = {
      required: newRequired,
      completed: newCompleted,
      cleared: isCleared,
      clearedAt: isCleared
        ? prevGate.clearedAt || new Date().toISOString()
        : null,
    };

    // Drop inProgress if that skill was removed from profile
    const updatedInProgress =
      local.inProgress && !newRequired.includes(local.inProgress.skill)
        ? null
        : local.inProgress;

    return writeLocal({
      ...local,
      profile,
      gate,
      inProgress: updatedInProgress,
      updatedAt: new Date().toISOString(),
    });
  }

  async function setCourseStatus(courseId, status) {
    const local = readLocal();
    const progress = { ...(local.courseProgress || {}) };
    if (status === "not_started") {
      delete progress[courseId];
    } else {
      progress[courseId] = status;
    }
    return writeLocal({
      ...local,
      courseProgress: progress,
      updatedAt: new Date().toISOString(),
    });
  }

  async function setActiveRole(role) {
    const valid = ["employee", "manager", "hr"].includes(role)
      ? role
      : "employee";
    const local = readLocal();
    return writeLocal({
      ...local,
      activeRole: valid,
      updatedAt: new Date().toISOString(),
    });
  }

  async function setAnonymiseHR(value) {
    const local = readLocal();
    return writeLocal({
      ...local,
      anonymiseHR: Boolean(value),
      updatedAt: new Date().toISOString(),
    });
  }

  async function recordTestAttempt(employeeId, skillId, attemptRecord) {
    const local = readLocal();
    const empId = employeeId || local.currentEmployeeId || CURRENT_EMP_ID;
    const allResults = { ...(local.testResults || {}) };
    const empResults = { ...(allResults[empId] || {}) };
    const prevAttempts = Array.isArray(empResults[skillId])
      ? empResults[skillId].slice()
      : [];

    prevAttempts.push(attemptRecord);
    empResults[skillId] = prevAttempts;
    allResults[empId] = empResults;

    const allVerified = { ...(local.verifiedLevels || {}) };
    const empVerified = { ...(allVerified[empId] || {}) };
    empVerified[skillId] = {
      level: attemptRecord.level,
      score: attemptRecord.score,
      easyCorrect: attemptRecord.easyCorrect,
      hardCorrect: attemptRecord.hardCorrect,
      verifiedPct: attemptRecord.verifiedPct,
      updatedAt: attemptRecord.date,
    };
    allVerified[empId] = empVerified;

    // Update gate: mark this skill as completed for the current user
    let updatedGate = local.gate || { required: [], completed: [], cleared: false, clearedAt: null };
    if (empId === (local.currentEmployeeId || CURRENT_EMP_ID)) {
      const prevCompleted = Array.isArray(updatedGate.completed) ? updatedGate.completed : [];
      const newCompleted = prevCompleted.includes(skillId)
        ? prevCompleted
        : [...prevCompleted, skillId];
      const required = Array.isArray(updatedGate.required) ? updatedGate.required : [];
      const isCleared = required.length > 0 && required.every((s) => newCompleted.includes(s));
      updatedGate = {
        ...updatedGate,
        completed: newCompleted,
        cleared: isCleared,
        clearedAt: isCleared && !updatedGate.clearedAt ? new Date().toISOString() : updatedGate.clearedAt,
      };
    }

    // Clear inProgress for this skill since it's now completed
    const updatedInProgress = local.inProgress && local.inProgress.skill === skillId
      ? null
      : local.inProgress;

    return writeLocal({
      ...local,
      testResults: allResults,
      verifiedLevels: allVerified,
      gate: updatedGate,
      inProgress: updatedInProgress,
      updatedAt: new Date().toISOString(),
    });
  }

  async function addReplanEntry(entry) {
    const local = readLocal();
    const list = Array.isArray(local.replanHistory)
      ? local.replanHistory.slice()
      : [];
    list.unshift({
      id: `replan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      date: new Date().toISOString(),
      ...entry,
    });
    return writeLocal({
      ...local,
      replanHistory: list.slice(0, 30),
      updatedAt: new Date().toISOString(),
    });
  }

  async function addNudge({
    employeeId,
    employeeName,
    actionType = "nudge",
    senderRole = "manager",
    message,
  }) {
    const local = readLocal();
    const timestamp = new Date().toISOString();
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const notifications = [
      {
        id,
        employeeId,
        employeeName,
        type: actionType,
        senderRole,
        message,
        createdAt: timestamp,
        read: false,
      },
      ...(local.notifications || []),
    ].slice(0, 40);

    const nudges = [
      {
        id,
        employeeId,
        employeeName,
        actionType,
        senderRole,
        message,
        createdAt: timestamp,
      },
      ...(local.nudges || []),
    ].slice(0, 40);

    return writeLocal({
      ...local,
      notifications,
      nudges,
      updatedAt: timestamp,
    });
  }

  async function markNotificationsRead() {
    const local = readLocal();
    const notifications = (local.notifications || []).map((n) => ({
      ...n,
      read: true,
    }));
    return writeLocal({
      ...local,
      notifications,
      updatedAt: new Date().toISOString(),
    });
  }

  async function savePriorities(priorities) {
    const local = readLocal();
    const clean = (Array.isArray(priorities) ? priorities : [])
      .filter((p) => p && p.skillId)
      .map((p) => ({
        skillId: String(p.skillId),
        weight: Math.max(1, Math.min(5, Number(p.weight) || 3)),
      }));

    return writeLocal({
      ...local,
      priorities: clean,
      updatedAt: new Date().toISOString(),
    });
  }

  async function resetState() {
    const local = readLocal();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_KEY_V1);
      window.localStorage.removeItem(LEGACY_KEY_OLD);
    } catch (_err) {
      // Ignore storage removal errors.
    }
    const fresh = defaultState();
    fresh.activeRole = local.activeRole || "employee";
    return fresh;
  }

  function getTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY) === "dark"
        ? "dark"
        : "light";
    } catch (_err) {
      return "light";
    }
  }

  function setTheme(theme) {
    const clean = theme === "dark" ? "dark" : "light";
    try {
      window.localStorage.setItem(THEME_KEY, clean);
    } catch (_err) {
      // Ignore storage error.
    }
    document.documentElement.setAttribute("data-theme", clean);
    return clean;
  }

  /**
   * Save mid-test resume state so a refresh can resume at the exact question.
   * Stores shuffled order and all answers given so far.
   */
  function saveInProgress(inProgressData) {
    const local = readLocal();
    return writeLocal({
      ...local,
      inProgress: inProgressData,
      updatedAt: new Date().toISOString(),
    });
  }

  function clearInProgress() {
    const local = readLocal();
    return writeLocal({
      ...local,
      inProgress: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Recompute and persist the gate state from the current profile + completed tests.
   * Called after profile edits and test completions.
   */
  function updateGate(profile, completedSkillIds) {
    const local = readLocal();
    const selectedSkills = Array.isArray(profile?.selectedSkills) ? profile.selectedSkills : [];
    const required = selectedSkills.slice();
    const completed = Array.isArray(completedSkillIds)
      ? completedSkillIds.filter((s) => required.includes(s))
      : [];
    const isCleared = required.length > 0 && required.every((s) => completed.includes(s));
    const prevGate = local.gate || {};
    const gate = {
      required,
      completed,
      cleared: isCleared,
      clearedAt: isCleared ? (prevGate.clearedAt || new Date().toISOString()) : null,
    };
    return writeLocal({ ...local, gate, updatedAt: new Date().toISOString() });
  }

  return {
    CURRENT_EMP_ID,
    readLocal,
    initState,
    saveProfile,
    setCourseStatus,
    setActiveRole,
    setAnonymiseHR,
    recordTestAttempt,
    addReplanEntry,
    addNudge,
    markNotificationsRead,
    savePriorities,
    resetState,
    getTheme,
    setTheme,
    saveInProgress,
    clearInProgress,
    updateGate,
  };
})();
