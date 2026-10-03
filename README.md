# 🎮 Pow

A JavaScript Nintendo emulator with independent NES, SNES, and experimental
N64 kernels. There are no runtime package dependencies. The N64 kernel is a
new implementation; the existing SNES audio core has a separate third-party
notice below.

<img width="1002" height="947" alt="Screenshot 2026-02-24 at 1 20 54 PM" src="https://github.com/user-attachments/assets/4eaa2055-bc47-4b12-a268-aa794195d9d1" />

<img width="1016" height="897" alt="Screenshot 2026-02-26 at 1 17 46 AM" src="https://github.com/user-attachments/assets/48170135-5b50-4c09-8e2c-c9aa0f133895" />

## Highlights

- Self-hosted kernels with no external runtime emulator packages
- Modern ESM-only codebase (`.mjs`)
- Multi-system architecture with separate NES, SNES, and N64 kernels
- Shared Nintendo library for cross-kernel utilities
- Deterministic save/load state support
- Headless CLI execution for CI and regression testing
- Minimal browser HTML GUI with Canvas rendering
- Stereo AudioWorklet output with a WebAudio fallback
- N64 emulation in a Web Worker, paced by audio consumption
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
- N64 `.z64`, `.v64`, and `.n64` byte-order normalization
- N64 VR4300 interpreter, CP0/TLB, integer and floating-point execution
- N64 RCP memory map, DMA, interrupts, controller/PIF, and in-memory EEPROM
- N64 Fast3D display-list processing and software triangle rasterization
- N64 ABI1 audio tasks: ADPCM, four-tap resampling, mixing, and stereo AI DMA
- ROM format detection + kernel factory (`NES` / `SNES` / `N64`)

### N64 Validation and Limits

The initial reference ROM is **Super Mario 64 NTSC-U**. A reproducible 4,300-frame
scenario boots the unmodified ROM, enters the file menu and opening sequence,
then verifies Mario walking and jumping in the castle courtyard. It exports
screenshots, ten seconds of stereo PCM, signal measurements, and a state-replay
check. N64 ROMs and derived test artifacts are not bundled.

N64 remains experimental. Startup uses post-IPL initialization; RSP execution
uses high-level Fast3D and ABI1 task interpreters rather than a general RSP
instruction interpreter. CPU/device timing, floating-point exception details,
RDP blending/filtering, and VI scanout are not hardware-exact. Output currently
targets 320x240. Arbitrary microcodes, direct RDP command DMA, and broader game
compatibility are not supported or claimed. Unsupported instructions and task
commands fail explicitly. Software rendering can run below real time in busy
scenes, depending on the host and browser.

See [N64 development notes](docs/n64-development.md) for the architecture,
validation gates, references, and remaining work.

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

Run SNES smoke execution with `Mario World.smc`:

```bash
npm run smoke:snes
```

Run the N64 reference-ROM scenario (provide your own ROM):

```bash
N64_ROM='/path/to/Super Mario 64 (U).z64' npm run smoke:n64
```

Artifacts are written to `tmp/n64/verification/`. This check takes longer than
the short NES/SNES smoke runs. Use `-- --rom <path> --output <dir>` to override
the input and output paths.

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

Then load a `.nes/.smc/.sfc/.z64/.v64/.n64` file from the GUI. Controls:

- Keyboard: Arrow keys / WASD
- A: `J`
- B: `K`
- Start: `Enter`
- Select: `Shift`
- SNES extra buttons: `U=X`, `I=Y`, `Q=L`, `E=R`
- N64: Arrow keys/WASD control the analog stick; `J=A`, `K=B`, `Shift=Z`,
  `Enter=Start`, `Q=L`, `E=R`, `U/I/O/P=C-Left/Up/Right/Down`

Audio notes:

- Browser autoplay restrictions apply.
  - Click `Start` once to unlock/resume WebAudio playback.
- If no sound is heard, verify system/browser tab is not muted.
- N64 stereo channels are preserved through the browser output.
- N64 runs off the UI thread, but demanding software-rendered scenes can
  still run below real time and produce audio underruns.
- `Buffering` means emulation has not yet supplied enough audio for playback.

## CLI

```bash
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240
node src/cli/run-headless.mjs --rom ./Mario.nes --frames 240 --strict-opcodes
node src/cli/run-headless.mjs --rom "./Mario World.smc" --frames 240 --strict-opcodes
node src/cli/run-headless.mjs --rom "/path/to/game.z64" --frames 600
```

Arguments:

- `--rom <path>`: ROM file path
- `--system <nes|snes|n64>`: Optional manual system override
- `--frames <n>`: Number of frames to execute
- `--strict-opcodes`: Throw on unsupported NES/SNES opcodes; N64 always throws

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

For N64, `setAnalogStick(player, x, y)` accepts signed coordinates in the range
`-80..80`. `onAudioFrame(left, right, sampleIndex)` receives stereo samples;
the existing `onAudioSample(mono, sampleIndex)` callback remains available.
`saveState()` returns a copied snapshot with typed arrays; use `structuredClone`
or a binary serializer to retain their types. `loadState()` checks the ROM
header identity. EEPROM is retained across `reset()`, and included in snapshots;
it is not automatically persisted to disk or browser storage.

## Current Scope and Roadmap

- Stabilize NES, SNES, and N64 browser GUI behavior and controls
- Improve APU accuracy and timing behavior
- Expand SNES instruction coverage and PPU features (sprites/window/HDMA)
- Improve SNES APU accuracy (echo/timing edge cases)
- Expand mapper coverage for broader ROM compatibility
- Build compatibility benchmark suite and ROM matrix
- Extend N64 RSP microcodes, RDP/VI fidelity, CPU timing, and performance
