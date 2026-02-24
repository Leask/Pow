# 🎮 Pow

A JS NES emulator developed from scratch. It features zero external
dependencies and utilizes the latest JS features to ensure a thoroughly
modern, powerful, and stable experience.

## Highlights

- 100% self-hosted emulator core, no external emulator libraries
- Modern ESM-only codebase (`.mjs`)
- Deterministic save/load state support
- Headless CLI execution for CI and regression testing
- Strict-opcode mode for compatibility validation

## Implemented Core Features

- iNES parser and ROM loader
- Cartridge abstraction + mapper system
  - Mapper `0` (NROM)
  - Mapper `2` (UxROM)
  - Mapper `3` (CNROM)
- 6502 CPU core with mainstream instruction coverage
- PPU pipeline
  - VBlank / NMI timing
  - VRAM, OAM, and DMA behavior
  - Background + sprite composition
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

Run full test suite:

```bash
npm test
```

## CLI

```bash
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240 --strict-opcodes
```

Arguments:

- `--rom <path>`: ROM file path
- `--frames <n>`: Number of frames to execute
- `--strict-opcodes`: Throw when unsupported opcode is encountered

## Public API

```js
import { NESKernel } from './src/index.mjs';

const kernel = new NESKernel();
kernel.loadROMFromFile('./Mario.nes');
kernel.runFrames(60);
console.log(kernel.getExecutionState());
```

## Current Scope and Roadmap

Current focus is a stable and testable emulator kernel. Next milestones:

- Web canvas renderer adapter
- WebAudio APU output path
- Expanded mapper coverage for broader ROM compatibility
- Compatibility benchmark suite and ROM matrix
