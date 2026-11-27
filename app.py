"""Flask backend for SkillSync AI with SQLite auth, RBAC, CSRF, and AI endpoints."""

from __future__ import annotations

import json
import os
import re
import secrets
import string
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import requests
from flask import (
    Flask,
    abort,
    g,
    jsonify,
    redirect,
    request,
    send_from_directory,
    session,
)
from werkzeug.security import check_password_hash, generate_password_hash

import db
import mailer

BASE_DIR = Path(__file__).resolve().parent
QUESTIONS_JS_PATH = BASE_DIR / "js" / "questions.js"
INACTIVITY_TIMEOUT_SECONDS = 30 * 60

PAGE_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/profile": "index.html",
    "/analyzer": "analyzer.html",
    "/analyzer.html": "analyzer.html",
    "/courses": "courses.html",
    "/courses.html": "courses.html",
    "/quiz": "quiz.html",
    "/quiz.html": "quiz.html",
    "/dashboard": "dashboard.html",
    "/dashboard.html": "dashboard.html",
    "/change-password": "change-password.html",
    "/change-password.html": "change-password.html",
}

PUBLIC_PAGE_FILES = {
    "/login": "login.html",
    "/login.html": "login.html",
    "/tests.html": "tests.html",
}


def utc_now_iso() -> str:
    """Return an ISO-8601 UTC timestamp string."""
    return db.utc_now_iso()


def load_offline_question_bank() -> dict[str, list[dict[str, Any]]]:
    """Parse the canonical offline JSON question bank embedded in js/questions.js."""
    try:
        content = QUESTIONS_JS_PATH.read_text(encoding="utf-8")
        match = re.search(
            r"/\* QUESTION_BANK_JSON_START \*/\s*const QUESTION_BANK = (\{.*?\});\s*/\* QUESTION_BANK_JSON_END \*/",
            content,
            re.DOTALL,
        )
        if match:
            parsed = json.loads(match.group(1))
            if isinstance(parsed, dict):
                return parsed
    except Exception:
        pass
    return {}


OFFLINE_QUESTION_BANK = load_offline_question_bank()


def validate_quiz_questions(raw_questions: Any) -> list[dict[str, Any]] | None:
    """Validate strictly that quiz output has 5 MCQs (3 easy then 2 hard, 4 options each)."""
    if not isinstance(raw_questions, list) or len(raw_questions) != 5:
        return None

    validated: list[dict[str, Any]] = []
    for idx, q in enumerate(raw_questions):
        if not isinstance(q, dict):
            return None
        expected_diff = "easy" if idx < 3 else "hard"
        diff = str(q.get("difficulty") or "").strip().lower()
        if diff != expected_diff:
            return None

        question_text = str(q.get("question") or "").strip()
        explanation = str(q.get("explanation") or "").strip()
        options = q.get("options")
        correct_idx = q.get("correctAnswer")

        if (
            not question_text
            or not explanation
            or not isinstance(options, list)
            or len(options) != 4
            or any(not str(opt).strip() for opt in options)
            or isinstance(correct_idx, bool)
            or not isinstance(correct_idx, int)
            or not (0 <= correct_idx < 4)
        ):
            return None

        validated.append(
            {
                "id": str(q.get("id") or f"ai_q{idx + 1}"),
                "difficulty": expected_diff,
                "question": question_text,
                "options": [str(opt).strip() for opt in options],
                "correctAnswer": correct_idx,
                "explanation": explanation,
            }
        )

    return validated


def build_fallback_explanations(payload: dict[str, Any]) -> dict[str, Any]:
    """Generate deterministic, explainable course rationales when no AI API is used."""
    role_name = str(payload.get("roleName") or "your target role")
    priority = str(payload.get("companyPriority") or "").strip()
    user_type = str(payload.get("userType") or "employee").strip().lower()
    previous_field = str(payload.get("previousField") or "").strip()
    cert_bonus_on = bool(payload.get("certRankingBonus"))
    non_tech_note = ""
    if user_type == "other":
        if previous_field:
            non_tech_note = (
                f" Since you are moving from {previous_field} (a non-tech background), "
                "this starts from fundamentals."
            )
        else:
            non_tech_note = (
                " Since you are moving from a non-tech background, "
                "this starts from fundamentals."
            )
    courses = payload.get("courses") or []

    explanations: dict[str, str] = {}
    for item in courses:
        if not isinstance(item, dict):
            continue
        course_id = str(item.get("courseId") or "")
        if not course_id:
            continue
        skill_name = str(item.get("skillName") or "this skill")
        current_pct = int(item.get("currentPct") or 0)
        target_pct = int(item.get("targetPct") or 80)
        is_priority = bool(item.get("isPriorityMatch"))
        has_cert = bool(item.get("hasCertification"))
        cert_name = str(item.get("certificationName") or "").strip()
        cert_note = ""
        if has_cert and cert_name:
            cert_note = (
                f" Includes {cert_name} (boosted by certification ranking bonus)."
                if cert_bonus_on
                else f" Includes {cert_name}."
            )

        if current_pct >= target_pct:
            explanations[course_id] = (
                f"Optional refresher: your {skill_name} score is already {current_pct}% "
                f"(meets the {target_pct}% target for {role_name}).{cert_note}"
            )
        elif is_priority and priority:
            explanations[course_id] = (
                f"Recommended because your {skill_name} score is {current_pct}% "
                f"(target {target_pct}%) and {priority} is a current company priority.{non_tech_note}{cert_note}"
            )
        else:
            gap = max(0, target_pct - current_pct)
            explanations[course_id] = (
                f"Recommended because your {skill_name} score is {current_pct}% "
                f"(target {target_pct}%), closing a {gap}% gap required for {role_name}.{non_tech_note}{cert_note}"
            )

    return {
        "source": "fallback",
        "explanations": explanations,
        "generatedAt": utc_now_iso(),
    }


def try_gemini_explanations(
    payload: dict[str, Any], api_key: str
) -> dict[str, Any] | None:
    """Call Gemini REST API using env-provided key; return None on any failure."""
    courses = payload.get("courses") or []
    if not courses:
        return None

    role_name = str(payload.get("roleName") or "Target Role")
    priority = str(payload.get("companyPriority") or "General upskilling")
    user_type = str(payload.get("userType") or "employee").strip().lower()
    previous_field = str(payload.get("previousField") or "").strip()
    background_hint = ""
    if user_type == "other":
        origin = previous_field or "a non-tech field"
        background_hint = (
            f" The learner is a new joiner or career switcher moving from {origin}, "
            "so mention starting from fundamentals."
        )
    compact_courses = [
        {
            "courseId": c.get("courseId"),
            "title": c.get("title"),
            "skillName": c.get("skillName"),
            "currentPct": c.get("currentPct"),
            "targetPct": c.get("targetPct"),
            "isPriorityMatch": c.get("isPriorityMatch"),
        }
        for c in courses[:15]
        if isinstance(c, dict) and c.get("courseId")
    ]

    prompt = (
        "You are SkillSync AI, a corporate upskilling advisor. "
        f"Target role: {role_name}. Company priority: {priority}.{background_hint} "
        "For each course below, write ONE concise, clear sentence explaining why it is recommended, "
        "explicitly mentioning the learner's current % vs target % and company priority if relevant. "
        "Return ONLY valid JSON mapping courseId -> explanation string.\n"
        f"Courses: {json.dumps(compact_courses)}"
    )

    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={api_key}"
    )

    try:
        resp = requests.post(
            endpoint,
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json"},
            },
            timeout=5,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            return None
        clean = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
        if not clean:
            return None
        return {
            "source": "ai",
            "explanations": clean,
            "generatedAt": utc_now_iso(),
        }
    except Exception:
        return None


