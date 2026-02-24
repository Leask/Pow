const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_B = 0x10;
const FLAG_U = 0x20;
const FLAG_V = 0x40;
const FLAG_N = 0x80;

class CPU6502 {
    constructor(bus, options = {}) {
        this.bus = bus;
        this.strictOpcodes = options.strictOpcodes ?? false;
        this.unknownOpcodes = new Map();
        this.reset();
    }

    reset() {
        this.A = 0;
        this.X = 0;
        this.Y = 0;
        this.SP = 0xfd;
        this.P = FLAG_U | FLAG_I;
        this.PC = this.#read16(0xfffc);
        this.totalCycles = 7;
    }

    step() {
        if (this.bus.pollNMI()) {
            return this.#interrupt(0xfffa, false);
        }

        if (this.bus.pollIRQ() && !this.#flag(FLAG_I)) {
            return this.#interrupt(0xfffe, false);
        }

        const opcode = this.#read(this.PC);
        this.PC = (this.PC + 1) & 0xffff;
        const cycles = this.#execute(opcode);
        this.totalCycles += cycles;
        return cycles;
    }

    #execute(opcode) {
        const cc = opcode & 0x03;

        if (cc === 0x01) {
            return this.#executeGroup1(opcode);
        }

        if (cc === 0x02) {
            const cycles = this.#executeGroup2(opcode);

            if (cycles !== null) {
                return cycles;
            }
        }

