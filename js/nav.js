/**
 * Shared navigation bar, role switcher (Employee / Manager / HR),
 * notifications bell, dark mode toggle, page stepper, and toast utilities.
 *
 * Gate guard: requireDiagnosticComplete() blocks locked pages for Employees
 * who haven't completed all required skill tests.
 */
window.SkillPathNav = (function () {
  const FLASH_TOAST_KEY = "skillsync_flash_toast";
  let pageshowGuardBound = false;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  /**
   * Gate guard function. Call on every locked page (analyzer.html, courses.html, etc.).
   * Redirects to quiz.html with toast "Please complete your diagnostic test first"
   * when an Employee has not cleared the diagnostic gate.
   * Also guards Back/Forward navigation via `pageshow`.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] - Skip setting flash toast if true.
   * @returns {boolean} true if access is allowed, false if blocked & redirecting.
   */
  function requireDiagnosticComplete(opts) {
    const Storage = window.SkillPathStorage;
    const Engine = window.SkillPathEngine;
    if (!Storage || !Engine) return true;

    function check(showMessage) {
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

  function render({ activePage, state, onReset, onRoleChange }) {
    const currentTheme = applyStoredTheme();
    consumeFlashToast();
    const mount = document.getElementById("app-navbar");
    if (!mount) return;

    const Storage = window.SkillPathStorage;
    const Engine = window.SkillPathEngine;
    const currentState = state || (Storage ? Storage.readLocal() : {});
    const activeRole = currentState.activeRole || "employee";
    const profile = currentState.profile || null;
    const analysis =
      profile && Engine
        ? Engine.analyzeProfile(
            profile,
            currentState.courseProgress,
            currentState
          )
        : null;

    // Gate state
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

    const notifications = Array.isArray(currentState.notifications)
      ? currentState.notifications
      : [];
    const unreadCount = notifications.filter((n) => !n.read).length;

    const roles = [
      { id: "employee", label: "Employee" },
      { id: "manager", label: "Manager" },
      { id: "hr", label: "HR" },
    ];

    const roleSwitcherHtml = `
      <div class="nav-role-switcher" role="group" aria-label="Switch perspective role">
        ${roles
          .map(
            (r) => `
          <button
            type="button"
            class="role-switch-btn ${activeRole === r.id ? "is-active" : ""}"
            data-switch-role="${r.id}"
            aria-pressed="${activeRole === r.id}"
          >${r.label}</button>
        `
          )
          .join("")}
      </div>
    `;

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
              notifications.length > 0
                ? `<button type="button" class="btn-link-xs" id="btn-mark-notifs-read">Mark all read</button>`
                : ""
            }
          </div>
          <div class="notif-list">
            ${
              notifications.length === 0
                ? `<p class="notif-empty">No nudges or retest alerts yet.</p>`
                : notifications
                    .slice(0, 6)
                    .map(
                      (n) => `
                  <div class="notif-item ${n.read ? "is-read" : "is-unread"}">
                    <div class="notif-item-top">
                      <span class="notif-type-tag">${escapeHtml(n.type === "retest_requested" ? "Retest Request" : n.type === "diagnostic_nudge" ? "Diagnostic Nudge" : "Manager/HR Nudge")}</span>
                      <span class="notif-time">${escapeHtml((n.createdAt || "").slice(0, 10))}</span>
                    </div>
                    <p>${escapeHtml(n.message)}</p>
                  </div>
                `
                    )
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

    const resetBtn = profile
      ? `<button type="button" class="btn-ghost-sm" id="nav-reset-btn" title="Start over with a fresh profile">Reset</button>`
      : "";

    mount.innerHTML = `
      <div class="navbar-inner">
        <a href="index.html" class="brand-link">
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
        </nav>

        <div class="nav-actions">
          ${roleSwitcherHtml}
          ${notifHtml}
          ${themeToggleHtml}
          ${resetBtn}
        </div>
      </div>
    `;

    // Role switcher bindings
    mount.querySelectorAll("[data-switch-role]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const nextRole = btn.getAttribute("data-switch-role");
        const nextState = await Storage.setActiveRole(nextRole);

        if (nextRole === "employee") {
          if (activePage === "dashboard") {
            if (nextState.profile && Engine.isGateCleared(nextState)) {
              window.location.href = "analyzer.html";
            } else if (nextState.profile) {
              window.location.href = "quiz.html";
            } else {
              window.location.href = "index.html";
            }
            return;
          }
        } else if (activePage !== "dashboard") {
          window.location.href = "dashboard.html";
          return;
        }

        if (typeof onRoleChange === "function") {
          onRoleChange(nextRole, nextState);
        } else {
          render({ activePage, state: nextState, onReset, onRoleChange });
        }
      });
    });

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
      markReadBtn.addEventListener("click", async () => {
        const updated = await Storage.markNotificationsRead();
        render({ activePage, state: updated, onReset, onRoleChange });
      });
    }

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
    applyStoredTheme,
    showToast,
    setFlashToast,
    consumeFlashToast,
    getSampleProfile,
    render,
    requireDiagnosticComplete,
  };
})();
