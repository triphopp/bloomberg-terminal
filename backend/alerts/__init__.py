"""
Alert Rule Engine — boolean-algebra alerts for the WATCHLIST.

See memory/plans/alert-rule-engine.md for the design. This package holds only
the parts that don't need a running FastAPI app: AST + evaluator (phase 1).
CRUD storage, the scan engine, and the router land in phase 2.
"""
