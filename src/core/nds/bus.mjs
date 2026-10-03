import { biosService } from '../../shared/nintendo/arm-bios.mjs';
import { crc16 } from './rom.mjs';

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
    'X',
    'Y',
];
const BANK_SIZES = [
    0x20000, 0x20000, 0x20000, 0x20000, 0x10000, 0x4000, 0x4000, 0x8000, 0x4000,
];
const LCD_OFFSETS = [
    0, 0x20000, 0x40000, 0x60000, 0x80000, 0x90000, 0x94000, 0x98000, 0xa0000,
];

class NDSMemory {
    constructor(rom) {
        this.rom = rom;
        this.ram = new Uint8Array(0x400000);
        this.sharedWRAM = new Uint8Array(32768);
        this.arm7WRAM = new Uint8Array(65536);
        this.itcm = new Uint8Array(32768);
        this.dtcm = new Uint8Array(16384);
        this.dtcmBase = 0x00800000;
        this.dtcmEnabled = true;
        this.itcmEnabled = true;
        this.palette = new Uint8Array(2048);
        this.oam = new Uint8Array(2048);
        this.vram = BANK_SIZES.map((size) => new Uint8Array(size));
        this.vramControl = new Uint8Array(9);
        this.vramMappings = [];
        this.vramPages = [[], []];
        this.wramControl = 3;
        this.fifos = [[], []];
        this.fifoLast = new Uint32Array(2);
        this.keys = 0x0fff;
        this.touch = { down: false, x: 128, y: 96 };
        this.firmware = new Uint8Array(0x40000).fill(255);
        this.firmware[0x20] = 0xc0;
        this.firmware[0x21] = 0x7f;
        this.firmware.fill(0, 0x3fe00, 0x40000);
        // Generic firmware user settings, including touchscreen calibration.
        const set16 = (a, v) => {
            this.firmware[a] = v;
            this.firmware[a + 1] = v >>> 8;
        };
        set16(0x3fe00, 5);
        set16(0x3fe58, 0x0200);
        set16(0x3fe5a, 0x0200);
        this.firmware[0x3fe5c] = 1;
        this.firmware[0x3fe5d] = 1;
        set16(0x3fe5e, 0x0e00);
        set16(0x3fe60, 0x0e00);
        this.firmware[0x3fe62] = 255;
        this.firmware[0x3fe63] = 191;
        this.firmware[0x3fe64] = 1;
        set16(0x3fe72, crc16(this.firmware, 0x3fe00, 0x3fe70));
        this.firmware.copyWithin(0x3ff00, 0x3fe00, 0x3ff00);
        set16(0x3ff70, 1);
        this.backup = new Uint8Array(65536).fill(255);
        this.buses = [];
        this.line = 0;
        this.frame = 0;
    }
    remapVRAM() {
        this.vramMappings = [];
        this.vramPages = [[], []];
        this.vramControl.forEach((control, bank) => {
            if (!(control & 128)) return;
            const mode = control & 7,
                offset = (control >>> 3) & 3;
            let base = 0,
                cpu = 0;
            if (mode === 0) base = 0x06800000 + LCD_OFFSETS[bank];
            else if (bank < 4 && mode === 1)
                base = 0x06000000 + offset * 0x20000;
            else if (bank < 2 && mode === 2)
                base = 0x06400000 + (offset & 1) * 0x20000;
            else if ((bank === 2 || bank === 3) && mode === 2) {
                base = 0x06000000 + (offset & 1) * 0x20000;
                cpu = 1;
            } else if (bank === 2 && mode === 4) base = 0x06200000;
            else if (bank === 3 && mode === 4) base = 0x06600000;
            else if (bank === 4 && (mode === 1 || mode === 2))
                base = mode === 1 ? 0x06000000 : 0x06400000;
            else if ((bank === 5 || bank === 6) && (mode === 1 || mode === 2)) {
                base =
                    (mode === 1 ? 0x06000000 : 0x06400000) +
                    (offset & 1) * 0x4000 +
                    (offset & 2) * 0x8000;
            } else if (bank === 7 && mode === 1) base = 0x06200000;
            else if (bank === 8 && mode === 1) base = 0x06208000;
            else if (bank === 8 && mode === 2) base = 0x06600000;
            if (base) {
                this.vramMappings.push({
                    base,
                    bank,
                    cpu,
                    size: BANK_SIZES[bank],
                });
                for (
                    let offset = 0;
                    offset < BANK_SIZES[bank];
                    offset += 0x4000
                ) {
                    const page = ((base & 0xffffff) + offset) >>> 14;
                    (this.vramPages[cpu][page] ??= []).push({
                        data: this.vram[bank],
                        offset,
                    });
                }
            }
        });
    }
    readVRAM(address, cpu = 0) {
        let value = 0;
        const page = this.vramPages[cpu][(address & 0xffffff) >>> 14];
        if (page)
            for (const mapping of page)
                value |= mapping.data[mapping.offset + (address & 0x3fff)];
        return value;
    }
    writeVRAM(address, value, cpu = 0) {
        const page = this.vramPages[cpu][(address & 0xffffff) >>> 14];
        if (page)
            for (const mapping of page)
                mapping.data[mapping.offset + (address & 0x3fff)] = value;
    }
    setButton(name, pressed) {
        const bit = KEYS.indexOf(String(name).toUpperCase());
        if (bit < 0) throw new RangeError(`Unsupported DS button ${name}`);
        if (pressed) this.keys &= ~(1 << bit);
        else this.keys |= 1 << bit;
    }
}

