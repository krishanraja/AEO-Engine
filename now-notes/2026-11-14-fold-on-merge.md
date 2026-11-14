Status: closeout notes now fold into NOW.md after every merge: auto-merge.yml starts .github/workflows/closeout-fold.yml on main by workflow_dispatch, because the merge's own push, made with the Actions token, starts no workflow and the generated fold in harness-repository-context.yml ran only on a push (five notes had waited on main).
Next: after the next auto-merge, read back that closeout-fold.yml ran and now-notes/ is empty on main.
North Star check (2026-11-14): holds.
