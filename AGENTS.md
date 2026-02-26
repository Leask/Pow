# AGENTS.md

This document is for future AI agents working on `Pow`.
Read it before making changes.

## Project Mission

`Pow` is a modern Nintendo emulator in JavaScript, built from scratch.
The core goals are:

- Correct emulation behavior for real ROMs.
- Keep NES and SNES as separate kernels with clean boundaries.
- Zero external emulator dependencies.
- Clean, maintainable, testable architecture.
- Shared core that works in both Node.js and browser environments.

## Hard Constraints

- Keep the emulator core self-hosted.
  - Do not add third-party emulator cores.
- Do not merge NES and SNES kernels into one monolith.
  - Shared logic belongs in `src/shared/nintendo/*`.
- Keep runtime dependencies at zero unless explicitly requested.
- Keep the codebase ESM-only.
  - Use `.mjs` files.
  - Use `import` / `export` only.
- Keep core modules environment-neutral.
  - `src/core/*` must not depend on `node:*` modules.
  - File I/O belongs in CLI/tests, not in core.

## Current Architecture

- Shared Nintendo utilities: `src/shared/nintendo/`
  - ROM buffer helpers, checksum helpers, system constants
- Core emulation: `src/core/`
  - NES kernel + components:
    `cpu6502.mjs`, `ppu.mjs`, `apu.mjs`, `bus.mjs`, `cartridge.mjs`,
    `mappers/*`, `nes-kernel.mjs`, `ines.mjs`
  - SNES kernel + components:
    `snes/snes-kernel.mjs`, `snes/smc.mjs`, `snes/cartridge.mjs`,
    `snes/bus.mjs`, `snes/cpu65816.mjs`, `snes/ppu.mjs`,
    `snes/controller.mjs`
  - Multi-system orchestration:
    `system-detect.mjs`, `emulator-factory.mjs`
- Public API: `src/index.mjs`
- Node headless CLI:
  - `src/cli/run-headless.mjs`
- Browser static GUI:
  - `web/index.html`, `web/app.mjs`
  - server: `src/cli/serve-gui.mjs`
- Tests:
  - `test/*.mjs`

## Behavioral Notes You Must Preserve

- The GUI must be accessed over HTTP, not `file://`.
  - Use `npm run gui` and open `http://127.0.0.1:8184`.
- Audio playback uses WebAudio and user-gesture unlock rules.
  - Start audio only after user interaction (clicking `Start`).
  - Keep audio callback flow for active systems:
    `Kernel(onAudioSample)` -> system audio path -> GUI audio queue.
- Background scrolling is timing-sensitive.
  - Do not reset scanline scroll buffers at pre-render.
  - SMB-style mid-frame scroll writes rely on per-scanline latching.
- Sprite behavior currently appears functionally acceptable for SMB
  smoke usage; avoid broad sprite refactors without regression checks.

## Development Guidelines

- Make small, isolated changes.
- Preserve existing public API unless change is explicitly requested.
- Prefer readability over clever micro-optimizations.
- Keep comments concise and only for non-obvious logic.
- Respect existing project style (indentation, naming, structure).

## Testing Requirements

After code changes, run all relevant checks:

1. `npm test`
2. `npm run smoke`
3. `npm run smoke:snes`
4. If GUI-affecting changes:
   - `npm run gui`
   - Verify `GET /` and `GET /web/app.mjs` return `200`.
   - Verify `GET /src/index.mjs` returns `200`.
   - Manual ROM load sanity check in browser.

If you cannot run one of these checks, state it clearly.

## Compatibility and Scope

- Implemented mappers: `0`, `2`, `3`.
- Systems currently wired in the app layer: `NES`, `SNES`.
- APU is intentionally simplified right now.
  - Prioritize stability and audible output.
  - Do not claim cycle-accurate APU behavior unless implemented.
- SNES currently has real execution plumbing (LoROM + 65C816 subset +
  DMA + VBlank/NMI + BG1 render path), but is still not cycle-accurate.
  - Do not claim full/playable SNES compatibility until sprites, windows,
    HDMA edge cases, and APU audio are completed.
- Keep changes mapper-safe unless intentionally expanding support.
- For new mapper work, add focused tests and avoid regressions in mapper 0.

## Documentation Discipline

If behavior, scripts, or ports change, update:

- `README.md`
- `package.json` scripts
- Any affected CLI help text

Keep docs aligned with actual behavior.

## Before You Finish

- Ensure diff is coherent and minimal.
- Ensure no accidental CommonJS or Node-only imports in `src/core/`.
- If audio path was touched, verify:
  - `test/apu.audio.test.mjs` passes.
  - GUI still produces sound after pressing `Start`.
- Ensure tests pass.
- Summarize what changed, why, and residual risks.
