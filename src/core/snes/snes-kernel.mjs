import { checksum32 } from '../../shared/nintendo/checksum.mjs';
import { toByteArray } from '../../shared/nintendo/rom-buffer.mjs';
import { SNESCartridge } from './cartridge.mjs';
import { SNESBus } from './bus.mjs';
import { CPU65816 } from './cpu65816.mjs';
import { SNES_BUTTON_ORDER } from './controller.mjs';
import { SNES_WIDTH, SNES_HEIGHT } from './ppu.mjs';

class SNESKernel {
    constructor(options = {}) {
        this.options = options;
        this.onFrame = typeof options.onFrame === 'function'
            ? options.onFrame
            : null;
        this.onAudioSample = typeof options.onAudioSample === 'function'
            ? options.onAudioSample
            : null;
        this.onStatusUpdate = typeof options.onStatusUpdate === 'function'
            ? options.onStatusUpdate
            : null;

        this.strictOpcodes = options.strictOpcodes ?? false;

        this.romPath = null;
        this.romData = null;

        this.cartridge = null;
        this.bus = null;
        this.cpu = null;

        this.frameCount = 0;
        this.audioSampleCount = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
        this.lastStatus = null;
    }

    loadROMBuffer(romData) {
        this.romData = Uint8Array.from(toByteArray(romData));
        this.#bootCore();
        this.#updateStatus('ROM loaded');
        return this.getROMMetadata();
    }

    reset() {
        this.#ensureCore();
        this.#bootCore();
    }

    runFrame() {
        this.#ensureCore();
        const targetFrame = this.bus.ppu.frame + 1;
        let guard = 8_000_000;

        while (this.bus.ppu.frame < targetFrame) {
            const cycles = this.cpu.step();
            this.bus.clock(cycles);

            guard -= 1;

            if (guard === 0) {
                throw new Error('SNES frame execution guard exceeded.');
            }
        }

        this.frameCount = this.bus.ppu.frame;
        this.lastFrameBuffer = Uint32Array.from(this.bus.ppu.frameBuffer);
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);

        if (this.onFrame) {
            this.onFrame(this.lastFrameBuffer, this.frameCount);
        }

        return this.getExecutionState();
    }

    runFrames(frameCount) {
        this.#ensureCore();

        if (!Number.isInteger(frameCount) || frameCount <= 0) {
            throw new RangeError('frameCount must be a positive integer.');
        }

        for (let index = 0; index < frameCount; index += 1) {
            this.runFrame();
        }

        return this.getExecutionState();
    }

    pressButton(player, buttonName) {
        this.#setButton(player, buttonName, true);
    }

    releaseButton(player, buttonName) {
        this.#setButton(player, buttonName, false);
    }

    saveState() {
        this.#ensureCore();

        return {
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastFrameChecksum: this.lastFrameChecksum,
            cartridge: this.cartridge.saveState(),
            bus: this.bus.saveState(),
            cpu: this.cpu.saveState(),
        };
    }

    loadState(state) {
        this.#ensureCore();
        this.cartridge.loadState(state.cartridge);
        this.bus.loadState(state.bus);
        this.cpu.loadState(state.cpu);
        this.frameCount = state.frameCount >>> 0;
        this.audioSampleCount = state.audioSampleCount >>> 0;
        this.lastFrameChecksum = state.lastFrameChecksum;
        this.lastFrameBuffer = Uint32Array.from(this.bus.ppu.frameBuffer);
    }

    getROMMetadata() {
        if (!this.cartridge) {
            return null;
        }

        return {
            ...this.cartridge.header,
            path: this.romPath,
            screen: {
                width: SNES_WIDTH,
                height: SNES_HEIGHT,
            },
        };
    }

    getExecutionState() {
        this.#ensureCore();

        return {
            system: 'snes',
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastStatus: this.lastStatus,
            lastFrameChecksum: this.lastFrameChecksum,
            cpu: {
                pc: this.cpu.PC,
                pb: this.cpu.PBR,
                sp: this.cpu.SP,
                dp: this.cpu.D,
                db: this.cpu.DBR,
                acc: this.cpu.A,
                x: this.cpu.X,
                y: this.cpu.Y,
                status: this.cpu.P,
                emulation: this.cpu.E ? 1 : 0,
                totalCycles: this.cpu.totalCycles,
            },
            ppu: {
                scanline: this.bus.ppu.scanline,
                cycle: this.bus.ppu.cycle,
                frame: this.bus.ppu.frame,
                width: SNES_WIDTH,
                height: SNES_HEIGHT,
            },
            unsupportedOpcodes: Array.from(this.cpu.unknownOpcodes.entries())
                .map(([opcode, count]) => ({
                    opcode,
                    count,
                })),
        };
    }

    #bootCore() {
        this.cartridge = new SNESCartridge(this.romData);
        this.bus = new SNESBus(this.cartridge);
        this.cpu = new CPU65816(this.bus, {
            strictOpcodes: this.strictOpcodes,
        });
        this.frameCount = 0;
        this.audioSampleCount = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
    }

    #setButton(player, buttonName, pressed) {
        this.#ensureCore();

        if (!Number.isInteger(player) || player < 1 || player > 2) {
            throw new RangeError('player must be 1 or 2.');
        }

        this.bus.controllers[player - 1].setButton(buttonName, pressed);
    }

    #ensureCore() {
        if (!this.cpu || !this.bus || !this.cartridge) {
            throw new Error('No ROM loaded. Call loadROMBuffer() first.');
        }
    }

    #updateStatus(message) {
        this.lastStatus = message;

        if (this.onStatusUpdate) {
            this.onStatusUpdate(message);
        }
    }
}

export {
    SNESKernel,
    SNES_BUTTON_ORDER as SNES_BUTTONS,
    SNES_WIDTH,
    SNES_HEIGHT,
};
