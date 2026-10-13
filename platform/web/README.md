# platform/web (placeholder)

The ATL single-page app (React + Vite) specified by `docs/platform/08-ui-design.md` and laid out in 01 §13
(`web/src/app`, `auth`, `api`, `features/*`, `verify/index.html`, `public/config.json`). Not implemented in this round.

Data contracts it will use are already in `@atl/shared`: the route table (`ROUTES`, `matchRoute`), session states,
event types, error codes and the lab.yaml v2 types. Routes that 08 §9.2 asks for but 01 has not registered yet are listed
in `UI_REQUESTED_ROUTES` and must not be called before 01 registers them.
