"""Email sending utility for SkillSync AI with SMTP and local JSON outbox fallback."""

from __future__ import annotations

import json
import os
import secrets
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

DEFAULT_OUTBOX_PATH = Path(__file__).resolve().parent / "data" / "outbox.json"


def utc_now_iso() -> str:
    """Return an ISO-8601 UTC timestamp string."""
    return datetime.now(timezone.utc).isoformat()


def get_outbox_path(outbox_path: str | Path | None = None) -> Path:
    """Resolve the outbox JSON file path."""
    if outbox_path is not None:
        return Path(outbox_path)
    env_path = os.environ.get("SKILLSYNC_OUTBOX_PATH", "").strip()
    if env_path:
        return Path(env_path)
    return DEFAULT_OUTBOX_PATH


def read_outbox(outbox_path: str | Path | None = None) -> list[dict[str, Any]]:
    """Read all emails saved to the simulated local outbox."""
    path = get_outbox_path(outbox_path)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def clear_outbox(outbox_path: str | Path | None = None) -> None:
    """Clear all emails from the simulated local outbox."""
    path = get_outbox_path(outbox_path)
    if path.exists():
        path.write_text("[]", encoding="utf-8")


def _save_to_outbox(
    to_email: str,
    subject: str,
    body: str,
    outbox_path: str | Path | None = None,
    reason: str = "outbox",
) -> dict[str, Any]:
    path = get_outbox_path(outbox_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    items = read_outbox(path)
    entry = {
        "id": f"mail_{secrets.token_hex(6)}",
        "to": to_email,
        "subject": subject,
        "body": body,
        "transport": reason,
        "createdAt": utc_now_iso(),
    }
    items.insert(0, entry)
    path.write_text(json.dumps(items[:100], indent=2), encoding="utf-8")
    return entry


def send_email(
    to_email: str,
    subject: str,
    body: str,
    outbox_path: str | Path | None = None,
) -> dict[str, Any]:
    """Send an email via SMTP when configured, falling back cleanly to the local outbox."""
    smtp_host = os.environ.get("SMTP_HOST", "").strip()
    smtp_port_raw = os.environ.get("SMTP_PORT", "587").strip()
    smtp_user = os.environ.get("SMTP_USER", "").strip()
    smtp_password = os.environ.get("SMTP_PASSWORD", "").strip()
    mail_from = os.environ.get("MAIL_FROM", "").strip() or smtp_user or "noreply@skillsync.local"

    if smtp_host:
        try:
            smtp_port = int(smtp_port_raw or "587")
            msg = EmailMessage()
            msg["From"] = mail_from
            msg["To"] = to_email
            msg["Subject"] = subject
            msg.set_content(body)

            if smtp_port == 465:
                with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10) as server:
                    if smtp_user and smtp_password:
                        server.login(smtp_user, smtp_password)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
                    server.ehlo()
                    if server.has_extn("starttls"):
                        server.starttls()
                        server.ehlo()
                    if smtp_user and smtp_password:
                        server.login(smtp_user, smtp_password)
                    server.send_message(msg)

            return {
                "sent": True,
                "transport": "smtp",
                "to": to_email,
                "subject": subject,
                "logMessage": f"[Notify Tool] Email sent via SMTP to {to_email} ({subject}).",
            }
        except Exception:
            entry = _save_to_outbox(
                to_email, subject, body, outbox_path=outbox_path, reason="outbox_fallback"
            )
            return {
                "sent": True,
                "transport": "outbox",
                "entry": entry,
                "to": to_email,
                "subject": subject,
                "logMessage": f"[Notify Tool] Email sent to local outbox for {to_email} ({subject}).",
            }

    entry = _save_to_outbox(
        to_email, subject, body, outbox_path=outbox_path, reason="outbox"
    )
    return {
        "sent": True,
        "transport": "outbox",
        "entry": entry,
        "to": to_email,
        "subject": subject,
        "logMessage": f"[Notify Tool] Email sent to local outbox for {to_email} ({subject}).",
    }


def build_new_account_email(
    name: str,
    user_id: str,
    default_password: str,
    login_url: str = "",
) -> tuple[str, str]:
    """Return (subject, body) for a newly created employee account."""
    subject = f"Welcome to SkillSync AI — Your Login ID ({user_id})"
    url_line = f"Login page: {login_url}\n" if login_url else ""
    body = (
        f"Hello {name},\n\n"
        "Your SkillSync AI account has been created.\n\n"
        f"Employee ID: {user_id}\n"
        f"Default Password: {default_password}\n"
        f"{url_line}\n"
        "For your security, please change this default password after your first login.\n\n"
        "— SkillSync AI Team"
    )
    return subject, body


def build_reset_password_email(
    name: str,
    user_id: str,
    temp_password: str,
    expiry_minutes: int = 15,
    login_url: str = "",
) -> tuple[str, str]:
    """Return (subject, body) for a temporary password reset email."""
    subject = f"SkillSync AI Password Reset — Temporary Password ({user_id})"
    url_line = f"Login page: {login_url}\n" if login_url else ""
    body = (
        f"Hello {name},\n\n"
        "A password reset was requested for your SkillSync AI account.\n\n"
        f"User ID: {user_id}\n"
        f"Temporary Password: {temp_password}\n"
        f"{url_line}\n"
        f"IMPORTANT: This temporary password expires in {expiry_minutes} minutes and works only once. "
        "You will be required to set a new password immediately after signing in.\n\n"
        "If you didn't ask for this, ignore this email — your existing password has not been removed.\n\n"
        "— SkillSync AI Security"
    )
    return subject, body
