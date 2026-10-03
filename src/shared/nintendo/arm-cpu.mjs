// Original ARMv4T/v5TE interpreter, shared by the separate GBA and DS buses.
const N = 0x80000000,
    Z = 0x40000000,
    C = 0x20000000,
    V = 0x10000000;
function ror(value, shift) {
    shift &= 31;
    return ((value >>> shift) | (value << ((32 - shift) & 31))) >>> 0;
}

class ARMCPU {
    constructor(bus, options = {}) {
        this.bus = bus;
        this.v5 = !!options.v5;
        this.r = new Uint32Array(16);
        this.cpsr = 0x1f;
        this.spsr = new Uint32Array(32);
        this.banks = Array.from({ length: 32 }, () => new Uint32Array(7));
        this.pc = options.entry ?? 0x08000000;
        this.halted = false;
        this.instructions = 0;
    }
    setCPSR(value) {
        const old = this.cpsr & 31,
            mode = value & 31;
        const bank = (m) => (m === 0x10 || m === 0x1f ? 0x10 : m);
        if (bank(old) !== bank(mode)) {
            const oldBank = this.banks[bank(old)],
                newBank = this.banks[bank(mode)];
            oldBank[5] = this.r[13];
            oldBank[6] = this.r[14];
            if (old === 0x11 || mode === 0x11) {
                for (let i = 8; i <= 12; i += 1) {
                    this.banks[old === 0x11 ? 0x11 : 0x10][i - 8] = this.r[i];
                    this.r[i] = this.banks[mode === 0x11 ? 0x11 : 0x10][i - 8];
                }
            }
            this.r[13] = newBank[5];
            this.r[14] = newBank[6];
        }
        this.cpsr = value >>> 0;
    }
    exception(mode, vector, link) {
        const status = this.cpsr;
        this.setCPSR((status & ~0x3f) | mode | 128);
        this.spsr[mode] = status;
        this.r[14] = link;
        this.pc = vector >>> 0;
        this.halted = false;
    }
    branch(value, exchange = false) {
        if (exchange) this.cpsr = (this.cpsr & ~32) | (value & 1 ? 32 : 0);
        this.pc = (value & (this.cpsr & 32 ? ~1 : ~3)) >>> 0;
    }
    condition(cond) {
        const n = !!(this.cpsr & N),
            z = !!(this.cpsr & Z);
        const c = !!(this.cpsr & C),
            v = !!(this.cpsr & V);
        switch (cond) {
            case 0:
                return z;
            case 1:
                return !z;
            case 2:
                return c;
            case 3:
                return !c;
            case 4:
                return n;
            case 5:
                return !n;
            case 6:
                return v;
            case 7:
                return !v;
            case 8:
                return c && !z;
            case 9:
                return !c || z;
            case 10:
                return n === v;
            case 11:
                return n !== v;
            case 12:
                return !z && n === v;
            case 13:
                return z || n !== v;
            case 14:
                return true;
            default:
                return false;
        }
    }
    nz(value) {
        value >>>= 0;
        this.cpsr =
            ((this.cpsr & 0x3fffffff) | (value & N) | (value === 0 ? Z : 0)) >>>
            0;
        return value;
    }
    add(a, b, carry = 0, flags = true) {
        a >>>= 0;
        b >>>= 0;
        const sum = a + b + carry,
            value = sum >>> 0;
        if (flags) {
            this.nz(value);
            this.cpsr =
                ((this.cpsr & ~0x30000000) |
                    (sum > 0xffffffff ? C : 0) |
                    (~(a ^ b) & (a ^ value) & N ? V : 0)) >>>
                0;
        }
        return value;
    }
    sub(a, b, borrow = 0, flags = true) {
        a >>>= 0;
        b >>>= 0;
        const sum = a - b - borrow,
            value = sum >>> 0;
        if (flags) {
            this.nz(value);
            this.cpsr =
                ((this.cpsr & ~0x30000000) |
                    (sum >= 0 ? C : 0) |
                    ((a ^ b) & (a ^ value) & N ? V : 0)) >>>
                0;
        }
        return value;
    }
    shift(value, type, amount, immediate = false) {
        value >>>= 0;
        let carry = this.cpsr & C ? 1 : 0;
        if (immediate && amount === 0 && type !== 0) {
            if (type === 3)
                return {
                    value: ((value >>> 1) | (carry << 31)) >>> 0,
                    carry: value & 1,
                };
            amount = 32;
        }
        if (amount === 0) return { value, carry };
        if (type === 0) {
            carry = amount <= 32 ? (value >>> (32 - amount)) & 1 : 0;
            value = amount < 32 ? value << amount : 0;
        } else if (type === 1) {
            carry = amount <= 32 ? (value >>> (amount - 1)) & 1 : 0;
            value = amount < 32 ? value >>> amount : 0;
        } else if (type === 2) {
            carry = amount < 32 ? (value >>> (amount - 1)) & 1 : value >>> 31;
            value = (value | 0) >> Math.min(31, amount);
        } else {
            value = ror(value, amount);
            carry = value >>> 31;
        }
        return { value: value >>> 0, carry };
    }
    loadWord(address) {
        return ror(this.bus.read32(address & ~3), (address & 3) * 8);
    }
    writeRegister(index, value, exchange = false) {
        if (index === 15) this.branch(value, exchange);
        else this.r[index] = value;
    }
    step() {
        if (this.bus.irqPending?.()) {
            this.halted = false;
            if (!(this.cpsr & 128)) {
                this.exception(0x12, this.bus.irqVector ?? 0x18, this.pc + 4);
                return 3;
            }
        }
        if (this.halted) return 4;
        const thumb = !!(this.cpsr & 32);
        const address = this.pc;
        this.r[15] = address + (thumb ? 4 : 8);
        this.pc = (address + (thumb ? 2 : 4)) >>> 0;
        this.instructions += 1;
        const opcode = thumb
            ? this.bus.read16(address)
            : this.bus.read32(address);
        return thumb ? this.thumb(opcode) : this.arm(opcode);
    }

