# SkillSync AI — Employer Upskilling & Onboarding Agent

A multi-page, AI-guided corporate upskilling and new-joiner onboarding platform built with HTML/CSS/JavaScript (`localStorage`-persisted state) and a stateless Flask backend for static serving and optional Gemini AI integration.

## Multi-Page Flow

1. **Profile Setup (`/` or `index.html`)** — 4-step wizard for employees and new joiners: user type (`Employee` or `Other` with optional previous non-tech field), target role & company priority, multi-select skills with 1–5 star ratings, experience level, and weekly learning slots.
2. **Diagnostic Quiz (`/quiz` or `quiz.html`)** — Mandatory 5-question verification gate (3 Easy + 2 Hard per selected skill, 60s timer, resume on refresh) before unlocking roadmaps and courses.
3. **Skill Gap & 6-Week Plan (`/analyzer` or `analyzer.html`)** — Personalized AI gap insight, skill-match percentage, interactive Radar & Bar comparison charts, and a 6-week upskilling plan.
4. **Courses & Progress (`/courses` or `courses.html`)** — Curated courses with explainable "Why this course?" cards and live `Not Started → In Progress → Completed` tracking.
5. **Manager & HR Dashboard (`/dashboard` or `dashboard.html`)** — Team/org heatmaps, employee type badges (`Employee` / `New joiner / Other`) & filters, ROI analytics, and nudges.

## Quick Start

```bash
python app.py
```

Then open [http://127.0.0.1:5050](http://127.0.0.1:5050) in your browser. All learner profiles, test results, and course progress persist in browser `localStorage`.

## Run Tests

```bash
python -m pytest -v
```
