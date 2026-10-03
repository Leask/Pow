import { N64Controller } from './controller.mjs';
import { AudioInterface, CPU_CLOCK } from './audio-interface.mjs';

class N64Bus {
    constructor(rom, options = {}) {
        this.rom = rom;
        this.romView = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
        this.ram = new Uint8Array(8 * 1024 * 1024);
        this.ramView = new DataView(this.ram.buffer);
        this.spMem = new Uint8Array(8192);
        this.spView = new DataView(this.spMem.buffer);
        this.pif = new Uint8Array(64);
        this.pifView = new DataView(this.pif.buffer);
        this.eeprom = new Uint8Array(512);
        this.eeprom.fill(255);
        this.controllers = Array.from(
            { length: 4 },
            (_, index) => new N64Controller(index === 0),
        );
        this.registers = new Map();
        this.sp = new Uint32Array(8);
        this.sp[4] = 1;
        this.dp = new Uint32Array(8);
        this.dp[3] = 0x80;
        this.vi = new Uint32Array(14);
        this.pi = new Uint32Array(13);
        this.si = new Uint32Array(7);
        this.miMode = 0x80;
        this.miInterrupt = 0;
        this.miMask = 0;
        this.interruptPending = false;
        this.cycles = 0;
        this.frame = 0;
        this.frameCycles = CPU_CLOCK / (options.region === 'PAL' ? 50 : 60);
        this.nextVI = this.frameCycles;
        this.events = [];
        this.audio = new AudioInterface(this, options);
        this.audioCycles = 0;
        this.nextAudio = Math.ceil(CPU_CLOCK / this.audio.sampleRate);
        this.onTask = options.onTask ?? null;
        this.taskCounts = { graphics: 0, audio: 0, other: 0 };
        this.lastTask = null;
    }

    raiseInterrupt(mask) {
        this.miInterrupt |= mask;
        this.interruptPending = (this.miInterrupt & this.miMask) !== 0;
    }

    clearInterrupt(mask) {
        this.miInterrupt &= ~mask;
        this.interruptPending = (this.miInterrupt & this.miMask) !== 0;
    }

    read8(address) {
        const a = address >>> 0;
        if (a < this.ram.length) return this.ram[a];
        if (a >= 0x10000000 && a < 0x10000000 + this.rom.length) {
            return this.rom[a - 0x10000000];
        }
        if (a >= 0x04000000 && a < 0x04002000) return this.spMem[a & 8191];
        if (a >= 0x1fc007c0 && a < 0x1fc00800) return this.pif[a & 63];
        return (this.read32(a & ~3) >>> ((3 - (a & 3)) * 8)) & 255;
    }

    read16(address) {
        const a = address >>> 0;
        if (a < this.ram.length - 1) return this.ramView.getUint16(a);
        return (this.read8(a) << 8) | this.read8(a + 1);
    }

    read32(address) {
        const a = address >>> 0;
        if (a < this.ram.length - 3) return this.ramView.getUint32(a);
        if (a >= 0x10000000 && a < 0x10000000 + this.rom.length - 3) {
            return this.romView.getUint32(a - 0x10000000);
        }
        if (a >= 0x04000000 && a < 0x04002000)
            return this.spView.getUint32(a & 8191);
        if (a >= 0x1fc007c0 && a < 0x1fc00800)
            return this.pifView.getUint32(a & 63);
        if (a >= 0x04040000 && a < 0x04040020) {
            const i = (a & 31) >>> 2;
            const result = this.sp[i];
            if (i === 7) this.sp[7] = 1;
            return result;
        }
        if (a >= 0x04100000 && a < 0x04100020) return this.dp[(a & 31) >>> 2];
        if (a >= 0x04400000 && a < 0x04400038) {
            if (a === 0x04400010) {
                return (
                    Math.floor(
                        ((this.cycles % this.frameCycles) / this.frameCycles) *
                            525,
                    ) & ~1
                );
            }
            return this.vi[(a & 63) >>> 2];
        }
        if (a >= 0x04600000 && a < 0x04600034) return this.pi[(a & 63) >>> 2];
        if (a >= 0x04800000 && a <= 0x04800018) return this.si[(a & 31) >>> 2];
        switch (a) {
            case 0x04300000:
                return this.miMode;
            case 0x04300004:
                return 0x02020102;
            case 0x04300008:
                return this.miInterrupt;
            case 0x0430000c:
                return this.miMask;
            case 0x04500004:
                return this.audio.remaining;
            case 0x0450000c:
                return this.audio.status >>> 0;
            default:
                return this.registers.get(a) ?? 0;
        }
    }

