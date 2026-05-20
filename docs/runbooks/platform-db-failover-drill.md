# Platform DB Failover — Quarterly Drill

**Purpose:** Verify the failover script works and the on-call human knows the runbook. Never your first time doing this in a real incident.

## Cadence

Quarterly. Schedule on the team calendar.

## Window

Pick a low-traffic window (weekend morning UTC). Announce 24h in advance in your team incident channel.

## Procedure

1. Run `status` — record the current state.
2. Execute `promote` — record the wall-clock time of each step from script output.
3. Verify the dashboard works on the standby (login, list apps, view billing).
4. Wait 5 minutes — verify nothing automatically reverted.
5. Run `failback` (the original primary will need to be re-replicated first; have the Neon UI ready).
6. Verify dashboard works again on the original primary.
7. Record total elapsed time + any issues.

## Recording

After the drill, append to this file:

```markdown
## YYYY-MM-DD drill results
- Operator: <name>
- Total elapsed: NN minutes
- Promote: NN seconds (target: < 8 min including human prompts)
- Failback: NN seconds
- Issues: <any unexpected behavior>
- Action items: <any runbook updates required>
```

## Pass criteria

- Total promote elapsed < 10 minutes (including human prompts).
- No data loss (synthetic write check passes).
- Dashboard usable on the promoted side within 60s of the script completing.

If any criterion fails, the failover capability is not production-ready — fix before the next drill.
