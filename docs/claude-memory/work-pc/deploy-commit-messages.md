---
name: deploy-commit-messages
description: "Whenever I tell the user to deploy the API and/or Gateway (or any repo), name each deployable and give its ready-to-paste commit message"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6c8f2208-a80c-480b-9c6d-6e8aa7e452a2
  modified: 2026-09-30T05:17:16.573Z
---

Every time I hand the user a deploy step, I list each repo to deploy **by name** (repo + deploy
path, e.g. myInsurAPI = `/Fire`, Bantu2u_APIGateway = `/SelamatFire`, see [[deploy-reality]]) with a
**ready-to-paste commit message** for that repo, in the deploy order. Same for the Admin Web or an
app if it is part of the deploy.

**Why:** user asked on 2026-09-30: "every time u gimme a code to deploy api and gateway include the
commit message as well". The user commits and deploys themselves, so a deploy step without the
message makes them come back and ask.

**How to apply:** build the message from `git status` / `git diff --stat` of THAT repo (only what
is uncommitted there), in the repo's own short style (e.g. "Add Spin the Wheel routes"), one line,
no attribution trailer unless asked. Never commit or push myself (see [[workspace-source-docs]]).
