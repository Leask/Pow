// Original SM83 interpreter. Cycle counts are T-cycles, not M-cycles.
const Z = 0x80;
const N = 0x40;
const H = 0x20;
const C = 0x10;

class SM83 {
    constructor(bus, color = false) {
        this.bus = bus;
        this.r = new Uint8Array([
            0,
            color ? 0 : 0x13,
            color ? 0xff : 0,
            color ? 0x56 : 0xd8,
            color ? 0 : 1,
            color ? 0x0d : 0x4d,
            0,
            color ? 0x11 : 1,
        ]);
        this.f = color ? 0x80 : 0xb0;
        this.sp = 0xfffe;
        this.pc = 0x100;
        this.ime = false;
        this.eiDelay = 0;
        this.halted = false;
        this.haltBug = false;
        this.instructions = 0;
    }

    read(index) {
        return index === 6 ? this.bus.read(this.pair(2)) : this.r[index];
    }

    write(index, value) {
        if (index === 6) this.bus.write(this.pair(2), value & 255);
        else this.r[index] = value;
    }

    pair(index) {
        if (index === 3) return this.sp;
        return (this.r[index * 2] << 8) | this.r[index * 2 + 1];
    }

    setPair(index, value) {
        value &= 0xffff;
        if (index === 3) this.sp = value;
        else {
            this.r[index * 2] = value >>> 8;
            this.r[index * 2 + 1] = value;
        }
    }

