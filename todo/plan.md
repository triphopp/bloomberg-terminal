# Plan: Full repository scan & remediation plan

Problem
-------
Perform a production-grade audit of the codebase to identify technical debt, prioritized fixes, and an implementation roadmap (modularization, tests/CI, API contracts, observability, and secrets hygiene).

Approach
--------
- Static and manual review of core backend (backend/main.py), frontend atoms/hooks, and app routes.
- Produce prioritized todos with small, verifiable deliverables and clear owners.
- Add CI for linting/tests, add unit/integration tests, and implement monitoring and secret validation.

Scope
-----
- Code quality and architecture risks
- State-management and concurrency issues
- Backend modularization and API contracts
- Tests and CI coverage gaps
- Observability and secrets handling

Todos
-----
- repo-scan: Run automated static checks and create a detailed findings file (lint, types, TODOs/FIXMEs, large files).
- modularize-backend: Break backend/main.py into modules (routes, services, utils) and add unit tests for each module.
- replace-global-state: Refactor GlobalState usage into explicit service/atom APIs; remove mutable singletons and ensure timers are managed by hooks/services.
- add-tests-ci: Add GitHub Actions (or other) to run Biome linting, typecheck, unit tests, and build on PRs.
- add-api-contracts: Create OpenAPI/JSON Schema for backend routes and generate TypeScript client types.
- observability-secrets: Add structured logging, health/metrics endpoints, env var validation, and secret rotation guidance.

Notes & Risks
------------
- Modularization may require small backwards-compatible adapters to avoid breaking frontend expectations.
- Tests require mocking external APIs (Alpha Vantage, Upstash) — add fixtures and local test servers.

Next steps
----------
Select an action below to proceed: run the repo scan first (recommended), or start with CI/tests.
