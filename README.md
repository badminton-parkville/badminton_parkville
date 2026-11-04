# Badminton signups

A minimal weekly signup page for a badminton session.

- **Attendees** (`index.html`) register each week with name + email and can drop out. They never see their queue position or whether they got a spot; they find out by email.
- **Organiser** (`admin.html`, password protected) creates sessions, ticks the playing list, generates invite / waitlist / payment emails and calendar invites, records attendance, and reviews everyone's queue priority.

## How it fits together

```
GitHub Pages (static)                 Cloudflare Worker (free tier)
index.html  admin.html  assets/  ──►  worker/src/index.js  ──►  D1 (SQLite)
```

GitHub Pages only serves static files, so it can't store signups or keep admin data private. The small API in `worker/` does that. The admin password is checked **on the server**: without it, the admin API returns nothing. The admin page itself is public HTML but shows nothing until you sign in, and it isn't linked from the attendee page.

## Rules it implements

- **Registration** opens at the time the organiser sets and closes when the session starts. Timestamps come from the server.
- **Queue order** = priority (high first), then registration time (first come, first served). Priority works like Slurm's multifactor scheduling:
  - **+ miss bonus** for each consecutive time on the waitlist since last playing. Regulars who register early can't crowd out the same people every week.
  - **− penalty** for each dropout or no-show the organiser flagged as invalid within the penalty window.
  - **− fair-share** (optional, off by default) for each session played recently.
  - **+/− manual adjustment** per person.

  You can change every weight in Settings. Set them all to 0 for pure first come, first served.
- **After signing up**, attendees see a message (editable in Settings) explaining they'll be emailed if successful, the drop-out deadline, and that people who don't drop out are charged and lose priority.
- **Dropouts:** free until the drop-out deadline (default: 1 business day before the session). Every drop-out asks for confirmation first. After the deadline the normal button is greyed out and attendees must give a reason. The organiser sees late dropouts with their reasons and can tick “invalid”, which lowers that person's priority and marks them as owing the fee. A late dropout from someone who was only on the waitlist is still recorded as a normal dropout.
- **Organiser override:** add anyone to any session at any time, even before registration opens or when the session is full. Attendees can't see who was added this way.
- **Waitlist history** is counted from sessions where the organiser pressed **Confirm list**. Anyone registered but not ticked counts as waitlisted.
- Attendees get a private manage link (saved in their browser and copyable) so they can drop out from another device. No accounts are needed.

## Weekly organiser workflow

1. **Sessions → Duplicate +1 week** (or **New session**). The times, registration opening and drop-out deadline all shift together.
2. People register. Open the session to watch the queue (sorted by priority, with a dashed line at capacity).
3. Press **Tick top N**, adjust if you want, then press **Confirm list**.
4. **Emails → Invite**: open the email in your mail app (everyone in Bcc), or copy the parts. Then use **Outlook calendar** / **Google Calendar** / **.ics** for the calendar invite. Press **Mark as sent**.
5. Optionally, **Emails → Waitlist** tells the others they missed out.
6. If someone drops out, tick the next person, press **Save list**, and send the invite to “only people not yet emailed”.
7. After the session, tick **Attended** (or press **Mark all ticked as attended**) and flag any no-shows as **Invalid**. Then use **Emails → Payment**: it goes to everyone who attended plus anyone flagged invalid. The app only writes the email; it never handles money.
8. As people pay, tick **Paid**. For reminders, choose **Emails → Payment → Not yet paid**.

The **People** tab lists everyone's priority, times played, times waitlisted, current miss streak, invalid/no-show/excused counts, sessions still unpaid and private notes.

**Records:** every past session stays in the admin Sessions list unless you delete it. For spreadsheets:
- **Session → Export CSV:** that session's registrations, including queue rank and priority.
- **People → Export full history CSV:** every registration ever, with session, timestamps, outcome (played / waitlisted / dropped out), drop-out reason, attendance, invalid, emails sent and paid date.
- **People → Export people CSV:** the per-person summary.

## Setup (one time, about 15 minutes)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js.

### 1. API (Cloudflare Worker + D1)

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create badminton
```

Paste the printed `database_id` into `worker/wrangler.toml`, and set `ALLOWED_ORIGINS` to your Pages origin (e.g. `https://badminton-parkville.github.io`). Then:

```bash
npm run db:init:remote
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

The deploy prints a URL like `https://badminton-parkville-api.<you>.workers.dev`.

### 2. Frontend (GitHub Pages, in the `badminton-parkville` organisation)

1. Put the Worker URL into `PROD_API` in `config.js`.
2. Move the repository into the organisation: on GitHub, open the repo's **Settings → General → Danger Zone → Transfer ownership** and choose `badminton-parkville`. Optionally rename the repo to `badminton-parkville.github.io` for the shortest address. Then point your local copy at the new location:
   ```bash
   git remote set-url origin git@github.com:badminton-parkville/<repo-name>.git
   ```
3. Push. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, `main`, `/ (root)`.
4. The pages will be at:
   - repo named `badminton-parkville.github.io`: `https://badminton-parkville.github.io/` (organiser page: `/admin.html`);
   - any other repo name: `https://badminton-parkville.github.io/<repo-name>/` (organiser page: `admin.html` under that path).

   Either way `ALLOWED_ORIGINS` stays `https://badminton-parkville.github.io`.
5. Add other organisers as organisation owners so the site can be handed over without moving anything.
4. Sign in to the admin page and fill in **Settings**: organiser name/email, payment details and templates.

To change the password, run `npx wrangler secret put ADMIN_PASSWORD` again. This also signs out every admin session.

## Local development

```bash
cd worker
echo 'ADMIN_PASSWORD=some-local-password' > .dev.vars
npm run db:init:local
npm run dev                            # API on http://localhost:8787
```

```bash
python3 -m http.server 8000            # in the repo root; open http://localhost:8000
```

When the page is served from localhost, `config.js` points at `localhost:8787` automatically.

## Updating an existing database

If you created the database before the **Paid** feature was added, add the new column once:

```bash
npx wrangler d1 execute badminton --remote --command "ALTER TABLE registrations ADD COLUMN paid_at TEXT"
```

(Use `--local` instead of `--remote` for your local test database.)

## Notes and limits

- Times are entered in the organiser's browser timezone and shown in the club timezone (Settings, default `Australia/Melbourne`). The admin page warns you if the two differ.
- “Business day” skips weekends only, not public holidays. You can edit the deadline per session.
- Admin sign-in lasts 12 hours per browser tab. Ten wrong passwords lock sign-in for 15 minutes.
- Anyone who knows an attendee's email can't act as them: dropping out needs the private manage link. If someone loses their link, the organiser can remove or restore them.
- Both HTML pages have an empty `<meta name="extra" content="">` tag in `<head>` that you can fill with anything.
- Free-tier limits (100k requests/day, 5 GB of D1 storage) are far beyond what a club needs.
