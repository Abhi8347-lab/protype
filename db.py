"""SQLite database layer, schema migration, and demo account seeding for SkillSync AI."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from werkzeug.security import generate_password_hash

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "skillsync.db"

LEGACY_EMPLOYEE_ID_MAP = {
    "emp_maya": "EMP-1001",
    "emp_ethan": "EMP-1002",
    "emp_elena": "EMP-1003",
    "emp_liam": "EMP-1004",
    "emp_priya": "EMP-1005",
    "emp_carlos": "EMP-1006",
    "emp_hana": "EMP-1007",
    "emp_noah": "EMP-1008",
    "emp_amara": "EMP-1009",
}


def utc_now() -> datetime:
    """Return current UTC datetime."""
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    """Return ISO-8601 UTC timestamp string."""
    return utc_now().isoformat()


def get_db_path(db_path: str | Path | None = None) -> Path:
    """Resolve the SQLite database path."""
    if db_path is not None:
        return Path(db_path)
    env_path = os.environ.get("SKILLSYNC_DB_PATH", "").strip()
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open a SQLite connection with row_factory and foreign keys enabled."""
    path = get_db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK(role IN ('employee', 'manager', 'hr')),
            designation TEXT NOT NULL DEFAULT '',
            team TEXT NOT NULL DEFAULT 'Analytics & BI',
            user_type TEXT NOT NULL DEFAULT 'employee',
            previous_field TEXT NOT NULL DEFAULT '',
            manager_id TEXT,
            password_hash TEXT NOT NULL,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            force_password_change INTEGER NOT NULL DEFAULT 0,
            reset_password_hash TEXT,
            reset_expires TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            is_demo INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_login TEXT,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            activated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS employee_data (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            profile_json TEXT,
            course_progress_json TEXT NOT NULL DEFAULT '{}',
            certifications_json TEXT NOT NULL DEFAULT '[]',
            test_results_json TEXT NOT NULL DEFAULT '{}',
            verified_levels_json TEXT NOT NULL DEFAULT '{}',
            gate_json TEXT NOT NULL DEFAULT '{"required":[],"completed":[],"cleared":false,"clearedAt":null}',
            in_progress_json TEXT,
            replan_history_json TEXT NOT NULL DEFAULT '[]',
            levels_gained INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            audience TEXT NOT NULL,
            notify_hr INTEGER NOT NULL DEFAULT 1,
            employee_id TEXT,
            employee_name TEXT,
            manager_id TEXT,
            sender_role TEXT,
            course_id TEXT,
            course_title TEXT,
            certification_name TEXT,
            completed_on TEXT,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL,
            read INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS nudges (
            id TEXT PRIMARY KEY,
            employee_id TEXT NOT NULL,
            employee_name TEXT NOT NULL,
            manager_id TEXT,
            action_type TEXT NOT NULL,
            sender_role TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_activity_log (
            id TEXT PRIMARY KEY,
            tool TEXT NOT NULL,
            manager_id TEXT,
            employee_id TEXT,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS org_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS password_reset_rate_limits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            limit_key TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rate_limits_key_time
            ON password_reset_rate_limits (limit_key, created_at);
        """
    )


def _demo_employees_seed_specs() -> list[dict[str, Any]]:
    """Return the exact seeded demo users and their learning state."""
    return [
        {
            "id": "EMP-1001",
            "name": "Maya Lin",
            "email": "maya.lin@skillsync.demo",
            "role": "employee",
            "designation": "Junior Data Analyst",
            "team": "Analytics & BI",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-24T09:15:00+00:00",
            "created_at": "2026-10-15T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-15T09:10:00+00:00",
            "profile": {
                "name": "Maya Lin",
                "userType": "employee",
                "status": "employee",
                "previousField": "",
                "backgroundDetail": "Data Analyst",
                "targetRole": "junior_data_analyst",
                "companyPriority": "Dashboards",
                "companyPriorities": ["Dashboards"],
                "learningSlotsPerWeek": 3,
                "weeklyHours": "5-10",
                "experience": "1-3",
                "selectedSkills": ["sql", "power_bi", "statistics"],
                "skillScores": {"sql": 80, "power_bi": 60, "statistics": 60},
                "skillRatings": {"sql": 4, "power_bi": 3, "statistics": 3},
            },
            "verified_levels": {
                "sql": {"level": "Expert", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "verifiedPct": 90, "updatedAt": "2026-11-18"},
                "power_bi": {"level": "Intermediate", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-20"},
                "statistics": {"level": "Intermediate", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-22"},
            },
            "test_results": {
                "sql": [
                    {"date": "2026-11-02", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60},
                    {"date": "2026-11-18", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "level": "Expert", "verifiedPct": 90},
                ],
                "power_bi": [
                    {"date": "2026-11-10", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30},
                    {"date": "2026-11-20", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60},
                ],
                "statistics": [
                    {"date": "2026-11-22", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60},
                ],
            },
            "course_progress": {
                "mslearn-powerbi-start": "completed",
                "mslearn-powerbi-dashboards": "completed",
                "coursera-powerbi-analyst": "in_progress",
                "coursera-applied-stats": "completed",
            },
            "certifications": [
                {
                    "courseId": "mslearn-powerbi-start",
                    "certificationName": "Microsoft Power BI Data Analyst Certificate",
                    "certId": "MS-PBI-2026-104",
                    "completedOn": "2026-11-19",
                    "status": "verified",
                },
                {
                    "courseId": "coursera-applied-stats",
                    "certificationName": "Applied Statistics for Data Analytics Certificate",
                    "certId": "COURSERA-STAT-8891",
                    "completedOn": "2026-11-24",
                    "status": "pending_review",
                },
            ],
            "replan_history": [
                {"date": "2026-11-20", "reason": "Power BI diagnostic upgraded Beginner → Intermediate", "summary": "Advanced directly to Week 6 Mini Dashboard Project."},
            ],
            "levels_gained": 3,
        },
        {
            "id": "EMP-1002",
            "name": "Ethan Reed",
            "email": "ethan.reed@skillsync.demo",
            "role": "employee",
            "designation": "Junior Data Analyst",
            "team": "Analytics & BI",
            "user_type": "other",
            "previous_field": "Retail Operations",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-23T14:20:00+00:00",
            "created_at": "2026-10-20T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-20T09:30:00+00:00",
            "profile": {
                "name": "Ethan Reed",
                "userType": "other",
                "status": "other",
                "previousField": "Retail Operations",
                "backgroundDetail": "Career Switcher",
                "targetRole": "junior_data_analyst",
                "companyPriority": "Dashboards",
                "companyPriorities": ["Dashboards"],
                "learningSlotsPerWeek": 2,
                "weeklyHours": "2-5",
                "experience": "0-1",
                "selectedSkills": ["sql", "power_bi", "statistics"],
                "skillScores": {"sql": 60, "power_bi": 40, "statistics": 40},
                "skillRatings": {"sql": 3, "power_bi": 2, "statistics": 2},
            },
            "verified_levels": {
                "sql": {"level": "Intermediate", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-12"},
                "power_bi": {"level": "Beginner", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "verifiedPct": 30, "updatedAt": "2026-11-14"},
                "statistics": {"level": "Beginner", "score": 1, "easyCorrect": 1, "hardCorrect": 0, "verifiedPct": 30, "updatedAt": "2026-11-15"},
            },
            "test_results": {
                "sql": [{"date": "2026-11-12", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
                "power_bi": [{"date": "2026-11-14", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30}],
                "statistics": [{"date": "2026-11-15", "score": 1, "easyCorrect": 1, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30}],
            },
            "course_progress": {
                "mslearn-powerbi-start": "in_progress",
            },
            "certifications": [],
            "replan_history": [
                {"date": "2026-11-15", "reason": "Low initial Statistics & Power BI diagnostic scores", "summary": "Extended Power BI Essentials across Weeks 1–4."},
            ],
            "levels_gained": 1,
        },
        {
            "id": "EMP-1003",
            "name": "Elena Ivanova",
            "email": "elena.ivanova@skillsync.demo",
            "role": "employee",
            "designation": "Data Engineer",
            "team": "Analytics & BI",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-24T11:00:00+00:00",
            "created_at": "2026-10-12T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-12T09:15:00+00:00",
            "profile": {
                "name": "Elena Ivanova",
                "userType": "employee",
                "status": "employee",
                "previousField": "",
                "backgroundDetail": "Software Developer",
                "targetRole": "data_engineer",
                "companyPriority": "Data Governance",
                "companyPriorities": ["Data Governance"],
                "learningSlotsPerWeek": 3,
                "weeklyHours": "5-10",
                "experience": "1-3",
                "selectedSkills": ["sql", "python", "docker"],
                "skillScores": {"sql": 80, "python": 60, "numpy_pandas": 60, "docker": 40},
                "skillRatings": {"sql": 4, "python": 3, "docker": 2},
            },
            "verified_levels": {
                "sql": {"level": "Expert", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "verifiedPct": 90, "updatedAt": "2026-11-19"},
                "python": {"level": "Intermediate", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-21"},
                "docker": {"level": "Beginner", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "verifiedPct": 30, "updatedAt": "2026-11-23"},
            },
            "test_results": {
                "sql": [{"date": "2026-11-19", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "level": "Expert", "verifiedPct": 90}],
                "python": [
                    {"date": "2026-11-05", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30},
                    {"date": "2026-11-21", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60},
                ],
                "docker": [{"date": "2026-11-23", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30}],
            },
            "course_progress": {
                "fcc-scientific-python": "completed",
                "fcc-data-analysis-python": "completed",
                "yt-docker-nana": "in_progress",
            },
            "certifications": [
                {
                    "courseId": "fcc-scientific-python",
                    "certificationName": "freeCodeCamp Scientific Computing with Python Certificate",
                    "certId": "FCC-PY-9021",
                    "completedOn": "2026-11-14",
                    "status": "verified",
                },
                {
                    "courseId": "fcc-data-analysis-python",
                    "certificationName": "freeCodeCamp Data Analysis with Python Certificate",
                    "certId": "FCC-DA-9410",
                    "completedOn": "2026-11-22",
                    "status": "verified",
                },
            ],
            "replan_history": [
                {"date": "2026-11-21", "reason": "Python verified Intermediate", "summary": "Shifted focus to Docker & AWS pipelines."},
            ],
            "levels_gained": 2,
        },
        {
            "id": "EMP-1004",
            "name": "Liam Carter",
            "email": "liam.carter@skillsync.demo",
            "role": "employee",
            "designation": "Data Scientist",
            "team": "Analytics & BI",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-22T16:40:00+00:00",
            "created_at": "2026-10-18T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-18T09:20:00+00:00",
            "profile": {
                "name": "Liam Carter",
                "userType": "employee",
                "status": "employee",
                "previousField": "",
                "backgroundDetail": "Data Analyst",
                "targetRole": "data_scientist",
                "companyPriority": "AI Adoption",
                "companyPriorities": ["AI Adoption"],
                "learningSlotsPerWeek": 3,
                "weeklyHours": "5-10",
                "experience": "0-1",
                "selectedSkills": ["python", "sql", "statistics"],
                "skillScores": {"python": 60, "sql": 60, "statistics": 40, "machine_learning": 40},
                "skillRatings": {"python": 3, "sql": 3, "statistics": 2},
            },
            "verified_levels": {
                "python": {"level": "Intermediate", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-16"},
                "sql": {"level": "Intermediate", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-17"},
                "statistics": {"level": "Beginner", "score": 2, "easyCorrect": 1, "hardCorrect": 1, "verifiedPct": 30, "updatedAt": "2026-11-18"},
            },
            "test_results": {
                "python": [{"date": "2026-11-16", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
                "sql": [{"date": "2026-11-17", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
                "statistics": [{"date": "2026-11-18", "score": 2, "easyCorrect": 1, "hardCorrect": 1, "level": "Beginner", "verifiedPct": 30}],
            },
            "course_progress": {
                "coursera-sql-ds": "completed",
                "coursera-applied-stats": "in_progress",
            },
            "certifications": [
                {
                    "courseId": "coursera-sql-ds",
                    "certificationName": "Coursera SQL for Data Science Certificate",
                    "certId": "COURSERA-SQL-3182",
                    "completedOn": "2026-11-18",
                    "status": "pending_review",
                },
            ],
            "replan_history": [
                {"date": "2026-11-18", "reason": "Statistics rated Beginner (missed easy foundation)", "summary": "Added Khan Academy Statistics before ML Specialization."},
            ],
            "levels_gained": 1,
        },
        {
            "id": "EMP-1005",
            "name": "Priya Sharma",
            "email": "priya.sharma@skillsync.demo",
            "role": "employee",
            "designation": "AI / ML Engineer",
            "team": "AI & Data",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-25T10:15:00+00:00",
            "created_at": "2026-10-10T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-10T09:12:00+00:00",
            "profile": {
                "name": "Priya Sharma",
                "userType": "employee",
                "status": "employee",
                "previousField": "",
                "backgroundDetail": "Software Developer",
                "targetRole": "ai_ml_engineer",
                "companyPriority": "AI Adoption",
                "companyPriorities": ["AI Adoption"],
                "learningSlotsPerWeek": 5,
                "weeklyHours": "10-20",
                "experience": "1-3",
                "selectedSkills": ["python", "git", "machine_learning", "deep_learning"],
                "skillScores": {"python": 80, "git": 80, "machine_learning": 60, "deep_learning": 60},
                "skillRatings": {"python": 4, "git": 4, "machine_learning": 3, "deep_learning": 3},
            },
            "verified_levels": {
                "python": {"level": "Expert", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "verifiedPct": 90, "updatedAt": "2026-11-20"},
                "git": {"level": "Expert", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "verifiedPct": 90, "updatedAt": "2026-11-21"},
                "machine_learning": {"level": "Intermediate", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-22"},
                "deep_learning": {"level": "Intermediate", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-23"},
            },
            "test_results": {
                "python": [{"date": "2026-11-20", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "level": "Expert", "verifiedPct": 90}],
                "machine_learning": [
                    {"date": "2026-11-08", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30},
                    {"date": "2026-11-22", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60},
                ],
                "deep_learning": [{"date": "2026-11-23", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
            },
            "course_progress": {
                "yt-streamlit-12apps": "completed",
                "fcc-data-analysis-python": "completed",
                "coursera-ml-spec": "completed",
                "coursera-dl-spec": "in_progress",
            },
            "certifications": [
                {
                    "courseId": "fcc-data-analysis-python",
                    "certificationName": "freeCodeCamp Data Analysis with Python Certificate",
                    "certId": "FCC-DA-7731",
                    "completedOn": "2026-11-10",
                    "status": "verified",
                },
                {
                    "courseId": "coursera-ml-spec",
                    "certificationName": "DeepLearning.AI Machine Learning Specialization Certificate",
                    "certId": "DLAI-ML-5502",
                    "completedOn": "2026-11-23",
                    "status": "verified",
                },
            ],
            "replan_history": [
                {"date": "2026-11-22", "reason": "ML upgraded to Intermediate", "summary": "Prioritized Deep Learning Specialization for Weeks 4–6."},
            ],
            "levels_gained": 3,
        },
        {
            "id": "EMP-1006",
            "name": "Carlos Mendez",
            "email": "carlos.mendez@skillsync.demo",
            "role": "employee",
            "designation": "DevOps Engineer",
            "team": "Platform & Cloud",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-20T08:45:00+00:00",
            "created_at": "2026-10-22T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-22T09:10:00+00:00",
            "profile": {
                "name": "Carlos Mendez",
                "userType": "employee",
                "status": "employee",
                "previousField": "",
                "backgroundDetail": "IT Support / SysAdmin",
                "targetRole": "devops_engineer",
                "companyPriority": "Cloud Migration",
                "companyPriorities": ["Cloud Migration"],
                "learningSlotsPerWeek": 3,
                "weeklyHours": "5-10",
                "experience": "1-3",
                "selectedSkills": ["linux", "docker", "kubernetes"],
                "skillScores": {"linux": 80, "docker": 60, "kubernetes": 40, "aws_cloud": 40},
                "skillRatings": {"linux": 4, "docker": 3, "kubernetes": 2},
            },
            "verified_levels": {
                "linux": {"level": "Expert", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "verifiedPct": 90, "updatedAt": "2026-11-09"},
                "docker": {"level": "Intermediate", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-11"},
                "kubernetes": {"level": "Beginner", "score": 1, "easyCorrect": 1, "hardCorrect": 0, "verifiedPct": 30, "updatedAt": "2026-11-12"},
            },
            "test_results": {
                "linux": [{"date": "2026-11-09", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "level": "Expert", "verifiedPct": 90}],
                "docker": [{"date": "2026-11-11", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
                "kubernetes": [{"date": "2026-11-12", "score": 1, "easyCorrect": 1, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30}],
            },
            "course_progress": {
                "yt-k8s-nana": "in_progress",
            },
            "certifications": [],
            "replan_history": [
                {"date": "2026-11-12", "reason": "Kubernetes Beginner score detected", "summary": "Scheduled K8s foundational pods/services labs first."},
            ],
            "levels_gained": 1,
        },
        {
            "id": "EMP-1007",
            "name": "Hana Sato",
            "email": "hana.sato@skillsync.demo",
            "role": "employee",
            "designation": "Full-Stack Developer",
            "team": "Web Engineering",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-25T13:10:00+00:00",
            "created_at": "2026-10-08T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-08T09:25:00+00:00",
            "profile": {
                "name": "Hana Sato",
                "userType": "employee",
                "status": "employee",
                "previousField": "",
                "backgroundDetail": "Software Developer",
                "targetRole": "fullstack_developer",
                "companyPriority": "Dashboards",
                "companyPriorities": ["Dashboards"],
                "learningSlotsPerWeek": 3,
                "weeklyHours": "5-10",
                "experience": "1-3",
                "selectedSkills": ["javascript", "react", "sql"],
                "skillScores": {"javascript": 80, "react": 60, "typescript": 60, "sql": 60},
                "skillRatings": {"javascript": 4, "react": 3, "sql": 3},
            },
            "verified_levels": {
                "javascript": {"level": "Expert", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "verifiedPct": 90, "updatedAt": "2026-11-19"},
                "react": {"level": "Intermediate", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-20"},
                "sql": {"level": "Intermediate", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-21"},
            },
            "test_results": {
                "javascript": [{"date": "2026-11-19", "score": 5, "easyCorrect": 3, "hardCorrect": 2, "level": "Expert", "verifiedPct": 90}],
                "react": [
                    {"date": "2026-11-04", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30},
                    {"date": "2026-11-20", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60},
                ],
                "sql": [{"date": "2026-11-21", "score": 4, "easyCorrect": 3, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
            },
            "course_progress": {
                "fcc-js-algos": "completed",
                "coursera-meta-react": "completed",
                "yt-typescript-full": "completed",
                "udemy-react-guide": "completed",
                "cs50-web": "completed",
                "coursera-sql-ds": "in_progress",
            },
            "certifications": [
                {
                    "courseId": "fcc-js-algos",
                    "certificationName": "JavaScript Algorithms & Data Structures Certificate",
                    "certId": "FCC-JS-6201",
                    "completedOn": "2026-10-28",
                    "status": "verified",
                },
                {
                    "courseId": "coursera-meta-react",
                    "certificationName": "Meta React Basics Certificate",
                    "certId": "META-REACT-4402",
                    "completedOn": "2026-11-12",
                    "status": "verified",
                },
                {
                    "courseId": "udemy-react-guide",
                    "certificationName": "React Complete Guide Certificate",
                    "certId": "UC-REACT-8814",
                    "completedOn": "2026-11-22",
                    "status": "pending_review",
                },
            ],
            "replan_history": [
                {"date": "2026-11-20", "reason": "React upgraded to Intermediate", "summary": "Moved SQL & Docker capstone earlier in schedule."},
            ],
            "levels_gained": 3,
        },
        {
            "id": "EMP-1008",
            "name": "Noah Brooks",
            "email": "noah.brooks@skillsync.demo",
            "role": "employee",
            "designation": "Cybersecurity Analyst",
            "team": "Security Ops",
            "user_type": "other",
            "previous_field": "Banking",
            "manager_id": "MGR-2001",
            "last_login": "2026-11-21T15:05:00+00:00",
            "created_at": "2026-10-28T09:00:00+00:00",
            "must_change_password": 0,
            "activated_at": "2026-10-28T09:40:00+00:00",
            "profile": {
                "name": "Noah Brooks",
                "userType": "other",
                "status": "other",
                "previousField": "Banking",
                "backgroundDetail": "Career Switcher",
                "targetRole": "cybersecurity_analyst",
                "companyPriority": "Cybersecurity",
                "companyPriorities": ["Cybersecurity"],
                "learningSlotsPerWeek": 2,
                "weeklyHours": "2-5",
                "experience": "0-1",
                "selectedSkills": ["networking", "security_basics"],
                "skillScores": {"networking": 60, "linux": 60, "security_basics": 40},
                "skillRatings": {"networking": 3, "security_basics": 2},
            },
            "verified_levels": {
                "networking": {"level": "Intermediate", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "verifiedPct": 60, "updatedAt": "2026-11-10"},
                "security_basics": {"level": "Beginner", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "verifiedPct": 30, "updatedAt": "2026-11-11"},
            },
            "test_results": {
                "networking": [{"date": "2026-11-10", "score": 3, "easyCorrect": 2, "hardCorrect": 1, "level": "Intermediate", "verifiedPct": 60}],
                "security_basics": [{"date": "2026-11-11", "score": 2, "easyCorrect": 2, "hardCorrect": 0, "level": "Beginner", "verifiedPct": 30}],
            },
            "course_progress": {
                "cs50-cybersecurity": "in_progress",
            },
            "certifications": [],
            "replan_history": [
                {"date": "2026-11-11", "reason": "Security Fundamentals Beginner verified", "summary": "Prioritized CS50 Cybersecurity before SIEM monitoring."},
            ],
            "levels_gained": 1,
        },
        {
            "id": "EMP-1009",
            "name": "Jordan Patel",
            "email": "jordan.patel@skillsync.demo",
            "role": "employee",
            "designation": "Junior Data Analyst",
            "team": "Analytics & BI",
            "user_type": "other",
            "previous_field": "Retail",
            "manager_id": "MGR-2001",
            "last_login": None,
            "created_at": "2026-11-26T09:00:00+00:00",
            "must_change_password": 1,
            "activated_at": None,
            "password_plain_seed": "1234",
            "profile": None,
            "verified_levels": {},
            "test_results": {},
            "course_progress": {},
            "certifications": [],
            "replan_history": [],
            "levels_gained": 0,
        },
    ]


def init_db(db_path: str | Path | None = None) -> Path:
    """Initialize SQLite schema, migrate legacy IDs if needed, and seed demo accounts."""
    resolved = get_db_path(db_path)
    with get_connection(resolved) as conn:
        _create_schema(conn)
        _seed_demo_accounts_and_data(conn)
        conn.commit()
    return resolved


def _seed_demo_accounts_and_data(conn: sqlite3.Connection) -> None:
    """Idempotently seed Manager, HR, and EMP-1001..EMP-1009 with salted password hashes."""
    now = utc_now_iso()

    # Seed Manager & HR
    leaders = [
        {
            "id": "MGR-2001",
            "name": "Alex Morgan",
            "email": "manager@skillsync.demo",
            "role": "manager",
            "designation": "Analytics & BI Manager",
            "team": "Analytics & BI",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": None,
            "password": os.environ.get("DEMO_MANAGER_PASSWORD", "Manager@123"),
            "created_at": "2026-10-01T09:00:00+00:00",
            "last_login": "2026-11-26T08:30:00+00:00",
        },
        {
            "id": "HR-3001",
            "name": "Taylor Brooks",
            "email": "hr@skillsync.demo",
            "role": "hr",
            "designation": "HR People & L&D Lead",
            "team": "People & HR",
            "user_type": "employee",
            "previous_field": "",
            "manager_id": None,
            "password": os.environ.get("DEMO_HR_PASSWORD", "Hr@12345"),
            "created_at": "2026-10-01T09:00:00+00:00",
            "last_login": "2026-11-26T08:45:00+00:00",
        },
    ]

    for leader in leaders:
        exists = conn.execute("SELECT id FROM users WHERE id = ?", (leader["id"],)).fetchone()
        if not exists:
            conn.execute(
                """
                INSERT INTO users (
                    id, name, email, role, designation, team, user_type, previous_field,
                    manager_id, password_hash, must_change_password, force_password_change,
                    active, is_demo, created_at, last_login, activated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 1, ?, ?, ?)
                """,
                (
                    leader["id"],
                    leader["name"],
                    leader["email"].lower(),
                    leader["role"],
                    leader["designation"],
                    leader["team"],
                    leader["user_type"],
                    leader["previous_field"],
                    leader["manager_id"],
                    generate_password_hash(leader["password"]),
                    leader["created_at"],
                    leader["last_login"],
                    leader["created_at"],
                ),
            )

    # Seed EMP-1001..EMP-1009
    default_emp_pw = os.environ.get("DEMO_EMPLOYEE_PASSWORD", "Employee@123")
    for spec in _demo_employees_seed_specs():
        exists = conn.execute("SELECT id FROM users WHERE id = ?", (spec["id"],)).fetchone()
        if not exists:
            plain_pw = spec.get("password_plain_seed") or default_emp_pw
            conn.execute(
                """
                INSERT INTO users (
                    id, name, email, role, designation, team, user_type, previous_field,
                    manager_id, password_hash, must_change_password, force_password_change,
                    active, is_demo, created_at, last_login, activated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, ?)
                """,
                (
                    spec["id"],
                    spec["name"],
                    spec["email"].lower(),
                    spec["role"],
                    spec["designation"],
                    spec["team"],
                    spec["user_type"],
                    spec["previous_field"],
                    spec["manager_id"],
                    generate_password_hash(plain_pw),
                    spec["must_change_password"],
                    spec["created_at"],
                    spec["last_login"],
                    spec["activated_at"],
                ),
            )

        data_exists = conn.execute(
            "SELECT user_id FROM employee_data WHERE user_id = ?", (spec["id"],)
        ).fetchone()
        if not data_exists:
            profile = spec["profile"]
            selected = list(profile.get("selectedSkills") or []) if profile else []
            verified = spec["verified_levels"] or {}
            completed = [s for s in selected if s in verified]
            cleared = bool(selected) and all(s in completed for s in selected)
            gate = {
                "required": selected,
                "completed": completed,
                "cleared": cleared,
                "clearedAt": "2026-11-22T10:00:00+00:00" if cleared else None,
            }
            conn.execute(
                """
                INSERT INTO employee_data (
                    user_id, profile_json, course_progress_json, certifications_json,
                    test_results_json, verified_levels_json, gate_json, in_progress_json,
                    replan_history_json, levels_gained, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
                """,
                (
                    spec["id"],
                    json.dumps(profile) if profile is not None else None,
                    json.dumps(spec["course_progress"]),
                    json.dumps(spec["certifications"]),
                    json.dumps(spec["test_results"]),
                    json.dumps(verified),
                    json.dumps(gate),
                    json.dumps(spec["replan_history"]),
                    spec["levels_gained"],
                    now,
                ),
            )

    # Seed default org settings if missing
    default_settings = {
        "priorities": [
            {"skillId": "power_bi", "weight": 5},
            {"skillId": "sql", "weight": 4},
            {"skillId": "python", "weight": 4},
        ],
        "anonymiseHR": True,
        "certRankingBonus": False,
        "hrCertNotifications": True,
    }
    for k, val in default_settings.items():
        row = conn.execute("SELECT key FROM org_settings WHERE key = ?", (k,)).fetchone()
        if not row:
            conn.execute(
                "INSERT INTO org_settings (key, value_json) VALUES (?, ?)",
                (k, json.dumps(val)),
            )

    # Seed initial pending certification notification if notifications table is empty
    notif_count = conn.execute("SELECT COUNT(*) AS cnt FROM notifications").fetchone()["cnt"]
    if notif_count == 0:
        conn.execute(
            """
            INSERT INTO notifications (
                id, type, audience, notify_hr, employee_id, employee_name, manager_id,
                course_id, course_title, certification_name, completed_on, message, created_at, read
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "cert_seed_emp1001",
                "certification_completed",
                "manager",
                1,
                "EMP-1001",
                "Maya Lin",
                "MGR-2001",
                "coursera-applied-stats",
                "Applied Statistics for Data Analytics",
                "Applied Statistics for Data Analytics Certificate",
                "2026-11-24",
                "Maya Lin (EMP-1001) completed the certification Applied Statistics for Data Analytics Certificate (Applied Statistics for Data Analytics) on 24 Nov 2026.",
                "2026-11-24T10:00:00+00:00",
                0,
            ),
        )


def generate_next_user_id(conn: sqlite3.Connection, role: str) -> str:
    """Generate the next unique ID in EMP-1001 / MGR-2001 / HR-3001 format."""
    if role == "manager":
        prefix, base = "MGR-", 2001
    elif role == "hr":
        prefix, base = "HR-", 3001
    else:
        prefix, base = "EMP-", 1001

    rows = conn.execute("SELECT id FROM users WHERE id LIKE ?", (f"{prefix}%",)).fetchall()
    max_num = base - 1
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    for row in rows:
        match = pattern.match(str(row["id"]))
        if match:
            max_num = max(max_num, int(match.group(1)))
    return f"{prefix}{max_num + 1}"


def get_org_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    """Read organization-level dashboard settings."""
    rows = conn.execute("SELECT key, value_json FROM org_settings").fetchall()
    out: dict[str, Any] = {
        "priorities": [
            {"skillId": "power_bi", "weight": 5},
            {"skillId": "sql", "weight": 4},
            {"skillId": "python", "weight": 4},
        ],
        "anonymiseHR": True,
        "certRankingBonus": False,
        "hrCertNotifications": True,
    }
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value_json"])
        except Exception:
            pass
    return out


def set_org_setting(conn: sqlite3.Connection, key: str, value: Any) -> None:
    """Persist an organization-level setting."""
    conn.execute(
        """
        INSERT INTO org_settings (key, value_json) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
        """,
        (key, json.dumps(value)),
    )


def compute_account_status(user_row: sqlite3.Row | dict[str, Any]) -> str:
    """Compute human-readable account status for the Manager Employees & Login IDs table."""
    if not int(user_row["active"]):
        return "Deactivated"
    now_iso = utc_now_iso()
    reset_hash = user_row["reset_password_hash"]
    reset_exp = user_row["reset_expires"]
    if int(user_row["force_password_change"]) or (reset_hash and reset_exp and reset_exp > now_iso):
        return "Password reset pending"
    if not user_row["last_login"]:
        return "Never logged in"
    return "Active"


def serialize_user_public(user_row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    """Return safe user metadata (never includes password or reset hashes)."""
    return {
        "id": user_row["id"],
        "name": user_row["name"],
        "email": user_row["email"],
        "role": user_row["role"],
        "designation": user_row["designation"] or "",
        "team": user_row["team"] or "Analytics & BI",
        "userType": user_row["user_type"] or "employee",
        "previousField": user_row["previous_field"] or "",
        "managerId": user_row["manager_id"],
        "active": bool(user_row["active"]),
        "mustChangePassword": bool(user_row["must_change_password"]),
        "forcePasswordChange": bool(user_row["force_password_change"]),
        "accountStatus": compute_account_status(user_row),
        "createdAt": user_row["created_at"],
        "lastLogin": user_row["last_login"],
        "isDemo": bool(user_row["is_demo"]),
    }


def add_activity_log(
    conn: sqlite3.Connection,
    tool: str,
    message: str,
    manager_id: str | None = None,
    employee_id: str | None = None,
) -> None:
    """Record a [Notify Tool] or agent event in SQLite."""
    import secrets

    log_id = f"log_{int(utc_now().timestamp() * 1000)}_{secrets.token_hex(2)}"
    conn.execute(
        """
        INSERT INTO agent_activity_log (id, tool, manager_id, employee_id, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (log_id, tool, manager_id, employee_id, message, utc_now_iso()),
    )


def add_notification(
    conn: sqlite3.Connection,
    *,
    notif_type: str,
    audience: str,
    message: str,
    employee_id: str | None = None,
    employee_name: str | None = None,
    manager_id: str | None = None,
    notify_hr: bool = True,
    sender_role: str | None = None,
    course_id: str | None = None,
    course_title: str | None = None,
    certification_name: str | None = None,
    completed_on: str | None = None,
) -> dict[str, Any]:
    """Insert a notification row into SQLite and return it serialized."""
    import secrets

    notif_id = f"notif_{int(utc_now().timestamp() * 1000)}_{secrets.token_hex(3)}"
    created_at = utc_now_iso()
    conn.execute(
        """
        INSERT INTO notifications (
            id, type, audience, notify_hr, employee_id, employee_name, manager_id,
            sender_role, course_id, course_title, certification_name, completed_on,
            message, created_at, read
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (
            notif_id,
            notif_type,
            audience,
            1 if notify_hr else 0,
            employee_id,
            employee_name,
            manager_id,
            sender_role,
            course_id,
            course_title,
            certification_name,
            completed_on,
            message,
            created_at,
        ),
    )
    return {
        "id": notif_id,
        "type": notif_type,
        "audience": audience,
        "notifyHR": notify_hr,
        "employeeId": employee_id,
        "employeeName": employee_name,
        "managerId": manager_id,
        "senderRole": sender_role,
        "courseId": course_id,
        "courseTitle": course_title,
        "certificationName": certification_name,
        "completedOn": completed_on,
        "message": message,
        "createdAt": created_at,
        "read": False,
    }


def check_and_record_reset_rate_limit(
    conn: sqlite3.Connection, email: str, ip_addr: str
) -> bool:
    """Return True if within rate limits (<=3/hr per email and <=10/hr per IP), False if exceeded."""
    cutoff = (utc_now() - timedelta(hours=1)).isoformat()
    conn.execute("DELETE FROM password_reset_rate_limits WHERE created_at < ?", (cutoff,))

    email_key = f"email:{email.strip().lower()}"
    ip_key = f"ip:{(ip_addr or 'unknown').strip()}"

    email_cnt = conn.execute(
        "SELECT COUNT(*) AS cnt FROM password_reset_rate_limits WHERE limit_key = ? AND created_at >= ?",
        (email_key, cutoff),
    ).fetchone()["cnt"]
    ip_cnt = conn.execute(
        "SELECT COUNT(*) AS cnt FROM password_reset_rate_limits WHERE limit_key = ? AND created_at >= ?",
        (ip_key, cutoff),
    ).fetchone()["cnt"]

    if email_cnt >= 3 or ip_cnt >= 10:
        return False

    now_iso = utc_now_iso()
    conn.execute(
        "INSERT INTO password_reset_rate_limits (limit_key, created_at) VALUES (?, ?)",
        (email_key, now_iso),
    )
    conn.execute(
        "INSERT INTO password_reset_rate_limits (limit_key, created_at) VALUES (?, ?)",
        (ip_key, now_iso),
    )
    return True