    arm(op) {
        const cond = op >>> 28;
        if (this.v5 && cond === 15 && (op & 0x0e000000) === 0x0a000000) {
            this.r[14] = this.pc;
            this.cpsr |= 32;
            this.branch(this.r[15] + ((op << 8) >> 6) + ((op >>> 23) & 2));
            return 3;
        }
        if (!this.condition(cond)) return 1;
        const rd = (op >>> 12) & 15,
            rn = (op >>> 16) & 15,
            rm = op & 15;
        if (
            (op & 0x0ffffff0) === 0x012fff10 ||
            (this.v5 && (op & 0x0ffffff0) === 0x012fff30)
        ) {
            if (op & 32) this.r[14] = this.pc;
            this.branch(this.r[rm], true);
            return 3;
        }
        if (this.v5 && (op & 0x0fff0ff0) === 0x016f0f10) {
            this.r[rd] = Math.clz32(this.r[rm]);
            return 1;
        }
        if ((op & 0x0f9000f0) === 0x01000050) {
            if (!this.v5) this.illegal(op);
            const kind = (op >>> 21) & 3;
            const saturate = (value) => {
                if (value > 0x7fffffff || value < -0x80000000) {
                    this.cpsr |= 0x08000000;
                }
                return Math.max(-0x80000000, Math.min(0x7fffffff, value));
            };
            const b =
                kind & 2 ? saturate((this.r[rn] | 0) * 2) : this.r[rn] | 0;
            this.r[rd] = saturate((this.r[rm] | 0) + (kind & 1 ? -b : b));
            return 1;
        }
        if (this.v5 && (op & 0x0f900090) === 0x01000080) {
            const rs = (op >>> 8) & 15,
                kind = (op >>> 21) & 3;
            const half = (value, high) =>
                high ? value >> 16 : (value << 16) >> 16;
            const b = half(this.r[rs], op & 64);
            if (kind === 1) {
                let result = Number(
                    (BigInt(this.r[rm] | 0) * BigInt(b)) >> 16n,
                );
                if (!(op & 32)) result += this.r[rd] | 0;
                if (result > 0x7fffffff || result < -0x80000000)
                    this.cpsr |= 0x08000000;
                this.r[rn] = result;
            } else {
                const result = half(this.r[rm], op & 32) * b;
                if (kind === 2) {
                    const value = BigInt.asUintN(
                        64,
                        BigInt(result) +
                            (BigInt(this.r[rn]) << 32n) +
                            BigInt(this.r[rd]),
                    );
                    this.r[rd] = Number(value & 0xffffffffn);
                    this.r[rn] = Number(value >> 32n);
                } else {
                    const value = result + (kind === 0 ? this.r[rd] | 0 : 0);
                    if (value > 0x7fffffff || value < -0x80000000)
                        this.cpsr |= 0x08000000;
                    this.r[rn] = value;
                }
            }
            return 2;
        }
        if ((op & 0x0fbf0fff) === 0x010f0000) {
            this.r[rd] = op & 0x400000 ? this.spsr[this.cpsr & 31] : this.cpsr;
            return 1;
        }
        if ((op & 0x0db0f000) === 0x0120f000) {
            const value =
                op & 0x2000000
                    ? ror(op & 255, ((op >>> 8) & 15) * 2)
                    : this.r[rm];
            let mask = 0;
            for (let i = 0; i < 4; i += 1)
                if (op & (0x10000 << i)) mask |= 255 << (i * 8);
            if (op & 0x400000) {
                const mode = this.cpsr & 31;
                this.spsr[mode] = (this.spsr[mode] & ~mask) | (value & mask);
            } else {
                if ((this.cpsr & 31) === 0x10) mask &= 0xff000000;
                this.setCPSR((this.cpsr & ~mask) | (value & mask));
            }
            return 1;
        }
        if ((op & 0x0f8000f0) === 0x00800090) {
            const signed = !!(op & 0x400000);
            const a = BigInt(signed ? this.r[rm] | 0 : this.r[rm]);
            const rs = this.r[(op >>> 8) & 15];
            let result = a * BigInt(signed ? rs | 0 : rs);
            if (op & 0x200000)
                result += (BigInt(this.r[rn]) << 32n) | BigInt(this.r[rd]);
            result = BigInt.asUintN(64, result);
            this.r[rd] = Number(result & 0xffffffffn);
            this.r[rn] = Number(result >> 32n);
            if (op & 0x100000)
                this.cpsr =
                    ((this.cpsr & 0x3fffffff) |
                        (this.r[rn] & N) |
                        (result === 0n ? Z : 0)) >>>
                    0;
            return 4;
        }
        if ((op & 0x0fc000f0) === 0x00000090) {
            let value = Math.imul(this.r[rm], this.r[(op >>> 8) & 15]);
            if (op & 0x200000) value += this.r[rd];
            this.r[rn] = value;
            if (op & 0x100000) this.nz(this.r[rn]);
            return 3;
        }
        if ((op & 0x0fb00ff0) === 0x01000090) {
            const address = this.r[rn],
                value = this.r[rm];
            if (op & 0x400000) {
                this.r[rd] = this.bus.read8(address);
                this.bus.write8(address, value);
            } else {
                this.r[rd] = this.loadWord(address);
                this.bus.write32(address & ~3, value);
            }
            return 4;
        }
        if ((op & 0x0e000090) === 0x00000090) {
            const immediate = op & 0x400000;
            const offset = immediate ? ((op >>> 4) & 0xf0) | rm : this.r[rm];
            const base = this.r[rn],
                delta = op & 0x800000 ? offset : -offset;
            const address = (op & 0x1000000 ? base + delta : base) >>> 0;
            const kind = (op >>> 5) & 3;
            if (op & 0x100000) {
                let value;
                if (kind === 1)
                    value = ror(
                        this.bus.read16(address & ~1),
                        (address & 1) * 8,
                    );
                else if (kind === 2 || address & 1)
                    value = (this.bus.read8(address) << 24) >> 24;
                else value = (this.bus.read16(address) << 16) >> 16;
                this.writeRegister(rd, value);
            } else if (kind === 1) this.bus.write16(address & ~1, this.r[rd]);
            else if (this.v5 && kind >= 2) {
                if (kind === 2) {
                    this.r[rd] = this.bus.read32(address & ~3);
                    this.r[(rd + 1) & 15] = this.bus.read32((address + 4) & ~3);
                } else {
                    this.bus.write32(address & ~3, this.r[rd]);
                    this.bus.write32((address + 4) & ~3, this.r[(rd + 1) & 15]);
                }
            } else this.illegal(op);
            if (!(op & 0x1000000) || op & 0x200000) this.r[rn] = base + delta;
            return 3;
        }
        if ((op & 0x0c000000) === 0) {
            const operation = (op >>> 21) & 15;
            const flags = !!(op & 0x100000);
            let shifted;
            if (op & 0x2000000) {
                const rotate = ((op >>> 8) & 15) * 2;
                const value = ror(op & 255, rotate);
                shifted = {
                    value,
                    carry: rotate ? value >>> 31 : (this.cpsr >>> 29) & 1,
                };
            } else {
                const register = !!(op & 16);
                let value = this.r[rm];
                if (rm === 15 && register) value += 4;
                shifted = this.shift(
                    value,
                    (op >>> 5) & 3,
                    register ? this.r[(op >>> 8) & 15] & 255 : (op >>> 7) & 31,
                    !register,
                );
            }
            const a = this.r[rn],
                b = shifted.value;
            const carry = (this.cpsr >>> 29) & 1;
            const test = operation >= 8 && operation <= 11;
            if (test && !flags) this.illegal(op);
            let result,
                arithmetic = false;
            switch (operation) {
                case 0:
                case 8:
                    result = a & b;
                    break;
                case 1:
                case 9:
                    result = a ^ b;
                    break;
                case 2:
                case 10:
                    result = this.sub(a, b, 0, flags || test);
                    arithmetic = true;
                    break;
                case 3:
                    result = this.sub(b, a, 0, flags);
                    arithmetic = true;
                    break;
                case 4:
                case 11:
                    result = this.add(a, b, 0, flags || test);
                    arithmetic = true;
                    break;
                case 5:
                    result = this.add(a, b, carry, flags);
                    arithmetic = true;
                    break;
                case 6:
                    result = this.sub(a, b, 1 - carry, flags);
                    arithmetic = true;
                    break;
                case 7:
                    result = this.sub(b, a, 1 - carry, flags);
                    arithmetic = true;
                    break;
                case 12:
                    result = a | b;
                    break;
                case 13:
                    result = b;
                    break;
                case 14:
                    result = a & ~b;
                    break;
                case 15:
                    result = ~b;
                    break;
            }
            if ((flags || test) && !arithmetic) {
                this.nz(result);
                this.cpsr = ((this.cpsr & ~C) | (shifted.carry ? C : 0)) >>> 0;
            }
            if (!test) {
                if (
                    rd === 15 &&
                    flags &&
                    ![0x10, 0x1f].includes(this.cpsr & 31)
                ) {
                    this.setCPSR(this.spsr[this.cpsr & 31]);
                    this.bus.onExceptionReturn?.(this);
                }
                this.writeRegister(rd, result);
            }
            return !test && rd === 15
                ? 3
                : op & 16 && !(op & 0x2000000)
                  ? 2
                  : 1;
        }
        if ((op & 0x0c000000) === 0x04000000) {
            const base = this.r[rn];
            const offset =
                op & 0x2000000
                    ? this.shift(
                          this.r[rm],
                          (op >>> 5) & 3,
                          (op >>> 7) & 31,
                          true,
                      ).value
                    : op & 4095;
            const delta = op & 0x800000 ? offset : -offset;
            const address = (op & 0x1000000 ? base + delta : base) >>> 0;
            if (op & 0x100000) {
                this.writeRegister(
                    rd,
                    op & 0x400000
                        ? this.bus.read8(address)
                        : this.loadWord(address),
                    this.v5 && rd === 15,
                );
            } else {
                const value = rd === 15 ? this.r[15] + 4 : this.r[rd];
                if (op & 0x400000) this.bus.write8(address, value);
                else this.bus.write32(address & ~3, value);
            }
            if (!(op & 0x1000000) || op & 0x200000) this.r[rn] = base + delta;
            return op & 0x100000 ? 3 : 2;
        }
        if ((op & 0x0e000000) === 0x08000000) {
            let list = op & 65535,
                count = 0;
            for (let i = 0; i < 16; i += 1) if (list & (1 << i)) count += 1;
            const empty = count === 0;
            if (empty) {
                list = 0x8000;
                count = 16;
            }
            const base = this.r[rn],
                up = !!(op & 0x800000),
                pre = !!(op & 0x1000000);
            let address = up
                ? base + (pre ? 4 : 0)
                : base - count * 4 + (pre ? 0 : 4);
            const final = (base + (up ? count * 4 : -count * 4)) >>> 0;
            const load = !!(op & 0x100000),
                user = !!(op & 0x400000);
            const oldMode = this.cpsr & 31;
            const userTransfer = user && !(load && list & 0x8000);
            if (userTransfer) this.setCPSR((this.cpsr & ~31) | 0x1f);
            for (let i = 0; i < 16; i += 1) {
                if (!(list & (1 << i))) continue;
                if (load) {
                    const value = this.bus.read32(address & ~3);
                    if (i === 15) {
                        if (user && !userTransfer) {
                            this.setCPSR(this.spsr[oldMode]);
                            this.bus.onExceptionReturn?.(this);
                        }
                        this.branch(value, this.v5 && !user);
                    } else this.r[i] = value;
                } else
                    this.bus.write32(
                        address & ~3,
                        i === 15 ? this.r[15] + 4 : this.r[i],
                    );
                address += 4;
            }
            if (userTransfer) this.setCPSR((this.cpsr & ~31) | oldMode);
            if (op & 0x200000 && !(load && list & (1 << rn)))
                this.r[rn] = final;
            return count + (load ? 2 : 1);
        }
        if ((op & 0x0e000000) === 0x0a000000) {
            if (op & 0x1000000) this.r[14] = this.pc;
            this.branch(this.r[15] + ((op << 8) >> 6));
            return 3;
        }
        if ((op & 0x0f000000) === 0x0f000000) {
            return this.bus.swi((op >>> 16) & 255, this) ?? 3;
        }
        if (this.v5 && (op & 0x0f000010) === 0x0e000010) {
            const value = this.bus.cp15?.(op, this.r[rd]) ?? 0;
            if (op & 0x100000) this.r[rd] = value;
            return 1;
        }
        this.illegal(op);
    }

