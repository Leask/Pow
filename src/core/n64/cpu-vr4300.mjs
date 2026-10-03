const TRAP = Symbol('MIPS exception');
const SIGN64 = 0x8000000000000000n;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function roundEven(value) {
    const floor = Math.floor(value);
    const fraction = value - floor;
    return fraction === 0.5
        ? floor + (floor % 2 !== 0 ? 1 : 0)
        : Math.round(value);
}

class VR4300 {
    constructor(bus) {
        this.bus = bus;
        this.lo = new Uint32Array(32);
        this.hi = new Int32Array(32);
        this.cp0 = new Uint32Array(32);
        this.fpr = new Uint32Array(64);
        this.fprSingle = new Float32Array(this.fpr.buffer);
        this.fprDouble = new Float64Array(this.fpr.buffer);
        this.fpScratch = new DataView(new ArrayBuffer(8));
        this.fcr31 = 0;
        this.hilo = [0n, 0n];
        this.tlb = Array.from({ length: 32 }, () => ({
            mask: 0,
            hi: 0,
            lo0: 0,
            lo1: 0,
        }));
        this.pc = 0;
        this.nextPC = 4;
        this.delaySlot = false;
        this.totalCycles = 0;
        this.instructions = 0;
        this.exceptionCount = 0;
        this.llAddress = -1;
        this.idleLoopPC = -1;
        this.idleLoopInstruction = 0;
        this.cp0[1] = 31;
        this.cp0[12] = 0x34000000;
        this.cp0[15] = 0x00000b22;
        this.cp0[16] = 0x7006e463;
    }

    setPC(value) {
        this.pc = value >>> 0;
        this.nextPC = (value + 4) >>> 0;
        this.delaySlot = false;
    }

    set32(index, value) {
        this.lo[index] = value;
        this.hi[index] = (value | 0) >> 31;
    }

    get64(index, unsigned = false) {
        const value = (BigInt(this.hi[index]) << 32n) | BigInt(this.lo[index]);
        return unsigned ? BigInt.asUintN(64, value) : value;
    }

    set64(index, value) {
        this.lo[index] = Number(BigInt.asUintN(32, value));
        this.hi[index] = Number(BigInt.asIntN(32, value >> 32n));
    }

    translate(address, write = false) {
        const a = address >>> 0;
        if (a >= 0x80000000 && a < 0xc0000000) {
            return a & 0x1fffffff;
        }
        for (const entry of this.tlb) {
            const mask = entry.mask | 0x1fff;
            if ((a & ~mask) >>> 0 !== (entry.hi & ~mask) >>> 0) {
                continue;
            }
            if (
                !(entry.lo0 & entry.lo1 & 1) &&
                (entry.hi & 255) !== (this.cp0[10] & 255)
            ) {
                continue;
            }
            const pageSize = (mask + 1) >>> 1;
            const low = a & pageSize ? entry.lo1 : entry.lo0;
            if (!(low & 2) || (write && !(low & 4))) {
                this.memoryException(
                    a,
                    write && low & 2 ? 1 : write ? 3 : 2,
                    false,
                );
            }
            return (
                (((low >>> 6) << 12) & ~(pageSize - 1)) | (a & (pageSize - 1))
            );
        }
        this.memoryException(a, write ? 3 : 2, true);
    }

    memoryException(address, code, refill = false) {
        this.cp0[8] = address;
        this.cp0[4] =
            (this.cp0[4] & 0xff80000f) | ((address >>> 9) & 0x007ffff0);
        this.cp0[10] = (address & 0xffffe000) | (this.cp0[10] & 255);
        this.exception(code, 0, refill);
        throw TRAP;
    }

    address(address, alignment, write = false) {
        if (address & (alignment - 1)) {
            this.cp0[8] = address;
            this.exception(write ? 5 : 4);
            throw TRAP;
        }
        return this.translate(address, write);
    }

