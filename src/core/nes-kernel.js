'use strict';

const fs = require('node:fs');
const path = require('node:path');
const jsnes = require('jsnes');
const { parseINESHeader } = require('./ines');

const BUTTONS = {
    A: jsnes.Controller.BUTTON_A,
    B: jsnes.Controller.BUTTON_B,
    SELECT: jsnes.Controller.BUTTON_SELECT,
    START: jsnes.Controller.BUTTON_START,
    UP: jsnes.Controller.BUTTON_UP,
    DOWN: jsnes.Controller.BUTTON_DOWN,
    LEFT: jsnes.Controller.BUTTON_LEFT,
    RIGHT: jsnes.Controller.BUTTON_RIGHT,
};

class NESKernel {
    constructor(options = {}) {
        this.frameCount = 0;
        this.audioSampleCount = 0;
        this.lastStatus = null;
        this.lastFrameBuffer = null;
        this.romMetadata = null;
        this.romPath = null;
        this.romLoaded = false;

        const onFrame = options.onFrame;
        const onAudioSample = options.onAudioSample;
        const onStatusUpdate = options.onStatusUpdate;

        this.nes = new jsnes.NES({
            emulateSound: options.emulateSound ?? false,
            preferredFrameRate: options.preferredFrameRate ?? 60,
            sampleRate: options.sampleRate ?? 44100,
            onFrame: (frameBuffer) => {
                this.frameCount += 1;
                this.lastFrameBuffer = Array.from(frameBuffer);

                if (typeof onFrame === 'function') {
                    onFrame(frameBuffer, this.frameCount);
                }
            },
            onAudioSample: (left, right) => {
                this.audioSampleCount += 1;

                if (typeof onAudioSample === 'function') {
                    onAudioSample(left, right, this.audioSampleCount);
                }
            },
            onStatusUpdate: (message) => {
                this.lastStatus = message;

                if (typeof onStatusUpdate === 'function') {
                    onStatusUpdate(message);
                }
            },
        });
    }

    loadROMBuffer(romBuffer) {
        const buffer = Buffer.isBuffer(romBuffer)
            ? romBuffer
            : Buffer.from(romBuffer);

        this.romMetadata = parseINESHeader(buffer);
        this.nes.loadROM(buffer.toString('binary'));
        this.romLoaded = true;
        return this.getROMMetadata();
    }

    loadROMFromFile(romFilePath) {
        const absolutePath = path.resolve(romFilePath);
        const romBuffer = fs.readFileSync(absolutePath);
        this.romPath = absolutePath;
        this.loadROMBuffer(romBuffer);

        return this.getROMMetadata();
    }

    runFrame() {
        this.ensureROMLoaded();
        this.nes.frame();
        return this.getExecutionState();
    }

    runFrames(frameCount) {
        this.ensureROMLoaded();

        if (!Number.isInteger(frameCount) || frameCount <= 0) {
            throw new RangeError('frameCount must be a positive integer.');
        }

        for (let index = 0; index < frameCount; index += 1) {
            this.nes.frame();
        }

        return this.getExecutionState();
    }

    pressButton(player, buttonName) {
        this.setButtonState(player, buttonName, true);
    }

    releaseButton(player, buttonName) {
        this.setButtonState(player, buttonName, false);
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
        const cpu = this.nes.cpu;
        const ppu = this.nes.ppu;

        return {
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastStatus: this.lastStatus,
            cpu: cpu
                ? {
                    pc: cpu.REG_PC & 0xffff,
                    sp: cpu.REG_SP & 0xffff,
                    acc: cpu.REG_ACC & 0xff,
                    x: cpu.REG_X & 0xff,
                    y: cpu.REG_Y & 0xff,
                    carry: cpu.F_CARRY,
                    zero: cpu.F_ZERO === 0 ? 1 : 0,
                    interrupt: cpu.F_INTERRUPT,
                    decimal: cpu.F_DECIMAL,
                    overflow: cpu.F_OVERFLOW,
                    sign: cpu.F_SIGN,
                }
                : null,
            ppu: ppu
                ? {
                    scanline: ppu.scanline,
                    cycle: ppu.curX,
                }
                : null,
            lastFrameChecksum: this.getLastFrameChecksum(),
        };
    }

    getLastFrameChecksum() {
        if (!this.lastFrameBuffer) {
            return null;
        }

        let checksum = 0;

        for (const pixel of this.lastFrameBuffer) {
            checksum = (checksum + (pixel >>> 0)) >>> 0;
        }

        return checksum >>> 0;
    }

    setButtonState(player, buttonName, pressed) {
        this.ensureROMLoaded();

        if (!Number.isInteger(player) || player < 1 || player > 2) {
            throw new RangeError('player must be 1 or 2.');
        }

        const normalizedButton = String(buttonName).trim().toUpperCase();
        const button = BUTTONS[normalizedButton];

        if (button === undefined) {
            throw new RangeError(
                `Unsupported button "${buttonName}". ` +
                `Use: ${Object.keys(BUTTONS).join(', ')}`,
            );
        }

        if (pressed) {
            this.nes.buttonDown(player, button);
            return;
        }

        this.nes.buttonUp(player, button);
    }

    ensureROMLoaded() {
        if (!this.romLoaded) {
            throw new Error('No ROM loaded. Call loadROMFromFile() first.');
        }
    }
}

module.exports = {
    NESKernel,
    BUTTONS: Object.keys(BUTTONS),
};