        switch (opcode) {
        case 0x00:
            this.PC = (this.PC + 1) & 0xffff;
            this.#push16(this.PC);
            this.#push(this.P | FLAG_B | FLAG_U);
            this.#setFlag(FLAG_I, true);
            this.PC = this.#read16(0xfffe);
            return 7;
        case 0x20: {
            const target = this.#addrAbsolute();
            this.#push16((this.PC - 1) & 0xffff);
            this.PC = target;
            return 6;
        }
        case 0x40:
            this.P = (this.#pop() & ~FLAG_B) | FLAG_U;
            this.PC = this.#pop16();
            return 6;
        case 0x60:
            this.PC = (this.#pop16() + 1) & 0xffff;
            return 6;
        case 0x08:
            this.#push(this.P | FLAG_B | FLAG_U);
            return 3;
        case 0x28:
            this.P = (this.#pop() & ~FLAG_B) | FLAG_U;
            return 4;
        case 0x48:
            this.#push(this.A);
            return 3;
        case 0x68:
            this.A = this.#pop();
            this.#setZN(this.A);
            return 4;
        case 0x10:
            return this.#branch(!this.#flag(FLAG_N));
        case 0x30:
            return this.#branch(this.#flag(FLAG_N));
        case 0x50:
            return this.#branch(!this.#flag(FLAG_V));
        case 0x70:
            return this.#branch(this.#flag(FLAG_V));
        case 0x90:
            return this.#branch(!this.#flag(FLAG_C));
        case 0xb0:
            return this.#branch(this.#flag(FLAG_C));
        case 0xd0:
            return this.#branch(!this.#flag(FLAG_Z));
        case 0xf0:
            return this.#branch(this.#flag(FLAG_Z));
        case 0x18:
            this.#setFlag(FLAG_C, false);
            return 2;
        case 0x38:
            this.#setFlag(FLAG_C, true);
            return 2;
        case 0x58:
            this.#setFlag(FLAG_I, false);
            return 2;
        case 0x78:
            this.#setFlag(FLAG_I, true);
            return 2;
        case 0xb8:
            this.#setFlag(FLAG_V, false);
            return 2;
        case 0xd8:
            this.#setFlag(FLAG_D, false);
            return 2;
        case 0xf8:
            this.#setFlag(FLAG_D, true);
            return 2;
        case 0x4c:
            this.PC = this.#addrAbsolute();
            return 3;
        case 0x6c:
            this.PC = this.#read16Bug(this.#addrAbsolute());
            return 5;
        case 0x24:
            this.#bit(this.#read(this.#addrZeroPage()));
            return 3;
        case 0x2c:
            this.#bit(this.#read(this.#addrAbsolute()));
            return 4;
        case 0x84:
            this.#write(this.#addrZeroPage(), this.Y);
            return 3;
        case 0x94:
            this.#write(this.#addrZeroPageX(), this.Y);
            return 4;
        case 0x8c:
            this.#write(this.#addrAbsolute(), this.Y);
            return 4;
        case 0xa0:
            this.Y = this.#readImmediate();
            this.#setZN(this.Y);
            return 2;
        case 0xa4:
            this.Y = this.#read(this.#addrZeroPage());
            this.#setZN(this.Y);
            return 3;
        case 0xb4:
            this.Y = this.#read(this.#addrZeroPageX());
            this.#setZN(this.Y);
            return 4;
        case 0xac:
            this.Y = this.#read(this.#addrAbsolute());
            this.#setZN(this.Y);
            return 4;
        case 0xbc: {
            const resolved = this.#addrAbsoluteX();
            this.Y = this.#read(resolved.address);
            this.#setZN(this.Y);
            return 4 + (resolved.pageCross ? 1 : 0);
        }
        case 0xc0:
            this.#compare(this.Y, this.#readImmediate());
            return 2;
        case 0xc4:
            this.#compare(this.Y, this.#read(this.#addrZeroPage()));
            return 3;
        case 0xcc:
            this.#compare(this.Y, this.#read(this.#addrAbsolute()));
            return 4;
        case 0xe0:
            this.#compare(this.X, this.#readImmediate());
            return 2;
        case 0xe4:
            this.#compare(this.X, this.#read(this.#addrZeroPage()));
            return 3;
        case 0xec:
            this.#compare(this.X, this.#read(this.#addrAbsolute()));
            return 4;
        case 0x88:
            this.Y = (this.Y - 1) & 0xff;
            this.#setZN(this.Y);
            return 2;
        case 0xa8:
            this.Y = this.A;
            this.#setZN(this.Y);
            return 2;
        case 0xc8:
            this.Y = (this.Y + 1) & 0xff;
            this.#setZN(this.Y);
            return 2;
        case 0xe8:
            this.X = (this.X + 1) & 0xff;
            this.#setZN(this.X);
            return 2;
        case 0x8a:
            this.A = this.X;
            this.#setZN(this.A);
            return 2;
        case 0x9a:
            this.SP = this.X;
            return 2;
        case 0xaa:
            this.X = this.A;
            this.#setZN(this.X);
            return 2;
        case 0xba:
            this.X = this.SP;
            this.#setZN(this.X);
            return 2;
        case 0x98:
            this.A = this.Y;
            this.#setZN(this.A);
            return 2;
        case 0xca:
            this.X = (this.X - 1) & 0xff;
            this.#setZN(this.X);
            return 2;
        case 0xea:
            return 2;
        case 0xeb:
            this.#sbc(this.#readImmediate());
            return 2;
        case 0x1a:
        case 0x3a:
        case 0x5a:
        case 0x7a:
        case 0xda:
        case 0xfa:
            return 2;
        case 0x80:
        case 0x82:
        case 0x89:
        case 0xc2:
        case 0xe2:
            this.#readImmediate();
            return 2;
        case 0x04:
        case 0x44:
        case 0x64:
            this.#read(this.#addrZeroPage());
            return 3;
        case 0x14:
        case 0x34:
        case 0x54:
        case 0x74:
        case 0xd4:
        case 0xf4:
            this.#read(this.#addrZeroPageX());
            return 4;
        case 0x0c:
            this.#read(this.#addrAbsolute());
            return 4;
        case 0x1c:
        case 0x3c:
        case 0x5c:
        case 0x7c:
        case 0xdc:
        case 0xfc: {
            const resolved = this.#addrAbsoluteX();
            this.#read(resolved.address);
            return 4 + (resolved.pageCross ? 1 : 0);
        }
        default:
            return this.#illegal(opcode, 2);
        }
    }

    #executeGroup1(opcode) {
        const operation = opcode >> 5;
        const mode = (opcode >> 2) & 0x07;
        const isStore = operation === 0x04;
        const readCycles = [6, 3, 2, 4, 5, 4, 4, 4];
        const storeCycles = [6, 3, 2, 4, 6, 4, 5, 5];
        let resolved = null;

        if (mode === 0) {
            resolved = { address: this.#addrIndirectX(), pageCross: false };
        } else if (mode === 1) {
            resolved = { address: this.#addrZeroPage(), pageCross: false };
        } else if (mode === 2) {
            resolved = {
                address: this.#addrImmediateAddress(),
                pageCross: false,
            };
        } else if (mode === 3) {
            resolved = { address: this.#addrAbsolute(), pageCross: false };
        } else if (mode === 4) {
            resolved = this.#addrIndirectY();
        } else if (mode === 5) {
            resolved = { address: this.#addrZeroPageX(), pageCross: false };
        } else if (mode === 6) {
            resolved = this.#addrAbsoluteY();
        } else if (mode === 7) {
            resolved = this.#addrAbsoluteX();
        }

        if (!resolved) {
            return this.#illegal(opcode, 2);
        }

        if (isStore && mode === 2) {
            this.#readImmediate();
            return 2;
        }

        let cycles = isStore ? storeCycles[mode] : readCycles[mode];

        if (operation === 0x00) {
            this.A |= this.#read(resolved.address);
            this.#setZN(this.A);
        } else if (operation === 0x01) {
            this.A &= this.#read(resolved.address);
            this.#setZN(this.A);
        } else if (operation === 0x02) {
            this.A ^= this.#read(resolved.address);
            this.#setZN(this.A);
        } else if (operation === 0x03) {
            this.#adc(this.#read(resolved.address));
        } else if (operation === 0x04) {
            this.#write(resolved.address, this.A);
        } else if (operation === 0x05) {
            this.A = this.#read(resolved.address);
            this.#setZN(this.A);
        } else if (operation === 0x06) {
            this.#compare(this.A, this.#read(resolved.address));
        } else if (operation === 0x07) {
            this.#sbc(this.#read(resolved.address));
        }

        if (
            !isStore &&
            resolved.pageCross &&
            (mode === 4 || mode === 6 || mode === 7)
        ) {
            cycles += 1;
        }

        return cycles;
    }

    #executeGroup2(opcode) {
        const operation = opcode >> 5;
        const mode = (opcode >> 2) & 0x07;

        if (operation <= 0x03) {
            return this.#executeShift(operation, mode, opcode);
        }

        if (operation === 0x04) {
            if (mode === 1) {
                this.#write(this.#addrZeroPage(), this.X);
                return 3;
            }

            if (mode === 5) {
                this.#write(this.#addrZeroPageY(), this.X);
                return 4;
            }

            if (mode === 3) {
                this.#write(this.#addrAbsolute(), this.X);
                return 4;
            }

            return null;
        }

        if (operation === 0x05) {
            if (mode === 0) {
                this.X = this.#readImmediate();
                this.#setZN(this.X);
                return 2;
            }

            if (mode === 1) {
                this.X = this.#read(this.#addrZeroPage());
                this.#setZN(this.X);
                return 3;
            }

            if (mode === 5) {
                this.X = this.#read(this.#addrZeroPageY());
                this.#setZN(this.X);
                return 4;
            }

            if (mode === 3) {
                this.X = this.#read(this.#addrAbsolute());
                this.#setZN(this.X);
                return 4;
            }

            if (mode === 7) {
                const resolved = this.#addrAbsoluteY();
                this.X = this.#read(resolved.address);
                this.#setZN(this.X);
                return 4 + (resolved.pageCross ? 1 : 0);
            }

            return null;
        }

        if (operation === 0x06 || operation === 0x07) {
            const increase = operation === 0x07;
            let address = null;
            let cycles = 0;

            if (mode === 1) {
                address = this.#addrZeroPage();
                cycles = 5;
            } else if (mode === 5) {
                address = this.#addrZeroPageX();
                cycles = 6;
            } else if (mode === 3) {
                address = this.#addrAbsolute();
                cycles = 6;
            } else if (mode === 7) {
                address = this.#addrAbsoluteX().address;
                cycles = 7;
            } else {
                return null;
            }

            const value = this.#read(address);
            const next = increase
                ? ((value + 1) & 0xff)
                : ((value - 1) & 0xff);
            this.#write(address, next);
            this.#setZN(next);
            return cycles;
        }

        return null;
    }

    #executeShift(operation, mode, opcode) {
        const isAccumulator = mode === 2;
        let address = null;
        let cycles = 0;

        if (isAccumulator) {
            cycles = 2;
        } else if (mode === 1) {
            address = this.#addrZeroPage();
            cycles = 5;
        } else if (mode === 5) {
            address = this.#addrZeroPageX();
            cycles = 6;
        } else if (mode === 3) {
            address = this.#addrAbsolute();
            cycles = 6;
        } else if (mode === 7) {
            address = this.#addrAbsoluteX().address;
            cycles = 7;
        } else {
            return null;
        }

        const source = isAccumulator ? this.A : this.#read(address);
        let result = source;

        if (operation === 0x00) {
            this.#setFlag(FLAG_C, (source & 0x80) !== 0);
            result = (source << 1) & 0xff;
        } else if (operation === 0x01) {
            const carryIn = this.#flag(FLAG_C) ? 1 : 0;
            this.#setFlag(FLAG_C, (source & 0x80) !== 0);
            result = ((source << 1) | carryIn) & 0xff;
        } else if (operation === 0x02) {
            this.#setFlag(FLAG_C, (source & 0x01) !== 0);
            result = (source >> 1) & 0xff;
        } else if (operation === 0x03) {
            const carryIn = this.#flag(FLAG_C) ? 0x80 : 0;
            this.#setFlag(FLAG_C, (source & 0x01) !== 0);
            result = ((source >> 1) | carryIn) & 0xff;
        } else {
            return this.#illegal(opcode, 2);
        }

        if (isAccumulator) {
            this.A = result;
        } else {
            this.#write(address, result);
        }

        this.#setZN(result);
        return cycles;
    }

    #read(address) {
        return this.bus.read(address) & 0xff;
    }

    #write(address, value) {
        this.bus.write(address, value & 0xff);
    }

    #read16(address) {
        const low = this.#read(address);
        const high = this.#read((address + 1) & 0xffff);
        return low | (high << 8);
    }

