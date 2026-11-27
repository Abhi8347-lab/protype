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
  const VALID_USER_TYPES = ["employee", "other"];

  function isValidUserType(value) {
    return VALID_USER_TYPES.includes(value);
  }

  function normalizeUserType(value) {
    return isValidUserType(value) ? value : "other";
  }

  function migrateProfileUserType(profileObj) {
    if (!profileObj || typeof profileObj !== "object") {
      return { profile: null, changed: false };
    }
    const rawType =
      profileObj.userType !== undefined
        ? profileObj.userType
        : profileObj.status;
    const normalized = normalizeUserType(rawType);
    const changed =
      profileObj.userType !== normalized || profileObj.status !== normalized;
    return {
      profile: {
        ...profileObj,
        userType: normalized,
        status: normalized,
        previousField:
          typeof profileObj.previousField === "string"
            ? profileObj.previousField
            : "",
      },
      changed,
    };
  }

  function defaultState() {
    const defaultPriorities =
      window.SkillPathData && window.SkillPathData.DEFAULT_ORG_PRIORITIES
        ? JSON.parse(JSON.stringify(window.SkillPathData.DEFAULT_ORG_PRIORITIES))
        : [{ skillId: "power_bi", weight: 5 }];

    return {
      schemaVersion: 4,
      activeRole: "employee",
      currentEmployeeId: CURRENT_EMP_ID,
      anonymiseHR: true,
      certRankingBonus: false,
      hrCertNotifications: true,
      profile: null,
      courseProgress: {},
      certifications: {},
      testResults: {},
      verifiedLevels: {},
      notifications: [],
      nudges: [],
      agentActivityLog: [],
      priorities: defaultPriorities,
      replanHistory: [],
      updatedAt: null,
      gate: { required: [], completed: [], cleared: false, clearedAt: null },
      inProgress: null,
    };
  }

  function sanitizeCertificationsMap(rawMap) {
    if (!rawMap || typeof rawMap !== "object") return {};
    const clean = {};
    Object.entries(rawMap).forEach(([empId, list]) => {
      if (!Array.isArray(list)) return;
      const seen = new Map();
      list.forEach((item) => {
        if (!item || typeof item !== "object" || !item.courseId) return;
        const cid = String(item.courseId);
        seen.set(cid, {
          courseId: cid,
          certificationName: String(item.certificationName || ""),
          certId: String(item.certId || ""),
          completedOn: String(
            item.completedOn || new Date().toISOString().slice(0, 10)
          ),
          status: item.status === "verified" ? "verified" : "pending_review",
        });
      });
      clean[empId] = Array.from(seen.values());
    });
    return clean;
  }

  function sanitizeNotificationsList(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList
      .filter((n) => n && typeof n === "object" && n.message)
      .map((n, idx) => ({
        id: String(n.id || `notif_${idx}_${Date.now()}`),
        type: String(n.type || "nudge"),
        audience:
          n.audience ||
          (n.type === "certification_completed" ? "manager" : "employee"),
        notifyHR: typeof n.notifyHR === "boolean" ? n.notifyHR : true,
        employeeId: String(n.employeeId || CURRENT_EMP_ID),
        employeeName: String(n.employeeName || ""),
        senderRole: n.senderRole ? String(n.senderRole) : undefined,
        courseId: n.courseId ? String(n.courseId) : undefined,
        courseTitle: n.courseTitle ? String(n.courseTitle) : undefined,
        certificationName: n.certificationName
          ? String(n.certificationName)
          : undefined,
        completedOn: n.completedOn ? String(n.completedOn) : undefined,
        message: String(n.message),
        createdAt: String(n.createdAt || new Date().toISOString()),
        read: Boolean(n.read),
      }));
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

    const rawProfileObj =
      parsed.profile && typeof parsed.profile === "object"
        ? parsed.profile
        : null;
    const { profile: profileObj } = migrateProfileUserType(rawProfileObj);
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
      schemaVersion: 4,
      activeRole,
      currentEmployeeId: parsed.currentEmployeeId || CURRENT_EMP_ID,
      anonymiseHR:
        typeof parsed.anonymiseHR === "boolean" ? parsed.anonymiseHR : true,
      certRankingBonus:
        typeof parsed.certRankingBonus === "boolean"
          ? parsed.certRankingBonus
          : false,
      hrCertNotifications:
        typeof parsed.hrCertNotifications === "boolean"
          ? parsed.hrCertNotifications
          : true,
      profile: profileObj,
      courseProgress:
        parsed.courseProgress && typeof parsed.courseProgress === "object"
          ? parsed.courseProgress
          : {},
      certifications: sanitizeCertificationsMap(parsed.certifications),
      testResults:
        parsed.testResults && typeof parsed.testResults === "object"
          ? parsed.testResults
          : {},
      verifiedLevels:
        parsed.verifiedLevels && typeof parsed.verifiedLevels === "object"
          ? parsed.verifiedLevels
          : {},
      notifications: sanitizeNotificationsList(parsed.notifications),
      nudges: Array.isArray(parsed.nudges) ? parsed.nudges : [],
      agentActivityLog: Array.isArray(parsed.agentActivityLog)
        ? parsed.agentActivityLog
        : [],
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
      const profileMigration = migrateProfileUserType(parsed?.profile);
      const migrated = migrateState(parsed);
      if (
        needsMigrationSave ||
        profileMigration.changed ||
        !parsed.schemaVersion ||
        parsed.schemaVersion < 4
      ) {
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
    if (!profile || typeof profile !== "object") {
      throw new Error("Profile data is required.");
    }

    const rawUserType =
      profile.userType !== undefined ? profile.userType : profile.status;
    if (!isValidUserType(rawUserType)) {
      throw new Error(
        "Invalid user type. Please choose Employee or Other."
      );
    }
    if (profile.status !== undefined && !isValidUserType(profile.status)) {
      throw new Error(
        "Invalid user type. Please choose Employee or Other."
      );
    }

    const sanitizedProfile = {
      ...profile,
      userType: rawUserType,
      status: rawUserType,
      previousField:
        rawUserType === "other"
          ? String(profile.previousField || "").trim()
          : "",
    };

    const local = readLocal();
    const newSelected = Array.isArray(sanitizedProfile.selectedSkills)
      ? sanitizedProfile.selectedSkills.slice()
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
        : Boolean(sanitizedProfile && Array.isArray(sanitizedProfile.selectedSkills));

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
      profile: sanitizedProfile,
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

  async function setCertRankingBonus(value) {
    const local = readLocal();
    return writeLocal({
      ...local,
      certRankingBonus: Boolean(value),
      updatedAt: new Date().toISOString(),
    });
  }

  async function setHrCertNotifications(value) {
    const local = readLocal();
    return writeLocal({
      ...local,
      hrCertNotifications: Boolean(value),
      updatedAt: new Date().toISOString(),
    });
  }

  function findCourseMeta(courseId) {
    const bySkill = window.SkillPathData?.COURSES_BY_SKILL || {};
    const all = Object.values(bySkill).flat();
    return all.find((c) => c.id === courseId) || null;
  }

  function formatPrettyDate(isoDate) {
    const str = String(isoDate || new Date().toISOString().slice(0, 10)).slice(
      0,
      10
    );
    const parts = str.split("-");
    if (parts.length !== 3) return str;
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const year = parts[0];
    const monthIdx = Math.max(0, Math.min(11, Number(parts[1]) - 1));
    const day = Number(parts[2]);
    return `${day} ${months[monthIdx]} ${year}`;
  }

  /**
   * Return deduplicated certifications for a given employee (including seeded demo data
   * if not yet overridden in state.certifications).
   */
  function getCertifications(employeeId, stateOverride) {
    const state = stateOverride || readLocal();
    const empId = employeeId || state.currentEmployeeId || CURRENT_EMP_ID;
    const map = state.certifications || {};
    if (Array.isArray(map[empId])) {
      return map[empId].map((c) => ({ ...c }));
    }
    const seed = (window.SkillPathData?.SEED_EMPLOYEES || []).find(
      (e) => e.id === empId
    );
    if (seed && Array.isArray(seed.certifications)) {
      return seed.certifications.map((c) => ({ ...c }));
    }
    return [];
  }

  function getCertificationCount(employeeId, stateOverride) {
    return getCertifications(employeeId, stateOverride).length;
  }

  function getVerifiedCertificationCount(employeeId, stateOverride) {
    return getCertifications(employeeId, stateOverride).filter(
      (c) => c.status === "verified"
    ).length;
  }

  /**
   * Add or update an employee certification record.
   * Deduplicates by courseId so resetting and re-completing updates the existing record.
   */
  async function addCertification({
    employeeId,
    courseId,
    certificationName,
    certId,
    completedOn,
    status = "pending_review",
  }) {
    if (!courseId) {
      throw new Error("Course ID is required to record a certification.");
    }
    const cleanCertId = String(certId || "").trim();
    if (!cleanCertId) {
      throw new Error("Certificate ID or link is required.");
    }

    const local = readLocal();
    const empId = employeeId || local.currentEmployeeId || CURRENT_EMP_ID;
    const courseMeta = findCourseMeta(courseId);
    const cleanName = String(
      certificationName ||
        courseMeta?.certificationName ||
        courseMeta?.title ||
        courseId
    ).trim();
    const cleanDate = String(
      completedOn || new Date().toISOString().slice(0, 10)
    ).slice(0, 10);
    const cleanStatus = status === "verified" ? "verified" : "pending_review";

    const existingList = getCertifications(empId, local);
    const existingIdx = existingList.findIndex((c) => c.courseId === courseId);
    const record = {
      courseId: String(courseId),
      certificationName: cleanName,
      certId: cleanCertId,
      completedOn: cleanDate,
      status: cleanStatus,
    };

    if (existingIdx >= 0) {
      existingList[existingIdx] = record;
    } else {
      existingList.push(record);
    }

    const nextCerts = {
      ...(local.certifications || {}),
      [empId]: existingList,
    };

    return writeLocal({
      ...local,
      certifications: nextCerts,
      updatedAt: new Date().toISOString(),
    });
  }

  async function verifyCertification(employeeId, courseId) {
    const local = readLocal();
    const empId = employeeId || local.currentEmployeeId || CURRENT_EMP_ID;
    const existingList = getCertifications(empId, local);
    const idx = existingList.findIndex((c) => c.courseId === courseId);
    if (idx < 0) return local;

    existingList[idx] = {
      ...existingList[idx],
      status: "verified",
    };

    const nextCerts = {
      ...(local.certifications || {}),
      [empId]: existingList,
    };

    const timestamp = new Date().toISOString();
    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      tool: "Notify Tool",
      message: `[Notify Tool] Manager verified certification "${existingList[idx].certificationName}" (${existingList[idx].certId}).`,
      createdAt: timestamp,
    };

    return writeLocal({
      ...local,
      certifications: nextCerts,
      agentActivityLog: [logEntry, ...(local.agentActivityLog || [])].slice(
        0,
        40
      ),
      updatedAt: timestamp,
    });
  }

  /**
   * Create a manager (and optional HR) notification when an employee completes a certified course,
   * and log the simulated [Notify Tool] event in agentActivityLog.
   */
  async function notifyManager({
    employeeId,
    employeeName,
    courseId,
    courseTitle,
    certificationName,
    completedOn,
  }) {
    const local = readLocal();
    const empId = employeeId || local.currentEmployeeId || CURRENT_EMP_ID;
    const empName = String(
      employeeName || local.profile?.name || "Current Employee"
    ).trim();
    const courseMeta = courseId ? findCourseMeta(courseId) : null;
    const resolvedCourseTitle = String(
      courseTitle || courseMeta?.title || courseId || "Course"
    );
    const resolvedCertName = String(
      certificationName ||
        courseMeta?.certificationName ||
        `${resolvedCourseTitle} Certificate`
    );
    const dateIso = String(
      completedOn || new Date().toISOString().slice(0, 10)
    ).slice(0, 10);
    const prettyDate = formatPrettyDate(dateIso);
    const timestamp = new Date().toISOString();
    const id = `cert_notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const hrEnabled = local.hrCertNotifications !== false;

    const message = `${empName} completed the certification ${resolvedCertName} (${resolvedCourseTitle}) on ${prettyDate}.`;

    const notification = {
      id,
      type: "certification_completed",
      audience: "manager",
      notifyHR: hrEnabled,
      employeeId: empId,
      employeeName: empName,
      courseId: courseId ? String(courseId) : undefined,
      courseTitle: resolvedCourseTitle,
      certificationName: resolvedCertName,
      completedOn: dateIso,
      message,
      createdAt: timestamp,
      read: false,
    };

    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      tool: "Notify Tool",
      message: `[Notify Tool] Certification alert sent to manager${hrEnabled ? " & HR" : ""}: ${resolvedCertName} (${resolvedCourseTitle}).`,
      createdAt: timestamp,
    };

    return writeLocal({
      ...local,
      notifications: [notification, ...(local.notifications || [])].slice(0, 50),
      agentActivityLog: [logEntry, ...(local.agentActivityLog || [])].slice(
        0,
        40
      ),
      updatedAt: timestamp,
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

  function isNotificationForRole(notif, activeRole, hrEnabled = true) {
    if (!notif) return false;
    if (activeRole === "manager") {
      return notif.audience === "manager" || notif.type === "certification_completed";
    }
    if (activeRole === "hr") {
      return (
        notif.audience === "hr" ||
        (notif.type === "certification_completed" &&
          hrEnabled &&
          notif.notifyHR !== false)
      );
    }
    return notif.audience !== "manager" && notif.type !== "certification_completed";
  }

  async function markNotificationRead(notifId) {
    const local = readLocal();
    const notifications = (local.notifications || []).map((n) =>
      n.id === notifId ? { ...n, read: true } : n
    );
    return writeLocal({
      ...local,
      notifications,
      updatedAt: new Date().toISOString(),
    });
  }

  async function markNotificationsRead(activeRole) {
    const local = readLocal();
    const role = activeRole || local.activeRole || "employee";
    const hrEnabled = local.hrCertNotifications !== false;
    const notifications = (local.notifications || []).map((n) =>
      !activeRole || isNotificationForRole(n, role, hrEnabled)
        ? { ...n, read: true }
        : n
    );
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
    VALID_USER_TYPES,
    isValidUserType,
    normalizeUserType,
    readLocal,
    initState,
    saveProfile,
    setCourseStatus,
    setActiveRole,
    setAnonymiseHR,
    setCertRankingBonus,
    setHrCertNotifications,
    getCertifications,
    getCertificationCount,
    getVerifiedCertificationCount,
    addCertification,
    verifyCertification,
    notifyManager,
    formatPrettyDate,
    isNotificationForRole,
    recordTestAttempt,
    addReplanEntry,
    addNudge,
    markNotificationRead,
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
