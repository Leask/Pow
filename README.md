# 🎮 Pow

A JavaScript Nintendo emulator with independent NES, SNES, N64, GB/GBC, GBA,
and NDS kernels. There are no runtime package dependencies. The N64 and handheld
cores are original implementations; the existing SNES audio core has a separate
third-party notice below. N64, GBA and NDS compatibility remains experimental.

<img width="1002" height="947" alt="Screenshot 2026-02-24 at 1 20 54 PM" src="https://github.com/user-attachments/assets/4eaa2055-bc47-4b12-a268-aa794195d9d1" />

<img width="1016" height="897" alt="Screenshot 2026-02-26 at 1 17 46 AM" src="https://github.com/user-attachments/assets/48170135-5b50-4c09-8e2c-c9aa0f133895" />

## Highlights

- Self-hosted kernels with no external runtime emulator packages
- Modern ESM-only codebase (`.mjs`)
- Multi-system architecture with separate console and handheld kernels
- Shared Nintendo library for cross-kernel utilities
- Deterministic save/load state support
- Headless CLI execution for CI and regression testing
- Minimal browser HTML GUI with Canvas rendering
- Stereo AudioWorklet output with a WebAudio fallback
- N64 and handheld emulation in a Web Worker, paced by audio consumption
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
- GB/GBC SM83 CPU, MBC1/2/3/5, timers, DMA, scrolling, sprites and four-channel audio
- CGB banked VRAM/WRAM, color palettes, double speed and HBlank DMA
- Shared ARMv4T/v5 interpreter with Thumb, exception banks and documented BIOS services
- GBA text/affine/bitmap backgrounds, sprites, windows, blending, DMA and timers
- GBA stereo PSG and timer-driven direct-sound FIFOs
- NDS dual CPUs, IPC, cartridge DMA, VRAM banks, dual 2D displays and touchscreen
- NDS PCM8/16, IMA-ADPCM and PSG stereo audio
- ROM format detection + kernel factory for all seven system identifiers

### Handheld Validation and Limits

External reference-ROM scenarios exercise **Operation C (GB, USA)** and
**Contra Advance (GBA, Europe)** through actual first-stage gameplay. The
**Chessmaster (NDS, Europe)** scenario selects a language, creates a player
with touch input, enters a chess match, plays e2-e4 and checks the computer's
reply. Each scenario exports screenshots, about ten seconds of stereo audio,
signal measurements and deterministic frame/audio state-replay checks.

GBC currently has synthetic CPU, palette, VRAM/DMA and stereo replay coverage;
no external GBC game has been validated. These are initial kernels, not a claim
of universal compatibility or hardware-exact timing. GBA uses post-BIOS startup
and original BIOS-service HLE. NDS uses post-firmware startup and synthetic
user settings, and currently implements a **2D subset, not the 3D geometry
engine**. Encrypted secure-area execution, DSi mode, Wi-Fi and broad firmware
support are not implemented. Backups are volatile unless saved by the host.
Busy NDS scenes can run below real time and cause browser audio underruns.

See [handheld development notes](docs/handheld-development.md) for implementation
boundaries, known omissions and reference-ROM verification instructions.

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

Run the handheld scenarios with your own matching ROMs:

```bash
GB_ROM='/path/to/Operation C (USA).gb' npm run smoke:gb
GBA_ROM='/path/to/Contra Advance (Europe).gba' npm run smoke:gba
NDS_ROM='/path/to/Chessmaster (Europe).nds' npm run smoke:nds
# With all three environment variables set:
npm run smoke:handhelds
```

Artifacts are written to `tmp/handheld/verification/<system>/`. ROM hashes are
checked before scripted input is applied. `-- --rom <path> --output <dir>` is
available for single-system scenarios. No handheld ROMs or BIOS files are bundled.

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

Then load a `.nes/.smc/.sfc/.z64/.v64/.n64/.gb/.gbc/.gba/.nds` file from the GUI. Controls:

- Keyboard: Arrow keys / WASD
- A: `J`
- B: `K`
- Start: `Enter`
- Select: `Shift`
- SNES extra buttons: `U=X`, `I=Y`, `Q=L`, `E=R`
- N64: Arrow keys/WASD control the analog stick; `J=A`, `K=B`, `Shift=Z`,
  `Enter=Start`, `Q=L`, `E=R`, `U/I/O/P=C-Left/Up/Right/Down`
- GB/GBC/GBA/NDS: Arrows/WASD, `J=A`, `K=B`, `Enter=Start`, `Shift=Select`
- GBA/NDS shoulders: `Q=L`, `E=R`; NDS additional buttons: `U=X`, `I=Y`
- NDS touchscreen: click, drag or touch the lower half of the combined display

Audio notes:

- Browser autoplay restrictions apply.
  - Click `Start` once to unlock/resume WebAudio playback.
- If no sound is heard, verify system/browser tab is not muted.
- N64 and handheld stereo channels are preserved through the browser output.
- N64 and handhelds run off the UI thread, but demanding software-rendered scenes can
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
- `--system <nes|snes|n64|gb|gbc|gba|nds>`: Optional manual system override
- `--frames <n>`: Number of frames to execute
- `--strict-opcodes`: Throw on unsupported NES/SNES opcodes; new CPU cores reject unsupported instruction encodings

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

Handhelds expose the same load/frame/button/state API. NDS additionally accepts
`setTouch(x, y, down)` with lower-screen coordinates `x=0..255`, `y=0..191`.
Handheld snapshots are copied and validated against the complete ROM identity.
Cartridge RAM/backup contents survive `reset()` and are included in snapshots,
but are not automatically persisted. All new kernels provide stereo
`onAudioFrame`; do not also enqueue their compatibility mono callback.

## Current Scope and Roadmap

- Stabilize console and handheld browser GUI behavior and controls
- Improve APU accuracy and timing behavior
- Expand SNES instruction coverage and PPU features (sprites/window/HDMA)
- Improve SNES APU accuracy (echo/timing edge cases)
- Expand mapper coverage for broader ROM compatibility
- Build compatibility benchmark suite and ROM matrix
- Extend N64 RSP microcodes, RDP/VI fidelity, CPU timing, and performance
- Expand GBC real-ROM coverage and handheld timing/BIOS/audio accuracy
- Complete NDS 2D features, 3D geometry, save protocols and compatibility coverage