    exception(code, coprocessor = 0, refill = false) {
        const status = this.cp0[12];
        let cause =
            (this.cp0[13] & 0x0000ff00) | (code << 2) | (coprocessor << 28);
        if (!(status & 2)) {
            this.cp0[14] = this.inDelaySlot
                ? (this.instructionPC - 4) >>> 0
                : this.instructionPC;
            if (this.inDelaySlot) cause |= 0x80000000;
        } else {
            cause |= this.cp0[13] & 0x80000000;
        }
        this.cp0[13] = cause;
        this.cp0[12] = status | 2;
        const vector = refill && !(status & 2) ? 0 : 0x180;
        this.setPC(
            status & 0x400000 ? 0xbfc00200 + vector : 0x80000000 + vector,
        );
        this.exceptionCount += 1;
    }

    branch(condition, immediate, likely = false) {
        if (condition) {
            this.nextPC = (this.pc + (immediate << 2)) >>> 0;
            if (
                immediate === -1 &&
                this.instructionPC >= 0x80000000 &&
                this.instructionPC < 0xc0000000 &&
                this.bus.read32(this.pc & 0x1fffffff) === 0
            ) {
                this.idleLoopPC = this.instructionPC;
                this.idleLoopInstruction = this.bus.read32(
                    this.instructionPC & 0x1fffffff,
                );
            }
        } else if (likely) {
            this.pc = this.nextPC;
            this.nextPC = (this.nextPC + 4) >>> 0;
            return;
        }
        this.delaySlot = true;
    }

    advance(cycles) {
        const ticks = cycles / 2;
        const old = this.cp0[9];
        const distance = (this.cp0[11] - old) >>> 0;
        this.cp0[9] = old + ticks;
        if (distance > 0 && distance <= ticks) this.cp0[13] |= 0x8000;
        this.totalCycles += cycles;
        if (ticks === 1) {
            this.cp0[1] = this.cp0[1] <= this.cp0[6] ? 31 : this.cp0[1] - 1;
        } else {
            const span = 32 - this.cp0[6];
            this.cp0[1] =
                this.cp0[6] +
                ((((this.cp0[1] - this.cp0[6] - ticks) % span) + span) % span);
        }
    }

    idleBranchTaken() {
        const word = this.idleLoopInstruction;
        const op = word >>> 26;
        const rs = (word >>> 21) & 31;
        const rt = (word >>> 16) & 31;
        if (op === 4 || op === 20) {
            return this.lo[rs] === this.lo[rt] && this.hi[rs] === this.hi[rt];
        }
        if (op === 5 || op === 21) {
            return this.lo[rs] !== this.lo[rt] || this.hi[rs] !== this.hi[rt];
        }
        if (op === 6 || op === 22) {
            return this.hi[rs] < 0 || (this.hi[rs] === 0 && this.lo[rs] === 0);
        }
        if (op === 7 || op === 23) {
            return this.hi[rs] >= 0 && (this.hi[rs] !== 0 || this.lo[rs] !== 0);
        }
        if (op === 1 && rt < 4)
            return rt & 1 ? this.hi[rs] >= 0 : this.hi[rs] < 0;
        return false;
    }

    step() {
        this.instructionPC = this.pc;
        this.inDelaySlot = this.delaySlot;
        this.cp0[13] =
            (this.cp0[13] & ~0x400) | (this.bus.interruptPending ? 0x400 : 0);
        if (
            !this.delaySlot &&
            (this.cp0[12] & 7) === 1 &&
            this.cp0[12] & this.cp0[13] & 0xff00
        ) {
            this.exception(0);
            this.advance(2);
            return 2;
        }
        try {
            const physical = this.address(this.pc, 4);
            const instruction =
                physical < this.bus.ram.length - 3
                    ? this.bus.ramView.getUint32(physical)
                    : this.bus.read32(physical);
            this.pc = this.nextPC;
            this.nextPC = (this.nextPC + 4) >>> 0;
            this.delaySlot = false;
            if (instruction !== 0) this.execute(instruction);
        } catch (error) {
            if (error !== TRAP) throw error;
        }
        this.lo[0] = 0;
        this.hi[0] = 0;
        this.instructions += 1;
        this.advance(2);
        return 2;
    }

