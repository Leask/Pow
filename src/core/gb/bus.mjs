import { GBPPU } from './ppu.mjs';
import { GBAPU } from './apu.mjs';

const BUTTONS = ['RIGHT', 'LEFT', 'UP', 'DOWN', 'A', 'B', 'SELECT', 'START'];

class GBBus {
    constructor(cartridge, options = {}) {
        this.cartridge = cartridge;
        this.color = !!options.color;
        this.vram = new Uint8Array(16384);
        this.wram = new Uint8Array(32768);
        this.oam = new Uint8Array(160);
        this.hram = new Uint8Array(127);
        this.io = new Uint8Array(128);
        this.bgPalette = new Uint8Array(64).fill(255);
        this.objPalette = new Uint8Array(64).fill(255);
        this.io[0] = 0xcf;
        this.io[15] = 1;
        this.io[0x40] = 0x91;
        this.io[0x47] = 0xfc;
        this.io[0x48] = this.io[0x49] = 0xff;
        this.io[0x55] = 0xff;
        this.ie = 0;
        this.div = 0xabcc;
        this.doubleSpeed = false;
        this.buttons = 0;
        this.timerReload = 0;
        this.cycles = 0;
        this.dmaCycles = 0;
        this.dmaIndex = 160;
        this.serialCycles = 0;
        this.hdmaBlocks = 0;
        this.ppu = new GBPPU(this);
        this.apu = new GBAPU(options);
    }

    interrupt(bit) {
        this.io[15] |= 1 << bit;
    }
    joypad() {
        let value = 15;
        if (!(this.io[0] & 16)) value &= ~(this.buttons & 15);
        if (!(this.io[0] & 32)) value &= ~((this.buttons >>> 4) & 15);
        return 0xc0 | (this.io[0] & 48) | value;
    }
    setButton(name, pressed) {
        const bit = BUTTONS.indexOf(String(name).toUpperCase());
        if (bit < 0) throw new RangeError(`Unsupported GB button ${name}`);
        const old = this.joypad();
        if (pressed) this.buttons |= 1 << bit;
        else this.buttons &= ~(1 << bit);
        if ((old & ~this.joypad() & 15) !== 0) this.interrupt(4);
    }

    read(address) {
        address &= 0xffff;
        if (address < 0x8000 || (address >= 0xa000 && address < 0xc000))
            return this.cartridge.read(address);
        if (address < 0xa000)
            return this.vram[
                (address & 8191) + (this.color ? (this.io[0x4f] & 1) * 8192 : 0)
            ];
        if (address < 0xfe00) {
            const base = address & 8191;
            const bank = this.color ? this.io[0x70] & 7 || 1 : 1;
            return this.wram[base < 4096 ? base : bank * 4096 + (base & 4095)];
        }
        if (address < 0xfea0) return this.oam[address - 0xfe00];
        if (address < 0xff00) return 255;
        if (address === 0xffff) return this.ie;
        if (address >= 0xff80) return this.hram[address - 0xff80];
        const index = address & 127;
        if (index === 0) return this.joypad();
        if (index === 4) return this.div >>> 8;
        if (index === 7) return this.io[index] | 0xf8;
        if (index === 15) return this.io[index] | 0xe0;
        if (index >= 0x10 && index <= 0x3f) return this.apu.read(address);
        if (index === 0x41) return this.ppu.stat();
        if (index === 0x44) return this.ppu.line;
        if (!this.color && index >= 0x4d) return 255;
        if (index === 0x4d) return this.io[index] | 0x7e;
        if (index === 0x4f) return this.io[index] | 0xfe;
        if (index === 0x69) return this.bgPalette[this.io[0x68] & 63];
        if (index === 0x6b) return this.objPalette[this.io[0x6a] & 63];
        if (index === 0x76)
            return this.apu.digital(0) | (this.apu.digital(1) << 4);
        if (index === 0x77)
            return this.apu.digital(2) | (this.apu.digital(3) << 4);
        return this.io[index];
    }

