# SkillSync AI — Employer Upskilling & Onboarding Agent

A multi-page, AI-guided corporate upskilling and new-joiner onboarding platform built with HTML/CSS/JavaScript (`localStorage`-persisted state) and a stateless Flask backend for static serving and optional Gemini AI integration.

## Multi-Page Flow

1. **Profile Setup (`/` or `index.html`)** — 4-step wizard for employees and new joiners: user type (`Employee` or `Other` with optional previous non-tech field), target role & company priority, multi-select skills with 1–5 star ratings, experience level, and weekly learning slots.
2. **Diagnostic Quiz (`/quiz` or `quiz.html`)** — Mandatory 5-question verification gate (3 Easy + 2 Hard per selected skill, 60s timer, resume on refresh) before unlocking roadmaps and courses.
3. **Skill Gap & 6-Week Plan (`/analyzer` or `analyzer.html`)** — Personalized AI gap insight, skill-match percentage, interactive Radar & Bar comparison charts, and a 6-week upskilling plan.
4. **Courses & Progress (`/courses` or `courses.html`)** — Curated courses with explainable "Why this course?" cards, live `Not Started → In Progress → Completed` tracking, certification badges ("Certificate included" / "No certificate"), optional "Prioritize certified courses" ranking toggle, and a certification-only filter.
5. **Manager & HR Dashboard (`/dashboard` or `dashboard.html`)** — Team/org heatmaps, employee type badges (`Employee` / `New joiner / Other`) & filters, ROI analytics, nudges, sortable "Certifications completed" column with a "Verify" action, certification progress bar chart, and CSV export.

## Quick Start

```bash
python app.py
```

Then open [http://127.0.0.1:5050](http://127.0.0.1:5050) in your browser. All learner profiles, test results, and course progress persist in browser `localStorage`.

## Key Features

### Course Certifications
- Every course in the catalog has `hasCertification` (true/false) and `certificationName` when applicable.
- Courses page shows a **"Certificate included"** badge (ribbon icon + name) or a muted **"No certificate"** badge.
- Filter: **"Show only courses with certification"**; optional **"Prioritize certified courses"** ranking toggle.
- When an employee marks a certified course `Completed`, a modal prompts for **Certificate ID** (required) and **completion date** (defaults to today). Non-certified courses complete normally.
- Certificates are saved per-employee in `localStorage` state (`certifications[employeeId]`), deduplicated by courseId. Re-completing a course updates the existing record instead of adding a duplicate.

### Manager Notifications & Notification Bell
- Completing a certified course instantly creates a notification for the **Manager** (and **HR** when HR cert-notifications are enabled).
- A **bell icon** in the nav bar for Manager/HR shows an unread count badge; clicking opens a dropdown (newest first) with per-item "Mark read", "Mark all read", and click-to-open employee detail.
- An **in-app toast** appears if the manager is active when a cert is completed.
- The employee sees: *"Certification saved. Your manager has been notified."*
- HR **Anonymise Names** mode shows "Employee #04" instead of real names in notifications.
- An `[Notify Tool]` line is appended to the **Agent Activity Log** in the dashboard for each certification alert.

### Manager / HR Dashboard Updates
- **"Certifications completed"** sortable column in the team table with ribbon icon and tooltip (e.g. "2 completed (1 verified)").
- **Filter**: "All / Has certifications / None".
- **Summary cards**: "Total certifications completed" (team total + this month).
- **Certification progress bar chart** (inline SVG) — earned vs. certified courses in plan, per employee.
- **Employee detail panel** — Certifications list (name, course, cert ID/link, date, status badge) with a **Verify** button (Manager only) that moves status from `pending_review` → `verified`.
- **CSV export** includes "Certifications Completed", "Certifications Verified", and cert details columns.

### State & Migration
- State schema v4 adds `certifications{}`, `agentActivityLog[]`, `certRankingBonus`, `hrCertNotifications`.
- Existing saved state is migrated automatically; older `userType: "student"` values are converted to `"other"`.
- Helper functions in `storage.js`: `getCertificationCount()`, `addCertification()`, `notifyManager()`, `verifyCertification()`.

## Run Tests

```bash
python -m pytest -v
```