    write8(address, value) {
        const a = address >>> 0;
        if (a < this.ram.length) {
            this.ram[a] = value;
            return;
        }
        if (a >= 0x04000000 && a < 0x04002000) {
            this.spMem[a & 8191] = value;
            return;
        }
        if (a >= 0x1fc007c0 && a < 0x1fc00800) {
            this.pif[a & 63] = value;
            if ((a & 63) === 63) this.pifControl();
            return;
        }
        const shift = (3 - (a & 3)) * 8;
        this.write32(
            a & ~3,
            (this.read32(a & ~3) & ~(255 << shift)) | ((value & 255) << shift),
        );
    }

    write16(address, value) {
        if (address >>> 0 < this.ram.length - 1) {
            this.ramView.setUint16(address, value);
            return;
        }
        this.write8(address, value >>> 8);
        this.write8(address + 1, value);
    }

    write32(address, value) {
        const a = address >>> 0;
        const v = value >>> 0;
        if (a < this.ram.length - 3) {
            this.ramView.setUint32(a, v);
            return;
        }
        if (a >= 0x04000000 && a < 0x04002000) {
            this.spView.setUint32(a & 8191, v);
            return;
        }
        if (a >= 0x1fc007c0 && a < 0x1fc00800) {
            this.pifView.setUint32(a & 63, v);
            if (a === 0x1fc007fc) this.pifControl();
            return;
        }
        if (a >= 0x04040000 && a < 0x04040020) {
            const i = (a & 31) >>> 2;
            if (i === 4) this.spStatus(v);
            else if (i === 7) this.sp[7] = 0;
            else {
                this.sp[i] = v;
                if (i === 2 || i === 3) this.spDMA(v, i === 3);
            }
            return;
        }
        if (a >= 0x04100000 && a < 0x04100020) {
            const i = (a & 31) >>> 2;
            if (i === 3) {
                for (let bit = 0; bit < 3; bit += 1) {
                    if (v & (1 << (bit * 2))) this.dp[3] &= ~(1 << bit);
                    if (v & (2 << (bit * 2))) this.dp[3] |= 1 << bit;
                }
            } else {
                this.dp[i] = v;
                if (i === 0) this.dp[2] = v;
                if (i === 1 && v !== this.dp[2]) {
                    throw new Error(
                        'Direct RDP command DMA is not implemented yet.',
                    );
                }
            }
            return;
        }
        if (a >= 0x04400000 && a < 0x04400038) {
            if (a === 0x04400010) this.clearInterrupt(8);
            else this.vi[(a & 63) >>> 2] = v;
            return;
        }
        if (a >= 0x04600000 && a < 0x04600034) {
            const i = (a & 63) >>> 2;
            if (i === 4) {
                if (v & 2) this.clearInterrupt(16);
                if (v & 1) this.pi[4] = 0;
            } else {
                this.pi[i] = v;
                if (i === 2 || i === 3)
                    this.piDMA((v & 0x00ffffff) + 1, i === 3);
            }
            return;
        }
        if (a >= 0x04800000 && a <= 0x04800018) {
            const i = (a & 31) >>> 2;
            if (i === 6) {
                this.si[6] = 0;
                this.clearInterrupt(2);
            } else {
                this.si[i] = v;
                if (i === 1 || i === 4) this.siDMA(i === 1);
            }
            return;
        }
        switch (a) {
            case 0x04300000:
                this.miMode = (this.miMode & ~127) | (v & 127);
                if (v & 0x800) this.clearInterrupt(32);
                break;
            case 0x0430000c:
                for (let i = 0; i < 6; i += 1) {
                    if (v & (1 << (i * 2))) this.miMask &= ~(1 << i);
                    if (v & (2 << (i * 2))) this.miMask |= 1 << i;
                }
                this.interruptPending = (this.miInterrupt & this.miMask) !== 0;
                break;
            case 0x04500004:
                this.audio.enqueue(this.registers.get(0x04500000) ?? 0, v);
                break;
            case 0x04500008:
                this.audio.enabled = (v & 1) !== 0;
                break;
            case 0x0450000c:
                this.clearInterrupt(4);
                break;
            case 0x04500010:
                this.audio.dacRate = v & 0x3fff;
                break;
            default:
                this.registers.set(a, v);
        }
    }

