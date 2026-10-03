import { toByteArray } from '../../shared/nintendo/rom-buffer.mjs';
import { checksum32 } from '../../shared/nintendo/checksum.mjs';
import { ARMCPU } from '../../shared/nintendo/arm-cpu.mjs';
import { GBABus, GBA_BUTTONS } from './bus.mjs';
import { parseGBAHeader } from './rom.mjs';
import {
    saveHandheldState,
    loadHandheldState,
} from '../../shared/nintendo/handheld-state.mjs';

class GBAKernel {
    constructor(options = {}) {
        this.options = options;
        this.frameCount = 0;
    }
    loadROMBuffer(data) {
        this.header = parseGBAHeader(data);
        this.rom = toByteArray(data).slice();
        this.romIdentity = `${this.rom.length}:${checksum32(this.rom)}`;
        this.bus = null;
        this.reset();
        return this.getROMMetadata();
    }
    reset() {
        if (!this.rom) throw new Error('No ROM loaded.');
        const save = this.bus?.save.slice();
        this.bus = new GBABus(this.rom, this.options);
        if (save) this.bus.save.set(save);
        this.cpu = new ARMCPU(this.bus);
        this.bus.cpu = this.cpu;
        this.cpu.r[13] = 0x03007f00;
        this.cpu.banks[0x12][5] = 0x03007fa0;
        this.cpu.banks[0x13][5] = 0x03007fe0;
        this.frameCount = this.audioSampleCount = 0;
        this.lastFrameBuffer = this.bus.ppu.frameBuffer;
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
    }
    runFrame() {
        if (!this.bus) throw new Error('No ROM loaded.');
        const target = this.bus.frame + 1;
        while (this.bus.frame < target) this.bus.clock(this.cpu.step());
        this.frameCount += 1;
        this.audioSampleCount = this.bus.sampleCount;
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
        if (!this.bus) throw new Error('No ROM loaded.');
        if (player !== 1)
            throw new RangeError('GBA supports one local player.');
        this.bus.setButton(name, down);
    }
    getROMMetadata() {
        return { ...this.header };
    }
    saveState() {
        if (!this.bus) throw new Error('No ROM loaded.');
        return saveHandheldState(this);
    }
    loadState(state) {
        if (!this.bus) throw new Error('No ROM loaded.');
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
                      cpsr: this.cpu.cpsr,
                      sp: this.cpu.r[13],
                      instructions: this.cpu.instructions,
                      halted: this.cpu.halted,
                  }
                : null,
            ppu: this.bus
                ? { line: this.bus.line, displayControl: this.bus.reg(0) }
                : null,
        };
    }
}

export { GBAKernel, GBA_BUTTONS };
