import { GBAPU } from '../../shared/nintendo/handheld-psg.mjs';
import { GBAPPU } from './ppu.mjs';
import { biosService } from '../../shared/nintendo/arm-bios.mjs';

const KEYS = [
    'A',
    'B',
    'SELECT',
    'START',
    'RIGHT',
    'LEFT',
    'UP',
    'DOWN',
    'R',
    'L',
];
const SOUND_REGS = new Map([
    [0x60, 0],
    [0x62, 1],
    [0x63, 2],
    [0x64, 3],
    [0x65, 4],
    [0x68, 6],
    [0x69, 7],
    [0x6c, 8],
    [0x6d, 9],
    [0x70, 10],
    [0x72, 11],
    [0x73, 12],
    [0x74, 13],
    [0x75, 14],
    [0x78, 16],
    [0x79, 17],
    [0x7c, 18],
    [0x7d, 19],
    [0x80, 20],
    [0x81, 21],
    [0x84, 22],
]);

class GBABus {
    constructor(rom, options = {}) {
        this.rom = rom;
        this.options = options;
        this.ewram = new Uint8Array(0x40000);
        this.iwram = new Uint8Array(0x8000);
        this.io = new Uint8Array(1024);
        this.palette = new Uint8Array(1024);
        this.vram = new Uint8Array(0x18000);
        this.oam = new Uint8Array(1024);
        this.save = new Uint8Array(0x20000).fill(255);
        this.bios = new Uint8Array(0x4000);
        const bios = new DataView(this.bios.buffer);
        bios.setUint32(0x18, 0xea000038, true);
        [
            0xe92d500f, 0xe59f0018, 0xe59f1018, 0xe1a0e00f, 0xe591f000,
            0xe8bd500f, 0xe25ef004, 0xe1a00000, 0xe1a00000, 0x04000000,
            0x03007ffc,
        ].forEach((word, i) => bios.setUint32(0x100 + i * 4, word, true));
        this.cycles = 0;
        this.line = 0;
        this.lineCycles = 0;
        this.frame = 0;
        this.waitMask = 0;
        this.waitFlags = 0;
        this.keys = 0x3ff;
        this.timers = Array.from({ length: 4 }, () => ({
            reload: 0,
            value: 0,
            phase: 0,
            control: 0,
        }));
        this.dma = Array.from({ length: 4 }, () => ({
            source: 0,
            dest: 0,
            initialDest: 0,
            count: 0,
            control: 0,
        }));
        this.fifo = [[], []];
        this.pcm = new Int8Array(2);
        this.apuPhase = 0;
        this.apuSeq = 0;
        this.sampleCount = 0;
        this.pcmCap = new Float64Array(2);
        this.flashStage = 0;
        this.flashMode = '';
        this.flashBank = 0;
        this.eepromBits = [];
        this.eepromOutput = [];
        this.eepromAddressBits = rom.length > 0x1000000 ? 14 : 6;
        this.ppu = new GBAPPU(this);
        this.apu = new GBAPU({
            sampleRate: options.sampleRate,
            onAudioFrame: (left, right) => this.audio(left, right),
        });
        this.io[0x130] = 255;
        this.io[0x131] = 3;
        this.io[0x88] = 0;
        this.io[0x89] = 2;
    }
    reg(offset) {
        return this.io[offset] | (this.io[offset + 1] << 8);
    }
    reg32(offset) {
        return (this.reg(offset) | (this.reg(offset + 2) << 16)) >>> 0;
    }
    setReg(offset, value) {
        this.io[offset] = value;
        this.io[offset + 1] = value >>> 8;
    }
    interrupt(bit) {
        this.waitFlags |= 1 << bit;
        this.setReg(0x202, this.reg(0x202) | (1 << bit));
    }
    onExceptionReturn(cpu) {
        if (!this.waitMask) return;
        if (this.waitFlags & this.waitMask) this.waitMask = 0;
        else cpu.halted = true;
    }
    irqPending() {
        return !!(this.reg(0x208) & 1) && !!(this.reg(0x200) & this.reg(0x202));
    }
    swi(number, cpu) {
        biosService(number, cpu, this);
    }
    setButton(name, down) {
        const bit = KEYS.indexOf(String(name).toUpperCase());
        if (bit < 0) throw new RangeError(`Unsupported GBA button ${name}`);
        if (down) this.keys &= ~(1 << bit);
        else this.keys |= 1 << bit;
        this.setReg(0x130, this.keys);
        const control = this.reg(0x132),
            mask = control & 1023;
        if (
            control & 0x4000 &&
            (control & 0x8000
                ? (~this.keys & mask) === mask
                : !!(~this.keys & mask))
        )
            this.interrupt(12);
    }
    region(address) {
        const high = address >>> 24;
        if (high === 0 && address < 0x4000) return [this.bios, address];
        if (high === 2) return [this.ewram, address & 0x3ffff];
        if (high === 3) return [this.iwram, address & 0x7fff];
        if (high === 5) return [this.palette, address & 1023];
        if (high === 6) {
            let offset = address & 0x1ffff;
            if (offset >= 0x18000) offset -= 0x8000;
            return [this.vram, offset];
        }
        if (high === 7) return [this.oam, address & 1023];
        if (high >= 8 && high <= 13) return [this.rom, address & 0x1ffffff];
        return null;
    }
    isEEPROM(address) {
        return (
            address >>> 24 === 13 &&
            (this.rom.length <= 0x1000000 || (address & 0x1ffffff) >= 0x1ffff00)
        );
    }
    read8(address) {
        address >>>= 0;
        if (address >>> 24 === 4) {
            const offset = address & 0xffffff;
            if (offset >= 1024) return 0;
            if (offset >= 0x100 && offset < 0x110 && (offset & 3) < 2) {
                return (
                    (this.timers[(offset - 0x100) >>> 2].value >>>
                        ((offset & 1) * 8)) &
                    255
                );
            }
            if (SOUND_REGS.has(offset))
                return this.apu.read(0xff10 + SOUND_REGS.get(offset));
            return this.io[offset];
        }
        if (address >>> 24 >= 14) {
            const index = address & 65535;
            if (this.flashMode === 'id')
                return index === 0 ? 0xc2 : index === 1 ? 0x09 : 255;
            return this.save[index + this.flashBank * 65536];
        }
        const region = this.region(address);
        if (!region) return 0;
        if (region[0] === this.rom && region[1] >= this.rom.length) {
            return (((address >>> 1) & 65535) >>> ((address & 1) * 8)) & 255;
        }
        return region[0][region[1]] ?? 0;
    }
    read16(address) {
        if (this.isEEPROM(address))
            return this.eepromOutput.length ? this.eepromOutput.shift() : 1;
        return this.read8(address & ~1) | (this.read8((address & ~1) + 1) << 8);
    }
    read32(address) {
        address &= ~3;
        return (this.read16(address) | (this.read16(address + 2) << 16)) >>> 0;
    }
    flashWrite(address, value) {
        const index = address & 65535;
        if (this.flashMode === 'program') {
            this.save[index + this.flashBank * 65536] = value;
            this.flashMode = '';
            return;
        }
        if (this.flashMode === 'bank') {
            this.flashBank = value & 1;
            this.flashMode = '';
            return;
        }
        if (value === 0xf0) {
            this.flashMode = '';
            this.flashStage = 0;
            return;
        }
        if (this.flashStage === 0 && index === 0x5555 && value === 0xaa) {
            this.flashStage = 1;
            return;
        }
        if (this.flashStage === 1 && index === 0x2aaa && value === 0x55) {
            this.flashStage = 2;
            return;
        }
        if (this.flashStage === 2) {
            this.flashStage = 0;
            if (this.flashMode === 'erase') {
                if (value === 0x10 && index === 0x5555) this.save.fill(255);
                if (value === 0x30)
                    this.save.fill(
                        255,
                        (index & ~4095) + this.flashBank * 65536,
                        (index & ~4095) + this.flashBank * 65536 + 4096,
                    );
                this.flashMode = '';
            } else if (index === 0x5555) {
                this.flashMode =
                    {
                        0x90: 'id',
                        0xa0: 'program',
                        0xb0: 'bank',
                        0x80: 'erase',
                    }[value] ?? '';
            }
            return;
        }
        this.flashStage = 0;
        this.save[index] = value;
    }
    eepromWrite(value) {
        this.eepromBits.push(value & 1);
        if (this.eepromBits.length < 2) return;
        const read = this.eepromBits[1] === 1;
        const length = 2 + this.eepromAddressBits + (read ? 1 : 65);
        if (this.eepromBits.length !== length) return;
        let address = 0;
        for (let i = 2; i < 2 + this.eepromAddressBits; i += 1)
            address = (address << 1) | this.eepromBits[i];
        address = (address & 1023) * 8;
        if (read) {
            this.eepromOutput = [0, 0, 0, 0];
            for (let i = 0; i < 64; i += 1)
                this.eepromOutput.push(
                    (this.save[address + (i >>> 3)] >>> (7 - (i & 7))) & 1,
                );
        } else {
            for (let i = 0; i < 8; i += 1) {
                let byte = 0;
                for (let j = 0; j < 8; j += 1)
                    byte =
                        (byte << 1) |
                        this.eepromBits[2 + this.eepromAddressBits + i * 8 + j];
                this.save[address + i] = byte;
            }
        }
        this.eepromBits = [];
    }
    write8(address, value, wide = false) {
        address >>>= 0;
        value &= 255;
        const high = address >>> 24;
        if (high === 4) {
            this.writeIO(address & 0xffffff, value);
            return;
        }
        if (high >= 14) {
            this.flashWrite(address, value);
            return;
        }
        const region = this.region(address);
        if (!region || region[0] === this.rom || region[0] === this.bios)
            return;
        if (!wide && (high === 5 || high === 6)) {
            if (
                high === 6 &&
                region[1] >= ((this.reg(0) & 7) >= 3 ? 0x14000 : 0x10000)
            )
                return;
            region[0][region[1] & ~1] = value;
            region[0][(region[1] & ~1) + 1] = value;
        } else if (wide || high !== 7) region[0][region[1]] = value;
    }
    write16(address, value) {
        address &= ~1;
        if (this.isEEPROM(address)) {
            this.eepromWrite(value);
            return;
        }
        this.write8(address, value, true);
        this.write8(address + 1, value >>> 8, true);
    }
    write32(address, value) {
        address &= ~3;
        this.write16(address, value & 65535);
        this.write16(address + 2, value >>> 16);
    }
    writeIO(offset, value) {
        if (offset >= 1024) return;
        if (offset === 0x202 || offset === 0x203) {
            this.io[offset] &= ~value;
            return;
        }
        if (
            offset === 6 ||
            offset === 7 ||
            offset === 0x130 ||
            offset === 0x131
        )
            return;
        if (offset === 4) value = (value & 0xf8) | (this.io[4] & 7);
        if (offset >= 0xa0 && offset < 0xa8) {
            const index = (offset - 0xa0) >>> 2;
            if (this.fifo[index].length < 32)
                this.fifo[index].push((value << 24) >> 24);
            return;
        }
        if (offset === 0x83) {
            if (value & 8) this.fifo[0] = [];
            if (value & 128) this.fifo[1] = [];
            value &= 0x77;
        }
        this.io[offset] = value;
        if (SOUND_REGS.has(offset))
            this.apu.write(0xff10 + SOUND_REGS.get(offset), value);
        if (offset >= 0x90 && offset < 0xa0)
            this.apu.write(0xff30 + offset - 0x90, value);
        if (offset >= 0x28 && offset < 0x40 && (offset & 15) >= 8) {
            this.ppu.latchAffine((offset - 0x28) >>> 4);
        }
        if (offset >= 0x100 && offset < 0x110) {
            const index = (offset - 0x100) >>> 2,
                timer = this.timers[index],
                local = offset & 3;
            if (local < 2) timer.reload = this.reg(0x100 + index * 4);
            if (local === 2) {
                const old = timer.control;
                timer.control = value;
                if (!(old & 128) && value & 128) {
                    timer.value = timer.reload;
                    timer.phase = 0;
                }
            }
        }
        if (offset >= 0xb0 && offset < 0xe0 && (offset - 0xb0) % 12 === 11) {
            const index = Math.floor((offset - 0xb0) / 12),
                base = 0xb0 + index * 12,
                dma = this.dma[index];
            const control = this.reg(base + 10),
                old = dma.control;
            dma.control = control;
            if (!(old & 0x8000) && control & 0x8000) {
                dma.source = this.reg32(base) & 0x0fffffff;
                dma.dest = this.reg32(base + 4) & 0x0fffffff;
                dma.initialDest = dma.dest;
                dma.count = this.reg(base + 8) || (index === 3 ? 65536 : 16384);
                if (((control >>> 12) & 3) === 0) this.transfer(index);
            }
        }
        if (offset === 0x301) this.cpu.halted = true;
    }
    transfer(index, sound = false) {
        const dma = this.dma[index],
            control = dma.control;
        if (!(control & 0x8000)) return;
        const size = sound || control & 0x400 ? 4 : 2;
        const count = sound ? 4 : dma.count;
        const destMode = (control >>> 5) & 3,
            srcMode = (control >>> 7) & 3;
        const sourceStep = srcMode === 0 ? size : srcMode === 1 ? -size : 0;
        const destStep = sound
            ? 0
            : destMode === 1
              ? -size
              : destMode === 2
                ? 0
                : size;
        if (this.isEEPROM(dma.dest) && [9, 17, 73, 81].includes(count)) {
            this.eepromAddressBits = [17, 81].includes(count) ? 14 : 6;
        }
        for (let i = 0; i < count; i += 1) {
            if (size === 4)
                this.write32(dma.dest & ~3, this.read32(dma.source & ~3));
            else this.write16(dma.dest & ~1, this.read16(dma.source & ~1));
            dma.source = (dma.source + sourceStep) >>> 0;
            dma.dest = (dma.dest + destStep) >>> 0;
        }
        if (control & 0x4000) this.interrupt(8 + index);
        if (control & 512 && (control >>> 12) & 3) {
            if (destMode === 3) dma.dest = dma.initialDest;
        } else {
            dma.control &= ~0x8000;
            this.io[0xbb + index * 12] &= 127;
        }
    }
    eventDMA(timing) {
        for (let i = 0; i < 4; i += 1)
            if (((this.dma[i].control >>> 12) & 3) === timing) this.transfer(i);
    }
    timerOverflow(index, count) {
        const timer = this.timers[index];
        if (timer.control & 64) this.interrupt(3 + index);
        if (index < 2) {
            const control = this.reg(0x82);
            for (let channel = 0; channel < 2; channel += 1)
                if (((control >>> (10 + channel * 4)) & 1) === index) {
                    for (let j = 0; j < count; j += 1) {
                        this.pcm[channel] = this.fifo[channel].shift() ?? 0;
                        if (this.fifo[channel].length <= 16) {
                            for (let d = 1; d <= 2; d += 1)
                                if (
                                    ((this.dma[d].control >>> 12) & 3) === 3 &&
                                    (this.dma[d].dest & ~3) ===
                                        0x040000a0 + channel * 4
                                )
                                    this.transfer(d, true);
                        }
                    }
                }
        }
    }
    clockTimers(cycles) {
        let cascade = 0;
        for (let i = 0; i < 4; i += 1) {
            const timer = this.timers[i];
            if (!(timer.control & 128)) {
                cascade = 0;
                continue;
            }
            let ticks;
            if (i && timer.control & 4) ticks = cascade;
            else {
                const divisor = [1, 64, 256, 1024][timer.control & 3];
                timer.phase += cycles;
                ticks = Math.floor(timer.phase / divisor);
                timer.phase %= divisor;
            }
            let value = timer.value + ticks;
            cascade = 0;
            while (value >= 65536) {
                value -= 65536 - timer.reload;
                cascade += 1;
            }
            timer.value = value;
            if (cascade) this.timerOverflow(i, cascade);
        }
    }
    audio(left, right) {
        const control = this.reg(0x82),
            ratio = [0.25, 0.5, 1, 0.25][control & 3];
        left *= ratio;
        right *= ratio;
        for (let channel = 0; channel < 2; channel += 1) {
            const value =
                (this.pcm[channel] / 128) *
                (control & (4 << channel) ? 1 : 0.5);
            if (control & (0x100 << (channel * 4))) right += value;
            if (control & (0x200 << (channel * 4))) left += value;
        }
        if (!(this.io[0x84] & 128)) left = right = 0;
        const outL = left - this.pcmCap[0],
            outR = right - this.pcmCap[1];
        this.pcmCap[0] = left - outL * 0.995;
        this.pcmCap[1] = right - outR * 0.995;
        this.sampleCount += 1;
        this.options.onAudioFrame?.(outL * 0.5, outR * 0.5);
        this.options.onAudioSample?.((outL + outR) * 0.25, this.sampleCount);
    }
    clock(cycles) {
        this.cycles += cycles;
        this.clockTimers(cycles);
        this.apuPhase += cycles;
        this.apuSeq += cycles;
        while (this.apuSeq >= 32768) {
            this.apuSeq -= 32768;
            this.apu.frameClock();
        }
        const apuCycles = Math.floor(this.apuPhase / 4);
        this.apuPhase %= 4;
        if (apuCycles) this.apu.clock(apuCycles);
        this.lineCycles += cycles;
        if (this.lineCycles >= 960 && !(this.io[4] & 2)) {
            this.io[4] |= 2;
            if (this.line < 160) {
                this.ppu.renderLine(this.line);
                this.eventDMA(2);
            }
            if (this.io[4] & 16) this.interrupt(1);
        }
        if (this.lineCycles >= 1232) {
            this.lineCycles -= 1232;
            this.line = (this.line + 1) % 228;
            this.setReg(6, this.line);
            this.io[4] &= ~7;
            if (this.line >= 160 && this.line < 227) this.io[4] |= 1;
            if (this.line === this.io[5]) {
                this.io[4] |= 4;
                if (this.io[4] & 32) this.interrupt(2);
            }
            if (this.line === 160) {
                this.frame += 1;
                if (this.io[4] & 8) this.interrupt(0);
                this.eventDMA(1);
            }
            if (this.line === 0) {
                this.ppu.latchAffine(0);
                this.ppu.latchAffine(1);
            }
        }
    }
}

export { GBABus, KEYS as GBA_BUTTONS };
