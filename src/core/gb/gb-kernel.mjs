import { checksum32 } from '../../shared/nintendo/checksum.mjs';
import { GBCartridge } from './cartridge.mjs';
import { GBBus, BUTTONS } from './bus.mjs';
import { SM83 } from './cpu-sm83.mjs';
import {
    saveHandheldState,
    loadHandheldState,
} from '../../shared/nintendo/handheld-state.mjs';

class GBKernel {
    constructor(options = {}) {
        this.options = options;
        this.frameCount = 0;
        this.audioSampleCount = 0;
    }
    loadROMBuffer(data) {
        this.cartridge = new GBCartridge(data);
        this.romIdentity = `${this.cartridge.rom.length}:${checksum32(this.cartridge.rom)}`;
        this.reset();
        return this.getROMMetadata();
    }
    ensureCore() {
        if (!this.bus) throw new Error('No ROM loaded.');
    }
    reset() {
        if (!this.cartridge) throw new Error('No ROM loaded.');
        this.cartridge.reset();
        this.frameCount = this.audioSampleCount = 0;
        this.nextFrame = 70224;
        this.realCycles = 0;
        this.bus = new GBBus(this.cartridge, {
            ...this.options,
            color: this.options.color ?? this.cartridge.header.color,
            onAudioSample: (sample, count) => {
                this.audioSampleCount = count;
                this.options.onAudioSample?.(sample, count);
            },
        });
        this.cpu = new SM83(this.bus, this.bus.color);
        this.lastFrameBuffer = this.bus.ppu.frameBuffer;
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
    }
    runFrame() {
        this.ensureCore();
        while (this.realCycles < this.nextFrame) {
            const speed = this.bus.doubleSpeed ? 2 : 1;
            const cycles = this.cpu.step();
            this.bus.clock(cycles);
            this.realCycles += cycles / speed;
        }
        this.nextFrame += 70224;
        this.frameCount += 1;
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
        this.options.onFrame?.(this.lastFrameBuffer, this.frameCount);
        return this.getExecutionState();
    }
    runFrames(count) {
        if (!Number.isInteger(count) || count <= 0)
            throw new RangeError('Invalid frame count.');
        for (let i = 0; i < count; i += 1) this.runFrame();
        return this.getExecutionState();
    }
    pressButton(player, name) {
        this.input(player, name, true);
    }
    releaseButton(player, name) {
        this.input(player, name, false);
    }
    input(player, name, down) {
        this.ensureCore();
        if (player !== 1) throw new RangeError('GB supports one local player.');
        this.bus.setButton(name, down);
    }
    getROMMetadata() {
        return { ...this.cartridge?.header, mapperId: this.cartridge?.mapper };
    }
    saveState() {
        this.ensureCore();
        return saveHandheldState(this);
    }
    loadState(state) {
        this.ensureCore();
        loadHandheldState(this, state);
    }
    getExecutionState() {
        return {
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastFrameChecksum: this.lastFrameChecksum,
            cpu: this.cpu
                ? {
                      pc: this.cpu.pc,
                      sp: this.cpu.sp,
                      a: this.cpu.r[7],
                      f: this.cpu.f,
                      instructions: this.cpu.instructions,
                      halted: this.cpu.halted,
                  }
                : null,
            ppu: this.bus
                ? {
                      line: this.bus.ppu.line,
                      mode: this.bus.ppu.mode(),
                      color: this.bus.color,
                      doubleSpeed: this.bus.doubleSpeed,
                  }
                : null,
        };
    }
}

class GBCKernel extends GBKernel {
    constructor(options = {}) {
        super({ ...options, color: true });
    }
}

export { GBKernel, GBCKernel, BUTTONS as GB_BUTTONS };