    timerSignal() {
        return (
            !!(this.io[7] & 4) &&
            !!(this.div & (1 << [9, 3, 5, 7][this.io[7] & 3]))
        );
    }
    timerIncrement() {
        if (this.timerReload) return;
        this.io[5] += 1;
        if (this.io[5] === 0) this.timerReload = 4;
    }
    write(address, value) {
        address &= 0xffff;
        value &= 255;
        if (address < 0x8000 || (address >= 0xa000 && address < 0xc000)) {
            this.cartridge.write(address, value);
            return;
        }
        if (address < 0xa000) {
            this.vram[
                (address & 8191) + (this.color ? (this.io[0x4f] & 1) * 8192 : 0)
            ] = value;
            return;
        }
        if (address < 0xfe00) {
            const base = address & 8191;
            const bank = this.color ? this.io[0x70] & 7 || 1 : 1;
            this.wram[base < 4096 ? base : bank * 4096 + (base & 4095)] = value;
            return;
        }
        if (address < 0xfea0) {
            this.oam[address - 0xfe00] = value;
            return;
        }
        if (address < 0xff00) return;
        if (address === 0xffff) {
            this.ie = value;
            return;
        }
        if (address >= 0xff80) {
            this.hram[address - 0xff80] = value;
            return;
        }
        const index = address & 127;
        if (index >= 0x10 && index <= 0x3f) {
            this.apu.write(address, value);
            return;
        }
        if (index === 0) {
            const old = this.joypad();
            this.io[0] = value & 48;
            if (old & ~this.joypad() & 15) this.interrupt(4);
            return;
        }
        if (index === 4 || index === 7) {
            const signal = this.timerSignal();
            if (index === 4) {
                const apuBit = this.doubleSpeed ? 0x4000 : 0x2000;
                if (this.div & apuBit) this.apu.frameClock();
                this.div = 0;
            } else this.io[7] = value & 7;
            if (signal && !this.timerSignal()) this.timerIncrement();
            return;
        }
        if (index === 5) this.timerReload = 0;
        if (index === 0x44) return;
        if (index === 0x41) {
            this.io[index] = value & 0x78;
            this.ppu.stat();
            return;
        }
        if (index === 0x46) {
            this.dmaIndex = 0;
            this.dmaCycles = 0;
        }
        if (!this.color && index >= 0x4d) return;
        if (index === 0x69 || index === 0x6b) {
            const select = index - 1;
            const palette = index === 0x69 ? this.bgPalette : this.objPalette;
            palette[this.io[select] & 63] = value;
            if (this.io[select] & 128)
                this.io[select] = 128 | ((this.io[select] + 1) & 63);
            return;
        }
        if (index === 0x55) {
            if (this.hdmaBlocks && !(value & 128)) {
                this.io[0x55] = 128 | (this.hdmaBlocks - 1);
                this.hdmaBlocks = 0;
                return;
            }
            this.hdmaSource = (this.io[0x51] << 8) | (this.io[0x52] & 0xf0);
            this.hdmaDest =
                ((this.io[0x53] & 31) << 8) | (this.io[0x54] & 0xf0);
            this.hdmaBlocks = (value & 127) + 1;
            this.io[0x55] = value & 127;
            if (!(value & 128)) while (this.hdmaBlocks) this.hblankDMA();
            return;
        }
        this.io[index] = value;
        if (index === 0x45 || index === 0x40) this.ppu.stat();
    }

    hblankDMA() {
        if (!this.hdmaBlocks) return;
        for (let i = 0; i < 16; i += 1) {
            this.vram[(this.hdmaDest & 8191) + (this.io[0x4f] & 1) * 8192] =
                this.read(this.hdmaSource++);
            this.hdmaDest += 1;
        }
        this.hdmaBlocks -= 1;
        this.io[0x55] = this.hdmaBlocks ? this.hdmaBlocks - 1 : 255;
    }

    clock(cycles) {
        this.cycles += cycles;
        const apuBit = this.doubleSpeed ? 0x4000 : 0x2000;
        for (let i = 0; i < cycles; i += 1) {
            if (this.timerReload && --this.timerReload === 0) {
                this.io[5] = this.io[6];
                this.interrupt(2);
            }
            const signal = this.timerSignal(),
                old = this.div;
            this.div = (this.div + 1) & 65535;
            if (signal && !this.timerSignal()) this.timerIncrement();
            if (old & apuBit && !(this.div & apuBit)) this.apu.frameClock();
        }
        if (this.dmaIndex < 160) {
            this.dmaCycles += cycles;
            while (this.dmaCycles >= 4 && this.dmaIndex < 160) {
                this.dmaCycles -= 4;
                this.oam[this.dmaIndex] = this.read(
                    (this.io[0x46] << 8) + this.dmaIndex,
                );
                this.dmaIndex += 1;
            }
        }
        if ((this.io[2] & 0x81) === 0x81) {
            this.serialCycles += cycles;
            if (
                this.serialCycles >= (this.color && this.io[2] & 2 ? 128 : 4096)
            ) {
                this.io[1] = 255;
                this.io[2] &= 127;
                this.serialCycles = 0;
                this.interrupt(3);
            }
        }
        const realCycles = this.doubleSpeed ? cycles / 2 : cycles;
        this.ppu.clock(realCycles);
        this.apu.clock(realCycles);
        this.cartridge.clock(realCycles);
    }
}

export { GBBus, BUTTONS };
