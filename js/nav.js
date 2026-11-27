/**
 * Shared navigation bar, login guard, default-password banner,
 * notifications bell, dark mode toggle, page stepper, and toast utilities.
 *
 * Auth guard: requireLogin() redirects unauthenticated visitors to login.html.
 * Gate guard: requireDiagnosticComplete() blocks locked pages for Employees
 * who haven't completed all required skill tests.
 */
window.SkillPathNav = (function () {
  const FLASH_TOAST_KEY = "skillsync_flash_toast";
  const INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
  let pageshowGuardBound = false;
  let idleWatcherBound = false;
  let idleTimeoutHandle = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function certRibbonSvg() {
    return `<svg class="cert-ribbon-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>`;
  }

  function certBadgeHtml(course, opts = {}) {
    if (!course || !course.hasCertification) {
      return `<span class="cert-badge cert-badge-none">No certificate</span>`;
    }
    const certName = course.certificationName || "";
    const showName = opts.showName !== false && Boolean(certName);
    const nameHtml = showName
      ? `<span class="cert-badge-name">${escapeHtml(certName)}</span>`
      : "";
    return `<span class="cert-badge cert-badge-included" title="${escapeHtml(certName || "Certificate included")}">${certRibbonSvg()}<span>Certificate included</span>${nameHtml}</span>`;
  }

  function applyStoredTheme() {
    const theme = window.SkillPathStorage
      ? window.SkillPathStorage.getTheme()
      : "light";
    document.documentElement.setAttribute("data-theme", theme);
    return theme;
  }

  function showToast(message, tone = "info") {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.className = "toast-container";
      container.setAttribute("aria-live", "polite");
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${tone}`;
    toast.textContent = message;
    container.appendChild(toast);

    window.requestAnimationFrame(() => {
      toast.classList.add("is-visible");
    });

    window.setTimeout(() => {
      toast.classList.remove("is-visible");
      window.setTimeout(() => toast.remove(), 250);
    }, 3400);
  }

  function setFlashToast(message, tone = "warning") {
    try {
      window.sessionStorage.setItem(
        FLASH_TOAST_KEY,
        JSON.stringify({ message, tone })
      );
    } catch (_err) {
      // Ignore storage errors in restricted environments.
    }
  }

  function consumeFlashToast() {
    try {
      const raw = window.sessionStorage.getItem(FLASH_TOAST_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(FLASH_TOAST_KEY);
      const parsed = JSON.parse(raw);
      if (parsed && parsed.message) {
        showToast(parsed.message, parsed.tone || "info");
      }
    } catch (_err) {
      // Ignore parse/storage errors.
    }
  }

  function getSampleProfile() {
    return JSON.parse(
      JSON.stringify(window.SkillPathData.DEMO_EMPLOYEE_PROFILE)
    );
  }

  function startInactivityWatcher() {
    if (idleWatcherBound) return;
    idleWatcherBound = true;

    let lastReset = 0;
    async function triggerIdleLogout() {
      if (window.SkillPathStorage) {
        await window.SkillPathStorage.logout();
      }
      window.location.replace("login.html?reason=timeout");
    }

    function resetIdleTimer() {
      const now = Date.now();
      if (now - lastReset < 1000 && idleTimeoutHandle) return;
      lastReset = now;
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
      idleTimeoutHandle = window.setTimeout(triggerIdleLogout, INACTIVITY_LIMIT_MS);
    }

    ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach((evt) => {
      window.addEventListener(evt, resetIdleTimer, { passive: true });
    });
    resetIdleTimer();
  }

  /**
   * Login & Role guard.
   * Redirects unauthenticated visitors to login.html, forced password-change users
   * to change-password.html, and blocks unauthorized roles (e.g. Employee on dashboard.html).
   */
  async function requireLogin(opts = {}) {
    const Storage = window.SkillPathStorage;
    const redirectFn =
      typeof opts.redirectFn === "function"
        ? opts.redirectFn
        : (url) => window.location.replace(url);

    const sess = opts.sessionInfo
      ? opts.sessionInfo
      : Storage
        ? await Storage.fetchSession()
        : { authenticated: false };

    if (!sess || !sess.authenticated || !sess.user) {
      redirectFn("login.html");
      return { authenticated: false, redirectedTo: "login.html" };
    }

    if (sess.user.forcePasswordChange && !opts.allowForcedChange) {
      redirectFn("change-password.html");
      return {
        authenticated: true,
        user: sess.user,
        redirectedTo: "change-password.html",
      };
    }

    if (
      Array.isArray(opts.allowedRoles) &&
      !opts.allowedRoles.includes(sess.user.role)
    ) {
      if (opts.redirectOnForbidden) {
        redirectFn(opts.redirectOnForbidden);
      }
      return {
        authenticated: true,
        forbidden: true,
        user: sess.user,
      };
    }

    if (!opts.sessionInfo) {
      startInactivityWatcher();
    }

    return sess;
  }

  /**
   * Gate guard function. Call on every locked page (analyzer.html, courses.html, etc.).
   * Redirects to quiz.html with toast "Please complete your diagnostic test first"
   * when an Employee has not cleared the diagnostic gate.
   */
  function requireDiagnosticComplete(opts) {
    const Storage = window.SkillPathStorage;
    const Engine = window.SkillPathEngine;
    if (!Storage || !Engine) return true;

    function check(showMessage) {
      const sess = Storage.getSessionInfo ? Storage.getSessionInfo() : null;
      if (sess && sess._fetched && !sess.authenticated) {
        window.location.replace("login.html");
        return false;
      }
      const state = Storage.readLocal();
      if (Engine.isGateCleared(state)) {
        return true;
      }
      if (showMessage) {
        setFlashToast("Please complete your diagnostic test first", "warning");
        showToast("Please complete your diagnostic test first", "warning");
      }
      window.location.replace("quiz.html");
      return false;
    }

    if (!pageshowGuardBound) {
      pageshowGuardBound = true;
      window.addEventListener("pageshow", () => {
        check(true);
      });
    }

    return check(opts?.silent !== true);
  }

  function render({ activePage, state, onReset, onRoleChange, onSelectEmployee }) {
    const currentTheme = applyStoredTheme();
    consumeFlashToast();
    const mount = document.getElementById("app-navbar");
    if (!mount) return;

    const Storage = window.SkillPathStorage;
    const Engine = window.SkillPathEngine;
    const currentState = state || (Storage ? Storage.readLocal() : {});
    const sess = Storage && Storage.getSessionInfo ? Storage.getSessionInfo() : {};
    const sessionUser = sess.user || currentState.currentUser || null;
    const demoMode = Boolean(sess.demoMode);
    const activeRole = sessionUser?.role || currentState.activeRole || "employee";
    const profile = currentState.profile || null;
    const analysis =
      profile && Engine
        ? Engine.analyzeProfile(
            profile,
            currentState.courseProgress,
            currentState
          )
        : null;

    const gateCleared = Engine ? Engine.isGateCleared(currentState) : false;
    const isManagerOrHr = activeRole === "manager" || activeRole === "hr";
    const lockedByGate = !gateCleared && !isManagerOrHr;

    const steps = [
      {
        id: "profile",
        num: 1,
        label: "Profile Setup",
        href: "index.html",
        done: Boolean(profile),
        locked: false,
      },
      {
        id: "quiz",
        num: "✓",
        label: "Skill Quiz",
        href: "quiz.html",
        done: gateCleared && !isManagerOrHr,
        locked: false,
      },
      {
        id: "analyzer",
        num: 2,
        label: "Skill Gap & Plan",
        href: "analyzer.html",
        done: Boolean(analysis && analysis.roadmapProgressPct === 100),
        locked: lockedByGate,
      },
      {
        id: "courses",
        num: 3,
        label: "Courses",
        href: "courses.html",
        done: Boolean(
          analysis &&
            analysis.overallCoursePct === 100 &&
            analysis.totalGapCourses > 0
        ),
        locked: lockedByGate,
      },
    ];

    if (isManagerOrHr) {
      steps.push({
        id: "dashboard",
        num: activeRole === "hr" ? "HR" : "M",
        label: activeRole === "hr" ? "HR Dashboard" : "Manager Dashboard",
        href: "dashboard.html",
        done: false,
        locked: false,
      });
    }

    const allNotifications = Array.isArray(currentState.notifications)
      ? currentState.notifications
      : [];
    const hrCertEnabled = currentState.hrCertNotifications !== false;
    const notifications = allNotifications
      .filter((n) =>
        Storage && typeof Storage.isNotificationForRole === "function"
          ? Storage.isNotificationForRole(n, activeRole, hrCertEnabled)
          : true
      )
      .slice()
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
      );
    const unreadCount = notifications.filter((n) => !n.read).length;

    // Demo-mode role jump switch (hidden completely unless DEMO_MODE=1)
    const demoRoles = [
      { id: "employee", label: "Employee" },
      { id: "manager", label: "Manager" },
      { id: "hr", label: "HR" },
    ];
    const demoSwitcherHtml = demoMode
      ? `
      <div class="nav-role-switcher" role="group" aria-label="Demo mode role switch" title="Demo Mode quick jump">
        <span class="demo-switch-tag">Demo</span>
        ${demoRoles
          .map(
            (r) => `
          <button
            type="button"
            class="role-switch-btn ${activeRole === r.id ? "is-active" : ""}"
            data-demo-switch-role="${r.id}"
            aria-pressed="${activeRole === r.id}"
          >${r.label}</button>
        `
          )
          .join("")}
      </div>
    `
      : "";

    const userBadgeHtml = sessionUser
      ? `
      <div class="nav-user-pill" title="${escapeHtml(sessionUser.email || "")}">
        <span class="nav-user-name">${escapeHtml(sessionUser.name)}</span>
        <code class="nav-user-id">${escapeHtml(sessionUser.id)}</code>
      </div>
    `
      : "";

    const notifHtml = `
      <div class="notif-wrapper">
        <button
          type="button"
          class="icon-btn"
          id="nav-notif-btn"
          aria-label="Notifications (${unreadCount} unread)"
          title="Notifications"
        >
          🔔
          ${unreadCount > 0 ? `<span class="notif-badge">${unreadCount}</span>` : ""}
        </button>
        <div id="nav-notif-dropdown" class="notif-dropdown card" hidden>
          <div class="notif-dropdown-header">
            <strong>Notifications (${notifications.length})</strong>
            ${
              unreadCount > 0
                ? `<button type="button" class="btn-link-xs" id="btn-mark-notifs-read">Mark all as read</button>`
                : ""
            }
          </div>
          <div class="notif-list">
            ${
              notifications.length === 0
                ? `<p class="notif-empty">${isManagerOrHr ? "No employee certification or activation alerts yet." : "No nudges or retest alerts yet."}</p>`
                : notifications
                    .slice(0, 10)
                    .map((n) => {
                      const tagLabel =
                        n.type === "certification_completed"
                          ? "Certification"
                          : n.type === "account_activated"
                            ? "Account Activated"
                            : n.type === "retest_requested"
                              ? "Retest Request"
                              : n.type === "diagnostic_nudge"
                                ? "Diagnostic Nudge"
                                : "Manager/HR Nudge";
                      const displayMessage =
                        Engine && typeof Engine.formatNotificationMessage === "function"
                          ? Engine.formatNotificationMessage(n, currentState)
                          : n.message;
                      const isActionable =
                        isManagerOrHr &&
                        (n.type === "certification_completed" ||
                          n.type === "account_activated") &&
                        n.employeeId;
                      return `
                  <div class="notif-item ${n.read ? "is-read" : "is-unread"} ${isActionable ? "is-clickable" : ""}" data-notif-id="${escapeHtml(n.id)}" data-notif-emp="${escapeHtml(n.employeeId || "")}" data-notif-type="${escapeHtml(n.type || "")}">
                    <div class="notif-item-top">
                      <span class="notif-type-tag">${escapeHtml(tagLabel)}</span>
                      <div class="notif-item-meta">
                        <span class="notif-time">${escapeHtml((n.createdAt || "").slice(0, 10))}</span>
                        ${
                          !n.read
                            ? `<button type="button" class="btn-link-xs notif-mark-read-btn" data-mark-read-id="${escapeHtml(n.id)}">Mark read</button>`
                            : ""
                        }
                      </div>
                    </div>
                    <p>${escapeHtml(displayMessage)}</p>
                    ${
                      isActionable
                        ? `<span class="notif-action-hint">Click to open employee details →</span>`
                        : ""
                    }
                  </div>
                `;
                    })
                    .join("")
            }
          </div>
        </div>
      </div>
    `;

    const themeToggleHtml = `
      <button
        type="button"
        class="icon-btn"
        id="nav-theme-btn"
        aria-label="Toggle dark mode"
        title="Toggle Light / Dark theme"
      >${currentTheme === "dark" ? "☀️" : "🌙"}</button>
    `;

    const resetBtn =
      profile && !isManagerOrHr
        ? `<button type="button" class="btn-ghost-sm" id="nav-reset-btn" title="Start over with a fresh profile">Reset</button>`
        : "";

    const changePwLink =
      sessionUser && activePage !== "change-password"
        ? `<a href="change-password.html" class="btn-ghost-sm" id="nav-change-pw-link" title="Change password">Password</a>`
        : "";

    const logoutBtn = sessionUser
      ? `<button type="button" class="btn-ghost-sm" id="nav-logout-btn" title="Sign out">Logout</button>`
      : "";

    const showDefaultPwBanner = Boolean(
      sessionUser &&
        sessionUser.mustChangePassword &&
        !sessionUser.forcePasswordChange &&
        activePage !== "change-password"
    );

    const defaultPwBannerHtml = showDefaultPwBanner
      ? `
      <div id="default-pw-banner" class="default-pw-banner" role="alert">
        <div class="default-pw-banner-inner">
          <span>⚠ <strong>Security notice:</strong> You are using the default password. Please change it now.</span>
          <a href="change-password.html" class="btn-xs">Change password</a>
        </div>
      </div>
    `
      : "";

    mount.innerHTML = `
      <div class="navbar-inner">
        <a href="${isManagerOrHr ? "dashboard.html" : "index.html"}" class="brand-link">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
              <path d="M2 17l10 5 10-5"></path>
              <path d="M2 12l10 5 10-5"></path>
            </svg>
          </span>
          <span class="brand-text">
            <strong>SkillSync</strong>
            <span class="brand-badge">AI Agent</span>
          </span>
        </a>

        ${
          sessionUser?.forcePasswordChange
            ? ""
            : `
        <nav class="page-stepper" aria-label="Primary flow">
          ${steps
            .map((step, idx) => {
              const isActive = step.id === activePage;
              const cls = [
                "stepper-link",
                isActive ? "is-active" : "",
                step.done ? "is-done" : "",
                step.locked ? "is-locked" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const badgeContent = step.locked
                ? "🔒"
                : step.done && !isActive
                  ? "✓"
                  : String(step.num);
              const connector =
                idx < steps.length - 1
                  ? `<span class="stepper-arrow" aria-hidden="true">→</span>`
                  : "";
              const lockTitle = step.locked
                ? 'title="Complete your diagnostic test to unlock"'
                : "";
              const linkTag = step.locked
                ? `<span class="${cls}" aria-disabled="true" ${lockTitle}>`
                : `<a href="${step.href}" class="${cls}" ${isActive ? 'aria-current="page"' : ""}>`;
              const closeTag = step.locked ? `</span>` : `</a>`;
              return `
                ${linkTag}
                  <span class="stepper-num">${badgeContent}</span>
                  <span class="stepper-label">${escapeHtml(step.label)}</span>
                ${closeTag}
                ${connector}
              `;
            })
            .join("")}
        </nav>`
        }

        <div class="nav-actions">
          ${demoSwitcherHtml}
          ${userBadgeHtml}
          ${sessionUser?.forcePasswordChange ? "" : notifHtml}
          ${themeToggleHtml}
          ${changePwLink}
          ${resetBtn}
          ${logoutBtn}
        </div>
      </div>
      ${defaultPwBannerHtml}
    `;

    // Demo-only role jump bindings
    mount.querySelectorAll("[data-demo-switch-role]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const nextRole = btn.getAttribute("data-demo-switch-role");
        try {
          const res = await Storage.demoSwitchRole(nextRole);
          if (typeof onRoleChange === "function" && nextRole !== "employee" && activePage === "dashboard") {
            const freshState = await Storage.initState();
            onRoleChange(nextRole, freshState);
            return;
          }
          window.location.href = res.redirectTo || "index.html";
        } catch (err) {
          showToast(err?.message || "Demo switch failed", "warning");
        }
      });
    });

    // Logout binding
    const logoutTrigger = document.getElementById("nav-logout-btn");
    if (logoutTrigger) {
      logoutTrigger.addEventListener("click", async () => {
        await Storage.logout();
        window.location.href = "login.html";
      });
    }

    // Notification dropdown toggle
    const notifBtn = document.getElementById("nav-notif-btn");
    const notifDrop = document.getElementById("nav-notif-dropdown");
    if (notifBtn && notifDrop) {
      notifBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        notifDrop.hidden = !notifDrop.hidden;
      });
      document.addEventListener(
        "click",
        (ev) => {
          if (!mount.contains(ev.target)) {
            notifDrop.hidden = true;
          }
        },
        { once: false }
      );
    }

    const markReadBtn = document.getElementById("btn-mark-notifs-read");
    if (markReadBtn) {
      markReadBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const updated = await Storage.markNotificationsRead(activeRole);
        render({
          activePage,
          state: updated,
          onReset,
          onRoleChange,
          onSelectEmployee,
        });
      });
    }

    mount.querySelectorAll("[data-mark-read-id]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const nid = btn.getAttribute("data-mark-read-id");
        const updated = await Storage.markNotificationRead(nid);
        render({
          activePage,
          state: updated,
          onReset,
          onRoleChange,
          onSelectEmployee,
        });
        const drop = document.getElementById("nav-notif-dropdown");
        if (drop) drop.hidden = false;
      });
    });

    mount.querySelectorAll(".notif-item.is-clickable").forEach((item) => {
      item.addEventListener("click", async () => {
        const nid = item.getAttribute("data-notif-id");
        const empId = item.getAttribute("data-notif-emp");
        const updated = await Storage.markNotificationRead(nid);
        if (activePage === "dashboard" && typeof onSelectEmployee === "function") {
          const drop = document.getElementById("nav-notif-dropdown");
          if (drop) drop.hidden = true;
          onSelectEmployee(empId, updated);
        } else if (empId) {
          window.location.href = `dashboard.html?employee=${encodeURIComponent(empId)}`;
        }
      });
    });

    // Theme toggle
    const themeBtn = document.getElementById("nav-theme-btn");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        const nextTheme =
          Storage.getTheme() === "dark" ? "light" : "dark";
        Storage.setTheme(nextTheme);
        themeBtn.textContent = nextTheme === "dark" ? "☀️" : "🌙";
      });
    }

    // Reset button
    const resetTrigger = document.getElementById("nav-reset-btn");
    if (resetTrigger) {
      resetTrigger.addEventListener("click", async () => {
        if (
          !window.confirm(
            "Reset your saved profile, diagnostic attempts, and course progress?"
          )
        ) {
          return;
        }
        await Storage.resetState();
        if (typeof onReset === "function") {
          onReset();
        } else {
          window.location.href = "index.html";
        }
      });
    }
  }

  return {
    escapeHtml,
    certRibbonSvg,
    certBadgeHtml,
    applyStoredTheme,
    showToast,
    setFlashToast,
    consumeFlashToast,
    getSampleProfile,
    render,
    requireLogin,
    requireDiagnosticComplete,
  };
})();