    execute(word) {
        const op = word >>> 26;
        const rs = (word >>> 21) & 31;
        const rt = (word >>> 16) & 31;
        const rd = (word >>> 11) & 31;
        const shift = (word >>> 6) & 31;
        const immediate = (word << 16) >> 16;
        const a = this.lo[rs];
        const b = this.lo[rt];
        const address = (a + immediate) >>> 0;
        let value;
        let physical;
        switch (op) {
            case 0:
                this.special(word & 63, rs, rt, rd, shift);
                break;
            case 1: {
                const kind = rt & 15;
                const negative = this.hi[rs] < 0;
                if ([0, 1, 2, 3].includes(kind)) {
                    if (rt & 16) this.set32(31, this.nextPC);
                    this.branch(
                        kind & 1 ? !negative : negative,
                        immediate,
                        (kind & 2) !== 0,
                    );
                } else {
                    const signed = this.get64(rs);
                    const operand = BigInt(immediate);
                    const unsigned = BigInt.asUintN(64, operand);
                    const condition =
                        kind === 8
                            ? signed >= operand
                            : kind === 9
                              ? this.get64(rs, true) >= unsigned
                              : kind === 10
                                ? signed < operand
                                : kind === 11
                                  ? this.get64(rs, true) < unsigned
                                  : kind === 12
                                    ? signed === operand
                                    : kind === 14
                                      ? signed !== operand
                                      : false;
                    if (condition) this.exception(13);
                    if (![8, 9, 10, 11, 12, 14].includes(kind)) {
                        this.unsupported(word);
                    }
                }
                break;
            }
            case 2:
            case 3:
                if (op === 3) this.set32(31, this.nextPC);
                this.nextPC =
                    ((this.pc & 0xf0000000) | ((word & 0x03ffffff) << 2)) >>> 0;
                this.delaySlot = true;
                break;
            case 4:
            case 20:
                this.branch(
                    a === b && this.hi[rs] === this.hi[rt],
                    immediate,
                    op === 20,
                );
                break;
            case 5:
            case 21:
                this.branch(
                    a !== b || this.hi[rs] !== this.hi[rt],
                    immediate,
                    op === 21,
                );
                break;
            case 6:
            case 22:
                this.branch(
                    this.hi[rs] < 0 || (this.hi[rs] === 0 && a === 0),
                    immediate,
                    op === 22,
                );
                break;
            case 7:
            case 23:
                this.branch(
                    this.hi[rs] >= 0 && (this.hi[rs] !== 0 || a !== 0),
                    immediate,
                    op === 23,
                );
                break;
            case 8:
                value = (a | 0) + immediate;
                if (value !== (value | 0)) this.exception(12);
                else this.set32(rt, value);
                break;
            case 9:
                this.set32(rt, a + immediate);
                break;
            case 10:
                this.set32(
                    rt,
                    this.hi[rs] < immediate >> 31 ||
                        (this.hi[rs] === immediate >> 31 && a < immediate >>> 0)
                        ? 1
                        : 0,
                );
                break;
            case 11:
                this.set32(
                    rt,
                    this.hi[rs] >>> 0 < (immediate >> 31) >>> 0 ||
                        (this.hi[rs] === immediate >> 31 && a < immediate >>> 0)
                        ? 1
                        : 0,
                );
                break;
            case 12:
                this.lo[rt] = a & (word & 65535);
                this.hi[rt] = 0;
                break;
            case 13:
                this.lo[rt] = a | (word & 65535);
                this.hi[rt] = this.hi[rs];
                break;
            case 14:
                this.lo[rt] = a ^ (word & 65535);
                this.hi[rt] = this.hi[rs];
                break;
            case 15:
                this.set32(rt, word << 16);
                break;
            case 16:
                this.cop0(word, rs, rt, rd);
                break;
            case 17:
                this.cop1(word, rs, rt, rd, shift);
                break;
            case 18:
            case 19:
                this.exception(11, op - 16);
                break;
            case 24:
            case 25:
                value = this.get64(rs) + BigInt(immediate);
                if (op === 24 && BigInt.asIntN(64, value) !== value) {
                    this.exception(12);
                } else this.set64(rt, value);
                break;
            case 26:
            case 27:
                this.unaligned(rt, address, 8, op === 26, false);
                break;
            case 32:
                this.set32(
                    rt,
                    (this.bus.read8(this.translate(address)) << 24) >> 24,
                );
                break;
            case 33:
                this.set32(
                    rt,
                    (this.bus.read16(this.address(address, 2)) << 16) >> 16,
                );
                break;
            case 34:
            case 38:
                this.unaligned(rt, address, 4, op === 34, false);
                break;
            case 35:
                this.set32(rt, this.bus.read32(this.address(address, 4)));
                break;
            case 36:
                this.set32(rt, this.bus.read8(this.translate(address)));
                break;
            case 37:
                this.set32(rt, this.bus.read16(this.address(address, 2)));
                break;
            case 39:
                this.lo[rt] = this.bus.read32(this.address(address, 4));
                this.hi[rt] = 0;
                break;
            case 40:
                this.bus.write8(this.translate(address, true), b);
                break;
            case 41:
                this.bus.write16(this.address(address, 2, true), b);
                break;
            case 42:
            case 46:
                this.unaligned(rt, address, 4, op === 42, true);
                break;
            case 43:
                this.bus.write32(this.address(address, 4, true), b);
                break;
            case 44:
            case 45:
                this.unaligned(rt, address, 8, op === 44, true);
                break;
            case 47:
                break; // Interpreter memory is coherent; CACHE has no data effect.
            case 48:
            case 52:
                physical = this.address(address, op === 48 ? 4 : 8);
                this.llAddress = physical;
                this.cp0[17] = physical >>> 4;
                if (op === 48) this.set32(rt, this.bus.read32(physical));
                else {
                    this.hi[rt] = this.bus.read32(physical);
                    this.lo[rt] = this.bus.read32(physical + 4);
                }
                break;
            case 49:
            case 53:
                if (!this.checkFPU()) break;
                physical = this.address(address, op === 49 ? 4 : 8);
                if (op === 49)
                    this.fpr[this.fpIndex(rt)] = this.bus.read32(physical);
                else {
                    const index = this.fpIndex(rt & (this.fr ? 31 : 30));
                    this.fpr[index + 1] = this.bus.read32(physical);
                    this.fpr[index] = this.bus.read32(physical + 4);
                }
                break;
            case 55:
                physical = this.address(address, 8);
                this.hi[rt] = this.bus.read32(physical);
                this.lo[rt] = this.bus.read32(physical + 4);
                break;
            case 56:
            case 60:
                physical = this.address(address, op === 56 ? 4 : 8, true);
                value = this.llAddress === physical ? 1 : 0;
                if (value) {
                    this.bus.write32(physical, op === 56 ? b : this.hi[rt]);
                    if (op === 60) this.bus.write32(physical + 4, b);
                }
                this.set32(rt, value);
                this.llAddress = -1;
                break;
            case 57:
            case 61:
                if (!this.checkFPU()) break;
                physical = this.address(address, op === 57 ? 4 : 8, true);
                if (op === 57)
                    this.bus.write32(physical, this.fpr[this.fpIndex(rt)]);
                else {
                    const index = this.fpIndex(rt & (this.fr ? 31 : 30));
                    this.bus.write32(physical, this.fpr[index + 1]);
                    this.bus.write32(physical + 4, this.fpr[index]);
                }
                break;
            case 63:
                physical = this.address(address, 8, true);
                this.bus.write32(physical, this.hi[rt]);
                this.bus.write32(physical + 4, b);
                break;
            default:
                this.unsupported(word);
        }
    }