    fetch() {
        const value = this.bus.read(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        return value;
    }

    word() {
        return this.fetch() | (this.fetch() << 8);
    }
    push(value) {
        this.sp = (this.sp - 1) & 0xffff;
        this.bus.write(this.sp, value >>> 8);
        this.sp = (this.sp - 1) & 0xffff;
        this.bus.write(this.sp, value & 255);
    }
    pop() {
        const lo = this.bus.read(this.sp);
        this.sp = (this.sp + 1) & 0xffff;
        const hi = this.bus.read(this.sp);
        this.sp = (this.sp + 1) & 0xffff;
        return lo | (hi << 8);
    }
    condition(index) {
        return [!(this.f & Z), !!(this.f & Z), !(this.f & C), !!(this.f & C)][
            index
        ];
    }

    alu(operation, value) {
        const a = this.r[7];
        const carry =
            (operation === 1 || operation === 3) && this.f & C ? 1 : 0;
        let result;
        if (operation <= 1) {
            result = a + value + carry;
            this.f =
                ((a & 15) + (value & 15) + carry > 15 ? H : 0) |
                (result > 255 ? C : 0);
        } else if (operation <= 3 || operation === 7) {
            result = a - value - carry;
            this.f =
                N |
                ((a & 15) < (value & 15) + carry ? H : 0) |
                (result < 0 ? C : 0);
        } else if (operation === 4) {
            result = a & value;
            this.f = H;
        } else if (operation === 5) {
            result = a ^ value;
            this.f = 0;
        } else {
            result = a | value;
            this.f = 0;
        }
        result &= 255;
        if (result === 0) this.f |= Z;
        if (operation !== 7) this.r[7] = result;
    }

    rotate(operation, value, zero = true) {
        let carry = 0;
        let result;
        const old = this.f & C ? 1 : 0;
        switch (operation) {
            case 0:
                carry = value >>> 7;
                result = (value << 1) | carry;
                break;
            case 1:
                carry = value & 1;
                result = (value >>> 1) | (carry << 7);
                break;
            case 2:
                carry = value >>> 7;
                result = (value << 1) | old;
                break;
            case 3:
                carry = value & 1;
                result = (value >>> 1) | (old << 7);
                break;
            case 4:
                carry = value >>> 7;
                result = value << 1;
                break;
            case 5:
                carry = value & 1;
                result = (value >>> 1) | (value & 128);
                break;
            case 6:
                result = (value << 4) | (value >>> 4);
                break;
            case 7:
                carry = value & 1;
                result = value >>> 1;
                break;
        }
        result &= 255;
        this.f = (carry ? C : 0) | (zero && result === 0 ? Z : 0);
        return result;
    }

    step() {
        const pending = this.bus.ie & this.bus.io[15] & 31;
        if (pending) {
            this.halted = false;
            if (this.ime) {
                const bit = 31 - Math.clz32(pending & -pending);
                this.ime = false;
                this.bus.io[15] &= ~(1 << bit);
                this.push(this.pc);
                this.pc = 0x40 + bit * 8;
                return 20;
            }
        }
        if (this.halted) return 4;
        const opcode = this.fetch();
        if (this.haltBug) {
            this.pc = (this.pc - 1) & 0xffff;
            this.haltBug = false;
        }
        this.instructions += 1;
        const cycles = this.execute(opcode);
        if (this.eiDelay && --this.eiDelay === 0) this.ime = true;
        return cycles;
    }

    execute(op) {
        const x = op >>> 6;
        const y = (op >>> 3) & 7;
        const z = op & 7;
        const p = y >>> 1;
        const q = y & 1;
        if (x === 1) {
            if (op === 0x76) {
                if (!this.ime && this.bus.ie & this.bus.io[15] & 31) {
                    this.haltBug = true;
                } else this.halted = true;
                return 4;
            }
            this.write(y, this.read(z));
            return y === 6 || z === 6 ? 8 : 4;
        }
        if (x === 2) {
            this.alu(y, this.read(z));
            return z === 6 ? 8 : 4;
        }
        if (x === 0) {
            switch (z) {
                case 0:
                    if (y === 0) return 4;
                    if (y === 1) {
                        const address = this.word();
                        this.bus.write(address, this.sp & 255);
                        this.bus.write((address + 1) & 0xffff, this.sp >>> 8);
                        return 20;
                    }
                    if (y === 2) {
                        this.fetch();
                        if (this.bus.color && this.bus.io[0x4d] & 1) {
                            this.bus.doubleSpeed = !this.bus.doubleSpeed;
                            this.bus.io[0x4d] = this.bus.doubleSpeed ? 0x80 : 0;
                            this.bus.div = 0;
                        } else this.halted = true;
                        return 4;
                    }
                    {
                        const offset = (this.fetch() << 24) >> 24;
                        if (y === 3 || this.condition(y - 4)) {
                            this.pc = (this.pc + offset) & 0xffff;
                            return 12;
                        }
                        return 8;
                    }
                case 1:
                    if (!q) {
                        this.setPair(p, this.word());
                        return 12;
                    }
                    {
                        const hl = this.pair(2),
                            value = this.pair(p);
                        this.f =
                            (this.f & Z) |
                            ((hl & 0xfff) + (value & 0xfff) > 0xfff ? H : 0) |
                            (hl + value > 0xffff ? C : 0);
                        this.setPair(2, hl + value);
                        return 8;
                    }
                case 2: {
                    const address = this.pair(p < 2 ? p : 2);
                    if (q) this.r[7] = this.bus.read(address);
                    else this.bus.write(address, this.r[7]);
                    if (p >= 2) this.setPair(2, address + (p === 2 ? 1 : -1));
                    return 8;
                }
                case 3:
                    this.setPair(p, this.pair(p) + (q ? -1 : 1));
                    return 8;
                case 4: {
                    const value = this.read(y),
                        result = (value + 1) & 255;
                    this.f =
                        (this.f & C) |
                        (result === 0 ? Z : 0) |
                        ((value & 15) === 15 ? H : 0);
                    this.write(y, result);
                    return y === 6 ? 12 : 4;
                }
                case 5: {
                    const value = this.read(y),
                        result = (value - 1) & 255;
                    this.f =
                        (this.f & C) |
                        N |
                        (result === 0 ? Z : 0) |
                        ((value & 15) === 0 ? H : 0);
                    this.write(y, result);
                    return y === 6 ? 12 : 4;
                }
                case 6:
                    this.write(y, this.fetch());
                    return y === 6 ? 12 : 8;
                case 7:
                    if (y < 4) this.r[7] = this.rotate(y, this.r[7], false);
                    else if (y === 4) {
                        let correction = 0;
                        let carry = this.f & C;
                        if (!(this.f & N)) {
                            if (carry || this.r[7] > 0x99) {
                                correction |= 0x60;
                                carry = C;
                            }
                            if (this.f & H || (this.r[7] & 15) > 9) {
                                correction |= 6;
                            }
                            this.r[7] += correction;
                        } else {
                            if (carry) correction |= 0x60;
                            if (this.f & H) correction |= 6;
                            this.r[7] -= correction;
                        }
                        this.f =
                            (this.f & N) | carry | (this.r[7] === 0 ? Z : 0);
                    } else if (y === 5) {
                        this.r[7] ^= 255;
                        this.f |= N | H;
                    } else if (y === 6) this.f = (this.f & Z) | C;
                    else this.f = (this.f & Z) | (this.f & C ? 0 : C);
                    return 4;
            }
        }
        switch (z) {
            case 0:
                if (y < 4) {
                    if (this.condition(y)) {
                        this.pc = this.pop();
                        return 20;
                    }
                    return 8;
                }
                if (y === 4) {
                    this.bus.write(0xff00 | this.fetch(), this.r[7]);
                    return 12;
                }
                if (y === 6) {
                    this.r[7] = this.bus.read(0xff00 | this.fetch());
                    return 12;
                }
                {
                    const raw = this.fetch(),
                        signed = (raw << 24) >> 24;
                    this.f =
                        ((this.sp & 15) + (raw & 15) > 15 ? H : 0) |
                        ((this.sp & 255) + raw > 255 ? C : 0);
                    const result = (this.sp + signed) & 0xffff;
                    if (y === 5) this.sp = result;
                    else this.setPair(2, result);
                    return y === 5 ? 16 : 12;
                }
            case 1:
                if (!q) {
                    const value = this.pop();
                    if (p === 3) {
                        this.r[7] = value >>> 8;
                        this.f = value & 0xf0;
                    } else this.setPair(p, value);
                    return 12;
                }
                if (p <= 1) {
                    this.pc = this.pop();
                    if (p === 1) {
                        this.ime = true;
                        this.eiDelay = 0;
                    }
                    return 16;
                }
                if (p === 2) {
                    this.pc = this.pair(2);
                    return 4;
                }
                this.sp = this.pair(2);
                return 8;
            case 2:
                if (y < 4) {
                    const address = this.word();
                    if (this.condition(y)) {
                        this.pc = address;
                        return 16;
                    }
                    return 12;
                }
                if (y === 4) this.bus.write(0xff00 | this.r[1], this.r[7]);
                if (y === 5) this.bus.write(this.word(), this.r[7]);
                if (y === 6) this.r[7] = this.bus.read(0xff00 | this.r[1]);
                if (y === 7) this.r[7] = this.bus.read(this.word());
                return y & 1 ? 16 : 8;
            case 3:
                if (y === 0) {
                    this.pc = this.word();
                    return 16;
                }
                if (y === 1) {
                    const cb = this.fetch(),
                        target = cb & 7;
                    const operation = (cb >>> 3) & 7,
                        group = cb >>> 6;
                    const value = this.read(target);
                    if (group === 0)
                        this.write(target, this.rotate(operation, value));
                    if (group === 1)
                        this.f =
                            (this.f & C) |
                            H |
                            (value & (1 << operation) ? 0 : Z);
                    if (group === 2)
                        this.write(target, value & ~(1 << operation));
                    if (group === 3)
                        this.write(target, value | (1 << operation));
                    return target === 6 ? (group === 1 ? 12 : 16) : 8;
                }
                if (y === 6) {
                    this.ime = false;
                    this.eiDelay = 0;
                    return 4;
                }
                if (y === 7) {
                    this.eiDelay = 2;
                    return 4;
                }
                break;
            case 4:
                if (y < 4) {
                    const address = this.word();
                    if (this.condition(y)) {
                        this.push(this.pc);
                        this.pc = address;
                        return 24;
                    }
                    return 12;
                }
                break;
            case 5:
                if (!q) {
                    this.push(
                        p === 3 ? (this.r[7] << 8) | this.f : this.pair(p),
                    );
                    return 16;
                }
                if (p === 0) {
                    const address = this.word();
                    this.push(this.pc);
                    this.pc = address;
                    return 24;
                }
                break;
            case 6:
                this.alu(y, this.fetch());
                return 8;
            case 7:
                this.push(this.pc);
                this.pc = y * 8;
                return 16;
        }
        throw new Error(
            `Illegal SM83 opcode 0x${op.toString(16)} at ` +
                `0x${((this.pc - 1) & 0xffff).toString(16)}`,
        );
    }
}

export { SM83 };
