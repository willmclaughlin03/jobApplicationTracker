## Final Successful Path

1. Verified `chunk3Latency` existed as a clean linked worktree at `C:\tmp\job-application-tracker-chunk3Latency`.
2. Applied file edits with an escalated PowerShell replacement command because ordinary writes were denied.
3. Verified the diff was limited to:
   - `src/client/lib/api.js`
   - `src/client/lib/__tests__/api.test.js`
   - `docs/feature-memory.md`
   - `docs/fixes.md`
4. Ran the focused test with `NODE_PATH` pointing at the main workspace `node_modules`.
5. Staged and committed with escalation because linked-worktree Git metadata writes were denied.
6. Pushed `chunk3Latency` with escalation.

## Suggested Investigation Checklist

- Reproduce `apply_patch` in a Windows Codex session with and without repo-local `TEMP`/`TMP`.
- Check whether `C:\tmp` linked worktrees are really writable under the managed sandbox.
- Check whether `.git/worktrees/*` write access can be granted safely for linked worktree workflows.
- Document an official linked-worktree test command or install strategy.
- Prefer fixing the `apply_patch` sandbox path first, because it would remove most of the risky PowerShell quoting fallback work.

## Recommended Workflow Fix

Use one repo-local workspace shape for future PR branch pushes. The issue was not the `chunk3Latency` branch itself; it was the split between source files under `C:\tmp`, Git metadata under the main checkout's `.git\worktrees`, and dependencies under the main checkout's `node_modules`.

### 1. Start Codex With Repo-Local Temp Paths

```powershell
cd C:\Users\willm\job-application-tracker
$env:TEMP = "$PWD\.tmp"
$env:TMP = "$PWD\.tmp"
codex
```

### 2. Put Clean PR Worktrees Under `.tmp/worktrees`

Prefer this shape for new review branches:

```powershell
cd C:\Users\willm\job-application-tracker
git fetch origin
git worktree add .tmp/worktrees/chunk3Latency chunk3Latency
cd .tmp/worktrees/chunk3Latency
```

This keeps branch source files inside the main writable repo tree while preserving a clean checkout separate from the dirty main workspace.

### 3. Run Focused Tests From Linked Worktrees With Main Dependencies

If the linked worktree does not have its own `node_modules`, run focused Jest commands through the main checkout's Jest binary:

```powershell
$repo = 'C:\Users\willm\job-application-tracker'
$env:NODE_PATH = "$repo\node_modules"
node "$repo\node_modules\jest\bin\jest.js" --runTestsByPath src/client/lib/__tests__/api.test.js --runInBand --no-cache
```

### 4. Expect Git Metadata Approval When Needed

Even with repo-local worktrees, linked worktree Git metadata still lives under:

```text
C:\Users\willm\job-application-tracker\.git\worktrees\<worktree-name>
```

So `git add`, `git commit`, and `git push` may still need sandbox approval. The important fix is that normal file edits and `apply_patch` should no longer need brittle PowerShell or Node inline-script fallbacks.

### 5. Avoid Fragile Inline PowerShell Fallbacks

Once `apply_patch` works, prefer it for bounded edits. If scripted replacement is truly needed, use a short temporary helper file under `.tmp/` rather than long `node -e` or handcrafted inline patch strings.
