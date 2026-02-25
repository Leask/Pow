import { checksum32 } from '../../shared/nintendo/checksum.mjs';
import { toByteArray } from '../../shared/nintendo/rom-buffer.mjs';
import { parseSNESHeader } from './smc.mjs';

const SNES_WIDTH = 256;
const SNES_HEIGHT = 224;
const SNES_MASTER_CYCLES_PER_FRAME = 357_366;

const SNES_BUTTON_ORDER = Object.freeze([
    'B',
    'Y',
    'SELECT',
    'START',
    'UP',
    'DOWN',
    'LEFT',
    'RIGHT',
    'A',
    'X',
    'L',
    'R',
]);

function packColor(red, green, blue, alpha = 0xff) {
    return (
        ((alpha & 0xff) << 24) |
        ((red & 0xff) << 16) |
        ((green & 0xff) << 8) |
        (blue & 0xff)
    ) >>> 0;
}

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

        this.romPath = null;
        this.romData = null;
        this.romMetadata = null;

        this.frameCount = 0;
        this.audioSampleCount = 0;
        this.totalMasterCycles = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
        this.lastStatus = null;

        this.controllers = [new Set(), new Set()];
    }

    loadROMBuffer(romData) {
        const buffer = Uint8Array.from(toByteArray(romData));
        this.romData = buffer;
        this.romMetadata = parseSNESHeader(buffer);
        this.#bootCore();
        this.#updateStatus('ROM loaded');
        return this.getROMMetadata();
    }

    reset() {
        this.#ensureLoaded();
        this.#bootCore();
    }

    runFrame() {
        this.#ensureLoaded();
        this.totalMasterCycles += SNES_MASTER_CYCLES_PER_FRAME;
        this.frameCount += 1;
        this.lastFrameBuffer = this.#renderFrame();
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);

        if (this.onFrame) {
            this.onFrame(this.lastFrameBuffer, this.frameCount);
        }

        return this.getExecutionState();
    }

    runFrames(frameCount) {
        this.#ensureLoaded();

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
        this.#ensureLoaded();

        return {
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            totalMasterCycles: this.totalMasterCycles,
            lastFrameChecksum: this.lastFrameChecksum,
            controllers: this.controllers.map((buttons) =>
                Array.from(buttons.values()),
            ),
        };
    }

    loadState(state) {
        this.#ensureLoaded();
        this.frameCount = state.frameCount >>> 0;
        this.audioSampleCount = state.audioSampleCount >>> 0;
        this.totalMasterCycles = state.totalMasterCycles >>> 0;
        this.lastFrameChecksum = state.lastFrameChecksum;

        this.controllers = [new Set(), new Set()];

        for (let index = 0; index < this.controllers.length; index += 1) {
            const buttonList = state.controllers?.[index] ?? [];

            for (const name of buttonList) {
                const normalized = String(name).trim().toUpperCase();

                if (SNES_BUTTON_ORDER.includes(normalized)) {
                    this.controllers[index].add(normalized);
                }
            }
        }
    }

    getROMMetadata() {
        if (!this.romMetadata) {
            return null;
        }

        return {
            ...this.romMetadata,
            path: this.romPath,
            screen: {
                width: SNES_WIDTH,
                height: SNES_HEIGHT,
            },
        };
    }

    getExecutionState() {
        this.#ensureLoaded();

        return {
            system: 'snes',
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastStatus: this.lastStatus,
            lastFrameChecksum: this.lastFrameChecksum,
            cpu: {
                pc: this.romMetadata.nativeResetVector,
                sp: 0,
                acc: 0,
                x: 0,
                y: 0,
                status: 0,
                totalCycles: this.totalMasterCycles,
            },
            ppu: {
                scanline: 0,
                cycle: 0,
                frame: this.frameCount,
                width: SNES_WIDTH,
                height: SNES_HEIGHT,
            },
            unsupportedOpcodes: [],
        };
    }

    #bootCore() {
        this.frameCount = 0;
        this.audioSampleCount = 0;
        this.totalMasterCycles = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
        this.controllers = [new Set(), new Set()];
    }

    #setButton(player, buttonName, pressed) {
        this.#ensureLoaded();

        if (!Number.isInteger(player) || player < 1 || player > 2) {
            throw new RangeError('player must be 1 or 2.');
        }

        const normalized = String(buttonName).trim().toUpperCase();

        if (!SNES_BUTTON_ORDER.includes(normalized)) {
            throw new RangeError(
                `Unsupported button "${buttonName}". ` +
                `Use: ${SNES_BUTTON_ORDER.join(', ')}`,
            );
        }

        const controller = this.controllers[player - 1];

        if (pressed) {
            controller.add(normalized);
        } else {
            controller.delete(normalized);
        }
    }

    #renderFrame() {
        const frame = new Uint32Array(SNES_WIDTH * SNES_HEIGHT);
        const romLength = this.romData.length;
        const frameSeed = this.frameCount * 73;

        for (let y = 0; y < SNES_HEIGHT; y += 1) {
            const rowOffset = y * SNES_WIDTH;
            const colorSeed = (frameSeed + y * 17) % romLength;
            const base = this.romData[colorSeed];
            const accent = this.romData[(colorSeed + 97) % romLength];
            const rowColor = packColor(
                base,
                (base + accent) & 0xff,
                accent,
            );

            for (let x = 0; x < SNES_WIDTH; x += 1) {
                const blink = ((x + frameSeed) & 0x10) === 0 ? 0 : 16;
                const red = ((rowColor >>> 16) & 0xff) ^ blink;
                const green = ((rowColor >>> 8) & 0xff) ^ (blink >> 1);
                const blue = (rowColor & 0xff) ^ (blink >> 2);
                frame[rowOffset + x] = packColor(red, green, blue);
            }
        }

        return frame;
    }

    #ensureLoaded() {
        if (!this.romData || !this.romMetadata) {
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
