/**
 * Change Password Page Controller (change-password.html).
 */
(async function () {
  const Storage = window.SkillPathStorage;
  const Nav = window.SkillPathNav;

  const sessionInfo = await Nav.requireLogin({ allowForcedChange: true });
  if (!sessionInfo || !sessionInfo.authenticated) return;

  const user = sessionInfo.user;
  const appState = await Storage.initState({ allowForcedChange: true });

  Nav.render({
    activePage: "change-password",
    state: appState,
  });

  const forceBanner = document.getElementById("cp-force-banner");
  const cancelLink = document.getElementById("cp-cancel-link");
  if (user.forcePasswordChange) {
    if (forceBanner) forceBanner.hidden = false;
    if (cancelLink) cancelLink.hidden = true;
  } else if (cancelLink) {
    cancelLink.href =
      user.role === "manager" || user.role === "hr"
        ? "dashboard.html"
        : "index.html";
  }

  const form = document.getElementById("change-password-form");
  const currentInput = document.getElementById("cp-current");
  const newInput = document.getElementById("cp-new");
  const confirmInput = document.getElementById("cp-confirm");
  const errorEl = document.getElementById("cp-error");
  const submitBtn = document.getElementById("btn-cp-submit");

  const ruleLen = document.getElementById("rule-len");
  const ruleLetter = document.getElementById("rule-letter");
  const ruleNumber = document.getElementById("rule-number");
  const ruleNotDefault = document.getElementById("rule-not-default");

  document.querySelectorAll("[data-toggle-pw]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.getAttribute("data-toggle-pw"));
      if (!target) return;
      const showing = target.type === "text";
      target.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
    });
  });

  function updatePolicyHints() {
    const val = newInput.value || "";
    const okLen = val.length >= 8;
    const okLetter = /[A-Za-z]/.test(val);
    const okNum = /\d/.test(val);
    const okNotDefault =
      val.trim() !== "1234" &&
      val.trim().toLowerCase() !== String(user.id || "").toLowerCase();

    ruleLen.classList.toggle("is-valid", okLen);
    ruleLetter.classList.toggle("is-valid", okLetter);
    ruleNumber.classList.toggle("is-valid", okNum);
    ruleNotDefault.classList.toggle("is-valid", okNotDefault && val.length > 0);
  }

  newInput.addEventListener("input", updatePolicyHints);

  function showError(msg) {
    errorEl.hidden = !msg;
    errorEl.textContent = msg || "";
  }

  function validatePolicyClient(newPw) {
    if (newPw.length < 8) return "New password must be at least 8 characters long.";
    if (!/[A-Za-z]/.test(newPw)) return "New password must contain at least 1 letter.";
    if (!/\d/.test(newPw)) return "New password must contain at least 1 number.";
    if (newPw.trim() === "1234") return "New password cannot be 1234.";
    if (newPw.trim().toLowerCase() === String(user.id || "").toLowerCase()) {
      return "New password cannot be the same as your User ID.";
    }
    return null;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const currentPassword = currentInput.value;
    const newPassword = newInput.value;
    const confirmPassword = confirmInput.value;

    if (!currentPassword) {
      showError("Please enter your current password.");
      currentInput.focus();
      return;
    }
    const policyErr = validatePolicyClient(newPassword);
    if (policyErr) {
      showError(policyErr);
      newInput.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      showError("New password and confirmation do not match.");
      confirmInput.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Updating...";
    showError("");

    try {
      const resp = await Storage.apiFetch("/api/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        showError(data.error || "Unable to update password.");
        submitBtn.disabled = false;
        submitBtn.textContent = "Update Password →";
        return;
      }

      Nav.setFlashToast("Password updated successfully.", "success");
      window.location.href = data.redirectTo || "index.html";
    } catch (_err) {
      showError("Network error while updating password.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Update Password →";
    }
  });
})();