    thumb(op) {
        const rd = op & 7,
            rs = (op >>> 3) & 7;
        if (op < 0x1800) {
            const shifted = this.shift(
                this.r[rs],
                op >>> 11,
                (op >>> 6) & 31,
                true,
            );
            this.r[rd] = this.nz(shifted.value);
            this.cpsr = ((this.cpsr & ~C) | (shifted.carry ? C : 0)) >>> 0;
            return 1;
        }
        if (op < 0x2000) {
            const b = op & 0x400 ? (op >>> 6) & 7 : this.r[(op >>> 6) & 7];
            this.r[rd] =
                op & 0x200 ? this.sub(this.r[rs], b) : this.add(this.r[rs], b);
            return 1;
        }
        if (op < 0x4000) {
            const target = (op >>> 8) & 7,
                value = op & 255;
            switch ((op >>> 11) & 3) {
                case 0:
                    this.r[target] = this.nz(value);
                    break;
                case 1:
                    this.sub(this.r[target], value);
                    break;
                case 2:
                    this.r[target] = this.add(this.r[target], value);
                    break;
                case 3:
                    this.r[target] = this.sub(this.r[target], value);
                    break;
            }
            return 1;
        }
        if (op < 0x4400) {
            const operation = (op >>> 6) & 15,
                a = this.r[rd],
                b = this.r[rs];
            let result,
                test = false;
            switch (operation) {
                case 0:
                    result = this.nz(a & b);
                    break;
                case 1:
                    result = this.nz(a ^ b);
                    break;
                case 2:
                case 3:
                case 4:
                case 7: {
                    const shifted = this.shift(
                        a,
                        operation === 7 ? 3 : operation - 2,
                        b & 255,
                    );
                    result = this.nz(shifted.value);
                    this.cpsr =
                        ((this.cpsr & ~C) | (shifted.carry ? C : 0)) >>> 0;
                    break;
                }
                case 5:
                    result = this.add(a, b, (this.cpsr >>> 29) & 1);
                    break;
                case 6:
                    result = this.sub(a, b, 1 - ((this.cpsr >>> 29) & 1));
                    break;
                case 8:
                    this.nz(a & b);
                    test = true;
                    break;
                case 9:
                    result = this.sub(0, b);
                    break;
                case 10:
                    this.sub(a, b);
                    test = true;
                    break;
                case 11:
                    this.add(a, b);
                    test = true;
                    break;
                case 12:
                    result = this.nz(a | b);
                    break;
                case 13:
                    result = this.nz(Math.imul(a, b));
                    break;
                case 14:
                    result = this.nz(a & ~b);
                    break;
                case 15:
                    result = this.nz(~b);
                    break;
            }
            if (!test) this.r[rd] = result;
            return [2, 3, 4, 7, 13].includes(operation) ? 2 : 1;
        }
        if (op < 0x4800) {
            const target = rd | ((op >>> 4) & 8),
                source = (op >>> 3) & 15;
            switch ((op >>> 8) & 3) {
                case 0:
                    this.writeRegister(target, this.r[target] + this.r[source]);
                    break;
                case 1:
                    this.sub(this.r[target], this.r[source]);
                    break;
                case 2:
                    this.writeRegister(target, this.r[source]);
                    break;
                case 3:
                    if (this.v5 && op & 128) this.r[14] = this.pc | 1;
                    this.branch(this.r[source], true);
                    return 3;
            }
            return target === 15 ? 3 : 1;
        }
        if (op < 0x5000) {
            this.r[(op >>> 8) & 7] = this.bus.read32(
                (this.r[15] & ~3) + (op & 255) * 4,
            );
            return 3;
        }
        if (op < 0x6000) {
            const address = (this.r[rs] + this.r[(op >>> 6) & 7]) >>> 0;
            switch ((op >>> 9) & 7) {
                case 0:
                    this.bus.write32(address & ~3, this.r[rd]);
                    break;
                case 1:
                    this.bus.write16(address & ~1, this.r[rd]);
                    break;
                case 2:
                    this.bus.write8(address, this.r[rd]);
                    break;
                case 3:
                    this.r[rd] = (this.bus.read8(address) << 24) >> 24;
                    break;
                case 4:
                    this.r[rd] = this.loadWord(address);
                    break;
                case 5:
                    this.r[rd] = ror(
                        this.bus.read16(address & ~1),
                        (address & 1) * 8,
                    );
                    break;
                case 6:
                    this.r[rd] = this.bus.read8(address);
                    break;
                case 7:
                    this.r[rd] =
                        address & 1
                            ? (this.bus.read8(address) << 24) >> 24
                            : (this.bus.read16(address) << 16) >> 16;
                    break;
            }
            return op & 0x800 ? 3 : 2;
        }
        if (op < 0x8000) {
            const byte = !!(op & 0x1000),
                load = !!(op & 0x800);
            const address =
                (this.r[rs] + ((op >>> 6) & 31) * (byte ? 1 : 4)) >>> 0;
            if (load)
                this.r[rd] = byte
                    ? this.bus.read8(address)
                    : this.loadWord(address);
            else if (byte) this.bus.write8(address, this.r[rd]);
            else this.bus.write32(address & ~3, this.r[rd]);
            return load ? 3 : 2;
        }
        if (op < 0x9000) {
            const address = (this.r[rs] + ((op >>> 6) & 31) * 2) >>> 0;
            if (op & 0x800) this.r[rd] = this.bus.read16(address & ~1);
            else this.bus.write16(address & ~1, this.r[rd]);
            return op & 0x800 ? 3 : 2;
        }
        if (op < 0xa000) {
            const address = (this.r[13] + (op & 255) * 4) >>> 0,
                target = (op >>> 8) & 7;
            if (op & 0x800) this.r[target] = this.loadWord(address);
            else this.bus.write32(address & ~3, this.r[target]);
            return op & 0x800 ? 3 : 2;
        }
        if (op < 0xb000) {
            this.r[(op >>> 8) & 7] =
                (op & 0x800 ? this.r[13] : this.r[15] & ~3) + (op & 255) * 4;
            return 1;
        }
        if ((op & 0xff00) === 0xb000) {
            this.r[13] += (op & 127) * (op & 128 ? -4 : 4);
            return 1;
        }
        if ((op & 0xf600) === 0xb400) {
            const pop = !!(op & 0x800),
                list = op & 255;
            let count = op & 256 ? 1 : 0;
            for (let i = 0; i < 8; i += 1) if (list & (1 << i)) count += 1;
            let address = pop ? this.r[13] : this.r[13] - count * 4;
            for (let i = 0; i <= 8; i += 1) {
                if (!(i === 8 ? op & 256 : list & (1 << i))) continue;
                if (pop)
                    this.writeRegister(
                        i === 8 ? 15 : i,
                        this.bus.read32(address & ~3),
                        this.v5 && i === 8,
                    );
                else this.bus.write32(address & ~3, this.r[i === 8 ? 14 : i]);
                address += 4;
            }
            this.r[13] += (pop ? 4 : -4) * count;
            return count + 2;
        }
        if ((op & 0xf000) === 0xc000) {
            const base = (op >>> 8) & 7,
                load = !!(op & 0x800),
                list = op & 255;
            let address = this.r[base];
            for (let i = 0; i < 8; i += 1)
                if (list & (1 << i)) {
                    if (load) this.r[i] = this.bus.read32(address & ~3);
                    else this.bus.write32(address & ~3, this.r[i]);
                    address += 4;
                }
            if (!(load && list & (1 << base))) this.r[base] = address;
            return 4;
        }
        if ((op & 0xf000) === 0xd000) {
            const cond = (op >>> 8) & 15;
            if (cond === 15) return this.bus.swi(op & 255, this) ?? 3;
            if (cond === 14) this.illegal(op);
            if (this.condition(cond)) {
                this.branch(this.r[15] + ((op << 24) >> 23));
                return 3;
            }
            return 1;
        }
        if ((op & 0xf800) === 0xe000) {
            this.branch(this.r[15] + ((op << 21) >> 20));
            return 3;
        }
        if ((op & 0xf800) === 0xf000) {
            this.r[14] = this.r[15] + ((op << 21) >> 9);
            return 1;
        }
        if ((op & 0xf800) === 0xf800 || (this.v5 && (op & 0xf800) === 0xe800)) {
            const address = this.r[14] + (op & 2047) * 2;
            this.r[14] = this.pc | 1;
            if (!(op & 0x1000)) this.cpsr &= ~32;
            this.branch(address);
            return 3;
        }
        this.illegal(op);
    }
    illegal(op) {
        throw new Error(
            `Unsupported ARM opcode 0x${op.toString(16)} at ` +
                `0x${(this.r[15] - (this.cpsr & 32 ? 4 : 8)).toString(16)}`,
        );
    }
}

export { ARMCPU, ror };