    unaligned(rt, address, size, left, store) {
        const physical = this.translate(address, store);
        const base = physical & ~(size - 1);
        const offset = physical & (size - 1);
        let value = size === 8 ? this.get64(rt, true) : BigInt(this.lo[rt]);
        const start = left ? offset : 0;
        const end = left ? size : offset + 1;
        for (let i = start; i < end; i += 1) {
            const byte = left ? i - offset : size - 1 - offset + i;
            const shift = BigInt((size - 1 - byte) * 8);
            if (store) {
                this.bus.write8(base + i, Number((value >> shift) & 255n));
            } else {
                value =
                    (value & ~(255n << shift)) |
                    (BigInt(this.bus.read8(base + i)) << shift);
            }
        }
        if (!store) {
            if (size === 4) this.set32(rt, Number(value));
            else this.set64(rt, value);
        }
    }

    special(fn, rs, rt, rd, shift) {
        const a = this.lo[rs];
        const b = this.lo[rt];
        let value;
        switch (fn) {
            case 0:
                this.set32(rd, b << shift);
                break;
            case 2:
                this.set32(rd, b >>> shift);
                break;
            case 3:
                this.set32(rd, (b | 0) >> shift);
                break;
            case 4:
                this.set32(rd, b << (a & 31));
                break;
            case 6:
                this.set32(rd, b >>> (a & 31));
                break;
            case 7:
                this.set32(rd, (b | 0) >> (a & 31));
                break;
            case 8:
            case 9:
                if (fn === 9) this.set32(rd, this.nextPC);
                this.nextPC = a;
                this.delaySlot = true;
                break;
            case 12:
                this.exception(8);
                break;
            case 13:
                this.exception(9);
                break;
            case 15:
                break; // SYNC: all interpreter accesses are already ordered.
            case 16:
                this.set64(rd, this.hilo[1]);
                break;
            case 17:
                this.hilo[1] = this.get64(rs);
                break;
            case 18:
                this.set64(rd, this.hilo[0]);
                break;
            case 19:
                this.hilo[0] = this.get64(rs);
                break;
            case 20:
                this.set64(rd, this.get64(rt) << BigInt(a & 63));
                break;
            case 22:
                this.set64(rd, this.get64(rt, true) >> BigInt(a & 63));
                break;
            case 23:
                this.set64(rd, this.get64(rt) >> BigInt(a & 63));
                break;
            case 24:
            case 25:
                value =
                    BigInt(fn === 24 ? a | 0 : a) *
                    BigInt(fn === 24 ? b | 0 : b);
                this.hilo[0] = BigInt.asIntN(32, value);
                this.hilo[1] = BigInt.asIntN(32, value >> 32n);
                break;
            case 26:
            case 27: {
                const dividend = fn === 26 ? a | 0 : a;
                const divisor = fn === 26 ? b | 0 : b;
                this.hilo[0] = BigInt.asIntN(
                    32,
                    BigInt(
                        divisor === 0
                            ? dividend < 0
                                ? 1
                                : -1
                            : Math.trunc(dividend / divisor),
                    ),
                );
                this.hilo[1] = BigInt.asIntN(
                    32,
                    BigInt(divisor === 0 ? dividend : dividend % divisor),
                );
                break;
            }
            case 28:
            case 29:
                value = this.get64(rs, fn === 29) * this.get64(rt, fn === 29);
                this.hilo[0] = BigInt.asIntN(64, value);
                this.hilo[1] = BigInt.asIntN(64, value >> 64n);
                break;
            case 30:
            case 31: {
                const dividend = this.get64(rs, fn === 31);
                const divisor = this.get64(rt, fn === 31);
                this.hilo[0] = BigInt.asIntN(
                    64,
                    divisor === 0n
                        ? dividend < 0n
                            ? 1n
                            : -1n
                        : dividend / divisor,
                );
                this.hilo[1] = BigInt.asIntN(
                    64,
                    divisor === 0n ? dividend : dividend % divisor,
                );
                break;
            }
            case 32:
            case 34:
                value = (a | 0) + (fn === 32 ? b | 0 : -(b | 0));
                if (value !== (value | 0)) this.exception(12);
                else this.set32(rd, value);
                break;
            case 33:
                this.set32(rd, a + b);
                break;
            case 35:
                this.set32(rd, a - b);
                break;
            case 36:
                this.lo[rd] = a & b;
                this.hi[rd] = this.hi[rs] & this.hi[rt];
                break;
            case 37:
                this.lo[rd] = a | b;
                this.hi[rd] = this.hi[rs] | this.hi[rt];
                break;
            case 38:
                this.lo[rd] = a ^ b;
                this.hi[rd] = this.hi[rs] ^ this.hi[rt];
                break;
            case 39:
                this.lo[rd] = ~(a | b);
                this.hi[rd] = ~(this.hi[rs] | this.hi[rt]);
                break;
            case 42:
                this.set32(
                    rd,
                    this.hi[rs] < this.hi[rt] ||
                        (this.hi[rs] === this.hi[rt] && a < b)
                        ? 1
                        : 0,
                );
                break;
            case 43:
                this.set32(
                    rd,
                    this.hi[rs] >>> 0 < this.hi[rt] >>> 0 ||
                        (this.hi[rs] === this.hi[rt] && a < b)
                        ? 1
                        : 0,
                );
                break;
            case 44:
            case 45:
            case 46:
            case 47:
                value =
                    this.get64(rs) +
                    (fn < 46 ? this.get64(rt) : -this.get64(rt));
                if (!(fn & 1) && BigInt.asIntN(64, value) !== value) {
                    this.exception(12);
                } else this.set64(rd, value);
                break;
            case 48:
            case 49:
            case 50:
            case 51:
            case 52:
            case 54: {
                const av = this.get64(rs, (fn & 1) !== 0);
                const bv = this.get64(rt, (fn & 1) !== 0);
                const condition =
                    fn < 50
                        ? av >= bv
                        : fn < 52
                          ? av < bv
                          : fn === 52
                            ? av === bv
                            : av !== bv;
                if (condition) this.exception(13);
                break;
            }
            case 56:
            case 60:
                this.set64(
                    rd,
                    this.get64(rt) << BigInt(shift + (fn === 60 ? 32 : 0)),
                );
                break;
            case 58:
            case 62:
                this.set64(
                    rd,
                    this.get64(rt, true) >>
                        BigInt(shift + (fn === 62 ? 32 : 0)),
                );
                break;
            case 59:
            case 63:
                this.set64(
                    rd,
                    this.get64(rt) >> BigInt(shift + (fn === 63 ? 32 : 0)),
                );
                break;
            default:
                this.unsupported(fn);
        }
    }