class NDSBus {
    constructor(machine, index) {
        this.machine = machine;
        this.index = index;
        this.io = new Uint8Array(0x2000);
        this.bios = new Uint8Array(0x8000);
        const view = new DataView(this.bios.buffer);
        view.setUint32(0x18, 0xea000038, true);
        [
            0xe92d500f,
            0xe59f0018,
            0xe59f1018,
            0xe1a0e00f,
            0xe591f000,
            0xe8bd500f,
            0xe25ef004,
            0xe1a00000,
            0xe1a00000,
            0x04000000,
            index === 0 ? 0x00803ffc : 0x0380fffc,
        ].forEach((word, i) => view.setUint32(0x100 + i * 4, word, true));
        this.irqVector = index === 0 ? 0xffff0018 : 0x18;
        this.waitMask = this.waitFlags = 0;
        this.cpControl = 0x00012078;
        this.dma = Array.from({ length: 4 }, () => ({
            source: 0,
            dest: 0,
            initialDest: 0,
            count: 0,
            control: 0,
        }));
        this.timers = Array.from({ length: 4 }, () => ({
            value: 0,
            reload: 0,
            phase: 0,
            control: 0,
        }));
        this.card = { address: 0, remaining: 0, command: 0 };
        this.spi = { command: 0, phase: 0, address: 0, response: 0 };
        this.auxSPI = { command: 0, phase: 0, address: 0, response: 0 };
        this.cycles = 0;
        this.setReg(0x304, 0x820f);
        this.setReg(0x204, 0x4000);
        this.io[0x300] = 1;
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
    setReg32(offset, value) {
        this.setReg(offset, value);
        this.setReg(offset + 2, value >>> 16);
    }
    interrupt(bit) {
        this.waitFlags |= 1 << bit;
        this.setReg32(0x214, this.reg32(0x214) | (1 << bit));
    }
    irqPending() {
        return (
            !!(this.reg(0x208) & 1) && !!(this.reg32(0x210) & this.reg32(0x214))
        );
    }
    onExceptionReturn(cpu) {
        if (this.waitMask) {
            if (this.waitFlags & this.waitMask) this.waitMask = 0;
            else cpu.halted = true;
        }
    }
    swi(number, cpu) {
        return biosService(number, cpu, this, true);
    }
    cp15(op, value) {
        const crn = (op >>> 16) & 15,
            crm = op & 15,
            sub = (op >>> 5) & 7;
        const read = !!(op & 0x100000),
            m = this.machine;
        if (crn === 0) return 0x41059461;
        if (crn === 1) {
            if (!read) {
                this.cpControl = value;
                m.dtcmEnabled = !!(value & 0x10000);
                m.itcmEnabled = !!(value & 0x40000);
                this.irqVector = value & 0x2000 ? 0xffff0018 : 0x18;
            }
            return this.cpControl;
        }
        if (crn === 9 && crm === 1 && sub === 0) {
            if (!read) {
                m.dtcmBase = value & 0xfffff000;
                new DataView(this.bios.buffer).setUint32(
                    0x128,
                    m.dtcmBase + 0x3ffc,
                    true,
                );
            }
            return m.dtcmBase | 10;
        }
        if (crn === 7 && crm === 0 && sub === 4) this.cpu.halted = true;
        return 0;
    }
    region(address) {
        const m = this.machine;
        if (
            this.index === 0 &&
            m.dtcmEnabled &&
            address >= m.dtcmBase &&
            address < m.dtcmBase + 0x4000
        ) {
            return [m.dtcm, address - m.dtcmBase];
        }
        if (this.index === 0 && m.itcmEnabled && address < 0x02000000)
            return [m.itcm, address & 32767];
        if (this.index === 1 && address < 0x8000) return [this.bios, address];
        if (this.index === 0 && address >= 0xffff0000)
            return [this.bios, address & 0x7fff];
        if (address >>> 24 === 2) return [m.ram, address & 0x3fffff];
        if (address >>> 24 === 3) {
            if (this.index === 1 && address >= 0x03800000)
                return [m.arm7WRAM, address & 65535];
            const mode = m.wramControl;
            if (this.index === 0) {
                if (mode === 3) return null;
                if (mode === 0) return [m.sharedWRAM, address & 32767];
                return [
                    m.sharedWRAM,
                    (address & 16383) + (mode === 1 ? 16384 : 0),
                ];
            }
            if (mode === 0) return [m.arm7WRAM, address & 65535];
            if (mode === 3) return [m.sharedWRAM, address & 32767];
            return [m.sharedWRAM, (address & 16383) + (mode === 2 ? 16384 : 0)];
        }
        if (address >>> 24 === 5) return [m.palette, address & 2047];
        if (address >>> 24 === 7) return [m.oam, address & 2047];
        return null;
    }
    fifoStatus() {
        const m = this.machine,
            incoming = m.fifos[this.index],
            outgoing = m.fifos[1 - this.index];
        return (
            (this.reg(0x184) & 0xcc0c) |
            (!outgoing.length ? 1 : 0) |
            (outgoing.length >= 16 ? 2 : 0) |
            (!incoming.length ? 256 : 0) |
            (incoming.length >= 16 ? 512 : 0)
        );
    }
    read8(address) {
        address >>>= 0;
        if (address >>> 24 === 4) {
            const offset = address & 0xffffff;
            if (offset >= 0x2000) return 0;
            if (offset === 0x130 || offset === 0x131)
                return (this.machine.keys >>> ((offset & 1) * 8)) & 255;
            if (offset === 0x136)
                return (
                    ((this.machine.keys >>> 10) & 3) |
                    0x34 |
                    (this.machine.touch.down ? 0 : 64)
                );
            if (offset === 0x180 || offset === 0x181) {
                const sync =
                    (this.reg(0x180) & 0x6f00) |
                    ((this.machine.buses[1 - this.index].reg(0x180) >>> 8) &
                        15);
                return (sync >>> ((offset & 1) * 8)) & 255;
            }
            if (offset === 0x184 || offset === 0x185)
                return (this.fifoStatus() >>> ((offset & 1) * 8)) & 255;
            if (offset === 0x1c2) return this.spi.response;
            if (offset === 0x1a2) return this.auxSPI.response;
            if (offset === 0x240 && this.index === 1)
                return (
                    ((this.machine.vramControl[2] & 0x87) === 0x82 ? 1 : 0) |
                    ((this.machine.vramControl[3] & 0x87) === 0x82 ? 2 : 0)
                );
            if (offset === 0x241 && this.index === 1)
                return this.machine.wramControl;
            if (offset >= 0x100 && offset < 0x110 && (offset & 3) < 2)
                return (
                    (this.timers[(offset - 0x100) >>> 2].value >>>
                        ((offset & 1) * 8)) &
                    255
                );
            return this.io[offset];
        }
        if (address >>> 24 === 6)
            return this.machine.readVRAM(address, this.index);
        const region = this.region(address);
        return region ? region[0][region[1]] : 0;
    }
    read16(address) {
        return this.read8(address & ~1) | (this.read8((address & ~1) + 1) << 8);
    }
    read32(address) {
        address = (address & ~3) >>> 0;
        if (address === 0x04100000) {
            const m = this.machine,
                fifo = m.fifos[this.index];
            if (!(this.reg(0x184) & 0x8000)) return m.fifoLast[this.index];
            if (!fifo.length) {
                this.io[0x185] |= 64;
                return m.fifoLast[this.index];
            }
            m.fifoLast[this.index] = fifo.shift();
            if (!fifo.length && m.buses[1 - this.index].reg(0x184) & 4)
                m.buses[1 - this.index].interrupt(17);
            return m.fifoLast[this.index];
        }
        if (address === 0x04100010) return this.cardRead();
        if (address >>> 24 !== 4 && address >>> 24 !== 6) {
            const region = this.region(address);
            if (region) {
                const [data, offset] = region;
                return (
                    (data[offset] |
                        (data[offset + 1] << 8) |
                        (data[offset + 2] << 16) |
                        (data[offset + 3] << 24)) >>>
                    0
                );
            }
        }
        return (this.read16(address) | (this.read16(address + 2) << 16)) >>> 0;
    }
    write8(address, value) {
        address >>>= 0;
        value &= 255;
        if (address >>> 24 === 4) {
            this.writeIO(address & 0xffffff, value);
            return;
        }
        if (address >>> 24 === 6) {
            this.machine.writeVRAM(address, value, this.index);
            return;
        }
        const region = this.region(address);
        if (region && region[0] !== this.bios) region[0][region[1]] = value;
    }
    write16(address, value) {
        address &= ~1;
        this.write8(address, value);
        this.write8(address + 1, value >>> 8);
    }
    write32(address, value) {
        address = (address & ~3) >>> 0;
        if (address === 0x04000188) {
            const m = this.machine,
                fifo = m.fifos[1 - this.index];
            if (!(this.reg(0x184) & 0x8000)) return;
            if (fifo.length >= 16) {
                this.io[0x185] |= 64;
                return;
            }
            fifo.push(value >>> 0);
            const other = m.buses[1 - this.index];
            if (fifo.length === 1 && other.reg(0x184) & 0x400)
                other.interrupt(18);
            return;
        }
        this.write16(address, value);
        this.write16(address + 2, value >>> 16);
    }
    spiTransfer(value, auxiliary = false) {
        const state = auxiliary ? this.auxSPI : this.spi,
            control = this.reg(auxiliary ? 0x1a0 : 0x1c0);
        const device = auxiliary ? 1 : (control >>> 8) & 3;
        const memory = auxiliary ? this.machine.backup : this.machine.firmware;
        const touchSample = (command) => {
            const channel = (command >>> 4) & 7,
                touch = this.machine.touch;
            if (channel === 1)
                return 0x200 + Math.round((touch.y / 190) * 0xc00);
            if (channel === 5)
                return 0x200 + Math.round((touch.x / 254) * 0xc00);
            if (channel === 3) return touch.down ? 0x700 : 0;
            if (channel === 4) return touch.down ? 0x900 : 0xfff;
            return 0;
        };
        if (!state.phase || (device === 2 && value & 128)) {
            // A new ADC command may overlap the previous conversion's low
            // byte. SDK drivers use this two-transfer pipeline repeatedly.
            const response =
                device === 2 && state.phase === 2
                    ? (touchSample(state.command) << 3) & 255
                    : 0;
            state.command = value;
            state.address = 0;
            state.phase = 1;
            state.response = response;
        } else if (device === 1) {
            if (state.command === 3 || state.command === 2) {
                const addressBytes = auxiliary ? 2 : 3;
                if (state.phase <= addressBytes) {
                    state.address = (state.address << 8) | value;
                    state.phase += 1;
                    state.response = 0;
                } else {
                    if (state.command === 2 && auxiliary)
                        memory[state.address % memory.length] = value;
                    state.response = memory[state.address++ % memory.length];
                }
            } else state.response = 0;
        } else if (device === 2) {
            const sample = touchSample(state.command);
            state.response =
                state.phase & 1 ? sample >>> 5 : (sample << 3) & 255;
            state.phase += 1;
        } else state.response = 0;
        if (!(control & (auxiliary ? 64 : 0x800))) state.phase = 0;
        if (!auxiliary && control & 0x4000) this.interrupt(23);
    }
    writeIO(offset, value) {
        if (offset >= 0x2000) return;
        if (offset >= 0x214 && offset < 0x218) {
            this.io[offset] &= ~value;
            return;
        }
        if (offset === 6 || offset === 7) return;
        if (offset === 4) value = (value & 0xf8) | (this.io[4] & 7);
        if (offset === 0x185) {
            if (value & 64) this.io[offset] &= ~64;
            value = (value & 0xbc) | (this.io[offset] & 64);
        }
        if (offset === 0x184) {
            if (value & 8) this.machine.fifos[1 - this.index] = [];
            value &= ~8;
        }
        this.io[offset] = value;
        if (offset === 0x181 && value & 32) {
            const other = this.machine.buses[1 - this.index];
            if (other.reg(0x180) & 0x4000) other.interrupt(16);
        }
        if (offset === 0x1c2) this.spiTransfer(value);
        if (offset === 0x1a2) this.spiTransfer(value, true);
        if (offset === 0x301 && this.index === 1 && value & 0xc0)
            this.cpu.halted = true;
        if (offset >= 0x240 && offset <= 0x249 && this.index === 0) {
            if (offset === 0x247) this.machine.wramControl = value & 3;
            else {
                const bank = offset - 0x240 - (offset > 0x247 ? 1 : 0);
                this.machine.vramControl[bank] = value;
                this.machine.remapVRAM();
            }
        }
        const engine = offset >= 0x1000 ? 1 : 0,
            local = offset & 0xfff;
        if (local >= 0x28 && local < 0x40 && (local & 15) >= 8)
            this.machine.ppu?.latch(engine, (local - 0x28) >>> 4);
        if (offset >= 0x100 && offset < 0x110) {
            const index = (offset - 0x100) >>> 2,
                timer = this.timers[index];
            if ((offset & 3) < 2) timer.reload = this.reg(0x100 + index * 4);
            if ((offset & 3) === 2) {
                if (!(timer.control & 128) && value & 128) {
                    timer.value = timer.reload;
                    timer.phase = 0;
                }
                timer.control = value;
            }
        }
        if (offset >= 0xb0 && offset < 0xe0 && (offset - 0xb0) % 12 === 11) {
            const index = Math.floor((offset - 0xb0) / 12),
                base = 0xb0 + index * 12,
                dma = this.dma[index];
            const control = this.reg32(base + 8),
                old = dma.control;
            dma.control = control;
            if (!(old & 0x80000000) && control & 0x80000000) {
                dma.source = this.reg32(base);
                dma.dest = this.reg32(base + 4);
                dma.initialDest = dma.dest;
                dma.count =
                    control & (this.index === 0 ? 0x1fffff : 65535) ||
                    (this.index === 0 ? 0x200000 : 65536);
                if (this.timing(control) === 0) this.transfer(index);
            }
        }
        if (offset === 0x1a7 && value & 128) this.cardStart();
        if (offset >= 0x280 && offset <= 0x2bf) this.calculateMath();
        if (
            this.index === 1 &&
            offset >= 0x400 &&
            offset < 0x500 &&
            (offset & 15) === 3
        )
            this.machine.audio?.trigger((offset - 0x400) >>> 4);
    }
    calculateMath() {
        const mode = this.reg(0x280) & 3;
        const signed64 = (offset) =>
            BigInt.asIntN(
                64,
                (BigInt(this.reg32(offset + 4)) << 32n) |
                    BigInt(this.reg32(offset)),
            );
        const a = mode === 0 ? BigInt(this.reg32(0x290) | 0) : signed64(0x290);
        const b = mode === 2 ? signed64(0x298) : BigInt(this.reg32(0x298) | 0);
        const quotient = b === 0n ? (a < 0n ? 1n : -1n) : a / b;
        const remainder = b === 0n ? a : a % b;
        const write64 = (offset, v) => {
            v = BigInt.asUintN(64, v);
            this.setReg32(offset, Number(v & 0xffffffffn));
            this.setReg32(offset + 4, Number(v >> 32n));
        };
        write64(0x2a0, quotient);
        write64(0x2a8, remainder);
        this.setReg(0x280, mode | (b === 0n ? 0x4000 : 0));
        let input = BigInt(this.reg32(0x2b8));
        if (this.reg(0x2b0) & 1) input |= BigInt(this.reg32(0x2bc)) << 32n;
        let lo = 0n,
            hi = 0x100000000n;
        while (lo + 1n < hi) {
            const mid = (lo + hi) >> 1n;
            if (mid * mid <= input) lo = mid;
            else hi = mid;
        }
        this.setReg32(0x2b4, Number(lo));
    }
    timing(control) {
        return this.index === 0 ? (control >>> 27) & 7 : (control >>> 28) & 3;
    }
    transfer(index) {
        const dma = this.dma[index],
            control = dma.control;
        if (!(control & 0x80000000)) return;
        const size = control & 0x04000000 ? 4 : 2;
        const sourceMode = (control >>> 23) & 3,
            destMode = (control >>> 21) & 3;
        const sourceStep =
            sourceMode === 0 ? size : sourceMode === 1 ? -size : 0;
        const destStep = destMode === 1 ? -size : destMode === 2 ? 0 : size;
        for (let i = 0; i < dma.count; i += 1) {
            if (size === 4) this.write32(dma.dest, this.read32(dma.source));
            else this.write16(dma.dest, this.read16(dma.source));
            dma.source = (dma.source + sourceStep) >>> 0;
            dma.dest = (dma.dest + destStep) >>> 0;
        }
        if (control & 0x40000000) this.interrupt(8 + index);
        if (control & 0x02000000 && this.timing(control)) {
            if (destMode === 3) dma.dest = dma.initialDest;
        } else {
            dma.control &= 0x7fffffff;
            this.io[0xbb + index * 12] &= 127;
        }
    }
    eventDMA(timing) {
        for (let i = 0; i < 4; i += 1)
            if (this.timing(this.dma[i].control) === timing) this.transfer(i);
    }
    cardStart() {
        const cmd = this.io[0x1a8],
            control = this.reg32(0x1a4),
            size = (control >>> 24) & 7;
        this.card.command = cmd;
        this.card.address =
            cmd === 0xb7
                ? ((this.io[0x1a9] << 24) |
                      (this.io[0x1aa] << 16) |
                      (this.io[0x1ab] << 8) |
                      this.io[0x1ac]) >>>
                  0
                : 0;
        this.card.remaining = size === 0 ? 0 : size === 7 ? 4 : 0x100 << size;
        this.setReg32(0x1a4, control | 0x00800000);
        if (!this.card.remaining) this.cardComplete();
        const timing = this.index === 0 ? 5 : 2;
        // Each ready word requests another cartridge DMA burst. A typical
        // SDK transfer uses repeat DMA with a one-word count for a full block.
        while (this.card.remaining > 0) {
            const previous = this.card.remaining;
            this.eventDMA(timing);
            if (this.card.remaining === previous) break;
        }
    }
    cardComplete() {
        this.setReg32(0x1a4, this.reg32(0x1a4) & ~0x80800000);
        if (this.reg(0x1a0) & 0x4000) this.interrupt(19);
    }
    cardRead() {
        if (!this.card.remaining) return 0;
        let result;
        if ([0x90, 0xb8].includes(this.card.command)) result = 0x00001fc2;
        else if (this.card.command === 0x9f) result = 0xffffffff;
        else {
            const rom = this.machine.rom,
                a = this.card.address % rom.length;
            result =
                (rom[a] |
                    (rom[(a + 1) % rom.length] << 8) |
                    (rom[(a + 2) % rom.length] << 16) |
                    (rom[(a + 3) % rom.length] << 24)) >>>
                0;
            this.card.address += 4;
        }
        this.card.remaining -= 4;
        if (this.card.remaining <= 0) this.cardComplete();
        return result;
    }
    clock(cycles) {
        this.cycles += cycles;
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
            if (cascade && timer.control & 64) this.interrupt(3 + i);
        }
    }
}

export { NDSMemory, NDSBus, KEYS as NDS_BUTTONS };
