# NES Emulator Core (Self-Hosted, Modern JS)

This repository contains a self-developed NES emulator kernel in modern
JavaScript, without external emulator packages.

## Current core scope

- iNES ROM parsing
- Cartridge + Mapper abstraction (`0`, `2`, `3`)
- CPU memory bus
- 6502 CPU core with mainstream opcode coverage
- PPU core with VBlank/NMI timing, VRAM/OAM, and frame rendering
- Controller input and OAM DMA
- Save/load state snapshots
- Headless CLI execution and automated tests

## Requirements

- Node.js 20+

## Install

```bash
npm install
```

## Run smoke test with `Mario.nes`

```bash
npm run smoke
```

## Execute tests

```bash
npm test
```

## CLI options

```bash
node src/cli/run-headless.js --rom ./Mario.nes --frames 240
node src/cli/run-headless.js --rom ./Mario.nes --frames 240 --strict-opcodes
```

## Public API

```js
import { NESKernel } from './src/index.js';

const kernel = new NESKernel();
kernel.loadROMFromFile('./Mario.nes');
kernel.runFrames(60);
console.log(kernel.getExecutionState());
```
