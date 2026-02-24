# Pow

A JS NES emulator developed from scratch. It features zero external
dependencies and utilizes the latest JS features to ensure a thoroughly
modern, powerful, and stable experience.

## Highlights

- 100% self-hosted emulator core, no external emulator libraries
- Modern ESM-only codebase (`.mjs`)
- Deterministic save/load state support
- Headless CLI execution for CI and regression testing
- Minimal browser HTML GUI with Canvas rendering
- Strict-opcode mode for compatibility validation

## Implemented Core Features

- iNES parser and ROM loader
- Cartridge abstraction + mapper system (`0`, `2`, `3`)
- 6502 CPU core with mainstream instruction coverage
- PPU pipeline with VBlank/NMI, VRAM/OAM, DMA, background/sprite rendering
- Bus, controller ports, and memory map integration

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
http://127.0.0.1:8080
```

Then load a `.nes` file from the GUI. Controls:

- Keyboard: Arrow keys / WASD
- A: `J`
- B: `K`
- Start: `Enter`
- Select: `Shift`

## CLI

```bash
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240 --strict-opcodes
```

Arguments:

- `--rom <path>`: ROM file path
- `--frames <n>`: Number of frames to execute
- `--strict-opcodes`: Throw when unsupported opcode is encountered

## Public API (Node)

```js
import fs from 'node:fs';
import { NESKernel } from './src/index.mjs';

const romData = fs.readFileSync('./Mario.nes');
const kernel = new NESKernel();
kernel.loadROMBuffer(romData);
kernel.runFrames(60);
console.log(kernel.getExecutionState());
```

## Current Scope and Roadmap

- Stabilize browser GUI and controls
- Add WebAudio APU output path
- Expand mapper coverage for broader ROM compatibility
- Build compatibility benchmark suite and ROM matrix
