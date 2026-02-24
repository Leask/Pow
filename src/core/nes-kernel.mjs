import { parseINESHeader } from './ines.mjs';
import { Cartridge } from './cartridge.mjs';
import { Bus } from './bus.mjs';
import { CPU6502 } from './cpu6502.mjs';
import { BUTTON_ORDER } from './controller.mjs';

function toByteArray(data) {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    throw new TypeError(
        'ROM data must be Uint8Array, ArrayBuffer, or TypedArray view.',
    );
}

class NESKernel {
    constructor(options = {}) {
        this.options = options;
        this.onFrame = typeof options.onFrame === 'function'
            ? options.onFrame
            : null;
        this.onStatusUpdate = typeof options.onStatusUpdate === 'function'
            ? options.onStatusUpdate
            : null;

        this.romPath = null;
        this.romData = null;
        this.romMetadata = null;

        this.cartridge = null;
        this.bus = null;
        this.cpu = null;

        this.frameCount = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
        this.lastStatus = null;
    }

    loadROMBuffer(romData) {
        const buffer = Uint8Array.from(toByteArray(romData));
        this.romData = buffer;
        this.romMetadata = parseINESHeader(buffer);
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
        let guard = 2_000_000;

        while (this.bus.ppu.frame < targetFrame) {
            const stall = this.bus.consumeStallCycles();

            if (stall > 0) {
                this.cpu.totalCycles += stall;
                this.bus.clock(stall);
            } else {
                const cycles = this.cpu.step();
                this.bus.clock(cycles);
            }

            guard -= 1;

            if (guard === 0) {
                throw new Error('Frame execution guard exceeded.');
            }
        }

        this.frameCount = this.bus.ppu.frame;
        this.lastFrameBuffer = Uint32Array.from(this.bus.ppu.frameBuffer);
        this.lastFrameChecksum = this.#checksum(this.lastFrameBuffer);

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
        this.frameCount = state.frameCount;
        this.lastFrameChecksum = state.lastFrameChecksum;
    }

    getROMMetadata() {
        if (!this.romMetadata) {
            return null;
        }

        return {
            ...this.romMetadata,
            path: this.romPath,
        };
    }

    getExecutionState() {
        this.#ensureCore();
        const flags = this.cpu.P;

        return {
            frameCount: this.frameCount,
            lastStatus: this.lastStatus,
            lastFrameChecksum: this.lastFrameChecksum,
            cpu: {
                pc: this.cpu.PC,
                sp: this.cpu.SP,
                acc: this.cpu.A,
                x: this.cpu.X,
                y: this.cpu.Y,
                status: flags,
                carry: (flags & 0x01) !== 0 ? 1 : 0,
                zero: (flags & 0x02) !== 0 ? 1 : 0,
                interrupt: (flags & 0x04) !== 0 ? 1 : 0,
                decimal: (flags & 0x08) !== 0 ? 1 : 0,
                overflow: (flags & 0x40) !== 0 ? 1 : 0,
                sign: (flags & 0x80) !== 0 ? 1 : 0,
                totalCycles: this.cpu.totalCycles,
            },
            ppu: {
                scanline: this.bus.ppu.scanline,
                cycle: this.bus.ppu.cycle,
                frame: this.bus.ppu.frame,
            },
            unsupportedOpcodes: Array.from(this.cpu.unknownOpcodes.entries())
                .map(([opcode, count]) => ({
                    opcode,
                    count,
                })),
        };
    }

    #bootCore() {
        this.cartridge = new Cartridge(this.romData);
        this.bus = new Bus(this.cartridge);
        this.cpu = new CPU6502(this.bus, {
            strictOpcodes: this.options.strictOpcodes ?? false,
        });
        this.frameCount = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
    }

    #checksum(frameBuffer) {
        let sum = 0 >>> 0;

        for (const pixel of frameBuffer) {
            sum = (sum + (pixel >>> 0)) >>> 0;
        }

        return sum >>> 0;
    }

    #setButton(player, buttonName, pressed) {
        this.#ensureCore();

        if (!Number.isInteger(player) || player < 1 || player > 2) {
            throw new RangeError('player must be 1 or 2.');
        }

        const normalized = String(buttonName).trim().toUpperCase();

        if (!BUTTON_ORDER.includes(normalized)) {
            throw new RangeError(
                `Unsupported button "${buttonName}". ` +
                `Use: ${BUTTON_ORDER.join(', ')}`,
            );
        }

        this.bus.controllers[player - 1].setButton(normalized, pressed);
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
    NESKernel,
    BUTTON_ORDER as BUTTONS,
};