    cop0(word, rs, rt, rd) {
        if (rs === 0 || rs === 1) {
            this.set32(rt, this.cp0[rd]);
        } else if (rs === 4 || rs === 5) {
            const value = this.lo[rt];
            if (rd === 13)
                this.cp0[13] = (this.cp0[13] & ~0x300) | (value & 0x300);
            else if (rd !== 1 && rd !== 15) this.cp0[rd] = value;
            if (rd === 11) this.cp0[13] &= ~0x8000;
            if (rd === 6) {
                this.cp0[6] &= 31;
                this.cp0[1] = 31;
            }
        } else if (rs === 16) {
            const fn = word & 63;
            if (fn === 24) {
                const errorLevel = this.cp0[12] & 4;
                this.setPC(this.cp0[errorLevel ? 30 : 14]);
                this.cp0[12] &= errorLevel ? ~4 : ~2;
                this.llAddress = -1;
            } else if (fn === 1) {
                const entry = this.tlb[this.cp0[0] & 31];
                this.cp0[5] = entry.mask;
                this.cp0[10] = entry.hi;
                this.cp0[2] = entry.lo0;
                this.cp0[3] = entry.lo1;
            } else if (fn === 2 || fn === 6) {
                this.tlb[this.cp0[fn === 2 ? 0 : 1] & 31] = {
                    mask: this.cp0[5] & 0x01ffe000,
                    hi: this.cp0[10],
                    lo0: this.cp0[2],
                    lo1: this.cp0[3],
                };
            } else if (fn === 8) {
                this.cp0[0] = 0x80000000;
                for (let i = 0; i < 32; i += 1) {
                    const entry = this.tlb[i];
                    const mask = entry.mask | 0x1fff;
                    if (
                        (entry.hi & ~mask) === (this.cp0[10] & ~mask) &&
                        (entry.lo0 & entry.lo1 & 1 ||
                            (entry.hi & 255) === (this.cp0[10] & 255))
                    ) {
                        this.cp0[0] = i;
                        break;
                    }
                }
            } else this.unsupported(word);
        } else this.unsupported(word);
    }

