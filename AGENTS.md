# Agent instructions

## Unit tests: ignore them

- Never write, update, or run unit tests (`*.test.ts`, `*.test.tsx`, `bun test`).
- Don't fix failing tests either, and don't let them block a commit or deploy.
- To verify a change, typecheck (`bunx tsc --noEmit -p .`) and build. Nothing more.

See `CLAUDE.md` for the rest of the development notes.
