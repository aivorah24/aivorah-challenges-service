# Aivorah Challenges Service

Standalone microservice for Aivorah Challenges — listing, assignment, quiz
completion, and leaderboard — extracted from `ai-mentor/server`.

## Structure

```
routes/
  challenges.js       — thin route handlers only:
                         GET /, GET /assigned, GET /new-count,
                         POST /assign, POST /unassign,
                         POST /:assignmentId/complete, GET /leaderboard
services/
  challenges.js        — data-access + domain logic:
                          getChallenges / getChallengeById (fetch + row mapping),
                          attachImageUrl (Cloudinary/local image resolution),
                          computeLevel (XP -> level curve), isPastDue,
                          notifyChallengeAssigned (push + parent message)
  push.js               — Expo push notification sender
  supabase.js           — Supabase client
data/
  cloudinary_urls.json  — local-path -> Cloudinary CDN URL map for challenge images
```

`services/challenges.js` is kept scoped to what's actually shared/reusable
(data-access, image resolution, notifications) — new business logic that
doesn't fit that shape should get its own file rather than growing this one
into a catch-all.

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3008`).

Note: `attachImageUrl` falls back to a local
`data/images/challenges/{id}.png` path when a challenge has no Cloudinary
URL yet — that images folder (~40MB) isn't bundled in this repo. In
practice every published challenge should have a Cloudinary URL in
`data/cloudinary_urls.json`, so this fallback rarely matters; only fetch/
copy the local images folder from `ai-mentor/server/data/images/challenges/`
if you hit a real gap.

## Endpoints

- `GET /challenges?grade=&curriculum=&studentId=` — list, with per-student assignment status if studentId given
- `GET /challenges/assigned?studentId=` — a student's assigned challenges
- `GET /challenges/new-count?studentId=&since=` — unread assignment count
- `POST /challenges/assign` — assign a challenge to a student (grade-guarded, notifies student + parent)
- `POST /challenges/unassign` — remove an assignment
- `POST /challenges/:assignmentId/complete` — submit a score, awards XP, updates student_stats
- `GET /challenges/leaderboard?grade=&limit=` — ranked leaderboard
- `GET /health`

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR (see `.github/PULL_REQUEST_TEMPLATE.md`).
