# pi-review-loop

`pi-review-loop` is a Pi package that reviews the current worktree with `/skill:code-review`, applies actionable fixes, and repeats the review until it is clean or cannot safely continue.

## Install

Install from a local checkout, Git repository, or npm package:

```bash
pi install ./plugins/pi-review-loop
pi install git:github.com/example/pi-review-loop@v0.1.0
pi install npm:pi-review-loop@0.1.0
```

The Git and npm commands are examples. Replace them with the published source location.

For a project-local install, use `-l`:

```bash
pi install -l ./plugins/pi-review-loop
```

The package is tested with Pi `0.84.2` on Node.js `24.15.0`. Pi `0.84.2` requires Node.js `22.19.0` or newer.

## Usage

Run Pi in the worktree that should be reviewed, then execute:

```text
/review-loop
```

The default limit is ten review rounds. An optional round limit and additional review instructions can be supplied:

```text
/review-loop 3
/review-loop Focus on authorization checks
/review-loop 3 Focus on authorization checks
```

The additional instructions are applied to each review round. A limit from one to ten can be supplied.

## Configuration

Set the review prompt in `~/.pi/agent/review-loop.json` for all projects or in `.pi/review-loop.json` for one project:

```json
{
  "reviewPrompt": "/skill:code-review Review the current working tree changes for security, correctness, performance, and missing tests. Do not modify files during this review."
}
```

The default is the prompt shown above. The project config overrides the global config, and project config is read only for trusted projects. A prompt passed to `/review-loop` is appended as additional review instructions.

Stop an active loop with:

```text
/review-loop stop
```

Submitting any other input while the loop is running also stops it, because the review and fix sequence can no longer be guaranteed.

The loop does not commit, push, merge, create pull requests, or resume automatically after a session reload. Review the proposed file changes and command execution before installing packages from sources you do not trust.

The package uses the existing `code-review` skill resolved from project or user resources. It does not bundle or override a `code-review` skill. Review and fix responses remain normal text. After each review, the loop sends `fix them`; safe fixes are applied automatically, while findings that require user input are recorded and shown when the loop completes.

When the loop completes successfully, the status is cleared, while the completion notification includes the loop count and elapsed time as `Review loop completed after 2 loops in 1 hour 38 mins.` The completion notification uses warning styling, while the separate final review result uses the normal assistant output styling.

## Package contents

- `extensions/review-loop.ts`: Pi command and review/fix orchestration
- `src/reviewLoopState.ts`: dependency-free state transition rules

The package is independent of Domo and does not require Domo services, database access, or project-specific adapters.
