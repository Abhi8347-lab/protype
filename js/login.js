/**
 * Login & Forgot Password Controller (login.html).
 */
(async function () {
  const Storage = window.SkillPathStorage;

  // Apply stored theme immediately
  const themeBtn = document.getElementById("login-theme-btn");
  function syncTheme() {
    const theme = Storage ? Storage.getTheme() : "light";
    document.documentElement.setAttribute("data-theme", theme);
    if (themeBtn) themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  }
  syncTheme();
  if (themeBtn && Storage) {
    themeBtn.addEventListener("click", () => {
      const next = Storage.getTheme() === "dark" ? "light" : "dark";
      Storage.setTheme(next);
      syncTheme();
    });
  }

  const loginForm = document.getElementById("login-form");
  const forgotForm = document.getElementById("forgot-form");
  const authHeading = document.getElementById("auth-heading");
  const authSubheading = document.getElementById("auth-subheading");
  const timeoutBanner = document.getElementById("auth-timeout-banner");

  const userIdInput = document.getElementById("login-user-id");
  const passwordInput = document.getElementById("login-password");
  const togglePwBtn = document.getElementById("toggle-login-password");
  const loginError = document.getElementById("login-error");
  const loginSubmitBtn = document.getElementById("btn-login-submit");

  const openForgotBtn = document.getElementById("btn-open-forgot");
  const backToLoginBtn = document.getElementById("btn-back-to-login");
  const forgotEmailInput = document.getElementById("forgot-email");
  const forgotUserIdInput = document.getElementById("forgot-user-id");
  const forgotError = document.getElementById("forgot-error");
  const forgotSuccess = document.getElementById("forgot-success");
  const forgotSubmitBtn = document.getElementById("btn-forgot-submit");
  const demoBox = document.getElementById("demo-logins-box");

  let csrfToken = "";

  const params = new URLSearchParams(window.location.search);
  if (params.get("reason") === "timeout" && timeoutBanner) {
    timeoutBanner.hidden = false;
  }

  async function refreshSession() {
    try {
      const resp = await window.fetch("/api/auth/session", {
        credentials: "same-origin",
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data.csrfToken) csrfToken = data.csrfToken;
      if (demoBox) {
        demoBox.hidden = !data.demoMode;
      }
      if (data.authenticated && data.redirectTo) {
        window.location.replace(data.redirectTo);
        return data;
      }
      return data;
    } catch (_err) {
      return null;
    }
  }

  await refreshSession();

  function setLoginError(msg) {
    if (!msg) {
      loginError.hidden = true;
      loginError.textContent = "";
      return;
    }
    loginError.hidden = false;
    loginError.textContent = msg;
  }

  function setForgotFeedback(errMsg, okMsg) {
    forgotError.hidden = !errMsg;
    forgotError.textContent = errMsg || "";
    forgotSuccess.hidden = !okMsg;
    forgotSuccess.textContent = okMsg || "";
  }

  // Show/hide password toggle
  if (togglePwBtn && passwordInput) {
    togglePwBtn.addEventListener("click", () => {
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      togglePwBtn.textContent = showing ? "Show" : "Hide";
      togglePwBtn.setAttribute("aria-pressed", String(!showing));
      togglePwBtn.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password"
      );
    });
  }

  // Switch between Sign In and Forgot Password views
  if (openForgotBtn) {
    openForgotBtn.addEventListener("click", () => {
      loginForm.hidden = true;
      forgotForm.hidden = false;
      authHeading.textContent = "Reset your password";
      authSubheading.textContent =
        "Enter your registered work email to receive a 15-minute temporary password.";
      setLoginError("");
      setForgotFeedback("", "");
      forgotEmailInput.focus();
    });
  }

  if (backToLoginBtn) {
    backToLoginBtn.addEventListener("click", () => {
      forgotForm.hidden = true;
      loginForm.hidden = false;
      authHeading.textContent = "Sign in to your account";
      authSubheading.textContent =
        "Enter your Employee, Manager, or HR ID and password to continue.";
      setForgotFeedback("", "");
      userIdInput.focus();
    });
  }

  // Demo quick-fill buttons (only visible in DEMO_MODE=1)
  if (demoBox) {
    demoBox.querySelectorAll("[data-demo-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        forgotForm.hidden = true;
        loginForm.hidden = false;
        userIdInput.value = btn.getAttribute("data-demo-id") || "";
        passwordInput.value = btn.getAttribute("data-demo-pw") || "";
        setLoginError("");
        loginSubmitBtn.focus();
      });
    });
  }

  // Sign-In submit
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const userId = userIdInput.value.trim();
    const password = passwordInput.value;

    if (!userId || !password) {
      setLoginError("Please enter both your User ID and password.");
      return;
    }

    if (!csrfToken) {
      await refreshSession();
    }

    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = "Signing in...";
    setLoginError("");

    try {
      const resp = await window.fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ userId, password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setLoginError(data.error || "Sign in failed. Please try again.");
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = "Sign In →";
        return;
      }

      if (data.csrfToken) csrfToken = data.csrfToken;
      window.location.href = data.redirectTo || "index.html";
    } catch (_err) {
      setLoginError("Unable to reach the server. Please check your connection.");
      loginSubmitBtn.disabled = false;
      loginSubmitBtn.textContent = "Sign In →";
    }
  });

  // Forgot Password submit
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = forgotEmailInput.value.trim();
    const userId = forgotUserIdInput.value.trim();

    if (!email || !email.includes("@")) {
      setForgotFeedback("Please enter a valid registered email address.", "");
      forgotEmailInput.focus();
      return;
    }

    if (!csrfToken) {
      await refreshSession();
    }

    forgotSubmitBtn.disabled = true;
    forgotSubmitBtn.textContent = "Sending...";
    setForgotFeedback("", "");

    try {
      const resp = await window.fetch("/api/forgot-password", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ email, userId: userId || undefined }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setForgotFeedback(
          data.error || "Could not process reset request. Please try again.",
          ""
        );
      } else {
        setForgotFeedback(
          "",
          data.message ||
            "If this email is registered, a reset password has been sent."
        );
      }
    } catch (_err) {
      setForgotFeedback("Unable to reach the server. Please try again.", "");
    } finally {
      forgotSubmitBtn.disabled = false;
      forgotSubmitBtn.textContent = "Send Reset Password";
    }
  });
})();
