# Handheld Kernels

GB/GBC, GBA and NDS are separate, original JavaScript implementations. There
are no external emulator packages, BIOS images or runtime dependencies.
Core modules are environment-neutral ESM. The public factory, headless CLI
and browser GUI recognize `gb`, `gbc`, `gba` and `nds` by validated headers.

## Architecture

| Kernel | CPU | Video | Audio and Devices |
| --- | --- | --- | --- |
| `src/core/gb/` | SM83 legal base/CB instructions, interrupt/EI/HALT handling | DMG/CGB backgrounds, window, sprites, palettes and banked VRAM, 160x144 | Shared original four-channel PSG, DIV timer, serial stub, joypad, OAM/HDMA, MBC1/2/3/5 and deterministic MBC3 RTC |
| `src/core/gba/` | Shared ARMv4T/Thumb interpreter, exception banks, BIOS-service HLE | Modes 0-5, affine/text/bitmap backgrounds, sprites, windows and blending, 240x160 | PSG and two timer-driven PCM FIFOs, four DMA channels/timers, IRQs and volatile backup media |
| `src/core/nds/` | Interleaved ARMv5 ARM9 and ARMv4T ARM7, CP15 TCM and BIOS-service HLE | Two 2D engines, text/affine/bitmap backgrounds, sprites, VRAM banks and LCD scanout, 256x384 combined | Sixteen PCM8/16, ADPCM/PSG channels, IPC FIFO/sync, DMA, timers, card transfers, SPI firmware/backup and touchscreen ADC |

Shared ARM execution, BIOS services, handheld PSG, palette conversion and copied
state snapshots live in `src/shared/nintendo/`. Game-specific hashes, input
schedules and reference-image assertions live only in verification tools.
No game addresses, patched ROM bytes or prerecorded output are used in cores.

GBA starts at the cartridge entry after generic BIOS initialization. NDS copies
the documented ARM9/ARM7 boot segments and initializes generic post-firmware
memory, user settings and interrupt dispatch. Synthetic firmware settings have
valid CRCs and two calibrated user-setting copies. Original IRQ dispatch stubs
run the ROM's own interrupt handlers. BIOS calls are documented-service HLE;
this is not instruction-level execution of Nintendo firmware.

## Host Integration

The synchronous public API remains `loadROMBuffer`, `reset`, `runFrame(s)`,
`pressButton`, `releaseButton`, `getROMMetadata`, `getExecutionState`,
`saveState` and `loadState`. Handhelds support one player. NDS has
`setTouch(x, y, down)` in lower-screen coordinates. Audio is stereo at the
requested sample rate; the mono callback is a compatibility path only.

The existing worker transport now dispatches N64 and handheld kernels through
the public factory. Video dimensions follow ROM metadata. AudioWorklet epochs
discard stale ROM/reset samples, and consumption paces the worker. Short
keyboard and touch taps are latched across emulated frames. NDS pointer input
maps to the lower screen; a vertically stacked display remains usable on
mobile and desktop. Worker filenames retain their original N64 names to avoid
breaking existing integrations.

State snapshots contain copied device buffers and volatile saves, exclude ROMs
and live graph references, and are checked before mutation. The complete ROM
checksum/size and selected hardware mode identify a snapshot. Derived VRAM
mapping caches are rebuilt on restore. Typed arrays must retain their types
through `structuredClone` or binary serialization; ordinary JSON is unsuitable.

## Reference-ROM Gates

`npm run smoke:gb`, `smoke:gba`, `smoke:nds`, or `smoke:handhelds` run
`src/cli/verify-handhelds.mjs`. Provide external `GB_ROM`, `GBA_ROM` and
`NDS_ROM` paths. Single-system scenarios also accept `--rom` and `--output`.
Exact SHA-256 checks prevent applying reference-game input to unrelated ROMs.

| System | Reference | SHA-256 | Verified Flow |
| --- | --- | --- | --- |
| GB | Operation C, USA | `0b6670e44cc2edc6fbf32fc78f499e774cf0802019480f2bf7bdb836ee15c433` | Title, first-stage gameplay and directional input |
| GBA | Contra Advance: The Alien Wars Ex, Europe | `7292c8ad88c1416392e5fd98cf2444a4bcc9a612b28c1f736233ad0b1d1eb8a8` | Title, first-stage gameplay and directional input |
| NDS | Chessmaster: The Art of Learning, Europe | `b284d4bbc29364787eee7bd1f24ee2a3224367f32401f12b1045d8079ef92253` | Language selection, touchscreen keyboard/profile, chess board, e2-e4 and computer reply |
| GBC | Generated hardware fixtures | Not an external game ROM | Color palettes/VRAM/HDMA, CPU, audio, detection and copied replay |

Each real-ROM run exports PNG scenes, around ten seconds of stereo WAV,
per-second RMS/peak/clipping measurements and a six-frame full-state/audio
replay check under `tmp/handheld/verification/`. NDS board snapshots also have
reference checksums so a colorful menu cannot masquerade as a completed game
flow. Inspect the scenes and listen to the WAVs; a passing signal gate alone
does not establish perceptual audio fidelity. Never commit these ROM-derived
artifacts. Synthetic unit fixtures are generated in memory without external
ROMs. Run `npm test`, NES/SNES smoke checks and N64 verification after shared
worker or public API changes.

## Known Limits

- GB/CGB LCD timing uses fixed scanline modes, not a pixel FIFO; access restrictions, DMA stalls, LY/STAT edge cases, serial peers and obscure PSG quirks remain incomplete. CGB double-speed switching is approximate at the transition instruction. Cartridge types outside ROM-only/MBC1/2/3/5 fail explicitly. No real GBC reference game has been tested.
- ARM memory wait states, pipeline timing, abort/undefined exceptions and some ARMv5 DSP/saturating instructions are incomplete. Instruction coverage is substantial but not a complete conformance claim.
- GBA BIOS mathematical functions use original arithmetic approximations rather than exact firmware tables. Affine/window/blending are scanline-level, mosaic and detailed DMA/access/IRQ timing remain incomplete. GBA wave-bank behavior and backup protocol detection are partial.
- NDS **does not implement the 3D geometry engine**. Extended palettes, windows/blending, display capture and several 2D modes remain incomplete. CPU, card and DMA scheduling is functional rather than cycle-exact. The card bus assumes accessible/decrypted cartridge data, not full secure-area encryption or firmware execution.
- NDS Wi-Fi, RTC, microphone input, Slot-2, DSi features, power-management details and complete EEPROM/flash protocols are not implemented. PCM resampling, ADPCM edge cases, capture units and firmware sound tables are approximate. Busy interpreter scenes can produce slowdowns and browser audio underruns.
- Saves survive reset and snapshots but require explicit host persistence. This release does not claim broad or hardware-exact game compatibility.

## Sources

- [Pan Docs](https://gbdev.io/pandocs/): SM83, cartridges, timers, LCD, CGB registers and audio.
- [GB opcode tables](https://gbdev.io/gb-opcodes/optables/): SM83 instruction encodings and cycle counts.
- [GBATEK](https://dswifi.akkit.org/info/gbatek.htm): ARM/Thumb, GBA/NDS memory maps, DMA, BIOS services, video, sound, cartridge and touchscreen protocols.
- [libnds BIOS API](https://github.com/devkitPro/libnds/blob/master/include/nds/bios.h): public service signatures used for cross-checking.

These references guide original implementation; no external emulator kernel
or Nintendo BIOS is included in the handheld code.