def try_gemini_quiz(
    skill_id: str, skill_name: str, api_key: str
) -> list[dict[str, Any]] | None:
    """Generate 3 easy + 2 hard diagnostic MCQs via Gemini; validate strictly."""
    prompt = (
        f"Create a 5-question multiple-choice technical diagnostic quiz for the skill '{skill_name}' "
        f"(skillId '{skill_id}').\n"
        "Requirements:\n"
        "- Exactly 5 questions: first 3 must have difficulty 'easy' (definitions and basic usage), "
        "last 2 must have difficulty 'hard' (scenario-based or tricky real-world edge cases).\n"
        "- Each question must have exactly 4 distinct options, a valid integer correctAnswer (0-3), "
        "and a concise 1-line explanation.\n"
        "- Return ONLY a valid JSON object: {\"questions\": [{\"id\": \"...\", \"difficulty\": \"easy|hard\", "
        "\"question\": \"...\", \"options\": [\"...\",\"...\",\"...\",\"...\"], \"correctAnswer\": 0, \"explanation\": \"...\"}]}"
    )

    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={api_key}"
    )

    try:
        resp = requests.post(
            endpoint,
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json"},
            },
            timeout=6,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )
        parsed = json.loads(text)
        raw_questions = parsed.get("questions") if isinstance(parsed, dict) else parsed
        return validate_quiz_questions(raw_questions)
    except Exception:
        return None


def generate_temp_password(length: int = 10) -> str:
    """Generate a cryptographically random 10-character alphanumeric password."""
    letters = string.ascii_letters
    digits = string.digits
    alphabet = letters + digits
    chars = [secrets.choice(letters), secrets.choice(digits)] + [
        secrets.choice(alphabet) for _ in range(max(0, length - 2))
    ]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def validate_new_password(new_password: str, user_id: str) -> str | None:
    """Enforce password policy: >=8 chars, >=1 letter, >=1 number, not '1234', not user ID."""
    if not isinstance(new_password, str) or len(new_password) < 8:
        return "New password must be at least 8 characters long."
    if not re.search(r"[A-Za-z]", new_password):
        return "New password must contain at least 1 letter."
    if not re.search(r"\d", new_password):
        return "New password must contain at least 1 number."
    if new_password.strip() == "1234":
        return "New password cannot be 1234."
    if new_password.strip().lower() == user_id.strip().lower():
        return "New password cannot be the same as your User ID."
    return None


def _safe_json_loads(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback


def _serialize_notification_row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "type": row["type"],
        "audience": row["audience"],
        "notifyHR": bool(row["notify_hr"]),
        "employeeId": row["employee_id"],
        "employeeName": row["employee_name"] or "",
        "managerId": row["manager_id"],
        "senderRole": row["sender_role"],
        "courseId": row["course_id"],
        "courseTitle": row["course_title"],
        "certificationName": row["certification_name"],
        "completedOn": row["completed_on"],
        "message": row["message"],
        "createdAt": row["created_at"],
        "read": bool(row["read"]),
    }


def _determine_login_redirect(conn: Any, user_row: Any) -> str:
    if int(user_row["force_password_change"]):
        return "change-password.html"
    if user_row["role"] in ("manager", "hr"):
        return "dashboard.html"
    emp_data = conn.execute(
        "SELECT profile_json, gate_json FROM employee_data WHERE user_id = ?",
        (user_row["id"],),
    ).fetchone()
    profile = _safe_json_loads(emp_data["profile_json"] if emp_data else None, None)
    gate = _safe_json_loads(
        emp_data["gate_json"] if emp_data else None,
        {"required": [], "completed": [], "cleared": False},
    )
    if not profile:
        return "index.html"
    if gate.get("cleared"):
        return "analyzer.html"
    return "quiz.html"


def _build_employee_state_payload(conn: Any, user_row: Any) -> dict[str, Any]:
    emp_id = user_row["id"]
    data_row = conn.execute(
        "SELECT * FROM employee_data WHERE user_id = ?", (emp_id,)
    ).fetchone()
    settings = db.get_org_settings(conn)

    profile = _safe_json_loads(data_row["profile_json"] if data_row else None, None)
    course_progress = _safe_json_loads(
        data_row["course_progress_json"] if data_row else None, {}
    )
    certs = _safe_json_loads(
        data_row["certifications_json"] if data_row else None, []
    )
    test_results = _safe_json_loads(
        data_row["test_results_json"] if data_row else None, {}
    )
    verified_levels = _safe_json_loads(
        data_row["verified_levels_json"] if data_row else None, {}
    )
    gate = _safe_json_loads(
        data_row["gate_json"] if data_row else None,
        {"required": [], "completed": [], "cleared": False, "clearedAt": None},
    )
    in_progress = _safe_json_loads(
        data_row["in_progress_json"] if data_row else None, None
    )
    replan_history = _safe_json_loads(
        data_row["replan_history_json"] if data_row else None, []
    )

    notif_rows = conn.execute(
        """
        SELECT * FROM notifications
        WHERE employee_id = ? AND audience = 'employee'
        ORDER BY created_at DESC LIMIT 50
        """,
        (emp_id,),
    ).fetchall()

    return {
        "schemaVersion": 4,
        "activeRole": user_row["role"],
        "currentEmployeeId": emp_id,
        "anonymiseHR": bool(settings.get("anonymiseHR", True)),
        "certRankingBonus": bool(settings.get("certRankingBonus", False)),
        "hrCertNotifications": bool(settings.get("hrCertNotifications", True)),
        "profile": profile,
        "courseProgress": course_progress,
        "certifications": {emp_id: certs},
        "testResults": {emp_id: test_results},
        "verifiedLevels": {emp_id: verified_levels},
        "notifications": [_serialize_notification_row(r) for r in notif_rows],
        "nudges": [],
        "agentActivityLog": [],
        "priorities": settings.get("priorities", []),
        "replanHistory": replan_history,
        "updatedAt": data_row["updated_at"] if data_row else None,
        "gate": gate,
        "inProgress": in_progress,
    }


