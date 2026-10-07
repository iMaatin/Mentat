---
description: "Solve a task via Mentat's two-layer flow: local mock bundle → cloud worker → local reintegration."
---

Task: $ARGUMENTS

You are executing the Mentat two-layer flow. Follow these steps EXACTLY, in order. (You are the Layer-1 local gatekeeper; real code/data stays with you.)

1. **Verify local model.** Run `mentat_status`. If LM Studio is down, stop and tell the user to start it (local server on port 1234 + a loaded model). If the current session model is a cloud model, stop and ask the user to switch to an `lmstudio/*` model via `/models` first.

2. **Gather real context (local tools OK).** Use read/grep/glob to find the relevant real files and datasets for the task above. Note any proprietary terms the task needs (client names, codenames, internal hosts) — you will pass them as `entities`.

3. **Prepare the mock bundle.** Call `mentat_prepare` with:
   - `task`: the task restated against REAL names (the tool rewrites them; be precise),
   - `files`: the real code files involved,
   - `dataFiles`: the real CSV datasets involved (if any),
   - `entities`: proprietary terms from step 2.
   If the tool throws a leak error, NOTHING was sent anywhere: rephrase per its message and retry.

4. **Ask the cloud (mock only).** Call the `task` tool with `subagent_type: "mentat-cloud"` and the ENTIRE mock prompt from step 3 as `prompt`, VERBATIM. Add NOTHING — no preamble, no real names, no file attachments. (A deterministic hook re-scans this prompt and blocks on any leak.)

5. **Reintegrate.** Call `mentat_reintegrate` with the `bundleID` and the cloud's VERBATIM output. Review its warnings.

6. **Apply + verify.** Apply the real-space changes via edit/write tools, run the relevant tests/linters, and summarize what changed for the user.
