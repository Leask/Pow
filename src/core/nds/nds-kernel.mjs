import { toByteArray } from '../../shared/nintendo/rom-buffer.mjs';
import { checksum32 } from '../../shared/nintendo/checksum.mjs';
import { ARMCPU } from '../../shared/nintendo/arm-cpu.mjs';
import { parseNDSHeader } from './rom.mjs';
import { NDSMemory, NDSBus, NDS_BUTTONS } from './bus.mjs';
import { NDSPPU } from './ppu.mjs';
import { NDSAudio } from './audio.mjs';
import {
    saveHandheldState,
    loadHandheldState,
} from '../../shared/nintendo/handheld-state.mjs';

class NDSKernel {
    constructor(options = {}) {
        this.options = options;
        this.frameCount = 0;
    }
    loadROMBuffer(data) {
        this.header = parseNDSHeader(data);
        this.rom = toByteArray(data).slice();
        this.romIdentity = `${this.rom.length}:${checksum32(this.rom)}`;
        this.machine = null;
        this.reset();
        return this.getROMMetadata();
    }
    reset() {
        if (!this.rom) throw new Error('No ROM loaded.');
        const backup = this.machine?.backup.slice();
        const m = (this.machine = new NDSMemory(this.rom));
        if (backup) m.backup.set(backup);
        m.buses = [new NDSBus(m, 0), new NDSBus(m, 1)];
        this.cpus = m.buses.map((bus, i) => {
            const image = i === 0 ? this.header.arm9 : this.header.arm7;
            const cpu = new ARMCPU(bus, { v5: i === 0, entry: image.entry });
            bus.cpu = cpu;
            bus.entry = image.entry;
            cpu.r[13] = i === 0 ? 0x03002f7c : 0x0380fd80;
            cpu.banks[0x12][5] = i === 0 ? 0x03003f80 : 0x0380ff80;
            cpu.banks[0x13][5] = i === 0 ? 0x03003fc0 : 0x0380ffc0;
            for (let j = 0; j < image.size; j += 1)
                bus.write8(image.address + j, this.rom[image.offset + j]);
            return cpu;
        });
        m.ppu = new NDSPPU(m);
        m.audio = new NDSAudio(m, this.options);
        const arm9 = m.buses[0];
        for (let i = 0; i < 0x200; i += 1)
            arm9.write8(0x027ffe00 + i, this.rom[i]);
        for (let i = 0; i < 0x70; i += 1)
            arm9.write8(0x027ffc80 + i, m.firmware[0x3fe00 + i]);
        arm9.write32(0x027ff800, 0x00001fc2);
        arm9.write32(0x027ff804, 0x00001fc2);
        arm9.write16(
            0x027ff808,
            new DataView(this.rom.buffer).getUint16(0x15e, true),
        );
        arm9.write16(0x027ff850, 0x5835);
        arm9.write16(0x027ffc40, 1);
        this.frameCount = this.audioSampleCount = 0;
        this.clock9 = this.clock7 = this.time = 0;
        this.lastFrameBuffer = m.ppu.frameBuffer;
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
    }
    advance(cycles) {
        const target = this.time + cycles,
            m = this.machine;
        // ARM9 is clocked at twice ARM7. Interleave in short slices so IPC
        // handshakes and shared-memory writes remain visible to both CPUs.
        while (this.time < target) {
            const slice = Math.min(target, this.time + 32);
            while (this.clock9 < slice * 2) {
                const idle = this.cpus[0].halted && !m.buses[0].irqPending();
                const cycles9 = idle
                    ? slice * 2 - this.clock9
                    : this.cpus[0].step();
                this.clock9 += cycles9;
                m.buses[0].clock(cycles9 / 2);
            }
            while (this.clock7 < slice) {
                const idle = this.cpus[1].halted && !m.buses[1].irqPending();
                const cycles7 = idle
                    ? slice - this.clock7
                    : this.cpus[1].step();
                this.clock7 += cycles7;
                m.buses[1].clock(cycles7);
            }
            m.audio.clock(slice - this.time);
            this.time = slice;
        }
    }
    runFrame() {
        if (!this.machine) throw new Error('No ROM loaded.');
        const m = this.machine;
        for (let line = 0; line < 263; line += 1) {
            m.line = line;
            for (const bus of m.buses) {
                bus.setReg(6, line);
                bus.io[4] &= ~7;
                if (line >= 192 && line < 262) bus.io[4] |= 1;
                const match = bus.io[5] | ((bus.io[4] & 128) << 1);
                if (line === match) {
                    bus.io[4] |= 4;
                    if (bus.io[4] & 32) bus.interrupt(2);
                }
                if (line === 192) {
                    if (bus.io[4] & 8) bus.interrupt(0);
                    bus.eventDMA(1);
                }
            }
            if (line === 0)
                for (let e = 0; e < 2; e += 1)
                    for (let i = 0; i < 2; i += 1) m.ppu.latch(e, i);
            this.advance(1536);
            if (line < 192) m.ppu.renderLine(line);
            for (const bus of m.buses) {
                bus.io[4] |= 2;
                if (bus.io[4] & 16) bus.interrupt(1);
                if (line < 192 && bus.index === 0) bus.eventDMA(2);
            }
            this.advance(594);
        }
        m.frame = ++this.frameCount;
        this.audioSampleCount = m.audio.sampleCount;
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
    input(player, name, pressed) {
        if (!this.machine) throw new Error('No ROM loaded.');
        if (player !== 1) throw new RangeError('DS supports one local player.');
        this.machine.setButton(name, pressed);
    }
    setTouch(x, y, down = true) {
        if (!this.machine) throw new Error('No ROM loaded.');
        if (!Number.isFinite(x) || !Number.isFinite(y))
            throw new RangeError('Invalid touch coordinates.');
        this.machine.touch = {
            x: Math.max(0, Math.min(255, Math.round(x))),
            y: Math.max(0, Math.min(191, Math.round(y))),
            down: !!down,
        };
    }
    getROMMetadata() {
        return { ...this.header };
    }
    saveState() {
        if (!this.machine) throw new Error('No ROM loaded.');
        return saveHandheldState(this);
    }
    loadState(state) {
        if (!this.machine) throw new Error('No ROM loaded.');
        loadHandheldState(this, state);
    }
    getExecutionState() {
        return {
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastFrameChecksum: this.lastFrameChecksum,
            cpu:
                this.cpus?.map((cpu) => ({
                    pc: cpu.pc,
                    cpsr: cpu.cpsr,
                    instructions: cpu.instructions,
                    halted: cpu.halted,
                })) ?? null,
            ppu: this.machine
                ? {
                      line: this.machine.line,
                      vramBanks: [...this.machine.vramControl],
                  }
                : null,
        };
    }
}

export { NDSKernel, NDS_BUTTONS };