    get fr() {
        return (this.cp0[12] & 0x04000000) !== 0;
    }
    fpIndex(index) {
        return this.fr ? index * 2 : index;
    }

    checkFPU() {
        if (this.cp0[12] & 0x20000000) return true;
        this.exception(11, 1);
        return false;
    }

    readFloat(index, format) {
        const i = this.fpIndex(index);
        if (format === 16) return this.fprSingle[i];
        if (format === 20) return this.fpr[i] | 0;
        if (format === 17 && LITTLE_ENDIAN && !(i & 1)) {
            return this.fprDouble[i >>> 1];
        }
        this.fpScratch.setUint32(0, this.fpr[i], true);
        this.fpScratch.setUint32(4, this.fpr[i + 1], true);
        if (format === 17) return this.fpScratch.getFloat64(0, true);
        if (format === 21) return Number(this.fpScratch.getBigInt64(0, true));
        this.unsupported(format);
    }

    writeFloat(index, format, value) {
        const i = this.fpIndex(index);
        if (format === 16) {
            this.fprSingle[i] = value;
            return;
        }
        if (format === 20) {
            this.fpr[i] = value;
            return;
        }
        if (format === 17 && LITTLE_ENDIAN && !(i & 1)) {
            this.fprDouble[i >>> 1] = value;
            return;
        }
        if (format === 17) this.fpScratch.setFloat64(0, value, true);
        else this.fpScratch.setBigInt64(0, BigInt(value), true);
        this.fpr[i] = this.fpScratch.getUint32(0, true);
        if (format === 17 || format === 21) {
            this.fpr[i + 1] = this.fpScratch.getUint32(4, true);
        }
    }

