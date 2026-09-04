# AGENTS.md

## Guiding philosophy
- We build quickly and correctly
- Lean with documented residuals is preferred over gold-plated and overengineered. YAGNI
- No mistakes
- No bugs

## Development
- Work on feature branches in worktrees
- Make pull requests against main when you are ready

## Testing
- If the change seems low risk, let CI run the test suite. we require a green build to merge and deploy.
- Don't run the e2e tests unless there is a failure in CI and even then, only if it seems related or you are asked to.

## Subagents
- Always instruct subagents NOT to run e2e tests themselves.
