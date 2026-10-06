---
name: jarvis-usage-command-facts
description: "Facts about Claude Code usage limits as JARVIS reads them: /usage costs nothing and prints session and weekly percentages; the SDK rate_limit_event carries the same numbers; a silent start reports nothing; a real request costs about 5-10 cents"
metadata:
  node_type: reference
  type: reference
  originSessionId: cdf91711-015f-424f-9f18-24c835fdc75a
  modified: 2026-10-06T16:53:40.450Z
---

Checked on 2026-10-07 on the user's account (Max plan):

- `/usage` sent through the agent SDK (`query({ prompt: '/usage', ... })`) runs locally: result cost 0, about 2 seconds. It prints three lines, "Current session: N% used · resets <date> (<tz>)", "Current week (all models): ...", "Current week (Fable): ...", then "What's contributing to your limits usage?" with "Last 24h · N requests · M sessions" and "X% of your usage was at >150k context" (same for "Last 7d"). src/limits.mjs parses this.
- The SDK emits `rate_limit_event` with `rate_limit_info.unifiedWindows` ({five_hour, seven_day, ...} each with `utilization` as a fraction 0..1 and `resetsAt` in Unix seconds) and `overageStatus` / `overageDisabledReason`. It arrives after a request starts, not on an idle start: a silent session with no message gave no event in 60 seconds.
- A real one-word request ("Reply with exactly the word OK") cost about $0.05 to $0.10 of estimated usage. Test probes that send a model message cost money; `/usage` does not.
- The product split on the claude.ai usage page ("This week's usage by product") is not exposed to apps; do not invent it.
- Tool note: in Git Bash, `claude.exe -p "/usage"` gets rewritten to a path (`C:/Program Files/Git/usage`) and the model answers that instead. Use PowerShell, or `MSYS_NO_PATHCONV=1`, for slash arguments.

**How to apply:** when the user asks about usage or limits, read the cached reading (`usage:limits`) and refresh with `/usage` (free) rather than a model call. See [[jarvis-feature-sprint]].