    cop1(word, format, rt, fs, fd) {
        if (!this.checkFPU()) return;
        const index = this.fpIndex(fs);
        if (format === 0) this.set32(rt, this.fpr[index]);
        else if (format === 1) {
            this.lo[rt] = this.fpr[index];
            this.hi[rt] = this.fpr[index + 1];
        } else if (format === 2) this.set32(rt, fs === 31 ? this.fcr31 : 0xa00);
        else if (format === 4) this.fpr[index] = this.lo[rt];
        else if (format === 5) {
            this.fpr[index] = this.lo[rt];
            this.fpr[index + 1] = this.hi[rt];
        } else if (format === 6) {
            if (fs === 31) this.fcr31 = this.lo[rt] & 0x0183ffff;
        } else if (format === 8) {
            const condition = (this.fcr31 & 0x800000) !== 0;
            this.branch(
                condition === ((rt & 1) !== 0),
                (word << 16) >> 16,
                (rt & 2) !== 0,
            );
        } else if ([16, 17, 20, 21].includes(format)) {
            const fn = word & 63;
            const a = this.readFloat(fs, format);
            const b = this.readFloat(rt, format);
            let result;
            let outputFormat = format;
            if (fn >= 48) {
                const unordered = Number.isNaN(a) || Number.isNaN(b);
                const condition =
                    (fn & 1 && unordered) ||
                    (fn & 2 && a === b) ||
                    (fn & 4 && a < b);
                this.fcr31 =
                    (this.fcr31 & ~0x800000) | (condition ? 0x800000 : 0);
                return;
            }
            switch (fn) {
                case 0:
                    result = a + b;
                    break;
                case 1:
                    result = a - b;
                    break;
                case 2:
                    result = a * b;
                    break;
                case 3:
                    result = a / b;
                    break;
                case 4:
                    result = Math.sqrt(a);
                    break;
                case 5:
                    result = Math.abs(a);
                    break;
                case 6:
                    this.fpr[this.fpIndex(fd)] = this.fpr[index];
                    if (format === 17)
                        this.fpr[this.fpIndex(fd) + 1] = this.fpr[index + 1];
                    return;
                case 7:
                    result = -a;
                    break;
                case 8:
                case 9:
                case 10:
                case 11:
                case 12:
                case 13:
                case 14:
                case 15:
                case 36:
                case 37: {
                    outputFormat = fn < 12 || fn === 37 ? 21 : 20;
                    const mode = fn >= 36 ? this.fcr31 & 3 : fn & 3;
                    result = [roundEven, Math.trunc, Math.ceil, Math.floor][
                        mode
                    ](a);
                    if (
                        !Number.isFinite(result) ||
                        (outputFormat === 20 &&
                            (result < -2147483648 || result > 2147483647))
                    ) {
                        this.fcr31 |= 0x10040;
                        result =
                            outputFormat === 20 ? -2147483648 : -Number(SIGN64);
                    }
                    break;
                }
                case 32:
                    outputFormat = 16;
                    result = a;
                    break;
                case 33:
                    outputFormat = 17;
                    result = a;
                    break;
                default:
                    this.unsupported(word);
            }
            this.writeFloat(fd, outputFormat, result);
        } else this.unsupported(word);
    }

    unsupported(word) {
        throw new Error(
            `Unsupported VR4300 instruction 0x${word.toString(16)}` +
                ` at 0x${this.instructionPC.toString(16)}`,
        );
    }
}

export { VR4300 };