def _recompute_gate_from_profile(
    profile: dict[str, Any] | None, prev_gate: dict[str, Any] | None
) -> dict[str, Any]:
    new_selected = (
        list(profile.get("selectedSkills") or []) if isinstance(profile, dict) else []
    )
    prev_completed = (
        list(prev_gate.get("completed") or []) if isinstance(prev_gate, dict) else []
    )
    new_completed = [s for s in prev_completed if s in new_selected]
    if new_selected:
        is_cleared = all(s in new_completed for s in new_selected)
    else:
        is_cleared = bool(
            isinstance(profile, dict) and isinstance(profile.get("selectedSkills"), list)
        )
    return {
        "required": new_selected,
        "completed": new_completed,
        "cleared": is_cleared,
        "clearedAt": (
            (prev_gate or {}).get("clearedAt") or utc_now_iso() if is_cleared else None
        ),
    }


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    """Create and configure the Flask application with SQLite auth & RBAC."""
    app = Flask(__name__, static_folder=None)

    secret_key = os.environ.get("SECRET_KEY", "").strip()
    if not secret_key:
        secret_key = secrets.token_hex(32)

    app.config.update(
        SECRET_KEY=secret_key,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
        DATABASE=str(db.get_db_path()),
        OUTBOX_PATH=str(mailer.get_outbox_path()),
    )
    if test_config:
        app.config.update(test_config)

    db.init_db(app.config["DATABASE"])

    def is_demo_mode() -> bool:
        if "DEMO_MODE" in app.config:
            val = app.config["DEMO_MODE"]
            return val is True or str(val).strip() == "1"
        return os.environ.get("DEMO_MODE", "0").strip() == "1"

    def get_db() -> Any:
        if "db_conn" not in g:
            g.db_conn = db.get_connection(app.config["DATABASE"])
        return g.db_conn

    @app.teardown_appcontext
    def close_db(_exc: Any) -> None:
        conn = g.pop("db_conn", None)
        if conn is not None:
            conn.close()

    def ensure_csrf_token() -> str:
        token = session.get("csrf_token")
        if not token or not isinstance(token, str):
            token = secrets.token_urlsafe(32)
            session["csrf_token"] = token
        return token

    def verify_csrf() -> bool:
        expected = session.get("csrf_token")
        provided = request.headers.get("X-CSRF-Token", "")
        if not expected or not provided:
            return False
        return secrets.compare_digest(str(expected), str(provided))

    def can_manage_employee(actor: Any, target_user: Any) -> bool:
        if actor["role"] == "hr":
            return True
        if actor["role"] == "manager":
            return target_user["manager_id"] == actor["id"]
        return False

    @app.before_request
    def load_session_and_enforce_security() -> Any:
        g.current_user = None
        g.session_expired = False

        if request.path.startswith("/css/") or request.path.startswith("/js/"):
            return None
        if request.path == "/api/health":
            return None

        user_id = session.get("user_id")
        if user_id:
            last_act = session.get("last_activity")
            now_ts = time.time()
            if last_act is None or (now_ts - float(last_act)) > INACTIVITY_TIMEOUT_SECONDS:
                session.clear()
                g.session_expired = True
            else:
                conn = get_db()
                user_row = conn.execute(
                    "SELECT * FROM users WHERE id = ?", (user_id,)
                ).fetchone()
                if (
                    user_row is None
                    or not int(user_row["active"])
                    or (int(user_row["is_demo"]) and not is_demo_mode())
                ):
                    session.clear()
                else:
                    g.current_user = user_row
                    session["last_activity"] = now_ts

        # Enforce CSRF on all API POST endpoints
        if request.method == "POST" and request.path.startswith("/api/"):
            if not verify_csrf():
                return jsonify({"error": "Invalid or missing CSRF token"}), 403

        return None

    def require_auth(allow_force_pw_change: bool = False) -> tuple[Any, int] | None:
        if g.current_user is None:
            msg = (
                "Session expired due to inactivity. Please log in again."
                if g.session_expired
                else "Authentication required."
            )
            return jsonify({"error": msg, "sessionExpired": g.session_expired}), 401
        if not allow_force_pw_change and int(g.current_user["force_password_change"]):
            return (
                jsonify(
                    {
                        "error": "You must set a new password before continuing.",
                        "forcePasswordChange": True,
                    }
                ),
                403,
            )
        return None

    def require_manager_or_hr() -> tuple[Any, int] | None:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err
        if g.current_user["role"] not in ("manager", "hr"):
            return jsonify({"error": "Forbidden: Manager or HR role required"}), 403
        return None

    # ── Health & Auth Endpoints ────────────────────────────────────────────────
    @app.get("/api/health")
    def health() -> Any:
        return jsonify({"status": "ok", "timestamp": utc_now_iso()})

    @app.get("/api/auth/session")
    def auth_session() -> Any:
        token = ensure_csrf_token()
        user_payload = (
            db.serialize_user_public(g.current_user) if g.current_user else None
        )
        redirect_to = (
            _determine_login_redirect(get_db(), g.current_user)
            if g.current_user
            else None
        )
        return jsonify(
            {
                "authenticated": g.current_user is not None,
                "sessionExpired": g.session_expired,
                "csrfToken": token,
                "demoMode": is_demo_mode(),
                "user": user_payload,
                "redirectTo": redirect_to,
            }
        )

    @app.post("/api/login")
    def login() -> Any:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        raw_id = str(payload.get("userId") or "").strip().upper()
        password = str(payload.get("password") or "")
        if not raw_id or not password:
            return jsonify({"error": "User ID and password are required."}), 400

        conn = get_db()
        user = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (raw_id,)
        ).fetchone()

        if user is None or (int(user["is_demo"]) and not is_demo_mode()):
            return jsonify({"error": "Invalid ID or password"}), 401

        if not int(user["active"]):
            return (
                jsonify(
                    {
                        "error": "This account has been deactivated. Contact your manager or HR."
                    }
                ),
                403,
            )

        now_iso = utc_now_iso()
        locked_until = user["locked_until"]
        if locked_until and locked_until > now_iso:
            return (
                jsonify(
                    {
                        "error": "Account locked for 10 minutes due to too many failed login attempts. Please try again later.",
                        "locked": True,
                        "lockedUntil": locked_until,
                    }
                ),
                423,
            )

        reset_hash = user["reset_password_hash"]
        reset_expires = user["reset_expires"]
        used_temp_password = False

        if reset_hash and check_password_hash(reset_hash, password):
            if not reset_expires or reset_expires <= now_iso:
                conn.execute(
                    "UPDATE users SET reset_password_hash = NULL, reset_expires = NULL WHERE id = ?",
                    (user["id"],),
                )
                conn.commit()
                return (
                    jsonify(
                        {
                            "error": "Temporary password has expired. Please request a new password reset."
                        }
                    ),
                    401,
                )
            used_temp_password = True
        elif not check_password_hash(user["password_hash"], password):
            failed = int(user["failed_attempts"] or 0) + 1
            if failed >= 5:
                lock_until = (db.utc_now() + timedelta(minutes=10)).isoformat()
                conn.execute(
                    "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
                    (failed, lock_until, user["id"]),
                )
                conn.commit()
                return (
                    jsonify(
                        {
                            "error": "Account locked for 10 minutes due to too many failed login attempts. Please try again later.",
                            "locked": True,
                            "lockedUntil": lock_until,
                        }
                    ),
                    423,
                )
            conn.execute(
                "UPDATE users SET failed_attempts = ? WHERE id = ?",
                (failed, user["id"]),
            )
            conn.commit()
            return jsonify({"error": "Invalid ID or password"}), 401

        # Successful login
        if used_temp_password:
            conn.execute(
                """
                UPDATE users
                SET failed_attempts = 0, locked_until = NULL, last_login = ?,
                    reset_password_hash = NULL, reset_expires = NULL,
                    must_change_password = 1, force_password_change = 1
                WHERE id = ?
                """,
                (now_iso, user["id"]),
            )
            session["temp_pw_hash"] = generate_password_hash(password)
        else:
            conn.execute(
                """
                UPDATE users
                SET failed_attempts = 0, locked_until = NULL, last_login = ?
                WHERE id = ?
                """,
                (now_iso, user["id"]),
            )
            session.pop("temp_pw_hash", None)

        conn.commit()
        updated_user = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user["id"],)
        ).fetchone()

        session.permanent = True
        session["user_id"] = updated_user["id"]
        session["last_activity"] = time.time()
        ensure_csrf_token()

        redirect_to = _determine_login_redirect(conn, updated_user)
        return jsonify(
            {
                "user": db.serialize_user_public(updated_user),
                "redirectTo": redirect_to,
                "csrfToken": session["csrf_token"],
            }
        )

    @app.post("/api/logout")
    def logout() -> Any:
        session.clear()
        new_csrf = ensure_csrf_token()
        return jsonify({"ok": True, "csrfToken": new_csrf})

    @app.post("/api/change-password")
    def change_password() -> Any:
        auth_err = require_auth(allow_force_pw_change=True)
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        current_pw = str(payload.get("currentPassword") or "")
        new_pw = str(payload.get("newPassword") or "")
        confirm_pw = str(payload.get("confirmPassword") or "")

        user = g.current_user
        temp_pw_hash = session.get("temp_pw_hash")
        current_matches = False
        if int(user["force_password_change"]) and temp_pw_hash:
            current_matches = check_password_hash(temp_pw_hash, current_pw)
        if not current_matches:
            current_matches = check_password_hash(user["password_hash"], current_pw)

        if not current_matches:
            return jsonify({"error": "Current password is incorrect."}), 400

        if new_pw != confirm_pw:
            return jsonify({"error": "New password and confirmation do not match."}), 400

        policy_err = validate_new_password(new_pw, user["id"])
        if policy_err:
            return jsonify({"error": policy_err}), 400

        conn = get_db()
        now_iso = utc_now_iso()
        first_activation = (
            user["role"] == "employee"
            and bool(user["manager_id"])
            and not user["activated_at"]
        )

        conn.execute(
            """
            UPDATE users
            SET password_hash = ?,
                must_change_password = 0,
                force_password_change = 0,
                reset_password_hash = NULL,
                reset_expires = NULL,
                activated_at = COALESCE(activated_at, ?)
            WHERE id = ?
            """,
            (generate_password_hash(new_pw), now_iso, user["id"]),
        )
        session.pop("temp_pw_hash", None)

        if first_activation:
            msg = f"{user['id']} activated their account."
            db.add_notification(
                conn,
                notif_type="account_activated",
                audience="manager",
                message=msg,
                employee_id=user["id"],
                employee_name=user["name"],
                manager_id=user["manager_id"],
                notify_hr=True,
            )
            db.add_activity_log(
                conn,
                tool="Notify Tool",
                manager_id=user["manager_id"],
                employee_id=user["id"],
                message=f"[Notify Tool] {msg}",
            )

        conn.commit()
        updated_user = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        return jsonify(
            {
                "ok": True,
                "user": db.serialize_user_public(updated_user),
                "redirectTo": _determine_login_redirect(conn, updated_user),
            }
        )

    @app.post("/api/forgot-password")
    def forgot_password() -> Any:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        email = str(payload.get("email") or "").strip().lower()
        user_id_hint = str(payload.get("userId") or "").strip().upper()
        if not email or "@" not in email:
            return jsonify({"error": "Please enter a valid email address."}), 400

        conn = get_db()
        ip_addr = request.remote_addr or "127.0.0.1"
        if not db.check_and_record_reset_rate_limit(conn, email, ip_addr):
            conn.commit()
            return jsonify({"error": "Too many attempts, try again later"}), 429

        user = conn.execute(
            "SELECT * FROM users WHERE LOWER(email) = ?", (email,)
        ).fetchone()

        neutral_msg = "If this email is registered, a reset password has been sent."

        if (
            user is not None
            and int(user["active"])
            and (not user_id_hint or user["id"].upper() == user_id_hint)
            and not (int(user["is_demo"]) and not is_demo_mode())
        ):
            temp_pw = generate_temp_password(10)
            expires_at = (db.utc_now() + timedelta(minutes=15)).isoformat()
            conn.execute(
                """
                UPDATE users
                SET reset_password_hash = ?, reset_expires = ?, must_change_password = 1
                WHERE id = ?
                """,
                (generate_password_hash(temp_pw), expires_at, user["id"]),
            )
            subject, body = mailer.build_reset_password_email(
                name=user["name"],
                user_id=user["id"],
                temp_password=temp_pw,
                expiry_minutes=15,
                login_url=f"{request.host_url.rstrip('/')}/login.html",
            )
            mail_result = mailer.send_email(
                user["email"], subject, body, outbox_path=app.config["OUTBOX_PATH"]
            )
            db.add_activity_log(
                conn,
                tool="Notify Tool",
                manager_id=user["manager_id"],
                employee_id=user["id"],
                message=mail_result.get("logMessage") or "[Notify Tool] Email sent",
            )

        conn.commit()
        return jsonify({"message": neutral_msg})

    # ── Employee ID Management (Manager & HR) ──────────────────────────────────
    @app.get("/api/employees")
    def list_employees() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        conn = get_db()
        actor = g.current_user
        if actor["role"] == "hr":
            rows = conn.execute(
                "SELECT * FROM users ORDER BY id ASC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM users WHERE manager_id = ? ORDER BY id ASC",
                (actor["id"],),
            ).fetchall()

        return jsonify({"employees": [db.serialize_user_public(r) for r in rows]})

    @app.post("/api/employees")
    def create_employee() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        name = str(payload.get("name") or "").strip()
        email = str(payload.get("email") or "").strip().lower()
        designation = str(payload.get("designation") or "").strip()
        target_role = str(payload.get("targetRole") or "junior_data_analyst").strip()
        user_type = str(payload.get("userType") or "employee").strip().lower()
        previous_field = str(payload.get("previousField") or "").strip()

        if not name:
            return jsonify({"error": "Employee name is required."}), 400
        if not email or "@" not in email:
            return jsonify({"error": "A valid work email is required."}), 400
        if user_type not in ("employee", "other"):
            return jsonify({"error": "Employee type must be 'employee' or 'other'."}), 400

        conn = get_db()
        existing = conn.execute(
            "SELECT id FROM users WHERE LOWER(email) = ?", (email,)
        ).fetchone()
        if existing:
            return jsonify({"error": "An account with this email already exists."}), 409

        actor = g.current_user
        manager_id = (
            actor["id"]
            if actor["role"] == "manager"
            else str(payload.get("managerId") or "MGR-2001").strip().upper()
        )
        team_name = actor["team"] if actor["role"] == "manager" else "Analytics & BI"
        if actor["role"] == "hr":
            mgr_row = conn.execute(
                "SELECT id, team FROM users WHERE id = ? AND role = 'manager'",
                (manager_id,),
            ).fetchone()
            if not mgr_row:
                mgr_row = conn.execute(
                    "SELECT id, team FROM users WHERE role = 'manager' ORDER BY id ASC LIMIT 1"
                ).fetchone()
            if mgr_row:
                manager_id = mgr_row["id"]
                team_name = mgr_row["team"]

        new_id = db.generate_next_user_id(conn, "employee")
        default_pw = "1234"
        now_iso = utc_now_iso()

        conn.execute(
            """
            INSERT INTO users (
                id, name, email, role, designation, team, user_type, previous_field,
                manager_id, password_hash, must_change_password, force_password_change,
                active, is_demo, created_at, last_login, activated_at
            ) VALUES (?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?, 1, 0, 1, 0, ?, NULL, NULL)
            """,
            (
                new_id,
                name,
                email,
                designation or "Junior Data Analyst",
                team_name,
                user_type,
                previous_field if user_type == "other" else "",
                manager_id,
                generate_password_hash(default_pw),
                now_iso,
            ),
        )

        # Initialize empty/starter employee_data row
        conn.execute(
            """
            INSERT INTO employee_data (
                user_id, profile_json, course_progress_json, certifications_json,
                test_results_json, verified_levels_json, gate_json, in_progress_json,
                replan_history_json, levels_gained, updated_at
            ) VALUES (?, NULL, '{}', '[]', '{}', '{}', ?, NULL, '[]', 0, ?)
            """,
            (
                new_id,
                json.dumps({"required": [], "completed": [], "cleared": False, "clearedAt": None}),
                now_iso,
            ),
        )

        # Also store targetRole/designation hint if provided? Leaving profile_json NULL ensures
        # the new joiner goes through Profile Setup -> Diagnostic Gate cleanly on first login,
        # while dashboard falls back to designation/targetRole cleanly.
        conn.commit()

        created_row = conn.execute(
            "SELECT * FROM users WHERE id = ?", (new_id,)
        ).fetchone()
        return (
            jsonify(
                {
                    "employee": db.serialize_user_public(created_row),
                    "defaultPassword": default_pw,
                    "targetRole": target_role,
                }
            ),
            201,
        )

    @app.post("/api/employees/<emp_id>/send-login-email")
    def send_login_email(emp_id: str) -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        conn = get_db()
        target = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (emp_id.strip().upper(),)
        ).fetchone()
        if not target:
            return jsonify({"error": "Employee not found"}), 404
        if not can_manage_employee(g.current_user, target):
            return jsonify({"error": "Forbidden"}), 403

        default_pw_note = (
            "1234"
            if int(target["must_change_password"]) and not int(target["force_password_change"])
            else "(Use your current password or request Forgot Password)"
        )
        subject, body = mailer.build_new_account_email(
            name=target["name"],
            user_id=target["id"],
            default_password=default_pw_note,
            login_url=f"{request.host_url.rstrip('/')}/login.html",
        )
        result = mailer.send_email(
            target["email"], subject, body, outbox_path=app.config["OUTBOX_PATH"]
        )
        db.add_activity_log(
            conn,
            tool="Notify Tool",
            manager_id=target["manager_id"],
            employee_id=target["id"],
            message=result.get("logMessage") or "[Notify Tool] Email sent",
        )
        conn.commit()
        return jsonify(
            {
                "ok": True,
                "transport": result["transport"],
                "message": f"Login details sent to {target['email']} ({result['transport']}).",
            }
        )

    @app.post("/api/employees/<emp_id>/deactivate")
    def toggle_employee_active(emp_id: str) -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        conn = get_db()
        target = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (emp_id.strip().upper(),)
        ).fetchone()
        if not target:
            return jsonify({"error": "Employee not found"}), 404
        if not can_manage_employee(g.current_user, target):
            return jsonify({"error": "Forbidden"}), 403
        if target["id"] == g.current_user["id"]:
            return jsonify({"error": "You cannot deactivate your own account."}), 400

        payload = request.get_json(silent=True) or {}
        if "active" in payload:
            next_active = 1 if bool(payload["active"]) else 0
        else:
            next_active = 0 if int(target["active"]) else 1

        conn.execute(
            "UPDATE users SET active = ? WHERE id = ?", (next_active, target["id"])
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM users WHERE id = ?", (target["id"],)
        ).fetchone()
        return jsonify({"ok": True, "employee": db.serialize_user_public(updated)})

    @app.post("/api/employees/<emp_id>/reset-password")
    def manager_reset_employee_password(emp_id: str) -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        conn = get_db()
        target = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (emp_id.strip().upper(),)
        ).fetchone()
        if not target:
            return jsonify({"error": "Employee not found"}), 404
        if not can_manage_employee(g.current_user, target):
            return jsonify({"error": "Forbidden"}), 403

        temp_pw = generate_temp_password(10)
        expires_at = (db.utc_now() + timedelta(minutes=15)).isoformat()
        conn.execute(
            """
            UPDATE users
            SET reset_password_hash = ?, reset_expires = ?, must_change_password = 1
            WHERE id = ?
            """,
            (generate_password_hash(temp_pw), expires_at, target["id"]),
        )
        subject, body = mailer.build_reset_password_email(
            name=target["name"],
            user_id=target["id"],
            temp_password=temp_pw,
            expiry_minutes=15,
            login_url=f"{request.host_url.rstrip('/')}/login.html",
        )
        mail_result = mailer.send_email(
            target["email"], subject, body, outbox_path=app.config["OUTBOX_PATH"]
        )
        db.add_activity_log(
            conn,
            tool="Notify Tool",
            manager_id=target["manager_id"],
            employee_id=target["id"],
            message=mail_result.get("logMessage") or "[Notify Tool] Email sent",
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM users WHERE id = ?", (target["id"],)
        ).fetchone()
        return jsonify(
            {
                "ok": True,
                "transport": mail_result["transport"],
                "employee": db.serialize_user_public(updated),
                "message": f"Temporary reset password emailed to {target['email']}.",
            }
        )

    # ── Scoped Employee Data Route (Authorization Verification) ───────────────
    @app.get("/api/employees/<emp_id>/data")
    def get_employee_data(emp_id: str) -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        conn = get_db()
        actor = g.current_user
        target = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (emp_id.strip().upper(),)
        ).fetchone()
        if not target:
            return jsonify({"error": "Employee not found"}), 404

        if actor["role"] == "employee":
            if actor["id"] != target["id"]:
                return jsonify({"error": "Forbidden"}), 403
        elif actor["role"] == "manager":
            if actor["id"] != target["id"] and target["manager_id"] != actor["id"]:
                return jsonify({"error": "Forbidden"}), 403

        return jsonify(
            {
                "user": db.serialize_user_public(target),
                "state": _build_employee_state_payload(conn, target),
            }
        )

    # ── Current User Learning State Endpoints ──────────────────────────────────
    @app.get("/api/me/state")
    def get_my_state() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err
        conn = get_db()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    @app.post("/api/me/profile")
    def save_my_profile() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("profile"), dict):
            return jsonify({"error": "Profile payload is required"}), 400

        profile = dict(payload["profile"])
        user_type = profile.get("userType", profile.get("status", "employee"))
        if user_type not in ("employee", "other"):
            return jsonify({"error": "Invalid user type"}), 400

        profile["userType"] = user_type
        profile["status"] = user_type
        profile["previousField"] = (
            str(profile.get("previousField") or "").strip()
            if user_type == "other"
            else ""
        )

        conn = get_db()
        emp_id = g.current_user["id"]
        data_row = conn.execute(
            "SELECT gate_json, in_progress_json FROM employee_data WHERE user_id = ?",
            (emp_id,),
        ).fetchone()
        prev_gate = _safe_json_loads(data_row["gate_json"] if data_row else None, {})
        prev_in_prog = _safe_json_loads(
            data_row["in_progress_json"] if data_row else None, None
        )
        next_gate = _recompute_gate_from_profile(profile, prev_gate)

        if (
            prev_in_prog
            and prev_in_prog.get("skill")
            and prev_in_prog.get("skill") not in next_gate["required"]
        ):
            prev_in_prog = None

        now_iso = utc_now_iso()
        conn.execute(
            """
            INSERT INTO employee_data (user_id, profile_json, gate_json, in_progress_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                profile_json = excluded.profile_json,
                gate_json = excluded.gate_json,
                in_progress_json = excluded.in_progress_json,
                updated_at = excluded.updated_at
            """,
            (
                emp_id,
                json.dumps(profile),
                json.dumps(next_gate),
                json.dumps(prev_in_prog) if prev_in_prog else None,
                now_iso,
            ),
        )
        conn.commit()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    @app.post("/api/me/course-status")
    def update_my_course_status() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True) or {}
        course_id = str(payload.get("courseId") or "").strip()
        status = str(payload.get("status") or "").strip()
        if not course_id or status not in ("not_started", "in_progress", "completed"):
            return jsonify({"error": "Invalid courseId or status"}), 400

        conn = get_db()
        emp_id = g.current_user["id"]
        row = conn.execute(
            "SELECT course_progress_json FROM employee_data WHERE user_id = ?",
            (emp_id,),
        ).fetchone()
        progress = _safe_json_loads(row["course_progress_json"] if row else None, {})
        if status == "not_started":
            progress.pop(course_id, None)
        else:
            progress[course_id] = status

        conn.execute(
            "UPDATE employee_data SET course_progress_json = ?, updated_at = ? WHERE user_id = ?",
            (json.dumps(progress), utc_now_iso(), emp_id),
        )
        conn.commit()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    @app.post("/api/me/test-attempt")
    def record_my_test_attempt() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True) or {}
        skill_id = str(payload.get("skillId") or "").strip()
        attempt = payload.get("attemptRecord")
        if not skill_id or not isinstance(attempt, dict):
            return jsonify({"error": "skillId and attemptRecord are required"}), 400

        conn = get_db()
        emp_id = g.current_user["id"]
        row = conn.execute(
            "SELECT test_results_json, verified_levels_json, gate_json FROM employee_data WHERE user_id = ?",
            (emp_id,),
        ).fetchone()
        test_results = _safe_json_loads(row["test_results_json"] if row else None, {})
        verified = _safe_json_loads(row["verified_levels_json"] if row else None, {})
        gate = _safe_json_loads(
            row["gate_json"] if row else None,
            {"required": [], "completed": [], "cleared": False, "clearedAt": None},
        )

        attempts_list = list(test_results.get(skill_id) or [])
        attempts_list.append(attempt)
        test_results[skill_id] = attempts_list

        verified[skill_id] = {
            "level": attempt.get("level"),
            "score": attempt.get("score"),
            "easyCorrect": attempt.get("easyCorrect"),
            "hardCorrect": attempt.get("hardCorrect"),
            "verifiedPct": attempt.get("verifiedPct"),
            "updatedAt": attempt.get("date"),
        }

        completed = list(gate.get("completed") or [])
        if skill_id not in completed:
            completed.append(skill_id)
        required = list(gate.get("required") or [])
        cleared = bool(required) and all(s in completed for s in required)
        gate["completed"] = completed
        gate["cleared"] = cleared
        if cleared and not gate.get("clearedAt"):
            gate["clearedAt"] = utc_now_iso()

        conn.execute(
            """
            UPDATE employee_data
            SET test_results_json = ?, verified_levels_json = ?, gate_json = ?,
                in_progress_json = NULL, updated_at = ?
            WHERE user_id = ?
            """,
            (
                json.dumps(test_results),
                json.dumps(verified),
                json.dumps(gate),
                utc_now_iso(),
                emp_id,
            ),
        )
        conn.commit()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    @app.post("/api/me/in-progress")
    def update_my_in_progress() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err
        payload = request.get_json(silent=True) or {}
        in_prog = payload.get("inProgress")
        conn = get_db()
        conn.execute(
            "UPDATE employee_data SET in_progress_json = ?, updated_at = ? WHERE user_id = ?",
            (json.dumps(in_prog) if in_prog else None, utc_now_iso(), g.current_user["id"]),
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.post("/api/me/certification")
    def save_my_certification() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True) or {}
        course_id = str(payload.get("courseId") or "").strip()
        cert_id = str(payload.get("certId") or "").strip()
        cert_name = str(payload.get("certificationName") or course_id).strip()
        course_title = str(payload.get("courseTitle") or course_id).strip()
        completed_on = str(payload.get("completedOn") or utc_now_iso()[:10])[:10]
        notify_mgr = bool(payload.get("notifyManager", True))

        if not course_id or not cert_id:
            return jsonify({"error": "courseId and certId are required"}), 400

        conn = get_db()
        emp = g.current_user
        row = conn.execute(
            "SELECT certifications_json FROM employee_data WHERE user_id = ?",
            (emp["id"],),
        ).fetchone()
        certs = _safe_json_loads(row["certifications_json"] if row else None, [])
        record = {
            "courseId": course_id,
            "certificationName": cert_name,
            "certId": cert_id,
            "completedOn": completed_on,
            "status": "pending_review",
        }
        updated_list = [c for c in certs if c.get("courseId") != course_id]
        updated_list.append(record)

        conn.execute(
            "UPDATE employee_data SET certifications_json = ?, updated_at = ? WHERE user_id = ?",
            (json.dumps(updated_list), utc_now_iso(), emp["id"]),
        )

        if notify_mgr:
            settings = db.get_org_settings(conn)
            hr_enabled = bool(settings.get("hrCertNotifications", True))
            msg = (
                f"{emp['name']} ({emp['id']}) completed the certification "
                f"{cert_name} ({course_title}) on {completed_on}."
            )
            db.add_notification(
                conn,
                notif_type="certification_completed",
                audience="manager",
                message=msg,
                employee_id=emp["id"],
                employee_name=emp["name"],
                manager_id=emp["manager_id"],
                notify_hr=hr_enabled,
                course_id=course_id,
                course_title=course_title,
                certification_name=cert_name,
                completed_on=completed_on,
            )
            db.add_activity_log(
                conn,
                tool="Notify Tool",
                manager_id=emp["manager_id"],
                employee_id=emp["id"],
                message=f"[Notify Tool] Certification alert sent to manager{' & HR' if hr_enabled else ''}: {cert_name} ({course_title}).",
            )

        conn.commit()
        return jsonify(_build_employee_state_payload(conn, emp))

    @app.post("/api/me/replan")
    def add_my_replan() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err
        payload = request.get_json(silent=True) or {}
        conn = get_db()
        emp_id = g.current_user["id"]
        row = conn.execute(
            "SELECT replan_history_json FROM employee_data WHERE user_id = ?",
            (emp_id,),
        ).fetchone()
        history = _safe_json_loads(row["replan_history_json"] if row else None, [])
        entry = {
            "id": f"replan_{int(time.time() * 1000)}_{secrets.token_hex(2)}",
            "date": utc_now_iso(),
            "employeeId": emp_id,
            "skillId": payload.get("skillId"),
            "reason": str(payload.get("reason") or "Plan updated"),
            "summary": str(payload.get("summary") or ""),
        }
        history.insert(0, entry)
        conn.execute(
            "UPDATE employee_data SET replan_history_json = ?, updated_at = ? WHERE user_id = ?",
            (json.dumps(history[:30]), utc_now_iso(), emp_id),
        )
        conn.commit()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    @app.post("/api/me/reset")
    def reset_my_learning_state() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err
        conn = get_db()
        emp_id = g.current_user["id"]
        conn.execute(
            """
            UPDATE employee_data
            SET profile_json = NULL, course_progress_json = '{}', certifications_json = '[]',
                test_results_json = '{}', verified_levels_json = '{}',
                gate_json = '{"required":[],"completed":[],"cleared":false,"clearedAt":null}',
                in_progress_json = NULL, replan_history_json = '[]', updated_at = ?
            WHERE user_id = ?
            """,
            (utc_now_iso(), emp_id),
        )
        conn.commit()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    @app.post("/api/me/settings")
    def update_my_settings() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err
        payload = request.get_json(silent=True) or {}
        conn = get_db()
        if "certRankingBonus" in payload:
            db.set_org_setting(conn, "certRankingBonus", bool(payload["certRankingBonus"]))
        conn.commit()
        return jsonify(_build_employee_state_payload(conn, g.current_user))

    # ── Manager & HR Dashboard Data Endpoints ──────────────────────────────────
    @app.get("/api/dashboard/data")
    def get_dashboard_data() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        conn = get_db()
        actor = g.current_user
        settings = db.get_org_settings(conn)

        if actor["role"] == "hr":
            emp_rows = conn.execute(
                "SELECT * FROM users WHERE role = 'employee' ORDER BY id ASC"
            ).fetchall()
            all_users_rows = conn.execute("SELECT * FROM users ORDER BY id ASC").fetchall()
        else:
            emp_rows = conn.execute(
                "SELECT * FROM users WHERE role = 'employee' AND manager_id = ? ORDER BY id ASC",
                (actor["id"],),
            ).fetchall()
            all_users_rows = emp_rows

        emp_ids = [r["id"] for r in emp_rows]
        data_rows = (
            conn.execute(
                f"SELECT * FROM employee_data WHERE user_id IN ({','.join('?' for _ in emp_ids)})",
                emp_ids,
            ).fetchall()
            if emp_ids
            else []
        )
        data_by_id = {r["user_id"]: r for r in data_rows}

        team_records = []
        certifications_map: dict[str, list[dict[str, Any]]] = {}
        test_results_map: dict[str, dict[str, Any]] = {}
        verified_levels_map: dict[str, dict[str, Any]] = {}

        for u in emp_rows:
            uid = u["id"]
            d = data_by_id.get(uid)
            profile = _safe_json_loads(d["profile_json"] if d else None, None)
            course_prog = _safe_json_loads(
                d["course_progress_json"] if d else None, {}
            )
            certs = _safe_json_loads(d["certifications_json"] if d else None, [])
            tests = _safe_json_loads(d["test_results_json"] if d else None, {})
            verified = _safe_json_loads(d["verified_levels_json"] if d else None, {})
            gate = _safe_json_loads(
                d["gate_json"] if d else None,
                {"required": [], "completed": [], "cleared": False},
            )
            replan = _safe_json_loads(d["replan_history_json"] if d else None, [])

            certifications_map[uid] = certs
            test_results_map[uid] = tests
            verified_levels_map[uid] = verified

            team_records.append(
                {
                    **db.serialize_user_public(u),
                    "profile": profile,
                    "courseProgress": course_prog,
                    "certifications": certs,
                    "testResults": tests,
                    "verifiedLevels": verified,
                    "gate": gate,
                    "replanHistory": replan,
                    "levelsGained": d["levels_gained"] if d else 0,
                }
            )

        if actor["role"] == "hr":
            notif_rows = conn.execute(
                """
                SELECT * FROM notifications
                WHERE audience IN ('manager', 'hr')
                ORDER BY created_at DESC LIMIT 60
                """
            ).fetchall()
            nudge_rows = conn.execute(
                "SELECT * FROM nudges ORDER BY created_at DESC LIMIT 40"
            ).fetchall()
            log_rows = conn.execute(
                "SELECT * FROM agent_activity_log ORDER BY created_at DESC LIMIT 40"
            ).fetchall()
        else:
            notif_rows = conn.execute(
                """
                SELECT * FROM notifications
                WHERE audience = 'manager' AND (manager_id = ? OR manager_id IS NULL)
                ORDER BY created_at DESC LIMIT 60
                """,
                (actor["id"],),
            ).fetchall()
            nudge_rows = conn.execute(
                """
                SELECT * FROM nudges
                WHERE manager_id = ? OR manager_id IS NULL
                ORDER BY created_at DESC LIMIT 40
                """,
                (actor["id"],),
            ).fetchall()
            log_rows = conn.execute(
                """
                SELECT * FROM agent_activity_log
                WHERE manager_id = ? OR manager_id IS NULL
                ORDER BY created_at DESC LIMIT 40
                """,
                (actor["id"],),
            ).fetchall()

        return jsonify(
            {
                "activeRole": actor["role"],
                "currentUser": db.serialize_user_public(actor),
                "employees": team_records,
                "managedUsers": [db.serialize_user_public(u) for u in all_users_rows],
                "certifications": certifications_map,
                "testResults": test_results_map,
                "verifiedLevels": verified_levels_map,
                "notifications": [_serialize_notification_row(r) for r in notif_rows],
                "nudges": [
                    {
                        "id": r["id"],
                        "employeeId": r["employee_id"],
                        "employeeName": r["employee_name"],
                        "actionType": r["action_type"],
                        "senderRole": r["sender_role"],
                        "message": r["message"],
                        "createdAt": r["created_at"],
                    }
                    for r in nudge_rows
                ],
                "agentActivityLog": [
                    {
                        "id": r["id"],
                        "tool": r["tool"],
                        "message": r["message"],
                        "createdAt": r["created_at"],
                    }
                    for r in log_rows
                ],
                "priorities": settings.get("priorities", []),
                "anonymiseHR": bool(settings.get("anonymiseHR", True)),
                "certRankingBonus": bool(settings.get("certRankingBonus", False)),
                "hrCertNotifications": bool(settings.get("hrCertNotifications", True)),
            }
        )

    @app.post("/api/dashboard/verify-certification")
    def verify_employee_certification() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        payload = request.get_json(silent=True) or {}
        emp_id = str(payload.get("employeeId") or "").strip().upper()
        course_id = str(payload.get("courseId") or "").strip()
        if not emp_id or not course_id:
            return jsonify({"error": "employeeId and courseId are required"}), 400

        conn = get_db()
        target = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (emp_id,)
        ).fetchone()
        if not target:
            return jsonify({"error": "Employee not found"}), 404
        if not can_manage_employee(g.current_user, target):
            return jsonify({"error": "Forbidden"}), 403

        row = conn.execute(
            "SELECT certifications_json FROM employee_data WHERE user_id = ?",
            (target["id"],),
        ).fetchone()
        certs = _safe_json_loads(row["certifications_json"] if row else None, [])
        found = False
        cert_name = ""
        cert_code = ""
        for item in certs:
            if item.get("courseId") == course_id:
                item["status"] = "verified"
                cert_name = item.get("certificationName", "")
                cert_code = item.get("certId", "")
                found = True
        if not found:
            return jsonify({"error": "Certification record not found"}), 404

        conn.execute(
            "UPDATE employee_data SET certifications_json = ?, updated_at = ? WHERE user_id = ?",
            (json.dumps(certs), utc_now_iso(), target["id"]),
        )
        db.add_activity_log(
            conn,
            tool="Notify Tool",
            manager_id=target["manager_id"],
            employee_id=target["id"],
            message=f'[Notify Tool] Manager verified certification "{cert_name}" ({cert_code}) for {target["id"]}.',
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.post("/api/dashboard/nudge")
    def send_nudge() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        payload = request.get_json(silent=True) or {}
        emp_id = str(payload.get("employeeId") or "").strip().upper()
        action_type = str(payload.get("actionType") or "nudge").strip()
        message = str(payload.get("message") or "").strip()
        if not emp_id or not message:
            return jsonify({"error": "employeeId and message are required"}), 400

        conn = get_db()
        target = conn.execute(
            "SELECT * FROM users WHERE UPPER(id) = ?", (emp_id,)
        ).fetchone()
        if not target:
            return jsonify({"error": "Employee not found"}), 404
        if not can_manage_employee(g.current_user, target):
            return jsonify({"error": "Forbidden"}), 403

        nudge_id = f"nudge_{int(time.time() * 1000)}_{secrets.token_hex(2)}"
        created_at = utc_now_iso()
        conn.execute(
            """
            INSERT INTO nudges (id, employee_id, employee_name, manager_id, action_type, sender_role, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                nudge_id,
                target["id"],
                target["name"],
                target["manager_id"],
                action_type,
                g.current_user["role"],
                message,
                created_at,
            ),
        )
        db.add_notification(
            conn,
            notif_type=action_type,
            audience="employee",
            message=message,
            employee_id=target["id"],
            employee_name=target["name"],
            manager_id=target["manager_id"],
            sender_role=g.current_user["role"],
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.post("/api/dashboard/priorities")
    def save_priorities() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        payload = request.get_json(silent=True) or {}
        raw = payload.get("priorities")
        if not isinstance(raw, list):
            return jsonify({"error": "priorities list required"}), 400

        clean = []
        for item in raw:
            if isinstance(item, dict) and item.get("skillId"):
                clean.append(
                    {
                        "skillId": str(item["skillId"]),
                        "weight": max(1, min(5, int(item.get("weight") or 3))),
                    }
                )
        conn = get_db()
        db.set_org_setting(conn, "priorities", clean)
        conn.commit()
        return jsonify({"ok": True, "priorities": clean})

    @app.post("/api/dashboard/settings")
    def save_dashboard_settings() -> Any:
        role_err = require_manager_or_hr()
        if role_err is not None:
            return role_err

        payload = request.get_json(silent=True) or {}
        conn = get_db()
        for key in ("anonymiseHR", "certRankingBonus", "hrCertNotifications"):
            if key in payload:
                db.set_org_setting(conn, key, bool(payload[key]))
        conn.commit()
        return jsonify({"ok": True, "settings": db.get_org_settings(conn)})

    @app.post("/api/notifications/read")
    def mark_notifications_read() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True) or {}
        notif_id = payload.get("notificationId")
        conn = get_db()
        actor = g.current_user

        if notif_id:
            if actor["role"] == "employee":
                conn.execute(
                    "UPDATE notifications SET read = 1 WHERE id = ? AND employee_id = ? AND audience = 'employee'",
                    (str(notif_id), actor["id"]),
                )
            elif actor["role"] == "manager":
                conn.execute(
                    "UPDATE notifications SET read = 1 WHERE id = ? AND audience = 'manager' AND (manager_id = ? OR manager_id IS NULL)",
                    (str(notif_id), actor["id"]),
                )
            else:
                conn.execute(
                    "UPDATE notifications SET read = 1 WHERE id = ?", (str(notif_id),)
                )
        else:
            if actor["role"] == "employee":
                conn.execute(
                    "UPDATE notifications SET read = 1 WHERE employee_id = ? AND audience = 'employee'",
                    (actor["id"],),
                )
            elif actor["role"] == "manager":
                conn.execute(
                    "UPDATE notifications SET read = 1 WHERE audience = 'manager' AND (manager_id = ? OR manager_id IS NULL)",
                    (actor["id"],),
                )
            else:
                conn.execute(
                    "UPDATE notifications SET read = 1 WHERE audience IN ('manager', 'hr')"
                )
        conn.commit()
        return jsonify({"ok": True})

    # ── AI Endpoints (Authenticated + CSRF) ────────────────────────────────────
    @app.post("/api/ai-explain")
    def ai_explain() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if api_key:
            ai_result = try_gemini_explanations(payload, api_key)
            if ai_result is not None:
                return jsonify(ai_result)

        return jsonify(build_fallback_explanations(payload))

    @app.post("/api/ai-quiz")
    def ai_quiz() -> Any:
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        skill_id = str(payload.get("skillId") or "").strip()
        if not skill_id:
            return jsonify({"error": "Missing or invalid skillId"}), 400

        fallback_questions = validate_quiz_questions(
            OFFLINE_QUESTION_BANK.get(skill_id)
        )
        if fallback_questions is None:
            return jsonify({"error": f"Unknown skillId '{skill_id}'"}), 400

        skill_name = str(payload.get("skillName") or skill_id).strip()
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if api_key:
            ai_questions = try_gemini_quiz(skill_id, skill_name, api_key)
            if ai_questions is not None:
                return jsonify(
                    {
                        "source": "ai",
                        "skillId": skill_id,
                        "questions": ai_questions,
                        "generatedAt": utc_now_iso(),
                    }
                )

        return jsonify(
            {
                "source": "fallback",
                "skillId": skill_id,
                "questions": fallback_questions,
                "generatedAt": utc_now_iso(),
            }
        )

    # ── Demo-only Endpoints (DEMO_MODE=1) ──────────────────────────────────────
    @app.get("/dev/outbox")
    def dev_outbox_page() -> Any:
        if not is_demo_mode():
            abort(404)
        return send_from_directory(BASE_DIR, "outbox.html")

    @app.get("/api/dev/outbox")
    def dev_outbox_api() -> Any:
        if not is_demo_mode():
            abort(404)
        return jsonify({"emails": mailer.read_outbox(app.config["OUTBOX_PATH"])})

    @app.post("/api/dev/outbox/clear")
    def dev_outbox_clear() -> Any:
        if not is_demo_mode():
            abort(404)
        mailer.clear_outbox(app.config["OUTBOX_PATH"])
        return jsonify({"ok": True})

    @app.post("/api/demo/switch-role")
    def demo_switch_role() -> Any:
        if not is_demo_mode():
            abort(404)
        auth_err = require_auth()
        if auth_err is not None:
            return auth_err

        payload = request.get_json(silent=True) or {}
        next_role = str(payload.get("role") or "").strip().lower()
        target_id_map = {
            "employee": "EMP-1001",
            "manager": "MGR-2001",
            "hr": "HR-3001",
        }
        target_id = target_id_map.get(next_role)
        if not target_id:
            return jsonify({"error": "Invalid demo role"}), 400

        conn = get_db()
        target = conn.execute(
            "SELECT * FROM users WHERE id = ?", (target_id,)
        ).fetchone()
        if not target or not int(target["active"]):
            return jsonify({"error": "Demo account unavailable"}), 404

        session.permanent = True
        session["user_id"] = target["id"]
        session["last_activity"] = time.time()
        session.pop("temp_pw_hash", None)
        return jsonify(
            {
                "ok": True,
                "user": db.serialize_user_public(target),
                "redirectTo": _determine_login_redirect(conn, target),
            }
        )

    # ── Page Serving with Server-Side Auth Guards ──────────────────────────────
    @app.get("/login")
    @app.get("/login.html")
    @app.get("/tests.html")
    def serve_public_page() -> Any:
        filename = PUBLIC_PAGE_FILES.get(request.path)
        if not filename:
            abort(404)
        return send_from_directory(BASE_DIR, filename)

    @app.get("/")
    @app.get("/index.html")
    @app.get("/profile")
    @app.get("/analyzer")
    @app.get("/analyzer.html")
    @app.get("/courses")
    @app.get("/courses.html")
    @app.get("/quiz")
    @app.get("/quiz.html")
    @app.get("/dashboard")
    @app.get("/dashboard.html")
    @app.get("/change-password")
    @app.get("/change-password.html")
    def serve_page() -> Any:
        filename = PAGE_FILES.get(request.path)
        if not filename:
            abort(404)

        if g.current_user is None:
            suffix = "?reason=timeout" if g.session_expired else ""
            return redirect(f"/login.html{suffix}")

        if (
            int(g.current_user["force_password_change"])
            and filename != "change-password.html"
        ):
            return redirect("/change-password.html")

        if filename == "dashboard.html" and g.current_user["role"] not in (
            "manager",
            "hr",
        ):
            return ("Forbidden: Manager or HR role required.", 403)

        return send_from_directory(BASE_DIR, filename)

    @app.get("/css/<path:filename>")
    def serve_css(filename: str) -> Any:
        return send_from_directory(BASE_DIR / "css", filename)

    @app.get("/js/<path:filename>")
    def serve_js(filename: str) -> Any:
        return send_from_directory(BASE_DIR / "js", filename)

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=False)
