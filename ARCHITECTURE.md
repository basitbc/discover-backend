# API Architecture

## The shape

Four layers, each depending only on the one below it.

```
HTTP        crud.routes.ts · auth.routes.ts · uploads.routes.ts
              status codes, zod validation, bearer-token guard
                          │
BUSINESS    base.service.ts · packages.service.ts
              slugs, sanitisation, publish rules, pagination, search
                          │
DATA        base.repository.ts
              the ONLY place that talks to Prisma
                          │
            Postgres (Neon)
```

Cross-cutting concerns sit beside the stack, not inside it: `config/env.ts`
(validated once at boot), `plugins/` (auth, central error handler), `lib/`
(sanitise, slug, storage, revalidate, errors).

## Request flow

```
POST /api/v1/admin/packages
  ├─ plugins/auth        verify JWT, reject 401
  ├─ crud.routes         validate body against zod → 400 with field errors
  ├─ base.service        sanitise HTML, derive unique slug
  ├─ base.repository     prisma.package.create
  ├─ crud.routes         201 + row
  └─ lib/revalidate      fire-and-forget ping to the Next site
```

## Why these seams

**Repository is the only Prisma caller.** Adding a read replica, a query cache,
or swapping the ORM is a change to one file rather than to every route. It also
lets services be unit-tested against a fake repository with no database running.

**Services know nothing about HTTP.** No request, no reply, no status codes.
The same `PackageService` can be driven from a cron job, a CLI import, or a
queue worker without pulling in Fastify.

**Routes know nothing about the database.** They translate HTTP to service calls
and back. A permission or pagination bug is fixed once, for all six resources.

**One generic CRUD implementation, configured per resource.** Packages,
destinations, blogs, testimonials, hero slides and districts differ only in
schema and a few flags. Encoding those differences as configuration instead of
six copies of the same handlers is what keeps the codebase small.

## Extending it

Adding a content type is three things and no new handlers:

1. A model in `prisma/schema.prisma`
2. Create/update schemas in `modules/content.schemas.ts`
3. A block in `modules/content.routes.ts` wiring repository → service → routes

When a resource grows real domain logic, subclass `BaseService` rather than
adding flags to the base. `PackageService` is the worked example: it overrides
`transformForPublic` to resolve inclusion lists against the global defaults, and
inherits everything else.

## Deliberate decisions

**Sanitise on write, not on read.** Rich-text fields pass through an allowlist
before being stored, so the database can never hold a stored-XSS payload and
every consumer is safe without remembering to sanitise. The cost is that
changing the allowlist does not retroactively clean old rows.

**Public and admin reads return different shapes.** Public reads run through
`transformForPublic` so the website gets data it can render directly. Admin
reads stay raw, because an editor must see exactly what is stored — for
packages, "this has no items, so it inherits the defaults" is a state the editor
needs to see and change.

**Replace-the-collection for ordered children.** Tour plans and list items are
saved as one atomic replace inside a transaction, matching how the admin edits
them: as one ordered list, saved once. Per-row CRUD would let the stored order
disagree with what the editor saw.

**Free-text prices.** `price` and `notPrice` are strings because the real data
contains `"Whatsapp for quote"` and `"1,20,999"`. Typing them as numbers would
reject the client's own content.

**Slug is stored, not derived.** The site's URLs are the product. Deriving them
from names at render time meant a rename silently broke a live URL; storing them
makes that an explicit, editable decision.

## Scaling

The design is stateless — JWT auth, no server-side sessions — so instances scale
horizontally behind a load balancer with no shared state to coordinate.

Where the pressure will show up first, in order:

1. **Connection exhaustion.** Use Neon's *pooled* URL for `DATABASE_URL`; the
   direct URL is only for migrations. The Prisma client is a cached singleton so
   dev reloads don't leak pools.
2. **Repeated identical reads.** The public read path is the hot one. Add
   caching in the repository — that is precisely the seam it exists for. The
   global package-defaults cache (30s TTL, explicitly invalidated on write) is
   the pattern to follow.
3. **`listAll()` pagination loops.** The frontend walks pages of 100 during
   builds. Fine at this content volume; at thousands of rows, add a
   build-oriented endpoint that streams slugs only.
4. **Rate limits** are per-instance in memory. Multi-instance deployments need
   a shared store (Redis) for `@fastify/rate-limit` to be globally accurate.

## Known gaps

- **No automated tests.** The layering makes services testable without a
  database; that test suite has not been written.
- **Role checks are coarse.** `requireRole` exists and is wired, but every admin
  route currently requires only "authenticated", not ADMIN vs EDITOR.
- **No audit trail.** `updatedAt` records when a row changed, not who changed it.
