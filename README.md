# Discover Kashmir — Content API

Fastify + Prisma + Postgres backend that replaces the static JSON files the
website used to read from `discoverKashmir-NEXTjs/Data/`.

It owns packages, destinations, blogs, testimonials, hero slides, districts and
site settings. It does **not** touch payments — `api.thediscoverkashmir.in` still
owns the CCAvenue handshake and is left alone.

```
DK/
├── backend/                  ← this service
└── discoverKashmir-NEXTjs/   ← public site + admin UI (separate deploy)
```

---

## Setup

### 1. Database

Create a Postgres database on [Neon](https://neon.tech) (free tier is enough).
Copy both connection strings from the dashboard — the pooled one (contains
`-pooler`) and the direct one.

### 2. Environment

```bash
cp .env.example .env
```

Fill in at minimum `DATABASE_URL`, `DIRECT_URL` and `JWT_SECRET`. Generate a
secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The process refuses to start if anything required is missing or malformed —
you get a readable list of problems rather than a confusing runtime failure.

### 3. Install, migrate, seed

```bash
npm install
npm run prisma:migrate -- --name init   # creates the tables
npm run seed                            # imports the existing JSON content
npm run dev                             # http://localhost:4000
```

Interactive API docs: **http://localhost:4000/docs**

The seed is idempotent — safe to re-run. It prints every URL it preserved.

---

## The one rule that matters: slugs

The old frontend generated URLs with `slugify(name).toLowerCase()`, which leaves
apostrophes and colons in place:

```
/travelblogs/trekking-in-kashmir:-kashmir-is-trekker's-delight
```

Those exact strings are reproduced by the seed so **every already-published URL
keeps working**. Content created from now on gets clean, strict slugs instead
(`src/lib/slug.ts`). Slugs are editable in the admin, so ugly legacy ones can be
cleaned up deliberately — with a redirect — rather than by accident.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode on port 4000 |
| `npm run build` | `prisma generate` + compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Types only, no output |
| `npm run seed` | Import `../discoverKashmir-NEXTjs/Data/*.json` |
| `npm run prisma:migrate` | Create/apply a migration in development |
| `npm run prisma:deploy` | Apply migrations in production |
| `npm run prisma:studio` | Browse the database in a GUI |

---

## API shape

Everything is under `/api/v1`. Public `GET` routes serve the website and return
only published rows. Everything under `/admin` needs a bearer token and sees
drafts too.

```
POST   /auth/login                     → { token, user }
GET    /auth/me
POST   /auth/change-password

GET    /packages                       ?page&perPage&q
GET    /packages/:slug
GET    /package-defaults
GET    /destinations       /destinations/:slug
GET    /blogs              /blogs/:slug
GET    /districts  /testimonials  /hero-slides  /settings

GET    /admin/<resource>               ?published=false to list drafts
POST   /admin/<resource>
PATCH  /admin/<resource>/:id
DELETE /admin/<resource>/:id
POST   /admin/<resource>/reorder       { items: [{ id, sortOrder }] }

PUT    /admin/packages/:id/tour-plan   replaces the whole plan atomically
PUT    /admin/packages/:id/list-items  replaces one kind of list
PUT    /admin/package-defaults
PUT    /admin/settings
POST   /admin/uploads                  multipart, field name "file"
DELETE /admin/uploads                  { url }

GET    /health                         liveness + database check
```

Errors are always the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }
```

---

## How it is put together

```
src/
├── config/env.ts        zod-validated environment, fails fast on boot
├── lib/                 prisma · errors · sanitize · slug · storage · revalidate
├── plugins/             auth (JWT) · central error handler
├── core/crud.ts         ← the reusable CRUD factory
├── modules/             one config block per content type
├── app.ts               builds the instance (no port binding)
└── server.ts            binds the port, handles graceful shutdown
```

**`core/crud.ts` is the point of the whole design.** Packages, destinations,
blogs, testimonials, hero slides and districts differ only in their schema and a
few flags, so they share one implementation. Adding a content type is a Prisma
model, a zod schema and a config block — no new handlers. Fixing a pagination or
permission bug fixes it for all six at once.

A few decisions worth knowing:

- **HTML is sanitised on write, not on read** (`lib/sanitize.ts`). The database
  can never hold a stored-XSS payload, so every consumer is safe without having
  to remember to sanitise. Rich-text fields allow a small tag allowlist matching
  what the editor produces; plain-text fields are stripped entirely.
- **Package inclusion/exclusion lists fall back to global defaults.** Rows with
  `packageId = null` are the defaults, preserving how `MorePackageDetails.json`
  applied to every package. Define items on a package and they override the
  defaults *for that kind only*. Public reads resolve this server-side and return
  a ready-to-render `lists` object.
- **Tour plans and lists are replace-the-whole-collection, in a transaction.**
  The admin edits an ordered list and saves once, so a single atomic replace
  matches what the user did and the stored order can never disagree with what
  they saw.
- **Images are one complete path string.** Legacy files keep their
  `/Assets/Images/...` paths and only new uploads become Blob URLs. Both forms
  coexist and the site renders whatever it is given — so there is no bulk image
  migration to perform.
- **Login is timing-safe.** An unknown email is compared against a dummy hash so
  a failed login takes the same time either way and the endpoint cannot be used
  to discover which accounts exist.

---

## Connecting the Next.js site

### Public pages

Point `getStaticProps` at this API instead of reading `Data/*.json`, and switch
the three dynamic routes to look up **by slug** — today they take no `params`,
ship the whole dataset into every page and pick a record client-side from a
`?id=` querystring. `[destination].js` indexes a raw array, so once an admin can
delete rows those URLs would silently point at the wrong place.

```js
const res  = await fetch(`${process.env.API_URL}/packages/${params.package}`);
if (!res.ok) return { notFound: true };
return { props: { pkg: await res.json() }, revalidate: 300 };
```

Use `fallback: 'blocking'` in `getStaticPaths` so new content appears without a
rebuild.

### Instant publishing

Add `pages/api/revalidate.js` to the Next app:

```js
export default async function handler(req, res) {
  if (req.headers['x-revalidate-secret'] !== process.env.REVALIDATE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { paths = [] } = req.body;
  await Promise.all(paths.map((p) => res.revalidate(p).catch(() => {})));
  return res.json({ revalidated: paths });
}
```

Set the same `REVALIDATE_SECRET` on both sides plus `FRONTEND_REVALIDATE_URL`
here, and a save in the admin refreshes the affected pages within seconds. The
ping is fire-and-forget: if the site is down the save still succeeds.

### Admin auth

Wrap `POST /auth/login` in a NextAuth Credentials provider, keep the returned
token in the session, and send it as `Authorization: Bearer <token>` on admin
calls. Session handling stays in the frontend; this API stays stateless.

### Images

Add the Blob hostname to `next.config.js` — it currently has no `images` key at
all, so `next/image` will reject uploaded URLs:

```js
images: {
  remotePatterns: [{ protocol: 'https', hostname: '*.public.blob.vercel-storage.com' }],
}
```

---

## Deployment

Any Node host works (Railway, Render, Fly, a VPS). Build with `npm run build`,
run `npm run prisma:deploy`, start with `npm start`.

- Set `CORS_ORIGINS` to the real site and admin origins — the default only
  allows `localhost:3000`.
- Point `DATABASE_URL` at Neon's **pooled** connection; serverless platforms
  exhaust direct connections quickly.
- `/health` is the readiness probe. It returns 503 when Postgres is unreachable.
- Rate limits are per-IP with `trustProxy` on: 300 req/min globally, 10/min on
  login, 5/min on password change.

## Security checklist before going live

- [ ] Change the seeded admin password (`POST /auth/change-password`)
- [ ] `JWT_SECRET` is long and random, and not the example value
- [ ] `CORS_ORIGINS` lists only real origins
- [ ] **Rotate the CCAvenue working key** — it is committed in the Next repo at
      `pages/api/ccavenueResponse.js:10` and that repo is public. Unrelated to
      this service, but it is a live payment credential.