    #read16Bug(address) {
        const low = this.#read(address);
        const highAddress = (address & 0xff00) | ((address + 1) & 0x00ff);
        const high = this.#read(highAddress);
        return low | (high << 8);
    }

    #addrImmediateAddress() {
        const address = this.PC;
        this.PC = (this.PC + 1) & 0xffff;
        return address;
    }

    #readImmediate() {
        return this.#read(this.#addrImmediateAddress());
    }

    #addrZeroPage() {
        return this.#readImmediate();
    }

    #addrZeroPageX() {
        return (this.#readImmediate() + this.X) & 0xff;
    }

    #addrZeroPageY() {
        return (this.#readImmediate() + this.Y) & 0xff;
    }

    #addrAbsolute() {
        const low = this.#readImmediate();
        const high = this.#readImmediate();
        return low | (high << 8);
    }

    #addrAbsoluteX() {
        const base = this.#addrAbsolute();
        const address = (base + this.X) & 0xffff;
        return {
            address,
            pageCross: (base & 0xff00) !== (address & 0xff00),
        };
    }

    #addrAbsoluteY() {
        const base = this.#addrAbsolute();
        const address = (base + this.Y) & 0xffff;
        return {
            address,
            pageCross: (base & 0xff00) !== (address & 0xff00),
        };
    }

    #addrIndirectX() {
        const zeroPage = (this.#readImmediate() + this.X) & 0xff;
        const low = this.#read(zeroPage);
        const high = this.#read((zeroPage + 1) & 0xff);
        return low | (high << 8);
    }

    #addrIndirectY() {
        const zeroPage = this.#readImmediate() & 0xff;
        const low = this.#read(zeroPage);
        const high = this.#read((zeroPage + 1) & 0xff);
        const base = low | (high << 8);
        const address = (base + this.Y) & 0xffff;
        return {
            address,
            pageCross: (base & 0xff00) !== (address & 0xff00),
        };
    }

    #setZN(value) {
        const byte = value & 0xff;
        this.#setFlag(FLAG_Z, byte === 0);
        this.#setFlag(FLAG_N, (byte & 0x80) !== 0);
    }

    #flag(mask) {
        return (this.P & mask) !== 0;
    }

    #setFlag(mask, enabled) {
        if (enabled) {
            this.P |= mask;
        } else {
            this.P &= (~mask) & 0xff;
        }
    }

    #adc(value) {
        const operand = value & 0xff;
        const carryIn = this.#flag(FLAG_C) ? 1 : 0;
        const sum = this.A + operand + carryIn;
        const result = sum & 0xff;

        this.#setFlag(FLAG_C, sum > 0xff);
        this.#setFlag(
            FLAG_V,
            ((~(this.A ^ operand) & (this.A ^ result)) & 0x80) !== 0,
        );
        this.A = result;
        this.#setZN(this.A);
    }

    #sbc(value) {
        this.#adc((value ^ 0xff) & 0xff);
    }

    #compare(register, value) {
        const result = (register - value) & 0x1ff;
        this.#setFlag(FLAG_C, register >= value);
        this.#setFlag(FLAG_Z, (result & 0xff) === 0);
        this.#setFlag(FLAG_N, (result & 0x80) !== 0);
    }

    #bit(value) {
        const byte = value & 0xff;
        this.#setFlag(FLAG_Z, (this.A & byte) === 0);
        this.#setFlag(FLAG_V, (byte & 0x40) !== 0);
        this.#setFlag(FLAG_N, (byte & 0x80) !== 0);
    }

    #branch(condition) {
        const offsetByte = this.#readImmediate();
        const offset = offsetByte < 0x80
            ? offsetByte
            : offsetByte - 0x100;
        let cycles = 2;

        if (!condition) {
            return cycles;
        }

        const previous = this.PC;
        this.PC = (this.PC + offset) & 0xffff;
        cycles += 1;

        if ((previous & 0xff00) !== (this.PC & 0xff00)) {
            cycles += 1;
        }

        return cycles;
    }

    #push(value) {
        this.#write(0x0100 | this.SP, value);
        this.SP = (this.SP - 1) & 0xff;
    }

    #pop() {
        this.SP = (this.SP + 1) & 0xff;
        return this.#read(0x0100 | this.SP);
    }

    #push16(value) {
        this.#push((value >> 8) & 0xff);
        this.#push(value & 0xff);
    }

    #pop16() {
        const low = this.#pop();
        const high = this.#pop();
        return low | (high << 8);
    }

    #interrupt(vector, isBreak) {
        this.#push16(this.PC);
        this.#push((this.P & ~FLAG_B) | FLAG_U | (isBreak ? FLAG_B : 0));
        this.#setFlag(FLAG_I, true);
        this.PC = this.#read16(vector);
        this.totalCycles += 7;
        return 7;
    }

    #illegal(opcode, cycles) {
        if (this.strictOpcodes) {
            const programCounter = (this.PC - 1) & 0xffff;
            throw new Error(
                `Unsupported opcode 0x${opcode.toString(16)} ` +
                `at 0x${programCounter.toString(16)}`,
            );
        }

        const count = this.unknownOpcodes.get(opcode) ?? 0;
        this.unknownOpcodes.set(opcode, count + 1);
        return cycles;
    }

    saveState() {
        return {
            A: this.A,
            X: this.X,
            Y: this.Y,
            SP: this.SP,
            P: this.P,
            PC: this.PC,
            totalCycles: this.totalCycles,
            unknownOpcodes: Array.from(this.unknownOpcodes.entries()),
        };
    }

    loadState(state) {
        this.A = state.A & 0xff;
        this.X = state.X & 0xff;
        this.Y = state.Y & 0xff;
        this.SP = state.SP & 0xff;
        this.P = (state.P | FLAG_U) & 0xff;
        this.PC = state.PC & 0xffff;
        this.totalCycles = state.totalCycles >>> 0;
        this.unknownOpcodes = new Map(state.unknownOpcodes);
    }
}

export {
    CPU6502,
};
