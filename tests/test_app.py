"""Tests for SkillSync AI Flask routes, static serving, and AI fallback API."""

from __future__ import annotations

import re

import pytest

from app import create_app


@pytest.fixture()
def client():
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def test_health_endpoint(client) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["status"] == "ok"


def test_pages_and_assets_served(client) -> None:
    for path in [
        "/",
        "/index.html",
        "/quiz",
        "/quiz.html",
        "/analyzer",
        "/analyzer.html",
        "/courses",
        "/courses.html",
        "/dashboard",
        "/dashboard.html",
        "/tests.html",
        "/css/styles.css",
        "/js/data.js",
        "/js/questions.js",
        "/js/storage.js",
        "/js/engine.js",
        "/js/nav.js",
        "/js/chart.js",
        "/js/quiz.js",
        "/js/dashboard.js",
        "/js/page-profile.js",
        "/js/page-analyzer.js",
        "/js/page-courses.js",
    ]:
        resp = client.get(path)
        assert resp.status_code == 200, f"Expected 200 for {path}, got {resp.status_code}"


def test_ai_explain_fallback(client, monkeypatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    resp = client.post(
        "/api/ai-explain",
        json={
            "roleName": "Junior Data Analyst",
            "companyPriority": "Dashboards",
            "courses": [
                {
                    "courseId": "mslearn-powerbi-start",
                    "title": "Power BI Essentials",
                    "skillName": "Power BI",
                    "currentPct": 40,
                    "targetPct": 80,
                    "isPriorityMatch": True,
                },
                {
                    "courseId": "coursera-applied-stats",
                    "title": "Applied Statistics for Data Analytics",
                    "skillName": "Statistics",
                    "currentPct": 55,
                    "targetPct": 80,
                    "isPriorityMatch": False,
                },
            ],
        },
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["source"] == "fallback"
    assert "40%" in data["explanations"]["mslearn-powerbi-start"]
    assert "80%" in data["explanations"]["mslearn-powerbi-start"]
    assert "Dashboards" in data["explanations"]["mslearn-powerbi-start"]
    assert "55%" in data["explanations"]["coursera-applied-stats"]


def test_ai_explain_rejects_bad_payload(client) -> None:
    resp = client.post("/api/ai-explain", data="not-json", content_type="text/plain")
    assert resp.status_code == 400


def test_index_has_no_student_option(client) -> None:
    resp = client.get("/index.html")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)

    select_match = re.search(
        r'<select[^>]*id=["\']select-user-type["\'][^>]*>(.*?)</select>',
        html,
        re.IGNORECASE | re.DOTALL,
    )
    assert select_match is not None, "Expected #select-user-type selector in index.html"
    select_body = select_match.group(1)

    option_values = re.findall(
        r'<option[^>]*value=["\']([^"\']*)["\']', select_body, re.IGNORECASE
    )
    assert option_values == ["employee", "other"]
    assert "student" not in select_body.lower()
    assert re.search(r'<option[^>]*value=["\']?student["\']?', html, re.IGNORECASE) is None


def test_ai_explain_other_non_tech_fallback(client, monkeypatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    resp = client.post(
        "/api/ai-explain",
        json={
            "roleName": "Junior Data Analyst",
            "companyPriority": "Dashboards",
            "userType": "other",
            "previousField": "Retail",
            "courses": [
                {
                    "courseId": "mslearn-powerbi-start",
                    "title": "Power BI Essentials",
                    "skillName": "Power BI",
                    "currentPct": 40,
                    "targetPct": 80,
                    "isPriorityMatch": True,
                }
            ],
        },
    )
    assert resp.status_code == 200
    explanation = resp.get_json()["explanations"]["mslearn-powerbi-start"]
    assert "Retail" in explanation
    assert "fundamentals" in explanation.lower()


def test_courses_and_dashboard_return_200(client) -> None:
    for path in ["/courses.html", "/dashboard.html"]:
        resp = client.get(path)
        assert resp.status_code == 200
        html = resp.get_data(as_text=True)
        assert len(html) > 0
