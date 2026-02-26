import { SNESPPU } from './ppu.mjs';
import { SNESController } from './controller.mjs';
import { SNESSimpleAudio } from './audio.mjs';

const DMA_TRANSFER_PATTERNS = Object.freeze([
    [0],
    [0, 1],
    [0, 0],
    [0, 0, 1, 1],
    [0, 1, 2, 3],
    [0, 1, 0, 1],
    [0, 0],
    [0, 0, 1, 1],
]);
const MASTER_CYCLES_PER_SCANLINE = 1364;
const SCANLINES_PER_FRAME = 262;
const VISIBLE_SCANLINES = 224;
const VBLANK_START_SCANLINE = 225;
const FRAME_MASTER_CYCLES = MASTER_CYCLES_PER_SCANLINE * SCANLINES_PER_FRAME;

class SNESBus {
    constructor(cartridge, options = {}) {
        this.cartridge = cartridge;
        this.ppu = new SNESPPU();
        this.controllers = [new SNESController(), new SNESController()];
        this.audio = new SNESSimpleAudio({
            sampleRate: options.sampleRate,
            onSample: options.onAudioSample,
        });
        this.wram = new Uint8Array(128 * 1024);
        this.ioRegs = new Uint8Array(0x100);
        this.dmaRegs = new Uint8Array(0x80);
        this.irqPending = false;
        this.irqFlag = false;

        this.wramPortAddress = 0;
        this.openBus = 0;
        this.cpuCycles = 0;
        this.joypadStrobe = false;
        this.hdmaActive = new Uint8Array(8);
        this.hdmaLineCounter = new Uint8Array(8);
        this.hdmaDoTransfer = new Uint8Array(8);
        this.hdmaRepeat = new Uint8Array(8);
        this.hdmaTableAddress = new Uint16Array(8);
        this.hdmaIndirectAddress = new Uint16Array(8);
    }

    read(address) {
        const mapped = address & 0xffffff;
        const bank = (mapped >>> 16) & 0xff;
        const offset = mapped & 0xffff;
        const bankClass = bank & 0x7f;
        const isSystemBank = bankClass <= 0x3f;

        const wramOffset = this.#resolveWRAMOffset(bank, offset);

        if (wramOffset !== null) {
            return this.#setOpenBus(this.wram[wramOffset]);
        }

        if (isSystemBank && offset >= 0x2100 && offset <= 0x213f) {
            return this.#setOpenBus(this.ppu.readPPURegister(offset - 0x2100));
        }

        if (isSystemBank && offset >= 0x2140 && offset <= 0x2143) {
            return this.#setOpenBus(
                this.audio.readPort(offset - 0x2140),
            );
        }

        if (isSystemBank && offset >= 0x2180 && offset <= 0x2183) {
            return this.#setOpenBus(this.#readWRAMPort(offset));
        }

        if (isSystemBank && offset === 0x4016) {
            const value = (this.openBus & 0xfe) |
                this.controllers[0].readSerialBit();
            return this.#setOpenBus(value);
        }

        if (isSystemBank && offset === 0x4017) {
            const value = (this.openBus & 0xfe) |
                this.controllers[1].readSerialBit();
            return this.#setOpenBus(value);
        }

        if (isSystemBank && offset === 0x4210) {
            return this.#setOpenBus(this.ppu.readNMIStatus());
        }

        if (isSystemBank && offset === 0x4212) {
            return this.#setOpenBus(this.ppu.readHVBJOYStatus());
        }

        if (isSystemBank && offset === 0x4211) {
            const value = this.irqFlag ? 0x80 : 0x00;
            this.irqFlag = false;
            this.irqPending = false;
            return this.#setOpenBus(value);
        }

        if (isSystemBank && (offset === 0x4218 || offset === 0x4219)) {
            return this.#setOpenBus(this.ioRegs[offset - 0x4200]);
        }

        if (isSystemBank && (offset === 0x421a || offset === 0x421b)) {
            return this.#setOpenBus(this.ioRegs[offset - 0x4200]);
        }

        if (isSystemBank && offset >= 0x4214 && offset <= 0x4217) {
            return this.#setOpenBus(this.ioRegs[offset - 0x4200]);
        }

        if (isSystemBank && offset >= 0x4300 && offset <= 0x437f) {
            return this.#setOpenBus(this.dmaRegs[offset - 0x4300]);
        }

