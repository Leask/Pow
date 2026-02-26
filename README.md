# 🎮 Pow

A JS Nintendo emulator developed from scratch. It features zero external
dependencies and utilizes the latest JS features to ensure a thoroughly
modern, powerful, and stable experience.

<img width="1002" height="947" alt="Screenshot 2026-02-24 at 1 20 54 PM" src="https://github.com/user-attachments/assets/4eaa2055-bc47-4b12-a268-aa794195d9d1" />

<img width="1016" height="897" alt="Screenshot 2026-02-26 at 1 17 46 AM" src="https://github.com/user-attachments/assets/48170135-5b50-4c09-8e2c-c9aa0f133895" />

## Highlights

- 100% self-hosted emulator core, no external emulator libraries
- Modern ESM-only codebase (`.mjs`)
- Multi-system architecture with separate NES and SNES kernels
- Shared Nintendo library for cross-kernel utilities
- Deterministic save/load state support
- Headless CLI execution for CI and regression testing
- Minimal browser HTML GUI with Canvas rendering
- WebAudio output path for real-time audio playback
- Strict-opcode mode for compatibility validation

## Implemented Core Features

- iNES parser and ROM loader
- SNES (`.smc/.sfc`) header parser and loader
- Cartridge abstraction + mapper system (`0`, `2`, `3`)
- 6502 CPU core with mainstream instruction coverage
- Simplified APU mixing path (pulse, triangle, noise) with sample callbacks
- PPU pipeline with VBlank/NMI, VRAM/OAM, DMA, background/sprite rendering
- SNES LoROM bus + 65C816 CPU subset (strict-opcode tested on `Mario World.smc`)
- SNES DMA path, APU I/O boot handshake emulation, VBlank/NMI timing
- SNES PPU BG1/CGRAM/VRAM rendering path for GUI output
- SNES SPC700 + DSP audio core integration (echo path still partial)
- Bus, controller ports, and memory map integration
- ROM format detection + kernel factory (`NES` / `SNES`)

## Third-Party Code Notices

- `src/core/snes/apu/*` contains MIT-licensed SNES APU core logic adapted
  from SnesJs: https://github.com/angelo-wf/SnesJs

## Requirements

- Node.js 20+

## Quick Start

Install dependencies:

```bash
npm install
```

Run smoke execution with `Mario.nes`:

```bash
npm run smoke
```

Run test suite:

```bash
npm test
```

## Browser GUI

Start local static server:

```bash
npm run gui
```

Open:

```text
http://127.0.0.1:8184
```

Then load a `.nes/.smc/.sfc` file from the GUI. Controls:

- Keyboard: Arrow keys / WASD
- A: `J`
- B: `K`
- Start: `Enter`
- Select: `Shift`
- SNES extra buttons: `U=X`, `I=Y`, `Q=L`, `E=R`

Audio notes:

- Browser autoplay restrictions apply.
  - Click `Start` once to unlock/resume WebAudio playback.
- If no sound is heard, verify system/browser tab is not muted.

## CLI

```bash
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240 --strict-opcodes
node src/cli/run-headless.mjs --rom "./Mario World.smc" --frames 240 --strict-opcodes
```

Arguments:

- `--rom <path>`: ROM file path
- `--system <nes|snes>`: Optional manual system override
- `--frames <n>`: Number of frames to execute
- `--strict-opcodes`: Throw when unsupported opcode is encountered

## Public API (Node)

```js
import fs from 'node:fs';
import {
    createNintendoKernelFromROM,
} from './src/index.mjs';

const romData = fs.readFileSync('./Mario.nes');
const { system, kernel } = createNintendoKernelFromROM(romData);
console.log('Detected system:', system);
kernel.loadROMBuffer(romData);
kernel.runFrames(60);
console.log(kernel.getExecutionState());
```

## Current Scope and Roadmap

- Stabilize NES and SNES browser GUI behavior and controls
- Improve APU accuracy and timing behavior
- Expand SNES instruction coverage and PPU features (sprites/window/HDMA)
- Improve SNES APU accuracy (echo/timing edge cases)
- Expand mapper coverage for broader ROM compatibility
- Build compatibility benchmark suite and ROM matrix