    spDMA(value, toRAM) {
        const length = ((value & 4095) | 7) + 1;
        const count = ((value >>> 12) & 255) + 1;
        const skip = value >>> 20;
        let mem = this.sp[0] & 0x1ff8;
        let ram = this.sp[1] & 0x00fffff8;
        const bank = mem & 4096;
        for (let row = 0; row < count; row += 1) {
            for (let i = 0; i < length; i += 1) {
                const m = bank | ((mem + i) & 4095);
                if (toRAM) this.write8(ram + i, this.spMem[m]);
                else this.spMem[m] = this.read8(ram + i);
            }
            mem = bank | ((mem + length) & 4095);
            ram += length + (row + 1 < count ? skip : 0);
        }
        this.sp[0] = mem;
        this.sp[1] = ram;
        this.sp[2] = this.sp[3] = 0xff8;
    }

    spStatus(value) {
        if (value & 1) this.sp[4] &= ~1;
        if (value & 2) this.sp[4] |= 1;
        if (value & 4) this.sp[4] &= ~2;
        if (value & 8) this.clearInterrupt(1);
        if (value & 16) this.raiseInterrupt(1);
        for (let bit = 5; bit <= 14; bit += 1) {
            const shift = bit === 5 ? 5 : bit === 6 ? 7 : 9 + (bit - 7) * 2;
            if (value & (1 << shift)) this.sp[4] &= ~(1 << bit);
            if (value & (2 << shift)) this.sp[4] |= 1 << bit;
        }
        if (!(this.sp[4] & 1)) this.runTask();
    }

    runTask() {
        const task = {};
        const fields = [
            'type',
            'flags',
            'boot',
            'bootSize',
            'ucode',
            'ucodeSize',
            'ucodeData',
            'ucodeDataSize',
            'stack',
            'stackSize',
            'output',
            'outputSize',
            'data',
            'dataSize',
            'yield',
            'yieldSize',
        ];
        fields.forEach((name, index) => {
            task[name] = this.spView.getUint32(0xfc0 + index * 4);
        });
        this.lastTask = task;
        const kind =
            task.type === 1 ? 'graphics' : task.type === 2 ? 'audio' : 'other';
        this.taskCounts[kind] += 1;
        if (!this.onTask) {
            throw new Error(
                `RSP task ${task.type} at 0x${task.data.toString(16)} requires a handler.`,
            );
        }
        this.onTask(task);
        this.sp[4] |= 0x203;
        if (this.sp[4] & 0x40) this.raiseInterrupt(1);
    }