        if (isSystemBank && offset >= 0x4200 && offset <= 0x420f) {
            return this.#setOpenBus(this.ioRegs[offset - 0x4200]);
        }

        return this.#setOpenBus(this.cartridge.read(bank, offset));
    }

    write(address, value) {
        const mapped = address & 0xffffff;
        const bank = (mapped >>> 16) & 0xff;
        const offset = mapped & 0xffff;
        const byte = value & 0xff;
        const bankClass = bank & 0x7f;
        const isSystemBank = bankClass <= 0x3f;

        this.openBus = byte;

        const wramOffset = this.#resolveWRAMOffset(bank, offset);

        if (wramOffset !== null) {
            this.wram[wramOffset] = byte;
            return;
        }

        if (isSystemBank && offset >= 0x2100 && offset <= 0x213f) {
            this.ppu.writePPURegister(offset - 0x2100, byte);
            return;
        }

        if (isSystemBank && offset >= 0x2140 && offset <= 0x2143) {
            const portIndex = offset - 0x2140;
            this.audio.handlePortWrite(portIndex, byte);
            return;
        }

        if (isSystemBank && offset >= 0x2180 && offset <= 0x2183) {
            this.#writeWRAMPort(offset, byte);
            return;
        }

        if (isSystemBank && offset === 0x4016) {
            this.joypadStrobe = (byte & 0x01) !== 0;
            this.controllers[0].setStrobe(this.joypadStrobe);
            this.controllers[1].setStrobe(this.joypadStrobe);
            return;
        }

        if (isSystemBank && offset >= 0x4300 && offset <= 0x437f) {
            this.dmaRegs[offset - 0x4300] = byte;
            return;
        }

        if (isSystemBank && offset >= 0x4200 && offset <= 0x420f) {
            this.ioRegs[offset - 0x4200] = byte;

            if (offset === 0x4200) {
                this.ppu.setNMIEnabled((byte & 0x80) !== 0);

                if (((byte >>> 4) & 0x03) === 0) {
                    this.irqFlag = false;
                    this.irqPending = false;
                }

                return;
            }

            if (offset === 0x4202 || offset === 0x4203) {
                this.#updateMultiplication();
                return;
            }

            if (offset === 0x4204 || offset === 0x4205 || offset === 0x4206) {
                this.#updateDivision();
                return;
            }

            if (offset === 0x420b) {
                const transferredBytes = this.#startDMA(byte);

                if (transferredBytes > 0) {
                    this.#consumeDMACycles(transferredBytes);
                }

                return;
            }

            return;
        }

        this.cartridge.write(bank, offset, byte);
    }

    clock(cpuCycles) {
        const cycles = cpuCycles >>> 0;
        const beforeFrame = this.ppu.frame;
        const beforeScanline = this.ppu.scanline;
        const beforeCycle = this.ppu.cycle;
        this.cpuCycles += cycles;
        this.audio.clock(cycles);

        this.ppu.clock(cycles * 6);
        const completedFrames = this.ppu.frame - beforeFrame;

        if (completedFrames > 0) {
            this.audio.endFrame(completedFrames);
        }

        if (this.#crossedScanline(
            beforeFrame,
            beforeScanline,
            VBLANK_START_SCANLINE,
        )) {
            this.#autoJoypadPoll();
        }

        this.#clockHDMA(beforeFrame, beforeScanline);
        this.#updateIRQ(beforeFrame, beforeScanline, beforeCycle);
    }

    pollNMI() {
        return this.ppu.pollNMI();
    }

    pollIRQ() {
        if (!this.irqPending) {
            return false;
        }

        this.irqPending = false;
        return true;
    }

    saveState() {
        return {
            wram: Array.from(this.wram),
            ioRegs: Array.from(this.ioRegs),
            dmaRegs: Array.from(this.dmaRegs),
            irqPending: this.irqPending,
            irqFlag: this.irqFlag,
            wramPortAddress: this.wramPortAddress,
            openBus: this.openBus,
            cpuCycles: this.cpuCycles,
            joypadStrobe: this.joypadStrobe,
            hdmaActive: Array.from(this.hdmaActive),
            hdmaLineCounter: Array.from(this.hdmaLineCounter),
            hdmaDoTransfer: Array.from(this.hdmaDoTransfer),
            hdmaRepeat: Array.from(this.hdmaRepeat),
            hdmaTableAddress: Array.from(this.hdmaTableAddress),
            hdmaIndirectAddress: Array.from(this.hdmaIndirectAddress),
            audio: this.audio.saveState(),
            ppu: this.ppu.saveState(),
            controllers: this.controllers.map((controller) =>
                controller.saveState(),
            ),
        };
    }

    loadState(state) {
        this.wram.set(state.wram);
        this.ioRegs.set(state.ioRegs);
        this.dmaRegs.set(state.dmaRegs);
        this.irqPending = Boolean(state.irqPending);
        this.irqFlag = Boolean(state.irqFlag);
        this.wramPortAddress = state.wramPortAddress >>> 0;
        this.openBus = state.openBus & 0xff;
        this.cpuCycles = state.cpuCycles >>> 0;
        this.joypadStrobe = Boolean(state.joypadStrobe);
        this.hdmaActive.set(state.hdmaActive ?? []);
        this.hdmaLineCounter.set(state.hdmaLineCounter ?? []);
        this.hdmaDoTransfer.set(state.hdmaDoTransfer ?? []);
        this.hdmaRepeat.set(state.hdmaRepeat ?? []);
        this.hdmaTableAddress.set(state.hdmaTableAddress ?? []);
        this.hdmaIndirectAddress.set(state.hdmaIndirectAddress ?? []);
        this.audio.loadState(state.audio ?? {});
        this.ppu.loadState(state.ppu);
        this.controllers[0].loadState(state.controllers[0]);
        this.controllers[1].loadState(state.controllers[1]);
    }

    #resolveWRAMOffset(bank, address) {
        if (bank === 0x7e || bank === 0x7f) {
            return (((bank - 0x7e) << 16) | address) & 0x1ffff;
        }

        const bankClass = bank & 0x7f;
        const isSystemBank = bankClass <= 0x3f;

        if (isSystemBank && address < 0x2000) {
            return address & 0x1fff;
        }

        return null;
    }

    #setOpenBus(value) {
        this.openBus = value & 0xff;
        return this.openBus;
    }

    #updateMultiplication() {
        const result = this.ioRegs[0x02] * this.ioRegs[0x03];
        this.ioRegs[0x16] = result & 0xff;
        this.ioRegs[0x17] = (result >>> 8) & 0xff;
    }

    #updateDivision() {
        const dividend = this.ioRegs[0x04] | (this.ioRegs[0x05] << 8);
        const divisor = this.ioRegs[0x06];

        if (divisor === 0) {
            this.ioRegs[0x14] = 0xff;
            this.ioRegs[0x15] = 0xff;
            this.ioRegs[0x16] = dividend & 0xff;
            this.ioRegs[0x17] = (dividend >>> 8) & 0xff;
            return;
        }

        const quotient = Math.floor(dividend / divisor);
        const remainder = dividend % divisor;

        this.ioRegs[0x14] = quotient & 0xff;
        this.ioRegs[0x15] = (quotient >>> 8) & 0xff;
        this.ioRegs[0x16] = remainder & 0xff;
        this.ioRegs[0x17] = (remainder >>> 8) & 0xff;
    }

    #autoJoypadPoll() {
        if ((this.ioRegs[0x00] & 0x01) === 0) {
            return;
        }

        this.controllers[0].latch();
        this.controllers[1].latch();

        const p1 = this.controllers[0].getLatchedState();
        const p2 = this.controllers[1].getLatchedState();

        this.ioRegs[0x18] = p1 & 0xff;
        this.ioRegs[0x19] = (p1 >>> 8) & 0xff;
        this.ioRegs[0x1a] = p2 & 0xff;
        this.ioRegs[0x1b] = (p2 >>> 8) & 0xff;
        this.ioRegs[0x1c] = 0x00;
        this.ioRegs[0x1d] = 0x00;
        this.ioRegs[0x1e] = 0x00;
        this.ioRegs[0x1f] = 0x00;
    }

    #readWRAMPort(offset) {
        if (offset === 0x2180) {
            const value = this.wram[this.wramPortAddress & 0x1ffff];
            this.wramPortAddress = (this.wramPortAddress + 1) & 0x1ffff;
            return value;
        }

        if (offset === 0x2181) {
            return this.wramPortAddress & 0xff;
        }

        if (offset === 0x2182) {
            return (this.wramPortAddress >>> 8) & 0xff;
        }

        return (this.wramPortAddress >>> 16) & 0x01;
    }

    #writeWRAMPort(offset, value) {
        if (offset === 0x2180) {
            this.wram[this.wramPortAddress & 0x1ffff] = value & 0xff;
            this.wramPortAddress = (this.wramPortAddress + 1) & 0x1ffff;
            return;
        }

        if (offset === 0x2181) {
            this.wramPortAddress = (this.wramPortAddress & 0x1ff00) | (value & 0xff);
            return;
        }

        if (offset === 0x2182) {
            this.wramPortAddress =
                (this.wramPortAddress & 0x100ff) |
                ((value & 0xff) << 8);
            return;
        }

        if (offset === 0x2183) {
            this.wramPortAddress =
                (this.wramPortAddress & 0x0ffff) |
                ((value & 0x01) << 16);
        }
    }

    #updateIRQ(beforeFrame, beforeScanline, beforeCycle) {
        const irqMode = (this.ioRegs[0x00] >>> 4) & 0x03;

        if (irqMode === 0) {
            return;
        }

        const afterFrame = this.ppu.frame;
        const afterScanline = this.ppu.scanline;
        const afterCycle = this.ppu.cycle;
        const beforeAbsolute = this.#toAbsoluteMasterCycle(
            beforeFrame,
            beforeScanline,
            beforeCycle,
        );
        const afterAbsolute = this.#toAbsoluteMasterCycle(
            afterFrame,
            afterScanline,
            afterCycle,
        );
        const hTimer = this.ioRegs[0x07] | ((this.ioRegs[0x08] & 0x01) << 8);
        const vTimer = this.ioRegs[0x09] | ((this.ioRegs[0x0a] & 0x01) << 8);
        const hasValidVTimer = vTimer < SCANLINES_PER_FRAME;
        const hasValidHTimer = hTimer < 340;
        const hTargetCycle = hasValidHTimer
            ? (hTimer * 4)
            : 0;
        let shouldTrigger = false;

        if (irqMode === 0x01) {
            if (hasValidHTimer) {
                shouldTrigger = this.#intervalHasEvent(
                    beforeAbsolute,
                    afterAbsolute,
                    hTargetCycle,
                    MASTER_CYCLES_PER_SCANLINE,
                );
            }
        } else if (irqMode === 0x02) {
            if (hasValidVTimer) {
                shouldTrigger = this.#intervalHasEvent(
                    beforeAbsolute,
                    afterAbsolute,
                    vTimer * MASTER_CYCLES_PER_SCANLINE,
                    FRAME_MASTER_CYCLES,
                );
            }
        } else if (hasValidVTimer && hasValidHTimer) {
            shouldTrigger = this.#intervalHasEvent(
                beforeAbsolute,
                afterAbsolute,
                (vTimer * MASTER_CYCLES_PER_SCANLINE) + hTargetCycle,
                FRAME_MASTER_CYCLES,
            );
        }

        if (shouldTrigger) {
            this.irqFlag = true;
            this.irqPending = true;
        }
    }

    #toAbsoluteMasterCycle(frame, scanline, cycle) {
        return (
            (frame * FRAME_MASTER_CYCLES) +
            (scanline * MASTER_CYCLES_PER_SCANLINE) +
            cycle
        );
    }

    #intervalHasEvent(beforeAbsolute, afterAbsolute, offset, period) {
        if (afterAbsolute <= beforeAbsolute) {
            return false;
        }

        const firstEventIndex = Math.floor(
            (beforeAbsolute - offset) / period,
        ) + 1;
        const nextEvent = offset + (firstEventIndex * period);
        return nextEvent <= afterAbsolute;
    }

    #clockHDMA(beforeFrame, beforeScanline) {
        const afterFrame = this.ppu.frame;
        const afterScanline = this.ppu.scanline;
        let frame = beforeFrame;
        let scanline = beforeScanline;

        while (frame !== afterFrame || scanline !== afterScanline) {
            scanline += 1;

            if (scanline >= SCANLINES_PER_FRAME) {
                scanline = 0;
                frame += 1;
                this.#initializeHDMA();
            }

            if (scanline < VISIBLE_SCANLINES) {
                this.#runHDMAScanline();
                this.ppu.latchScanlineState(scanline);
            }
        }
    }

    #initializeHDMA() {
        const enabledMask = this.ioRegs[0x0c];

        for (let channel = 0; channel < 8; channel += 1) {
            if ((enabledMask & (1 << channel)) === 0) {
                this.hdmaActive[channel] = 0;
                this.hdmaLineCounter[channel] = 0;
                this.hdmaDoTransfer[channel] = 0;
                this.hdmaRepeat[channel] = 0;
                continue;
            }

            const base = channel * 0x10;
            const tableAddress = this.dmaRegs[base + 0x02] |
                (this.dmaRegs[base + 0x03] << 8);

            this.hdmaActive[channel] = 1;
            this.hdmaLineCounter[channel] = 0;
            this.hdmaDoTransfer[channel] = 1;
            this.hdmaRepeat[channel] = 0;
            this.hdmaTableAddress[channel] = tableAddress;
            this.hdmaIndirectAddress[channel] = this.dmaRegs[base + 0x05] |
                (this.dmaRegs[base + 0x06] << 8);
        }
    }

    #runHDMAScanline() {
        for (let channel = 0; channel < 8; channel += 1) {
            if (!this.hdmaActive[channel]) {
                continue;
            }

            if (this.hdmaLineCounter[channel] === 0) {
                this.#reloadHDMAChannel(channel);
            }

            if (!this.hdmaActive[channel]) {
                continue;
            }

            if (this.hdmaDoTransfer[channel]) {
                this.#transferHDMAChannel(channel);
            }

            this.hdmaLineCounter[channel] -= 1;

            if (this.hdmaLineCounter[channel] === 0) {
                this.hdmaDoTransfer[channel] = 1;
                continue;
            }

            this.hdmaDoTransfer[channel] = this.hdmaRepeat[channel]
                ? 1
                : 0;
        }
    }

    #reloadHDMAChannel(channel) {
        const base = channel * 0x10;
        const sourceBank = this.dmaRegs[base + 0x04];
        let tableAddress = this.hdmaTableAddress[channel];
        const lineDescriptor = this.read((sourceBank << 16) | tableAddress);

        tableAddress = (tableAddress + 1) & 0xffff;
        this.hdmaTableAddress[channel] = tableAddress;

        if (lineDescriptor === 0x00) {
            this.hdmaActive[channel] = 0;
            this.hdmaLineCounter[channel] = 0;
            this.hdmaDoTransfer[channel] = 0;
            return;
        }

        if (lineDescriptor === 0x80) {
            this.hdmaRepeat[channel] = 0;
            this.hdmaLineCounter[channel] = 128;
        } else {
            this.hdmaRepeat[channel] = (lineDescriptor & 0x80) !== 0 ? 1 : 0;
            this.hdmaLineCounter[channel] = lineDescriptor & 0x7f;

            if (this.hdmaLineCounter[channel] === 0) {
                this.hdmaLineCounter[channel] = 128;
            }
        }

        if ((this.dmaRegs[base + 0x00] & 0x40) !== 0) {
            const low = this.read((sourceBank << 16) | tableAddress);
            tableAddress = (tableAddress + 1) & 0xffff;
            const high = this.read((sourceBank << 16) | tableAddress);
            tableAddress = (tableAddress + 1) & 0xffff;
            this.hdmaIndirectAddress[channel] = low | (high << 8);
            this.dmaRegs[base + 0x05] = low;
            this.dmaRegs[base + 0x06] = high;
            this.hdmaTableAddress[channel] = tableAddress;
        }

        this.hdmaDoTransfer[channel] = 1;
    }

    #transferHDMAChannel(channel) {
        const base = channel * 0x10;
        const dmap = this.dmaRegs[base + 0x00];
        const bbad = this.dmaRegs[base + 0x01];
        const sourceBank = this.dmaRegs[base + 0x04];
        const indirectBank = this.dmaRegs[base + 0x07];
        const directionBtoA = (dmap & 0x80) !== 0;
        const indirectMode = (dmap & 0x40) !== 0;
        const mode = dmap & 0x07;
        const pattern = DMA_TRANSFER_PATTERNS[mode] ?? DMA_TRANSFER_PATTERNS[0];

        for (let index = 0; index < pattern.length; index += 1) {
            const bbusAddress = (0x2100 + ((bbad + pattern[index]) & 0xff)) & 0xffff;
            let sourceAddress;

            if (indirectMode) {
                sourceAddress = ((indirectBank << 16) |
                    this.hdmaIndirectAddress[channel]) & 0xffffff;
                this.hdmaIndirectAddress[channel] =
                    (this.hdmaIndirectAddress[channel] + 1) & 0xffff;
            } else {
                sourceAddress = ((sourceBank << 16) |
                    this.hdmaTableAddress[channel]) & 0xffffff;
                this.hdmaTableAddress[channel] =
                    (this.hdmaTableAddress[channel] + 1) & 0xffff;
            }

            if (!directionBtoA) {
                const value = this.read(sourceAddress);
                this.write(bbusAddress, value);
            } else {
                const value = this.read(bbusAddress);
                this.write(sourceAddress, value);
            }
        }
    }

    #crossedScanline(beforeFrame, beforeScanline, targetScanline) {
        const afterFrame = this.ppu.frame;
        const afterScanline = this.ppu.scanline;

        if (afterFrame === beforeFrame) {
            return (
                beforeScanline < targetScanline &&
                afterScanline >= targetScanline
            );
        }

        if (afterFrame - beforeFrame > 1) {
            return true;
        }

        return (
            beforeScanline < targetScanline ||
            afterScanline >= targetScanline
        );
    }

    #startDMA(channelMask) {
        let transferredBytes = 0;

        for (let channel = 0; channel < 8; channel += 1) {
            if ((channelMask & (1 << channel)) === 0) {
                continue;
            }

            transferredBytes += this.#runDMAChannel(channel);
        }

        return transferredBytes;
    }

    #runDMAChannel(channel) {
        const base = channel * 0x10;
        const dmap = this.dmaRegs[base + 0x00];
        const bbad = this.dmaRegs[base + 0x01];
        let a1t = this.dmaRegs[base + 0x02] | (this.dmaRegs[base + 0x03] << 8);
        const a1b = this.dmaRegs[base + 0x04];
        let size = this.dmaRegs[base + 0x05] | (this.dmaRegs[base + 0x06] << 8);

        if (size === 0) {
            size = 0x10000;
        }

        const directionBtoA = (dmap & 0x80) !== 0;
        const fixedAddress = (dmap & 0x08) !== 0;
        const decrementAddress = (dmap & 0x10) !== 0;
        const mode = dmap & 0x07;
        const pattern = DMA_TRANSFER_PATTERNS[mode] ?? DMA_TRANSFER_PATTERNS[0];
        let patternIndex = 0;
        let transferredBytes = 0;

        while (size > 0) {
            const sourceAddress = ((a1b << 16) | a1t) & 0xffffff;
            const targetOffset = bbad + pattern[patternIndex];
            const targetAddress = (0x2100 + (targetOffset & 0xff)) & 0xffff;

            if (!directionBtoA) {
                const value = this.read(sourceAddress);
                this.write(targetAddress, value);
            } else {
                const value = this.read(targetAddress);
                this.write(sourceAddress, value);
            }

            if (!fixedAddress) {
                if (decrementAddress) {
                    a1t = (a1t - 1) & 0xffff;
                } else {
                    a1t = (a1t + 1) & 0xffff;
                }
            }

            size -= 1;
            transferredBytes += 1;
            patternIndex = (patternIndex + 1) % pattern.length;
        }

        this.dmaRegs[base + 0x02] = a1t & 0xff;
        this.dmaRegs[base + 0x03] = (a1t >>> 8) & 0xff;
        this.dmaRegs[base + 0x05] = size & 0xff;
        this.dmaRegs[base + 0x06] = (size >>> 8) & 0xff;
        return transferredBytes;
    }

    #consumeDMACycles(transferredBytes) {
        const bytes = transferredBytes >>> 0;

        if (bytes === 0) {
            return;
        }

        const beforeFrame = this.ppu.frame;
        const beforeScanline = this.ppu.scanline;
        const beforeCycle = this.ppu.cycle;
        const masterCycles = (bytes * 8) + 8;

        this.ppu.clock(masterCycles);
        this.#clockHDMA(beforeFrame, beforeScanline);
        this.#updateIRQ(beforeFrame, beforeScanline, beforeCycle);
        this.cpuCycles += Math.floor(masterCycles / 6);
    }
}

export {
    SNESBus,
};
