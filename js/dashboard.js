/**
 * Manager & HR Performance Dashboard Controller (dashboard.html).
 */
(async function () {
  const Data = window.SkillPathData;
  const Storage = window.SkillPathStorage;
  const Engine = window.SkillPathEngine;
  const Nav = window.SkillPathNav;
  const Chart = window.SkillPathChart;
  const { escapeHtml } = Nav;

  let appState = await Storage.initState();
  const urlParams = new URLSearchParams(window.location.search);
  let selectedEmployeeId = urlParams.get("employee") || null;
  let sortCol = "completionPct";
  let sortDir = "asc";
  let searchQuery = "";
  let userTypeFilter = "all";
  let roleFilter = "all";
  let levelFilter = "all";
  let statusFilter = "all";
  let certFilter = "all";
  const toastedNotifIds = new Set();

  const guardEl = document.getElementById("dashboard-guard");
  const contentEl = document.getElementById("dashboard-content");
  const anonymiseToggle = document.getElementById("toggle-anonymise");
  const hrCertNotifsWrap = document.getElementById("hr-cert-notifs-wrap");
  const hrCertNotifsToggle = document.getElementById("toggle-hr-cert-notifs");
  const hrOnlySection = document.getElementById("hr-only-section");

  function isHrView() {
    return appState.activeRole === "hr";
  }

  function isAnonymised() {
    return Boolean(anonymiseToggle && anonymiseToggle.checked);
  }

  function formatDisplayName(emp, indexOneBased) {
    if (isAnonymised()) {
      const padded = String(indexOneBased).padStart(2, "0");
      return emp.isCurrentUser ? `Employee #${padded} (You)` : `Employee #${padded}`;
    }
    return emp.isCurrentUser ? `${emp.name} (You)` : emp.name;
  }

  function getScopedEmployees() {
    const all = Engine.buildOrganizationDataset(appState);
    const scoped = isHrView()
      ? all
      : all.filter((e) => e.team === Data.MANAGER_TEAM_NAME || e.isCurrentUser);

    return scoped.map((emp, idx) => ({
      ...emp,
      anonIndex: idx + 1,
      displayName: formatDisplayName(emp, idx + 1),
    }));
  }

  function getFilteredAndSorted(employees) {
    const q = searchQuery.trim().toLowerCase();
    const filtered = employees.filter((emp) => {
      if (
        q &&
        !emp.displayName.toLowerCase().includes(q) &&
        !emp.roleName.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (userTypeFilter !== "all" && emp.userType !== userTypeFilter) return false;
      if (roleFilter !== "all" && emp.roleId !== roleFilter) return false;
      if (levelFilter !== "all" && emp.avgLevel !== levelFilter) return false;
      if (statusFilter !== "all" && emp.status !== statusFilter) return false;
      if (certFilter === "has" && Number(emp.certCount || 0) === 0) return false;
      if (certFilter === "none" && Number(emp.certCount || 0) > 0) return false;
      return true;
    });

    const mult = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      let va = a[sortCol];
      let vb = b[sortCol];
      if (sortCol === "name") {
        va = a.displayName;
        vb = b.displayName;
      }
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * mult;
      }
      return String(va || "").localeCompare(String(vb || "")) * mult;
    });

    return filtered;
  }

  function renderSummaryCards(employees) {
    const total = employees.length;
    const avgComp = total
      ? Math.round(
          employees.reduce((s, e) => s + e.completionPct, 0) / total
        )
      : 0;
    const totalVerifiedSkills = employees.reduce(
      (s, e) => s + e.verifiedCount,
      0
    );
    const fallingBehind = employees.filter(
      (e) => e.status === "Behind" || e.status === "At risk"
    ).length;
    const currentMonthPrefix = new Date().toISOString().slice(0, 7);
    const totalCerts = employees.reduce(
      (s, e) => s + Number(e.certCount || 0),
      0
    );
    const verifiedCerts = employees.reduce(
      (s, e) => s + Number(e.verifiedCertCount || 0),
      0
    );
    const certsThisMonth = employees.reduce(
      (s, e) =>
        s +
        (e.certifications || []).filter((c) =>
          String(c.completedOn || "").startsWith(currentMonthPrefix)
        ).length,
      0
    );

    const dist = { Beginner: 0, Intermediate: 0, Expert: 0, Unverified: 0 };
    employees.forEach((emp) => {
      const roleSkills = Data.ROLE_MAP[emp.roleId]?.skills || [];
      roleSkills.forEach((rs) => {
        const ver = emp.verifiedLevels[rs.skillId];
        if (ver && dist[ver.level] !== undefined) dist[ver.level] += 1;
        else dist.Unverified += 1;
      });
    });

    document.getElementById("dash-summary-grid").innerHTML = `
      <article class="card kpi-card">
        <span class="kpi-label">${isHrView() ? "Org Employees" : "Team Members"}</span>
        <span class="kpi-value">${total}</span>
        <span class="kpi-sub">${isHrView() ? "Across 5 departments" : Data.MANAGER_TEAM_NAME}</span>
      </article>
      <article class="card kpi-card">
        <span class="kpi-label">Avg Course Completion</span>
        <span class="kpi-value">${avgComp}%</span>
        <span class="kpi-sub">Active upskilling tracks</span>
      </article>
      <article class="card kpi-card">
        <span class="kpi-label">Total certifications completed</span>
        <span class="kpi-value">${totalCerts}</span>
        <span class="kpi-sub">${certsThisMonth} this month · ${verifiedCerts} verified</span>
      </article>
      <article class="card kpi-card">
        <span class="kpi-label">Verified Skills</span>
        <span class="kpi-value">${totalVerifiedSkills}</span>
        <span class="kpi-sub">${employees.filter((e) => e.verifiedCount > 0).length} of ${total} tested</span>
      </article>
      <article class="card kpi-card">
        <span class="kpi-label">Falling Behind</span>
        <span class="kpi-value ${fallingBehind > 0 ? "kpi-alert" : ""}">${fallingBehind}</span>
        <span class="kpi-sub">Behind or At risk · ${dist.Expert}E ${dist.Intermediate}I ${dist.Beginner}B</span>
      </article>
    `;

    Chart.renderLevelDistributionBarChart(
      document.getElementById("chart-level-dist"),
      dist
    );
    Chart.renderEmployeeCompletionBarChart(
      document.getElementById("chart-emp-completion"),
      employees
    );
    Chart.renderCertificationProgressBarChart(
      document.getElementById("chart-cert-progress"),
      employees
    );
  }

  function renderHrExtras(employees) {
    if (!isHrView()) {
      hrOnlySection.hidden = true;
      return;
    }
    hrOnlySection.hidden = false;

    const totalSpend = employees.reduce((sum, e) => sum + Number(e.spend || 0), 0);
    const totalLevelsGained = Math.max(
      1,
      employees.reduce((sum, e) => sum + Number(e.levelsGained || 0), 0)
    );
    const costPerLevel = Math.round(totalSpend / totalLevelsGained);

    document.getElementById("hr-roi-metrics").innerHTML = `
      <div class="roi-stat">
        <span>Total Catalog Spend</span>
        <strong>$${totalSpend.toLocaleString()}</strong>
      </div>
      <div class="roi-stat">
        <span>Skill Levels Gained</span>
        <strong>${totalLevelsGained} levels</strong>
      </div>
      <div class="roi-stat">
        <span>Cost / Level Gained</span>
        <strong>$${costPerLevel.toLocaleString()}</strong>
      </div>
    `;

    const priorities = Array.isArray(appState.priorities)
      ? appState.priorities
      : [];
    const prioritySkills = [
      "power_bi",
      "sql",
      "statistics",
      "python",
      "excel",
      "aws_cloud",
      "docker",
      "security_basics",
      "javascript",
    ];

    const controlsEl = document.getElementById("hr-priority-controls");
    controlsEl.innerHTML = `
      <div class="priority-weight-list">
        ${prioritySkills
          .map((sid) => {
            const existing = priorities.find((p) => p.skillId === sid);
            const active = Boolean(existing);
            const weight = existing ? existing.weight : 3;
            const name = Data.SKILL_MAP[sid]?.name || sid;

            return `
              <div class="priority-weight-row ${active ? "is-active" : ""}">
                <label class="priority-check-label">
                  <input type="checkbox" data-prio-toggle="${escapeHtml(sid)}" ${active ? "checked" : ""} />
                  <span>${escapeHtml(name)}</span>
                </label>
                <div class="priority-weight-select-wrap">
                  <span>Weight</span>
                  <select class="select-compact" data-prio-weight="${escapeHtml(sid)}" ${active ? "" : "disabled"}>
                    ${[1, 2, 3, 4, 5]
                      .map(
                        (w) =>
                          `<option value="${w}" ${w === weight ? "selected" : ""}>${w}${w === 5 ? " (Top)" : ""}</option>`
                      )
                      .join("")}
                  </select>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    async function persistPrioritiesFromUi(changedSkillName) {
      const updated = [];
      controlsEl.querySelectorAll("[data-prio-toggle]").forEach((cb) => {
        if (!cb.checked) return;
        const sid = cb.getAttribute("data-prio-toggle");
        const wSel = controlsEl.querySelector(`[data-prio-weight="${sid}"]`);
        updated.push({
          skillId: sid,
          weight: wSel ? Number(wSel.value) : 3,
        });
      });

      appState = await Storage.savePriorities(updated);
      const summary = updated
        .map(
          (p) =>
            `${Data.SKILL_MAP[p.skillId]?.name || p.skillId} (W${p.weight})`
        )
        .join(", ");
      appState = await Storage.addReplanEntry({
        employeeId: appState.currentEmployeeId || "emp_current",
        reason: `HR updated organization priority (${changedSkillName})`,
        summary: summary
          ? `Boosted priorities: ${summary}`
          : "Cleared organization priority weights.",
      });
      Nav.showToast(
        "Organization priorities saved & employee plans re-ranked.",
        "success"
      );
      renderAll();
    }

    controlsEl.querySelectorAll("[data-prio-toggle]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const sid = cb.getAttribute("data-prio-toggle");
        const wSel = controlsEl.querySelector(`[data-prio-weight="${sid}"]`);
        if (wSel) wSel.disabled = !cb.checked;
        persistPrioritiesFromUi(Data.SKILL_MAP[sid]?.name || sid);
      });
    });

    controlsEl.querySelectorAll("[data-prio-weight]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const sid = sel.getAttribute("data-prio-weight");
        persistPrioritiesFromUi(Data.SKILL_MAP[sid]?.name || sid);
      });
    });
  }

  function renderHeatmap(employees) {
    const prioritySet = new Set(
      (appState.priorities || []).map((p) => p.skillId)
    );
    const baseCols = [
      "power_bi",
      "sql",
      "statistics",
      "python",
      "excel",
      "docker",
      "aws_cloud",
      "javascript",
      "security_basics",
    ];
    (appState.priorities || []).forEach((p) => {
      if (!baseCols.includes(p.skillId)) baseCols.push(p.skillId);
    });

    const headerCells = baseCols
      .map((sid) => {
        const name = Data.SKILL_MAP[sid]?.name || sid;
        const isPrio = prioritySet.has(sid);
        return `<th class="${isPrio ? "is-prio-col" : ""}">
          ${escapeHtml(name)}
          ${isPrio ? `<span class="prio-star" title="Organization priority">★</span>` : ""}
        </th>`;
      })
      .join("");

    const rowsHtml = employees
      .map((emp) => {
        const cells = baseCols
          .map((sid) => {
            const ver = emp.verifiedLevels[sid];
            const level = ver ? ver.level : "Unverified";
            const scoreText = ver ? `${ver.verifiedPct}%` : "—";
            const dateNote = ver?.updatedAt
              ? `Tested ${String(ver.updatedAt).slice(0, 10)}`
              : "Not tested yet";
            const tip = `${emp.displayName} · ${Data.SKILL_MAP[sid]?.name || sid}: ${level} (${scoreText}) · ${dateNote}`;
            return `
              <td
                class="heat-cell heat-${level.toLowerCase()}"
                title="${escapeHtml(tip)}"
                data-inspect-emp="${escapeHtml(emp.id)}"
              >
                <span class="heat-cell-lvl">${level === "Unverified" ? "—" : level[0]}</span>
                <span class="heat-cell-pct">${scoreText}</span>
              </td>
            `;
          })
          .join("");

        return `
          <tr class="heatmap-row ${emp.id === selectedEmployeeId ? "is-selected-row" : ""}" data-inspect-emp="${escapeHtml(emp.id)}">
            <th class="heatmap-emp-name">${escapeHtml(emp.displayName)}</th>
            ${cells}
          </tr>
        `;
      })
      .join("");

    const mount = document.getElementById("team-heatmap-mount");
    mount.innerHTML = `
      <table class="heatmap-table">
        <thead>
          <tr>
            <th>Employee</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;

    mount.querySelectorAll("[data-inspect-emp]").forEach((el) => {
      el.addEventListener("click", () => {
        selectedEmployeeId = el.getAttribute("data-inspect-emp");
        renderAll();
      });
    });
  }

  function populateRoleFilter(employees) {
    const sel = document.getElementById("dash-filter-role");
    const uniqueRoles = new Map();
    employees.forEach((e) => uniqueRoles.set(e.roleId, e.roleName));
    sel.innerHTML =
      `<option value="all">All Roles</option>` +
      Array.from(uniqueRoles.entries())
        .map(
          ([id, name]) =>
            `<option value="${escapeHtml(id)}" ${id === roleFilter ? "selected" : ""}>${escapeHtml(name)}</option>`
        )
        .join("");
  }

  async function triggerAction(emp, actionType) {
    const senderLabel = isHrView() ? "HR" : "Manager";
    const msg =
      actionType === "retest_requested"
        ? `${senderLabel} requested a diagnostic skill retest for ${emp.displayName}.`
        : actionType === "diagnostic_nudge"
          ? `${senderLabel} nudged ${emp.displayName} to complete pending diagnostic tests (${emp.gateVerifiedCount || 0}/${emp.gateRequiredCount || 0} verified).`
          : `${senderLabel} sent a progress nudge to ${emp.displayName} (${emp.completionPct}% complete · ${emp.status}).`;

    appState = await Storage.addNudge({
      employeeId: emp.id,
      employeeName: emp.displayName,
      actionType,
      senderRole: appState.activeRole,
      message: msg,
    });

    Nav.render({
      activePage: "dashboard",
      state: appState,
      onRoleChange: handleRoleSwitch,
    });
    renderNudgeLog();
    Nav.showToast(msg, "success");
  }

  function renderGateBadgeHtml(emp) {
    const gateInfo = emp.gateStatus || "not_started";
    const gateVerified = Number(emp.gateVerifiedCount || 0);
    const gateRequired = Number(emp.gateRequiredCount || 0);

    if (gateInfo === "cleared") {
      return `<span class="gate-badge gate-badge-cleared">✓ Cleared (${gateVerified}/${gateRequired})</span>`;
    }
    const statusPill =
      gateInfo === "in_progress"
        ? `<span class="gate-badge gate-badge-progress">▶ In progress (${gateVerified}/${gateRequired})</span>`
        : `<span class="gate-badge gate-badge-not-started">○ Not started (${gateVerified}/${gateRequired})</span>`;
    return `<div class="gate-status-wrap">${statusPill}<span class="gate-badge gate-badge-pending">Diagnostic pending</span></div>`;
  }

  function renderPerformanceTable(filteredEmployees) {
    const columns = [
      { id: "name", label: "Employee" },
      { id: "roleName", label: "Role" },
      { id: "verifiedCount", label: "Verified Skills" },
      { id: "avgLevel", label: "Avg Level" },
      { id: "completionPct", label: "Completion %" },
      { id: "certCount", label: "Certifications completed" },
      { id: "lastTestDate", label: "Last Test Date" },
      { id: "gateStatus", label: "Diagnostic Gate" },
      { id: "status", label: "Status" },
    ];

    const thead = columns
      .map((c) => {
        const arrow =
          sortCol === c.id ? (sortDir === "asc" ? " ↑" : " ↓") : "";
        return `<th>
          <button type="button" class="sort-header-btn" data-sort-col="${c.id}">
            ${escapeHtml(c.label)}${arrow}
          </button>
        </th>`;
      })
      .join("");

    const tbody =
      filteredEmployees.length === 0
        ? `<tr><td colspan="10" class="table-empty-cell">No employees match the current filters.</td></tr>`
        : filteredEmployees
            .map((emp) => {
              const statusSlug = emp.status.toLowerCase().replace(/\s+/g, "-");
              const isSelected = emp.id === selectedEmployeeId;
              const gateInfo = emp.gateStatus || "not_started";
              const gateTag = renderGateBadgeHtml(emp);
              const typeBadgeClass =
                emp.userType === "other" ? "type-badge-other" : "type-badge-employee";
              const typeBadgeText =
                emp.userType === "other" ? "New joiner / Other" : "Employee";
              const typeTooltip =
                emp.userType === "other" && emp.previousField
                  ? `title="Previous field: ${escapeHtml(emp.previousField)}"`
                  : "";
              const certCount = Number(emp.certCount || 0);
              const verifiedCertCount = Number(emp.verifiedCertCount || 0);
              const certTooltip = `${certCount} completed (${verifiedCertCount} verified)`;
              const verifiedCertBadge =
                verifiedCertCount > 0
                  ? `<span class="cert-verified-pill">Verified (${verifiedCertCount})</span>`
                  : "";

              return `
                <tr class="perf-row ${isSelected ? "is-selected-row" : ""}" data-row-emp="${escapeHtml(emp.id)}">
                  <td>
                    <div class="row-name-wrap">
                      <button type="button" class="row-name-btn" data-inspect-btn="${escapeHtml(emp.id)}">
                        ${escapeHtml(emp.displayName)}
                      </button>
                      <span class="user-type-badge ${typeBadgeClass}" ${typeTooltip}>${escapeHtml(typeBadgeText)}</span>
                    </div>
                  </td>
                  <td>${escapeHtml(emp.roleName)}</td>
                  <td><strong>${emp.gateVerifiedCount || 0}/${emp.gateRequiredCount || 0}</strong> <span class="muted-note">(${emp.verifiedCount} total)</span></td>
                  <td><span class="ver-mini-pill level-${emp.avgLevel.toLowerCase()}">${escapeHtml(emp.avgLevel)}</span></td>
                  <td><strong>${emp.completionPct}%</strong></td>
                  <td>
                    <div class="cert-table-cell" title="${escapeHtml(certTooltip)}">
                      <span class="cert-count-chip">${Nav.certRibbonSvg()}<strong>${certCount}</strong></span>
                      ${verifiedCertBadge}
                    </div>
                  </td>
                  <td>${escapeHtml(emp.lastTestDate)}</td>
                  <td>${gateTag}</td>
                  <td><span class="emp-status-pill status-${statusSlug}">${escapeHtml(emp.status)}</span></td>
                  <td class="table-actions-cell">
                    <button type="button" class="btn-xs" data-nudge-emp="${escapeHtml(emp.id)}">Nudge</button>
                    <button type="button" class="btn-xs btn-xs-outline" data-retest-emp="${escapeHtml(emp.id)}">Request retest</button>
                    ${gateInfo !== "cleared"
                      ? `<button type="button" class="btn-xs btn-xs-warn" data-nudge-diagnostic="${escapeHtml(emp.id)}">Nudge to complete test</button>`
                      : ""}
                  </td>
                </tr>
              `;
            })
            .join("");

    const mount = document.getElementById("perf-table-mount");
    mount.innerHTML = `
      <table class="data-table perf-table">
        <thead>
          <tr>
            ${thead}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    `;

    mount.querySelectorAll("[data-sort-col]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const col = btn.getAttribute("data-sort-col");
        if (sortCol === col) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortCol = col;
          sortDir = "asc";
        }
        renderAll();
      });
    });

    mount.querySelectorAll("[data-inspect-btn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedEmployeeId = btn.getAttribute("data-inspect-btn");
        renderAll();
      });
    });

    mount.querySelectorAll("[data-row-emp]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        selectedEmployeeId = row.getAttribute("data-row-emp");
        renderAll();
      });
    });

    mount.querySelectorAll("[data-nudge-emp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const eid = btn.getAttribute("data-nudge-emp");
        const emp = filteredEmployees.find((x) => x.id === eid);
        if (emp) triggerAction(emp, "nudge");
      });
    });

    mount.querySelectorAll("[data-retest-emp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const eid = btn.getAttribute("data-retest-emp");
        const emp = filteredEmployees.find((x) => x.id === eid);
        if (emp) triggerAction(emp, "retest_requested");
      });
    });

    mount.querySelectorAll("[data-nudge-diagnostic]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const eid = btn.getAttribute("data-nudge-diagnostic");
        const emp = filteredEmployees.find((x) => x.id === eid);
        if (emp) triggerAction(emp, "diagnostic_nudge");
      });
    });
  }

  function renderDetailPanel(employees) {
    const detailCard = document.getElementById("employee-detail-card");
    const emp =
      employees.find((e) => e.id === selectedEmployeeId) || employees[0];
    if (!emp) {
      detailCard.hidden = true;
      return;
    }

    selectedEmployeeId = emp.id;
    detailCard.hidden = false;

    const gateLabel = emp.gateStatusLabel || "Not started";
    const typeLabel =
      emp.userType === "other" ? "New joiner / Other" : "Employee";
    const prevFieldSuffix =
      emp.userType === "other" && emp.previousField
        ? ` (Previous field: ${emp.previousField})`
        : "";
    document.getElementById("detail-team-badge").textContent =
      `${emp.team} · ${typeLabel} · ${emp.status} · Gate: ${gateLabel}`;
    document.getElementById("detail-emp-name").textContent = emp.displayName;
    document.getElementById("detail-emp-meta").innerHTML = `
      <span>${escapeHtml(emp.roleName)}${escapeHtml(prevFieldSuffix)} · ${emp.gateVerifiedCount || 0}/${emp.gateRequiredCount || 0} required skills verified · ${emp.completionPct}% course completion</span>
      ${renderGateBadgeHtml(emp)}
    `;

    const actionsMount = document.getElementById("detail-actions-mount");
    actionsMount.innerHTML = `
      ${
        emp.gateStatus !== "cleared"
          ? `<button type="button" class="btn-secondary btn-xs-warn" id="detail-nudge-diag-btn">Nudge to complete test</button>`
          : ""
      }
      <button type="button" class="btn-secondary" id="detail-nudge-btn">Send Nudge</button>
      <button type="button" class="btn-primary" id="detail-retest-btn">Request Retest</button>
    `;
    const diagBtn = document.getElementById("detail-nudge-diag-btn");
    if (diagBtn) {
      diagBtn.addEventListener("click", () =>
        triggerAction(emp, "diagnostic_nudge")
      );
    }
    document
      .getElementById("detail-nudge-btn")
      .addEventListener("click", () => triggerAction(emp, "nudge"));
    document
      .getElementById("detail-retest-btn")
      .addEventListener("click", () => triggerAction(emp, "retest_requested"));

    // Radar chart (verified vs target)
    if (emp.analysis) {
      Chart.renderRadarChart(
        document.getElementById("detail-radar-mount"),
        emp.analysis.roadmap
      );
    }

    // Score trend line chart
    const flatAttempts = [];
    Object.entries(emp.testResults || {}).forEach(([skillId, attempts]) => {
      (attempts || []).forEach((att) => {
        flatAttempts.push({
          ...att,
          skillId,
          skillName: Data.SKILL_MAP[skillId]?.name || skillId,
        });
      });
    });
    Chart.renderScoreTrendLineChart(
      document.getElementById("detail-trend-mount"),
      flatAttempts
    );

    // Per-skill test history (including tab-switch count)
    const historyMount = document.getElementById("detail-test-history");
    if (flatAttempts.length === 0) {
      historyMount.innerHTML = `<p class="muted-note">No diagnostic test history yet.</p>`;
    } else {
      historyMount.innerHTML = `
        <table class="data-table compact-table">
          <thead>
            <tr><th>Skill</th><th>Date</th><th>Score</th><th>Level</th><th>Tab Switches</th></tr>
          </thead>
          <tbody>
            ${flatAttempts
              .slice()
              .reverse()
              .map((att) => {
                const switches =
                  att.tabSwitchCount != null ? Number(att.tabSwitchCount) : null;
                const switchCell =
                  switches === null
                    ? `<span class="muted-note">—</span>`
                    : switches > 0
                      ? `<span class="tab-switch-flag" title="Tab focus lost during attempt">⚠ ${switches}</span>`
                      : `<span>0</span>`;
                return `
              <tr>
                <td><strong>${escapeHtml(att.skillName)}</strong></td>
                <td>${escapeHtml(String(att.date || "").slice(0, 10))}</td>
                <td>${att.score}/5 (${att.verifiedPct}%)</td>
                <td><span class="ver-mini-pill level-${att.level.toLowerCase()}">${escapeHtml(att.level)}</span></td>
                <td>${switchCell}</td>
              </tr>
            `;
              })
              .join("")}
          </tbody>
        </table>
      `;
    }

    // 6-Week plan + per-course progress
    const planMount = document.getElementById("detail-plan-progress");
    if (emp.analysis) {
      const planHtml = emp.analysis.sixWeekPlan
        .map(
          (p) => `
          <div class="detail-plan-item">
            <span class="week-pill">${escapeHtml(p.weeksLabel)}</span>
            <div>
              <strong>${escapeHtml(p.title)}</strong>
              <div class="muted-note">${escapeHtml(p.targetSummary)}</div>
            </div>
          </div>
        `
        )
        .join("");

      const coursesHtml = emp.analysis.roadmap
        .flatMap((s) => s.courses)
        .slice(0, 6)
        .map(
          (c) => `
          <div class="detail-course-row">
            <span class="detail-course-title-wrap">
              <span>${escapeHtml(c.title)}</span>
              ${Nav.certBadgeHtml(c, { showName: false })}
            </span>
            <span class="status-pill status-${c.status === "completed" ? "strong" : c.status === "in_progress" ? "needs_improvement" : "missing"}">
              ${escapeHtml(c.status.replace("_", " "))}
            </span>
          </div>
        `
        )
        .join("");

      planMount.innerHTML = `${planHtml}<div class="detail-course-list">${coursesHtml}</div>`;
    }

    // Certifications list with Verify action
    const certsMount = document.getElementById("detail-certifications-list");
    if (certsMount) {
      const empCerts = emp.certifications || [];
      if (empCerts.length === 0) {
        certsMount.innerHTML = `<p class="muted-note">No certifications completed yet for this employee.</p>`;
      } else {
        const allCatalogCourses = Object.values(Data.COURSES_BY_SKILL || {}).flat();
        certsMount.innerHTML = `
          <div class="detail-certs-list">
            ${empCerts
              .map((cert) => {
                const courseMeta = allCatalogCourses.find(
                  (c) => c.id === cert.courseId
                );
                const courseTitle = courseMeta ? courseMeta.title : cert.courseId;
                const isUrl = /^https?:\/\//i.test(String(cert.certId || ""));
                const certIdHtml = isUrl
                  ? `<a href="${escapeHtml(cert.certId)}" target="_blank" rel="noopener noreferrer" class="cert-id-link">${escapeHtml(cert.certId)} ↗</a>`
                  : `<code class="cert-id-code">${escapeHtml(cert.certId)}</code>`;
                const isVerified = cert.status === "verified";
                const statusBadge = isVerified
                  ? `<span class="cert-verified-pill">✓ Verified</span>`
                  : `<span class="cert-pending-pill">Pending review</span>`;
                const verifyBtn = !isVerified
                  ? `<button type="button" class="btn-xs btn-verify-cert" data-verify-emp="${escapeHtml(emp.id)}" data-verify-course="${escapeHtml(cert.courseId)}">Verify</button>`
                  : "";

                return `
                  <div class="detail-cert-row">
                    <div class="detail-cert-main">
                      <div class="detail-cert-title">${Nav.certRibbonSvg()} <strong>${escapeHtml(cert.certificationName)}</strong></div>
                      <div class="muted-note">Course: ${escapeHtml(courseTitle)} · Completed: ${escapeHtml(cert.completedOn || "—")} · ID/Link: ${certIdHtml}</div>
                    </div>
                    <div class="detail-cert-actions">
                      ${statusBadge}
                      ${verifyBtn}
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>
        `;

        certsMount.querySelectorAll("[data-verify-course]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const empId = btn.getAttribute("data-verify-emp");
            const courseId = btn.getAttribute("data-verify-course");
            appState = await Storage.verifyCertification(empId, courseId);
            Nav.showToast("Certification marked as Verified ✓.", "success");
            renderAll();
          });
        });
      }
    }

    // Re-plan history
    const replanMount = document.getElementById("detail-replan-history");
    const replans = emp.replanHistory || [];
    replanMount.innerHTML =
      replans.length === 0
        ? `<p class="muted-note">No re-plan events logged yet for this employee.</p>`
        : replans
            .map(
              (r) => `
            <div class="replan-entry">
              <div class="replan-entry-top">
                <strong>${escapeHtml(r.reason)}</strong>
                <span class="replan-date">${escapeHtml(String(r.date || "").slice(0, 10))}</span>
              </div>
              <p>${escapeHtml(r.summary)}</p>
            </div>
          `
            )
            .join("");
  }

  function renderNotifyActivityLog() {
    const mount = document.getElementById("dash-notify-log");
    if (!mount) return;
    const logs = appState.agentActivityLog || [];
    if (logs.length === 0) {
      mount.innerHTML = `<p class="muted-note">No Notify Tool events yet. When an employee completes a certified course, an alert is logged here.</p>`;
      return;
    }

    mount.innerHTML = logs
      .slice(0, 10)
      .map(
        (entry) => `
      <div class="replan-entry">
        <div class="replan-entry-top">
          <strong>${escapeHtml(entry.tool || "Notify Tool")}</strong>
          <span class="replan-date">${escapeHtml(String(entry.createdAt || "").slice(0, 16).replace("T", " "))}</span>
        </div>
        <p>${escapeHtml(entry.message)}</p>
      </div>
    `
      )
      .join("");
  }

  function renderNudgeLog() {
    const mount = document.getElementById("dash-nudge-log");
    const nudges = appState.nudges || [];
    if (nudges.length === 0) {
      mount.innerHTML = `<p class="muted-note">No nudges or retest requests logged yet. Click Nudge or Request retest on any employee above.</p>`;
      return;
    }

    mount.innerHTML = nudges
      .slice(0, 8)
      .map(
        (n) => `
      <div class="replan-entry">
        <div class="replan-entry-top">
          <strong>${escapeHtml(n.actionType === "retest_requested" ? "Retest Requested" : n.actionType === "diagnostic_nudge" ? "Diagnostic Nudge Sent" : "Nudge Sent")} · ${escapeHtml(n.employeeName)}</strong>
          <span class="replan-date">${escapeHtml(String(n.createdAt || "").slice(0, 16).replace("T", " "))}</span>
        </div>
        <p>${escapeHtml(n.message)}</p>
      </div>
    `
      )
      .join("");
  }

  function exportCsv(rows) {
    const headers = [
      "Name",
      "Type",
      "Team",
      "Role",
      "Verified Skills",
      "Gate Verified",
      "Diagnostic Gate",
      "Average Level",
      "Course Completion %",
      "Certifications Completed",
      "Certifications Verified",
      "Certifications",
      "Last Test Date",
      "Status",
    ];
    const csvEscape = (val) => {
      const s = String(val ?? "");
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [
      headers.map(csvEscape).join(","),
      ...rows.map((r) => {
        const certSummary = (r.certifications || [])
          .map(
            (c) =>
              `${c.certificationName} (${c.certId || "no-id"} · ${c.status})`
          )
          .join("; ");
        return [
          r.displayName,
          r.userTypeLabel || (r.userType === "other" ? "New joiner / Other" : "Employee"),
          r.team,
          r.roleName,
          r.verifiedCount,
          `${r.gateVerifiedCount || 0}/${r.gateRequiredCount || 0}`,
          r.gateStatusLabel || "Not started",
          r.avgLevel,
          r.completionPct,
          r.certCount || 0,
          r.verifiedCertCount || 0,
          certSummary || "None",
          r.lastTestDate,
          r.status,
        ]
          .map(csvEscape)
          .join(",");
      }),
    ];

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `skillsync-${appState.activeRole}-performance.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    Nav.showToast(`Exported ${rows.length} employee rows to CSV.`, "success");
  }

  function handleRoleSwitch(nextRole, nextState) {
    appState = nextState;
    if (anonymiseToggle) {
      anonymiseToggle.checked =
        nextRole === "hr" ? Boolean(appState.anonymiseHR) : false;
    }
    selectedEmployeeId = null;
    renderAll();
  }

  function toastUnreadManagerCertNotifications() {
    if (appState.activeRole === "employee") return;
    const hrEnabled = appState.hrCertNotifications !== false;
    const unreadCerts = (appState.notifications || []).filter(
      (n) =>
        !n.read &&
        n.type === "certification_completed" &&
        Storage.isNotificationForRole(n, appState.activeRole, hrEnabled) &&
        !toastedNotifIds.has(n.id)
    );
    if (unreadCerts.length > 0) {
      const newest = unreadCerts[0];
      unreadCerts.forEach((n) => toastedNotifIds.add(n.id));
      Nav.showToast(Engine.formatNotificationMessage(newest, appState), "success");
    }
  }

  function handleSelectEmployeeFromNotif(empId, updatedState) {
    if (updatedState) appState = updatedState;
    selectedEmployeeId = empId;
    renderAll();
    const card = document.getElementById("employee-detail-card");
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderAll() {
    Nav.render({
      activePage: "dashboard",
      state: appState,
      onRoleChange: handleRoleSwitch,
      onSelectEmployee: handleSelectEmployeeFromNotif,
    });

    if (appState.activeRole === "employee") {
      guardEl.hidden = false;
      contentEl.hidden = true;
      return;
    }

    guardEl.hidden = true;
    contentEl.hidden = false;

    if (hrCertNotifsWrap && hrCertNotifsToggle) {
      hrCertNotifsWrap.hidden = !isHrView();
      hrCertNotifsToggle.checked = appState.hrCertNotifications !== false;
    }

    document.getElementById("dash-role-badge").textContent = isHrView()
      ? "HR Organization View"
      : "Manager Team View";
    document.getElementById("dash-main-title").textContent = isHrView()
      ? "Organization Upskilling & ROI Dashboard"
      : `${Data.MANAGER_TEAM_NAME} Team Performance Dashboard`;
    document.getElementById("dash-main-subtitle").textContent = isHrView()
      ? "Company-wide skill verification heatmap, training ROI, and priority weighting across all teams."
      : "Track verified diagnostic levels, course progress, and send nudges across your direct team.";

    const employees = getScopedEmployees();
    populateRoleFilter(employees);
    const filtered = getFilteredAndSorted(employees);

    renderSummaryCards(employees);
    renderHrExtras(employees);
    renderHeatmap(employees);
    renderPerformanceTable(filtered);
    renderDetailPanel(employees);
    renderNotifyActivityLog();
    renderNudgeLog();
    toastUnreadManagerCertNotifications();
  }

  // Event Listeners
  if (anonymiseToggle) {
    anonymiseToggle.checked = isHrView() ? Boolean(appState.anonymiseHR) : false;
    anonymiseToggle.addEventListener("change", async () => {
      if (isHrView()) {
        appState = await Storage.setAnonymiseHR(anonymiseToggle.checked);
      }
      renderAll();
    });
  }

  document.getElementById("dash-search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderAll();
  });

  document.getElementById("dash-filter-usertype").addEventListener("change", (e) => {
    userTypeFilter = e.target.value;
    renderAll();
  });

  document.getElementById("dash-filter-role").addEventListener("change", (e) => {
    roleFilter = e.target.value;
    renderAll();
  });

  document.getElementById("dash-filter-level").addEventListener("change", (e) => {
    levelFilter = e.target.value;
    renderAll();
  });

  document.getElementById("dash-filter-status").addEventListener("change", (e) => {
    statusFilter = e.target.value;
    renderAll();
  });

  document.getElementById("dash-filter-certs").addEventListener("change", (e) => {
    certFilter = e.target.value;
    renderAll();
  });

  if (hrCertNotifsToggle) {
    hrCertNotifsToggle.addEventListener("change", async (e) => {
      appState = await Storage.setHrCertNotifications(Boolean(e.target.checked));
      renderAll();
    });
  }

  window.addEventListener("storage", () => {
    appState = Storage.readLocal();
    renderAll();
  });

  document.getElementById("btn-export-csv").addEventListener("click", () => {
    const filtered = getFilteredAndSorted(getScopedEmployees());
    exportCsv(filtered);
  });

  renderAll();
})();