    piDMA(length, toRAM) {
        const ram = this.pi[0] & 0x00fffffe;
        const cart = this.pi[1] & 0xfffffffe;
        for (let i = 0; i < length; i += 1) {
            if (toRAM) this.write8(ram + i, this.read8(cart + i));
            else this.write8(cart + i, this.read8(ram + i));
        }
        this.pi[0] = ram + length;
        this.pi[1] = cart + length;
        this.pi[4] = 1;
        this.events.push({ time: this.cycles + 512, type: 'pi' });
    }

    pifControl() {
        const control = this.pif[63];
        if (control & 0x30) this.pif[63] = 0x80;
        else if (control & 8) this.pif[63] = 0;
    }

    siDMA(toRAM) {
        const address = this.si[0] & 0x00fffff8;
        if (toRAM) {
            this.processJoybus();
            for (let i = 0; i < 64; i += 1)
                this.write8(address + i, this.pif[i]);
        } else {
            for (let i = 0; i < 64; i += 1)
                this.pif[i] = this.read8(address + i);
        }
        this.si[6] = 1;
        this.events.push({ time: this.cycles + 512, type: 'si' });
    }

    processJoybus() {
        let offset = 0;
        let channel = 0;
        while (offset < 63) {
            const tx = this.pif[offset];
            if (tx === 0xfe) break;
            if (tx === 0xff || tx === 0xfd) {
                offset += 1;
                continue;
            }
            if (tx === 0) {
                offset += 1;
                channel += 1;
                continue;
            }
            const rx = this.pif[offset + 1] & 63;
            const size = tx & 63;
            if (offset + 2 + size + rx > 63) break;
            const command = this.pif[offset + 2];
            const response = offset + 2 + size;
            const controller = this.controllers[channel];
            this.pif[offset + 1] = rx;
            if (channel < 4 && controller?.connected) {
                if (command === 0 || command === 255) {
                    this.pif.set([5, 0, 2], response);
                } else if (command === 1) {
                    this.pif.set(
                        [
                            controller.buttons >>> 8,
                            controller.buttons & 255,
                            controller.stickX & 255,
                            controller.stickY & 255,
                        ],
                        response,
                    );
                } else this.pif[offset + 1] |= 0x80;
            } else if (channel === 4) {
                if (command === 0 || command === 255)
                    this.pif.set([0, 0x80, 0], response);
                else if (command === 4) {
                    const start = (this.pif[offset + 3] & 63) * 8;
                    this.pif.set(
                        this.eeprom.subarray(start, start + 8),
                        response,
                    );
                } else if (command === 5) {
                    const start = (this.pif[offset + 3] & 63) * 8;
                    this.eeprom.set(
                        this.pif.subarray(offset + 4, offset + 12),
                        start,
                    );
                    this.pif[response] = 0;
                } else this.pif[offset + 1] |= 0x80;
            } else this.pif[offset + 1] |= 0x80;
            offset += 2 + size + rx;
            channel += 1;
        }
        this.pif[63] = 0;
    }

    clock(cycles) {
        this.cycles += cycles;
        for (let i = this.events.length - 1; i >= 0; i -= 1) {
            const event = this.events[i];
            if (event.time > this.cycles) continue;
            this.events.splice(i, 1);
            if (event.type === 'pi') {
                this.pi[4] = 0;
                this.raiseInterrupt(16);
            }
            if (event.type === 'si') {
                this.si[6] = 0x1000;
                this.raiseInterrupt(2);
            }
        }
        if (this.cycles >= this.nextVI) {
            this.nextVI += this.frameCycles;
            this.frame += 1;
            this.raiseInterrupt(8);
        }
        // Accumulate instruction time until a host sample can be emitted.
        // The deadline preserves the same sample/interrupt boundaries.
        if (this.cycles >= this.nextAudio) {
            this.audio.clock(this.cycles - this.audioCycles);
            this.audioCycles = this.cycles;
            this.nextAudio =
                this.cycles +
                Math.ceil(
                    (CPU_CLOCK - this.audio.samplePhase) /
                        this.audio.sampleRate,
                );
        }
    }
}

export { N64Bus };
