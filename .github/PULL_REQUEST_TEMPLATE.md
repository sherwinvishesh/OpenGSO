**What this changes, and why**


**Checks** (see [CONTRIBUTING.md](../CONTRIBUTING.md))

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run check:bundles`
- [ ] `npm run check:packages`
- [ ] A changeset that names every affected package by hand, if `packages/core` changed
- [ ] Docs updated where they state a fact this changes
- [ ] Any new user-facing string is in `packages/core/src/shared/errors.js`
- [ ] No new runtime dependency, and nothing new in `opengeo-prod`'s library that reads the disk
      per request, calls a provider, or blocks a bot
