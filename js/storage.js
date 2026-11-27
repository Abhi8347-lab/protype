/**
 * Client persistence & authenticated API client for SkillSync AI.
 *
 * User accounts and learning/team records live on the Flask/SQLite backend.
 * For the standalone offline JS unit-test runner (tests.html) or file:// preview,
 * localStorage fallback is preserved without storing any passwords or credentials.
 */
window.SkillPathStorage = (function () {
  const STORAGE_KEY = "skillsync_ai_state_v2";
  const LEGACY_KEY_V1 = "skillsync_ai_state_v1";
  const LEGACY_KEY_OLD = "skillpath_ai_state_v1";
  const THEME_KEY = "skillsync_ai_theme";
  const CURRENT_EMP_ID = "emp_current";
  const VALID_USER_TYPES = ["employee", "other"];

  let sessionCache = {
    authenticated: false,
    demoMode: false,
    csrfToken: "",
    user: null,
    redirectTo: null,
    sessionExpired: false,
  };
  let serverStateCache = null;

  function isHttpOrigin() {
    return (
      typeof window !== "undefined" &&
      (window.location.protocol === "http:" ||
        window.location.protocol === "https:")
    );
  }

  function isLocalTestMode() {
    return (
      typeof window !== "undefined" &&
      (Boolean(window.__SKILLSYNC_LOCAL_TEST_MODE) || !isHttpOrigin())
    );
  }

  function isValidUserType(value) {
    return VALID_USER_TYPES.includes(value);
  }

  function normalizeUserType(value) {
    return isValidUserType(value) ? value : "other";
  }

  function resolveLegacyId(empId) {
    const map = window.SkillPathData?.LEGACY_EMPLOYEE_ID_MAP || {};
    return map[empId] || empId;
  }

  function getSessionInfo() {
    return sessionCache;
  }

  function setSessionInfo(next) {
    sessionCache = { ...sessionCache, ...(next || {}) };
    return sessionCache;
  }

  function getCsrfToken() {
    return sessionCache.csrfToken || "";
  }

  async function fetchSession(forceRefresh = false) {
    if (!isHttpOrigin()) return sessionCache;
    if (!forceRefresh && sessionCache.csrfToken && sessionCache._fetched) {
      return sessionCache;
    }
    const resp = await window.fetch("/api/auth/session", {
      credentials: "same-origin",
    });
    if (!resp.ok) return sessionCache;
    const data = await resp.json();
    sessionCache = {
      ...data,
      _fetched: true,
    };
    return sessionCache;
  }

  async function apiFetch(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    if (method !== "GET" && method !== "HEAD") {
      if (!sessionCache.csrfToken) {
        await fetchSession(true);
      }
      if (sessionCache.csrfToken) {
        headers["X-CSRF-Token"] = sessionCache.csrfToken;
      }
    }

    const resp = await window.fetch(url, {
      ...options,
      method,
      headers,
      credentials: "same-origin",
    });

    if (resp.status === 401 && !options.skipAuthRedirect) {
      sessionCache.authenticated = false;
      sessionCache.user = null;
      serverStateCache = null;
      if (
        isHttpOrigin() &&
        !window.location.pathname.endsWith("login.html") &&
        window.location.pathname !== "/login"
      ) {
        window.location.replace("login.html");
      }
    } else if (resp.status === 403 && !options.skipAuthRedirect) {
      const clone = resp.clone();
      const body = await clone.json().catch(() => null);
      if (body && body.forcePasswordChange) {
        window.location.replace("change-password.html");
      }
    }
    return resp;
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
      serverEmployees: Array.isArray(parsed.serverEmployees)
        ? parsed.serverEmployees
        : undefined,
      managedUsers: Array.isArray(parsed.managedUsers)
        ? parsed.managedUsers
        : undefined,
      currentUser: parsed.currentUser || undefined,
    };
  }

  function readLocal() {
    if (serverStateCache && !isLocalTestMode()) {
      return serverStateCache;
    }
    try {
      let raw = window.localStorage.getItem(STORAGE_KEY);
      let needsMigrationSave = false;
      if (!raw) {
        const legacyV1 = window.localStorage.getItem(LEGACY_KEY_V1);
        if (legacyV1) {
          raw = legacyV1;
          needsMigrationSave = true;
        }
      }
      if (!raw) {
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
    if (serverStateCache && !isLocalTestMode()) {
      serverStateCache = payload;
      return payload;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_err) {
      // Ignore storage quota errors in restricted environments.
    }
    return payload;
  }

  function buildStateFromDashboardPayload(data) {
    const base = defaultState();
    return {
      ...base,
      activeRole: data.activeRole || "manager",
      currentEmployeeId: data.currentUser?.id || CURRENT_EMP_ID,
      currentUser: data.currentUser || null,
      anonymiseHR: Boolean(data.anonymiseHR),
      certRankingBonus: Boolean(data.certRankingBonus),
      hrCertNotifications:
        typeof data.hrCertNotifications === "boolean"
          ? data.hrCertNotifications
          : true,
      certifications: data.certifications || {},
      testResults: data.testResults || {},
      verifiedLevels: data.verifiedLevels || {},
      notifications: sanitizeNotificationsList(data.notifications),
      nudges: Array.isArray(data.nudges) ? data.nudges : [],
      agentActivityLog: Array.isArray(data.agentActivityLog)
        ? data.agentActivityLog
        : [],
      priorities: Array.isArray(data.priorities)
        ? data.priorities
        : base.priorities,
      serverEmployees: Array.isArray(data.employees) ? data.employees : [],
      managedUsers: Array.isArray(data.managedUsers) ? data.managedUsers : [],
    };
  }

  async function initState(opts = {}) {
    if (isLocalTestMode()) {
      return readLocal();
    }
    const sess = await fetchSession();
    if (!sess.authenticated) {
      return defaultState();
    }
    if (sess.user?.forcePasswordChange && opts.allowForcedChange) {
      serverStateCache = {
        ...defaultState(),
        activeRole: sess.user.role,
        currentEmployeeId: sess.user.id,
        currentUser: sess.user,
      };
      return serverStateCache;
    }

    const isMgrOrHr =
      sess.user && (sess.user.role === "manager" || sess.user.role === "hr");
    const isDashboardPage =
      typeof window !== "undefined" &&
      document.body?.getAttribute("data-page") === "dashboard";

    if (isMgrOrHr && isDashboardPage) {
      const resp = await apiFetch("/api/dashboard/data", opts);
      if (resp.ok) {
        const data = await resp.json();
        serverStateCache = buildStateFromDashboardPayload(data);
        return serverStateCache;
      }
    }

    const resp = await apiFetch("/api/me/state", opts);
    if (resp.ok) {
      const data = await resp.json();
      serverStateCache = migrateState({
        ...data,
        currentUser: sess.user,
      });
      return serverStateCache;
    }

    return defaultState();
  }

  async function saveProfile(profile) {
    if (!profile || typeof profile !== "object") {
      throw new Error("Profile data is required.");
    }

    const rawUserType =
      profile.userType !== undefined ? profile.userType : profile.status;
    if (!isValidUserType(rawUserType)) {
      throw new Error("Invalid user type. Please choose Employee or Other.");
    }
    if (profile.status !== undefined && !isValidUserType(profile.status)) {
      throw new Error("Invalid user type. Please choose Employee or Other.");
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

    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/me/profile", {
        method: "POST",
        body: JSON.stringify({ profile: sanitizedProfile }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save profile.");
      }
      const next = await resp.json();
      serverStateCache = migrateState({
        ...next,
        currentUser: sessionCache.user,
      });
      return serverStateCache;
    }

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
    const newCompleted = prevCompleted.filter((s) => newSelected.includes(s));
    const newRequired = newSelected.slice();
    const isCleared =
      newRequired.length > 0
        ? newRequired.every((s) => newCompleted.includes(s))
        : Boolean(
            sanitizedProfile && Array.isArray(sanitizedProfile.selectedSkills)
          );

    const gate = {
      required: newRequired,
      completed: newCompleted,
      cleared: isCleared,
      clearedAt: isCleared
        ? prevGate.clearedAt || new Date().toISOString()
        : null,
    };

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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/me/course-status", {
        method: "POST",
        body: JSON.stringify({ courseId, status }),
      });
      if (resp.ok) {
        serverStateCache = migrateState({
          ...(await resp.json()),
          currentUser: sessionCache.user,
        });
        return serverStateCache;
      }
    }

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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      await apiFetch("/api/dashboard/settings", {
        method: "POST",
        body: JSON.stringify({ anonymiseHR: Boolean(value) }),
      });
      return initState();
    }
    const local = readLocal();
    return writeLocal({
      ...local,
      anonymiseHR: Boolean(value),
      updatedAt: new Date().toISOString(),
    });
  }

  async function setCertRankingBonus(value) {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/me/settings", {
        method: "POST",
        body: JSON.stringify({ certRankingBonus: Boolean(value) }),
      });
      if (resp.ok) {
        serverStateCache = migrateState({
          ...(await resp.json()),
          currentUser: sessionCache.user,
        });
        return serverStateCache;
      }
    }
    const local = readLocal();
    return writeLocal({
      ...local,
      certRankingBonus: Boolean(value),
      updatedAt: new Date().toISOString(),
    });
  }

  async function setHrCertNotifications(value) {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      await apiFetch("/api/dashboard/settings", {
        method: "POST",
        body: JSON.stringify({ hrCertNotifications: Boolean(value) }),
      });
      return initState();
    }
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

  function getCertifications(employeeId, stateOverride) {
    const state = stateOverride || readLocal();
    const rawEmpId = employeeId || state.currentEmployeeId || CURRENT_EMP_ID;
    const empId = resolveLegacyId(rawEmpId);
    const map = state.certifications || {};
    if (Array.isArray(map[rawEmpId])) {
      return map[rawEmpId].map((c) => ({ ...c }));
    }
    if (Array.isArray(map[empId])) {
      return map[empId].map((c) => ({ ...c }));
    }
    const seed = (window.SkillPathData?.SEED_EMPLOYEES || []).find(
      (e) => e.id === empId || e.id === rawEmpId
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

  async function addCertification({
    employeeId,
    courseId,
    certificationName,
    certId,
    completedOn,
    status = "pending_review",
    courseTitle,
    skipNotify,
  }) {
    if (!courseId) {
      throw new Error("Course ID is required to record a certification.");
    }
    const cleanCertId = String(certId || "").trim();
    if (!cleanCertId) {
      throw new Error("Certificate ID or link is required.");
    }

    const courseMeta = findCourseMeta(courseId);
    const cleanName = String(
      certificationName ||
        courseMeta?.certificationName ||
        courseMeta?.title ||
        courseId
    ).trim();
    const cleanTitle = String(
      courseTitle || courseMeta?.title || courseId
    ).trim();
    const cleanDate = String(
      completedOn || new Date().toISOString().slice(0, 10)
    ).slice(0, 10);

    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/me/certification", {
        method: "POST",
        body: JSON.stringify({
          courseId: String(courseId),
          courseTitle: cleanTitle,
          certificationName: cleanName,
          certId: cleanCertId,
          completedOn: cleanDate,
          notifyManager: !skipNotify,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save certification.");
      }
      serverStateCache = migrateState({
        ...(await resp.json()),
        currentUser: sessionCache.user,
      });
      serverStateCache._lastCertNotifiedServer = !skipNotify;
      return serverStateCache;
    }

    const local = readLocal();
    const empId = employeeId || local.currentEmployeeId || CURRENT_EMP_ID;
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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/dashboard/verify-certification", {
        method: "POST",
        body: JSON.stringify({ employeeId, courseId }),
      });
      if (resp.ok) {
        return initState();
      }
    }

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

  async function notifyManager({
    employeeId,
    employeeName,
    courseId,
    courseTitle,
    certificationName,
    completedOn,
  }) {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      // Certification endpoint already records manager notification atomically
      if (serverStateCache && serverStateCache._lastCertNotifiedServer) {
        serverStateCache._lastCertNotifiedServer = false;
        return serverStateCache;
      }
      return serverStateCache || readLocal();
    }

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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/me/test-attempt", {
        method: "POST",
        body: JSON.stringify({ skillId, attemptRecord }),
      });
      if (resp.ok) {
        serverStateCache = migrateState({
          ...(await resp.json()),
          currentUser: sessionCache.user,
        });
        return serverStateCache;
      }
    }

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

    let updatedGate = local.gate || {
      required: [],
      completed: [],
      cleared: false,
      clearedAt: null,
    };
    if (empId === (local.currentEmployeeId || CURRENT_EMP_ID)) {
      const prevCompleted = Array.isArray(updatedGate.completed)
        ? updatedGate.completed
        : [];
      const newCompleted = prevCompleted.includes(skillId)
        ? prevCompleted
        : [...prevCompleted, skillId];
      const required = Array.isArray(updatedGate.required)
        ? updatedGate.required
        : [];
      const isCleared =
        required.length > 0 && required.every((s) => newCompleted.includes(s));
      updatedGate = {
        ...updatedGate,
        completed: newCompleted,
        cleared: isCleared,
        clearedAt:
          isCleared && !updatedGate.clearedAt
            ? new Date().toISOString()
            : updatedGate.clearedAt,
      };
    }

    const updatedInProgress =
      local.inProgress && local.inProgress.skill === skillId
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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      if (
        sessionCache.user?.role === "employee" ||
        !entry.employeeId ||
        entry.employeeId === sessionCache.user?.id
      ) {
        const resp = await apiFetch("/api/me/replan", {
          method: "POST",
          body: JSON.stringify(entry),
        });
        if (resp.ok) {
          serverStateCache = migrateState({
            ...(await resp.json()),
            currentUser: sessionCache.user,
          });
          return serverStateCache;
        }
      }
      return serverStateCache || readLocal();
    }

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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/dashboard/nudge", {
        method: "POST",
        body: JSON.stringify({ employeeId, actionType, message }),
      });
      if (resp.ok) {
        return initState();
      }
    }

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
      return (
        notif.audience === "manager" ||
        notif.type === "certification_completed" ||
        notif.type === "account_activated"
      );
    }
    if (activeRole === "hr") {
      return (
        notif.audience === "hr" ||
        ((notif.type === "certification_completed" ||
          notif.type === "account_activated") &&
          hrEnabled &&
          notif.notifyHR !== false)
      );
    }
    return (
      notif.audience !== "manager" &&
      notif.type !== "certification_completed" &&
      notif.type !== "account_activated"
    );
  }

  async function markNotificationRead(notifId) {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      await apiFetch("/api/notifications/read", {
        method: "POST",
        body: JSON.stringify({ notificationId: notifId }),
      });
      if (serverStateCache) {
        serverStateCache = {
          ...serverStateCache,
          notifications: (serverStateCache.notifications || []).map((n) =>
            n.id === notifId ? { ...n, read: true } : n
          ),
        };
        return serverStateCache;
      }
    }

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
    if (!isLocalTestMode() && sessionCache.authenticated) {
      await apiFetch("/api/notifications/read", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (serverStateCache) {
        serverStateCache = {
          ...serverStateCache,
          notifications: (serverStateCache.notifications || []).map((n) => ({
            ...n,
            read: true,
          })),
        };
        return serverStateCache;
      }
    }

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
    const clean = (Array.isArray(priorities) ? priorities : [])
      .filter((p) => p && p.skillId)
      .map((p) => ({
        skillId: String(p.skillId),
        weight: Math.max(1, Math.min(5, Number(p.weight) || 3)),
      }));

    if (!isLocalTestMode() && sessionCache.authenticated) {
      await apiFetch("/api/dashboard/priorities", {
        method: "POST",
        body: JSON.stringify({ priorities: clean }),
      });
      return initState();
    }

    const local = readLocal();
    return writeLocal({
      ...local,
      priorities: clean,
      updatedAt: new Date().toISOString(),
    });
  }

  async function resetState() {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      const resp = await apiFetch("/api/me/reset", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (resp.ok) {
        serverStateCache = migrateState({
          ...(await resp.json()),
          currentUser: sessionCache.user,
        });
        return serverStateCache;
      }
    }

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

  function saveInProgress(inProgressData) {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      apiFetch("/api/me/in-progress", {
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ inProgress: inProgressData }),
      }).catch(() => {});
      if (serverStateCache) {
        serverStateCache = {
          ...serverStateCache,
          inProgress: inProgressData,
        };
        return serverStateCache;
      }
    }
    const local = readLocal();
    return writeLocal({
      ...local,
      inProgress: inProgressData,
      updatedAt: new Date().toISOString(),
    });
  }

  function clearInProgress() {
    if (!isLocalTestMode() && sessionCache.authenticated) {
      apiFetch("/api/me/in-progress", {
        method: "POST",
        body: JSON.stringify({ inProgress: null }),
      }).catch(() => {});
      if (serverStateCache) {
        serverStateCache = { ...serverStateCache, inProgress: null };
        return serverStateCache;
      }
    }
    const local = readLocal();
    return writeLocal({
      ...local,
      inProgress: null,
      updatedAt: new Date().toISOString(),
    });
  }

  function updateGate(profile, completedSkillIds) {
    const local = readLocal();
    const selectedSkills = Array.isArray(profile?.selectedSkills)
      ? profile.selectedSkills
      : [];
    const required = selectedSkills.slice();
    const completed = Array.isArray(completedSkillIds)
      ? completedSkillIds.filter((s) => required.includes(s))
      : [];
    const isCleared =
      required.length > 0 && required.every((s) => completed.includes(s));
    const prevGate = local.gate || {};
    const gate = {
      required,
      completed,
      cleared: isCleared,
      clearedAt: isCleared
        ? prevGate.clearedAt || new Date().toISOString()
        : null,
    };
    return writeLocal({ ...local, gate, updatedAt: new Date().toISOString() });
  }

  // ── Manager / Auth Helper APIs ──────────────────────────────────────────────
  async function createEmployee(payload) {
    const resp = await apiFetch("/api/employees", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || "Failed to create employee account.");
    }
    return data;
  }

  async function sendLoginEmail(empId) {
    const resp = await apiFetch(
      `/api/employees/${encodeURIComponent(empId)}/send-login-email`,
      { method: "POST", body: JSON.stringify({}) }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || "Failed to send login email.");
    }
    return data;
  }

  async function toggleEmployeeActive(empId, active) {
    const resp = await apiFetch(
      `/api/employees/${encodeURIComponent(empId)}/deactivate`,
      {
        method: "POST",
        body: JSON.stringify(
          typeof active === "boolean" ? { active } : {}
        ),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || "Failed to update employee status.");
    }
    return data;
  }

  async function resetEmployeePassword(empId) {
    const resp = await apiFetch(
      `/api/employees/${encodeURIComponent(empId)}/reset-password`,
      { method: "POST", body: JSON.stringify({}) }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || "Failed to reset employee password.");
    }
    return data;
  }

  async function demoSwitchRole(role) {
    const resp = await apiFetch("/api/demo/switch-role", {
      method: "POST",
      body: JSON.stringify({ role }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || "Unable to switch demo role.");
    }
    serverStateCache = null;
    await fetchSession(true);
    return data;
  }

  async function logout() {
    try {
      await apiFetch("/api/logout", {
        method: "POST",
        body: JSON.stringify({}),
        skipAuthRedirect: true,
      });
    } catch (_err) {
      // Proceed with client redirect even if network hiccups
    }
    serverStateCache = null;
    sessionCache = {
      authenticated: false,
      demoMode: sessionCache.demoMode,
      csrfToken: "",
      user: null,
      redirectTo: null,
    };
  }

  return {
    CURRENT_EMP_ID,
    VALID_USER_TYPES,
    isValidUserType,
    normalizeUserType,
    getSessionInfo,
    setSessionInfo,
    getCsrfToken,
    fetchSession,
    apiFetch,
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
    createEmployee,
    sendLoginEmail,
    toggleEmployeeActive,
    resetEmployeePassword,
    demoSwitchRole,
    logout,
  };
})();
