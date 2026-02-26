const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_X = 0x10;
const FLAG_M = 0x20;
const FLAG_V = 0x40;
const FLAG_N = 0x80;

function toSigned8(value) {
    return value & 0x80 ? value - 0x100 : value;
}

class CPU65816 {
    constructor(bus, options = {}) {
        this.bus = bus;
        this.strictOpcodes = options.strictOpcodes ?? false;
        this.unknownOpcodes = new Map();
        this.reset();
    }

    reset() {
        this.A = 0x0000;
        this.X = 0x0000;
        this.Y = 0x0000;
        this.SP = 0x01ff;
        this.D = 0x0000;
        this.DBR = 0x00;
        this.PBR = 0x00;
        this.P = FLAG_I | FLAG_M | FLAG_X;
        this.E = true;
        this.PC = this.#read16Bank0(0xfffc);
        this.totalCycles = 7;
    }

    step() {
        if (this.bus.pollNMI()) {
            const cycles = this.#interrupt(true);
            this.totalCycles += cycles;
            return cycles;
        }

        if (!this.#flag(FLAG_I) && this.bus.pollIRQ()) {
            const cycles = this.#interrupt(false);
            this.totalCycles += cycles;
            return cycles;
        }

        const opcode = this.#fetch8();
        const cycles = this.#execute(opcode);
        this.totalCycles += cycles;
        return cycles;
    }

    saveState() {
        return {
            A: this.A,
            X: this.X,
            Y: this.Y,
            SP: this.SP,
            D: this.D,
            DBR: this.DBR,
            PBR: this.PBR,
            P: this.P,
            E: this.E,
            PC: this.PC,
            totalCycles: this.totalCycles,
            unknownOpcodes: Array.from(this.unknownOpcodes.entries()),
        };
    }

    loadState(state) {
        this.A = state.A & 0xffff;
        this.X = state.X & 0xffff;
        this.Y = state.Y & 0xffff;
        this.SP = state.SP & 0xffff;
        this.D = state.D & 0xffff;
        this.DBR = state.DBR & 0xff;
        this.PBR = state.PBR & 0xff;
        this.P = state.P & 0xff;
        this.E = Boolean(state.E);
        this.PC = state.PC & 0xffff;
        this.totalCycles = state.totalCycles >>> 0;
        this.unknownOpcodes = new Map(state.unknownOpcodes ?? []);
        this.#normalizeFlagsAndRegisters();
    }

    #execute(opcode) {
        switch (opcode) {
        case 0x00:
            return this.#brk();
        case 0x04:
            this.#tsb(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0x05:
            this.#ora(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0x06:
            this.#aslMemory(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0x07:
            this.#ora(this.#readDataByWidth(this.#addrDirectIndirectLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0x08:
            this.#push8(this.P | (this.E ? 0x30 : 0x00));
            return 3;
        case 0x09:
            this.#ora(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0x0a:
            this.#aslAccumulator();
            return this.#memory8() ? 2 : 3;
        case 0x0b:
            this.#push16(this.D);
            return 4;
        case 0x0d:
            this.#ora(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0x0c:
            this.#tsb(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0x0e:
            this.#aslMemory(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0x10:
            return this.#branch(!this.#flag(FLAG_N));
        case 0x14:
            this.#trb(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0x15:
            this.#ora(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0x18:
            this.#setFlag(FLAG_C, false);
            return 2;
        case 0x19:
            this.#ora(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0x16:
            this.#aslMemory(this.#addrDirectXData());
            return this.#memory8() ? 6 : 8;
        case 0x17:
            this.#ora(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0x1e:
            this.#aslMemory(this.#addrAbsoluteXData());
            return this.#memory8() ? 7 : 9;
        case 0x1d:
            this.#ora(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0x1f:
            this.#ora(this.#readDataByWidth(this.#addrLongX(), true));
            return this.#memory8() ? 5 : 6;
        case 0x1c:
            this.#trb(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0x1a:
            this.#incAccumulator();
            return this.#memory8() ? 2 : 3;
        case 0x1b:
            this.SP = this.E ? ((this.A & 0xff) | 0x0100) : (this.A & 0xffff);
            return 2;
        case 0x20: {
            const target = this.#fetch16();
            this.#push16((this.PC - 1) & 0xffff);
            this.PC = target;
            return 6;
        }
        case 0x25:
            this.#and(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0x26:
            this.#rolMemory(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0x27:
            this.#and(this.#readDataByWidth(this.#addrDirectIndirectLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0x22: {
            const target = this.#fetch24();
            this.#push8(this.PBR);
            this.#push16((this.PC - 1) & 0xffff);
            this.PBR = (target >>> 16) & 0xff;
            this.PC = target & 0xffff;
            return 8;
        }
        case 0x28:
            this.P = this.#pop8();
            this.#normalizeFlagsAndRegisters();
            return 4;
        case 0x24:
            this.#bitMemory(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0x29:
            this.#and(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0x2a:
            this.#rolAccumulator();
            return this.#memory8() ? 2 : 3;
        case 0x2c:
            this.#bitMemory(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0x30:
            return this.#branch(this.#flag(FLAG_N));
        case 0x34:
            this.#bitMemory(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0x35:
            this.#and(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0x36:
            this.#rolMemory(this.#addrDirectXData());
            return this.#memory8() ? 6 : 8;
        case 0x37:
            this.#and(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0x38:
            this.#setFlag(FLAG_C, true);
            return 2;
        case 0x3a:
            this.#decAccumulator();
            return this.#memory8() ? 2 : 3;
        case 0x40:
            return this.#rti();
        case 0x44:
            return this.#blockMove(false);
        case 0x2d:
            this.#and(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0x2e:
            this.#rolMemory(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0x2f:
            this.#and(this.#readDataByWidth(this.#addrLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0x45:
            this.#eor(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0x46:
            this.#lsrMemory(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0x47:
            this.#eor(this.#readDataByWidth(this.#addrDirectIndirectLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0x48:
            this.#pushAByWidth();
            return this.#memory8() ? 3 : 4;
        case 0x49:
            this.#eor(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0x4a:
            this.#lsrAccumulator();
            return this.#memory8() ? 2 : 3;
        case 0x4b:
            this.#push8(this.PBR);
            return 3;
        case 0x4c:
            this.PC = this.#fetch16();
            return 3;
        case 0x4d:
            this.#eor(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0x4e:
            this.#lsrMemory(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0x50:
            return this.#branch(!this.#flag(FLAG_V));
        case 0x54:
            return this.#blockMove(true);
        case 0x39:
            this.#and(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0x3d:
            this.#and(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0x3e:
            this.#rolMemory(this.#addrAbsoluteXData());
            return this.#memory8() ? 7 : 9;
        case 0x3f:
            this.#and(this.#readDataByWidth(this.#addrLongX(), true));
            return this.#memory8() ? 5 : 6;
        case 0x3c:
            this.#bitMemory(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0x58:
            this.#setFlag(FLAG_I, false);
            return 2;
        case 0x55:
            this.#eor(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0x56:
            this.#lsrMemory(this.#addrDirectXData());
            return this.#memory8() ? 6 : 8;
        case 0x57:
            this.#eor(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0x59:
            this.#eor(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0x5a:
            this.#pushYByWidth();
            return this.#index8() ? 3 : 4;
        case 0x5b:
            this.D = this.A & 0xffff;
            this.#setZN(this.D, 16);
            return 2;
        case 0x5c: {
            const target = this.#fetch24();
            this.PBR = (target >>> 16) & 0xff;
            this.PC = target & 0xffff;
            return 4;
        }
        case 0x5d:
            this.#eor(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0x5e:
            this.#lsrMemory(this.#addrAbsoluteXData());
            return this.#memory8() ? 7 : 9;
        case 0x60:
            this.PC = (this.#pop16() + 1) & 0xffff;
            return 6;
        case 0x62: {
            const displacement = this.#fetch16();
            const signed = displacement & 0x8000
                ? displacement - 0x10000
                : displacement;
            const value = (this.PC + signed) & 0xffff;
            this.#push16(value);
            return 6;
        }
        case 0x64:
            this.#writeByWidth(this.#addrDirectData(), 0);
            return this.#memory8() ? 3 : 4;
        case 0x65:
            this.#adc(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0x66:
            this.#rorMemory(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0x67:
            this.#adc(this.#readDataByWidth(this.#addrDirectIndirectLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0x68:
            this.#pullAByWidth();
            return this.#memory8() ? 4 : 5;
        case 0x69:
            this.#adc(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0x6a:
            this.#rorAccumulator();
            return this.#memory8() ? 2 : 3;
        case 0x6d:
            this.#adc(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0x6e:
            this.#rorMemory(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0x6f:
            this.#adc(this.#readDataByWidth(this.#addrLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0x6b:
            this.PC = (this.#pop16() + 1) & 0xffff;
            this.PBR = this.#pop8();
            return 6;
        case 0x70:
            return this.#branch(this.#flag(FLAG_V));
        case 0x74:
            this.#writeByWidth(this.#addrDirectXData(), 0);
            return this.#memory8() ? 4 : 5;
        case 0x76:
            this.#rorMemory(this.#addrDirectXData());
            return this.#memory8() ? 6 : 8;
        case 0x75:
            this.#adc(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0x77:
            this.#adc(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0x7a:
            this.#pullYByWidth();
            return this.#index8() ? 4 : 5;
        case 0x78:
            this.#setFlag(FLAG_I, true);
            return 2;
        case 0x79:
            this.#adc(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0x7d:
            this.#adc(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0x7e:
            this.#rorMemory(this.#addrAbsoluteXData());
            return this.#memory8() ? 7 : 9;
        case 0x7f:
            this.#adc(this.#readDataByWidth(this.#addrLongX(), true));
            return this.#memory8() ? 5 : 6;
        case 0x80:
            return this.#branch(true);
        case 0x82: {
            const displacement = this.#fetch16();
            const signed = displacement & 0x8000
                ? displacement - 0x10000
                : displacement;
            this.PC = (this.PC + signed) & 0xffff;
            return 4;
        }
        case 0x84:
            this.#writeIndexByWidth(this.#addrDirectData(), this.Y);
            return this.#index8() ? 3 : 4;
        case 0x85:
            this.#writeByWidth(this.#addrDirectData(), this.#accumulatorValue());
            return this.#memory8() ? 3 : 4;
        case 0x86:
            this.#writeIndexByWidth(this.#addrDirectData(), this.X);
            return this.#index8() ? 3 : 4;
        case 0x88:
            this.#decrementY();
            return 2;
        case 0x8a:
            this.#transferXToA();
            return 2;
        case 0x8b:
            this.#push8(this.DBR);
            return 3;
        case 0x8c:
            this.#writeIndexByWidth(this.#addrAbsoluteData(), this.Y);
            return this.#index8() ? 4 : 5;
        case 0x8d:
            this.#writeByWidth(this.#addrAbsoluteData(), this.#accumulatorValue());
            return this.#memory8() ? 4 : 5;
        case 0x8e:
            this.#writeIndexByWidth(this.#addrAbsoluteData(), this.X);
            return this.#index8() ? 4 : 5;
        case 0x8f:
            this.#writeByWidth(this.#addrLong(), this.#accumulatorValue(), true);
            return this.#memory8() ? 5 : 6;
        case 0x90:
            return this.#branch(!this.#flag(FLAG_C));
        case 0x92:
            this.#writeByWidth(this.#addrDirectIndirect(), this.#accumulatorValue());
            return this.#memory8() ? 5 : 6;
        case 0x87:
            this.#writeByWidth(this.#addrDirectIndirectLong(), this.#accumulatorValue(), true);
            return this.#memory8() ? 5 : 6;
        case 0x98:
            this.#transferYToA();
            return 2;
        case 0x99:
            this.#writeByWidth(this.#addrAbsoluteYData(), this.#accumulatorValue());
            return this.#memory8() ? 5 : 6;
        case 0x97:
            this.#writeByWidth(
                this.#addrDirectIndirectLongY(),
                this.#accumulatorValue(),
                true,
            );
            return this.#memory8() ? 6 : 7;
        case 0x94:
            this.#writeIndexByWidth(this.#addrDirectXData(), this.Y);
            return this.#index8() ? 4 : 5;
        case 0x95:
            this.#writeByWidth(this.#addrDirectXData(), this.#accumulatorValue());
            return this.#memory8() ? 4 : 5;
        case 0x9c:
            this.#writeByWidth(this.#addrAbsoluteData(), 0);
            return this.#memory8() ? 4 : 5;
        case 0x9d:
            this.#writeByWidth(this.#addrAbsoluteXData(), this.#accumulatorValue());
            return this.#memory8() ? 5 : 6;
        case 0x9e:
            this.#writeByWidth(this.#addrAbsoluteXData(), 0);
            return this.#memory8() ? 5 : 6;
        case 0x9f:
            this.#writeByWidth(this.#addrLongX(), this.#accumulatorValue(), true);
            return this.#memory8() ? 5 : 6;
        case 0x9b:
            this.#transferXToY();
            return 2;
        case 0xa0:
            this.#loadY(this.#readImmediateIndexByWidth());
            return this.#index8() ? 2 : 3;
        case 0xa2:
            this.#loadX(this.#readImmediateIndexByWidth());
            return this.#index8() ? 2 : 3;
        case 0xa4:
            this.#loadY(this.#readIndexByWidth(this.#addrDirectData()));
            return this.#index8() ? 3 : 4;
        case 0xa5:
            this.#loadA(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0xa6:
            this.#loadX(this.#readIndexByWidth(this.#addrDirectData()));
            return this.#index8() ? 3 : 4;
        case 0xa7:
            this.#loadA(this.#readDataByWidth(this.#addrDirectIndirectLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0xa8:
            this.#transferAToY();
            return 2;
        case 0xa9:
            this.#loadA(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0xaa:
            this.#transferAToX();
            return 2;
        case 0xab:
            this.DBR = this.#pop8();
            this.#setZN(this.DBR, 8);
            return 4;
        case 0xac:
            this.#loadY(this.#readIndexByWidth(this.#addrAbsoluteData()));
            return this.#index8() ? 4 : 5;
        case 0xad:
            this.#loadA(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0xae:
            this.#loadX(this.#readIndexByWidth(this.#addrAbsoluteData()));
            return this.#index8() ? 4 : 5;
        case 0xaf:
            this.#loadA(this.#readDataByWidth(this.#addrLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0xb0:
            return this.#branch(this.#flag(FLAG_C));
        case 0xb1:
            this.#loadA(this.#readDataByWidth(this.#addrDirectIndirectY()));
            return this.#memory8() ? 5 : 6;
        case 0xb2:
            this.#loadA(this.#readDataByWidth(this.#addrDirectIndirect()));
            return this.#memory8() ? 5 : 6;
        case 0xbb:
            this.#transferYToX();
            return 2;
        case 0xb5:
            this.#loadA(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0xb3:
            this.#loadA(this.#readDataByWidth(this.#addrStackRelativeIndirectY()));
            return this.#memory8() ? 7 : 8;
        case 0xb4:
            this.#loadY(this.#readIndexByWidth(this.#addrDirectXData()));
            return this.#index8() ? 4 : 5;
        case 0xb7:
            this.#loadA(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0xb6:
            this.#loadX(this.#readIndexByWidth(this.#addrDirectYData()));
            return this.#index8() ? 4 : 5;
        case 0xb9:
            this.#loadA(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0xbd:
            this.#loadA(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0xbe:
            this.#loadX(this.#readIndexByWidth(this.#addrAbsoluteYData()));
            return this.#index8() ? 4 : 5;
        case 0xbc:
            this.#loadY(this.#readIndexByWidth(this.#addrAbsoluteXData()));
            return this.#index8() ? 4 : 5;
        case 0xbf:
            this.#loadA(this.#readDataByWidth(this.#addrLongX(), true));
            return this.#memory8() ? 5 : 6;
        case 0xc0:
            this.#compareY(this.#readImmediateIndexByWidth());
            return this.#index8() ? 2 : 3;
        case 0xc2:
            this.#rep(this.#fetch8());
            return 3;
        case 0xc4:
            this.#compareY(this.#readIndexByWidth(this.#addrDirectData()));
            return this.#index8() ? 3 : 4;
        case 0xc5:
            this.#compareA(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0xc6:
            this.#decrementMemory(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0xc8:
            this.#incrementY();
            return 2;
        case 0xc9:
            this.#compareA(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0xca:
            this.#decrementX();
            return 2;
        case 0xcc:
            this.#compareY(this.#readIndexByWidth(this.#addrAbsoluteData()));
            return this.#index8() ? 4 : 5;
        case 0xcd:
            this.#compareA(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0xcf:
            this.#compareA(this.#readDataByWidth(this.#addrLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0xce:
            this.#decrementMemory(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0xd0:
            return this.#branch(!this.#flag(FLAG_Z));
        case 0xd5:
            this.#compareA(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0xd6:
            this.#decrementMemory(this.#addrDirectXData());
            return this.#memory8() ? 6 : 8;
        case 0xd7:
            this.#compareA(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0xd9:
            this.#compareA(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0xda:
            this.#pushXByWidth();
            return this.#index8() ? 3 : 4;
        case 0xdd:
            this.#compareA(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0xde:
            this.#decrementMemory(this.#addrAbsoluteXData());
            return this.#memory8() ? 7 : 9;
        case 0xdf:
            this.#compareA(this.#readDataByWidth(this.#addrLongX(), true));
            return this.#memory8() ? 5 : 6;
        case 0xdc: {
            const pointer = this.#fetch16();
            const low = this.bus.read(pointer & 0xffff);
            const high = this.bus.read((pointer + 1) & 0xffff);
            const bank = this.bus.read((pointer + 2) & 0xffff);

            this.PC = low | (high << 8);
            this.PBR = bank & 0xff;
            return 6;
        }
        case 0xe0:
            this.#compareX(this.#readImmediateIndexByWidth());
            return this.#index8() ? 2 : 3;
        case 0xe2:
            this.#sep(this.#fetch8());
            return 3;
        case 0xe4:
            this.#compareX(this.#readIndexByWidth(this.#addrDirectData()));
            return this.#index8() ? 3 : 4;
        case 0xe5:
            this.#sbc(this.#readDataByWidth(this.#addrDirectData()));
            return this.#memory8() ? 3 : 4;
        case 0xe6:
            this.#incrementMemory(this.#addrDirectData());
            return this.#memory8() ? 5 : 7;
        case 0xe7:
            this.#sbc(this.#readDataByWidth(this.#addrDirectIndirectLong(), true));
            return this.#memory8() ? 5 : 6;
        case 0xe8:
            this.#incrementX();
            return 2;
        case 0xe9:
            this.#sbc(this.#readImmediateByWidth());
            return this.#memory8() ? 2 : 3;
        case 0xea:
            return 2;
        case 0xed:
            this.#sbc(this.#readDataByWidth(this.#addrAbsoluteData()));
            return this.#memory8() ? 4 : 5;
        case 0xec:
            this.#compareX(this.#readIndexByWidth(this.#addrAbsoluteData()));
            return this.#index8() ? 4 : 5;
        case 0xee:
            this.#incrementMemory(this.#addrAbsoluteData());
            return this.#memory8() ? 6 : 8;
        case 0xeb:
            this.#xba();
            return 3;
        case 0xf0:
            return this.#branch(this.#flag(FLAG_Z));
        case 0xf5:
            this.#sbc(this.#readDataByWidth(this.#addrDirectXData()));
            return this.#memory8() ? 4 : 5;
        case 0xf6:
            this.#incrementMemory(this.#addrDirectXData());
            return this.#memory8() ? 6 : 8;
        case 0xf7:
            this.#sbc(this.#readDataByWidth(this.#addrDirectIndirectLongY(), true));
            return this.#memory8() ? 6 : 7;
        case 0xf9:
            this.#sbc(this.#readDataByWidth(this.#addrAbsoluteYData()));
            return this.#memory8() ? 4 : 5;
        case 0xfb:
            this.#xce();
            return 2;
        case 0xfa:
            this.#pullXByWidth();
            return this.#index8() ? 4 : 5;
        case 0xfd:
            this.#sbc(this.#readDataByWidth(this.#addrAbsoluteXData()));
            return this.#memory8() ? 4 : 5;
        case 0xff:
            this.#sbc(this.#readDataByWidth(this.#addrLongX(), true));
            return this.#memory8() ? 5 : 6;
        case 0xfe:
            this.#incrementMemory(this.#addrAbsoluteXData());
            return this.#memory8() ? 7 : 9;
        default:
            return this.#illegal(opcode);
        }
    }

    #interrupt(isNMI) {
        const emulationVector = isNMI ? 0xfffa : 0xfffe;
        const nativeVector = isNMI ? 0xffea : 0xffee;

        if (this.E) {
            this.#push16(this.PC);
            this.#push8(this.P & ~0x10);
            this.#setFlag(FLAG_I, true);
            this.#setFlag(FLAG_D, false);
            this.PBR = 0;
            this.PC = this.#read16Bank0(emulationVector);
            return 7;
        }

        this.#push8(this.PBR);
        this.#push16(this.PC);
        this.#push8(this.P);
        this.#setFlag(FLAG_I, true);
        this.#setFlag(FLAG_D, false);
        this.PBR = 0;
        this.PC = this.#read16Bank0(nativeVector);
        return 8;
    }

    #brk() {
        const vector = this.E ? 0xfffe : 0xffe6;
        this.#push16((this.PC + 1) & 0xffff);
        this.#push8(this.P | (this.E ? 0x30 : 0x00));
        this.#setFlag(FLAG_I, true);
        this.#setFlag(FLAG_D, false);
        this.PBR = 0;
        this.PC = this.#read16Bank0(vector);
        return this.E ? 7 : 8;
    }

    #rti() {
        this.P = this.#pop8();

        if (this.E) {
            this.P |= FLAG_M | FLAG_X;
            this.PC = this.#pop16();
            this.#normalizeFlagsAndRegisters();
            return 6;
        }

        this.PC = this.#pop16();
        this.PBR = this.#pop8();
        this.#normalizeFlagsAndRegisters();
        return 7;
    }

    #illegal(opcode) {
        const count = this.unknownOpcodes.get(opcode) ?? 0;
        this.unknownOpcodes.set(opcode, count + 1);

        if (this.strictOpcodes) {
            const hex = opcode.toString(16).padStart(2, '0');
            const bank = this.PBR.toString(16).padStart(2, '0');
            const pc = ((this.PC - 1) & 0xffff).toString(16).padStart(4, '0');
            throw new Error(`Unsupported opcode 0x${hex} at ${bank}:${pc}.`);
        }

        return 2;
    }

    #readImmediateByWidth() {
        return this.#memory8() ? this.#fetch8() : this.#fetch16();
    }

    #readImmediateIndexByWidth() {
        return this.#index8() ? this.#fetch8() : this.#fetch16();
    }

    #loadA(value) {
        if (this.#memory8()) {
            this.A = (this.A & 0xff00) | (value & 0xff);
            this.#setZN(this.A & 0xff, 8);
            return;
        }

        this.A = value & 0xffff;
        this.#setZN(this.A, 16);
    }

    #loadX(value) {
        if (this.#index8()) {
            this.X = value & 0xff;
            this.#setZN(this.X, 8);
            return;
        }

        this.X = value & 0xffff;
        this.#setZN(this.X, 16);
    }

    #loadY(value) {
        if (this.#index8()) {
            this.Y = value & 0xff;
            this.#setZN(this.Y, 8);
            return;
        }

        this.Y = value & 0xffff;
        this.#setZN(this.Y, 16);
    }

    #transferAToY() {
        if (this.#index8()) {
            this.Y = this.A & 0xff;
            this.#setZN(this.Y, 8);
            return;
        }

        this.Y = this.A & 0xffff;
        this.#setZN(this.Y, 16);
    }

    #transferAToX() {
        if (this.#index8()) {
            this.X = this.A & 0xff;
            this.#setZN(this.X, 8);
            return;
        }

        this.X = this.A & 0xffff;
        this.#setZN(this.X, 16);
    }

    #transferXToY() {
        if (this.#index8()) {
            this.Y = this.X & 0xff;
            this.#setZN(this.Y, 8);
            return;
        }

        this.Y = this.X & 0xffff;
        this.#setZN(this.Y, 16);
    }

    #transferYToA() {
        if (this.#memory8()) {
            this.A = (this.A & 0xff00) | (this.Y & 0xff);
            this.#setZN(this.A & 0xff, 8);
            return;
        }

        this.A = this.Y & 0xffff;
        this.#setZN(this.A, 16);
    }

    #transferYToX() {
        if (this.#index8()) {
            this.X = this.Y & 0xff;
            this.#setZN(this.X, 8);
            return;
        }

        this.X = this.Y & 0xffff;
        this.#setZN(this.X, 16);
    }

    #transferXToA() {
        if (this.#memory8()) {
            this.A = (this.A & 0xff00) | (this.X & 0xff);
            this.#setZN(this.A & 0xff, 8);
            return;
        }

        this.A = this.X & 0xffff;
        this.#setZN(this.A, 16);
    }

    #incrementX() {
        if (this.#index8()) {
            this.X = (this.X + 1) & 0xff;
            this.#setZN(this.X, 8);
            return;
        }

        this.X = (this.X + 1) & 0xffff;
        this.#setZN(this.X, 16);
    }

    #decrementX() {
        if (this.#index8()) {
            this.X = (this.X - 1) & 0xff;
            this.#setZN(this.X, 8);
            return;
        }

        this.X = (this.X - 1) & 0xffff;
        this.#setZN(this.X, 16);
    }

    #incrementY() {
        if (this.#index8()) {
            this.Y = (this.Y + 1) & 0xff;
            this.#setZN(this.Y, 8);
            return;
        }

        this.Y = (this.Y + 1) & 0xffff;
        this.#setZN(this.Y, 16);
    }

    #decrementY() {
        if (this.#index8()) {
            this.Y = (this.Y - 1) & 0xff;
            this.#setZN(this.Y, 8);
            return;
        }

        this.Y = (this.Y - 1) & 0xffff;
        this.#setZN(this.Y, 16);
    }

    #incAccumulator() {
        if (this.#memory8()) {
            const value = ((this.A & 0xff) + 1) & 0xff;
            this.A = (this.A & 0xff00) | value;
            this.#setZN(value, 8);
            return;
        }

        this.A = (this.A + 1) & 0xffff;
        this.#setZN(this.A, 16);
    }

    #decAccumulator() {
        if (this.#memory8()) {
            const value = ((this.A & 0xff) - 1) & 0xff;
            this.A = (this.A & 0xff00) | value;
            this.#setZN(value, 8);
            return;
        }

        this.A = (this.A - 1) & 0xffff;
        this.#setZN(this.A, 16);
    }

    #incrementMemory(address) {
        if (this.#memory8()) {
            const value = (this.#read8(address) + 1) & 0xff;
            this.#write8(address, value);
            this.#setZN(value, 8);
            return;
        }

        const value = (this.#read16BankWrapped(address) + 1) & 0xffff;
        this.#write16BankWrapped(address, value);
        this.#setZN(value, 16);
    }

    #decrementMemory(address) {
        if (this.#memory8()) {
            const value = (this.#read8(address) - 1) & 0xff;
            this.#write8(address, value);
            this.#setZN(value, 8);
            return;
        }

        const value = (this.#read16BankWrapped(address) - 1) & 0xffff;
        this.#write16BankWrapped(address, value);
        this.#setZN(value, 16);
    }

    #pushAByWidth() {
        if (this.#memory8()) {
            this.#push8(this.A & 0xff);
            return;
        }

        this.#push16(this.A);
    }

    #pullAByWidth() {
        if (this.#memory8()) {
            const value = this.#pop8();
            this.A = (this.A & 0xff00) | value;
            this.#setZN(value, 8);
            return;
        }

        this.A = this.#pop16();
        this.#setZN(this.A, 16);
    }

    #pullXByWidth() {
        if (this.#index8()) {
            this.X = this.#pop8() & 0xff;
            this.#setZN(this.X, 8);
            return;
        }

        this.X = this.#pop16() & 0xffff;
        this.#setZN(this.X, 16);
    }

    #pullYByWidth() {
        if (this.#index8()) {
            this.Y = this.#pop8() & 0xff;
            this.#setZN(this.Y, 8);
            return;
        }

        this.Y = this.#pop16() & 0xffff;
        this.#setZN(this.Y, 16);
    }

    #pushXByWidth() {
        if (this.#index8()) {
            this.#push8(this.X & 0xff);
            return;
        }

        this.#push16(this.X);
    }

    #pushYByWidth() {
        if (this.#index8()) {
            this.#push8(this.Y & 0xff);
            return;
        }

        this.#push16(this.Y);
    }

    #readDataByWidth(address, linear16 = false) {
        if (this.#memory8()) {
            return this.#read8(address);
        }

        return linear16
            ? this.#read16Linear(address)
            : this.#read16BankWrapped(address);
    }

    #readIndexByWidth(address, linear16 = false) {
        if (this.#index8()) {
            return this.#read8(address);
        }

        return linear16
            ? this.#read16Linear(address)
            : this.#read16BankWrapped(address);
    }

    #writeByWidth(address, value, linear16 = false) {
        if (this.#memory8()) {
            this.#write8(address, value & 0xff);
            return;
        }

        if (linear16) {
            this.#write16Linear(address, value & 0xffff);
            return;
        }

        this.#write16BankWrapped(address, value & 0xffff);
    }

    #writeIndexByWidth(address, value, linear16 = false) {
        if (this.#index8()) {
            this.#write8(address, value & 0xff);
            return;
        }

        if (linear16) {
            this.#write16Linear(address, value & 0xffff);
            return;
        }

        this.#write16BankWrapped(address, value & 0xffff);
    }

    #accumulatorValue() {
        return this.#memory8() ? this.A & 0xff : this.A & 0xffff;
    }

    #compareA(value) {
        const width = this.#memory8() ? 8 : 16;
        this.#compare(this.#accumulatorValue(), value, width);
    }

    #compareX(value) {
        const width = this.#index8() ? 8 : 16;
        this.#compare(this.#index8() ? this.X & 0xff : this.X, value, width);
    }

    #compareY(value) {
        const width = this.#index8() ? 8 : 16;
        this.#compare(this.#index8() ? this.Y & 0xff : this.Y, value, width);
    }

    #compare(left, right, width) {
        const mask = width === 8 ? 0xff : 0xffff;
        const diff = (left - right) & mask;

        this.#setFlag(FLAG_C, left >= right);
        this.#setZN(diff, width);
    }

    #bitMemory(value) {
        if (this.#memory8()) {
            const a = this.A & 0xff;
            const data = value & 0xff;
            this.#setFlag(FLAG_Z, (a & data) === 0);
            this.#setFlag(FLAG_N, (data & 0x80) !== 0);
            this.#setFlag(FLAG_V, (data & 0x40) !== 0);
            return;
        }

        const a = this.A & 0xffff;
        const data = value & 0xffff;
        this.#setFlag(FLAG_Z, (a & data) === 0);
        this.#setFlag(FLAG_N, (data & 0x8000) !== 0);
        this.#setFlag(FLAG_V, (data & 0x4000) !== 0);
    }

    #tsb(address) {
        if (this.#memory8()) {
            const a = this.A & 0xff;
            const data = this.#read8(address);
            this.#setFlag(FLAG_Z, (a & data) === 0);
            this.#write8(address, (data | a) & 0xff);
            return;
        }

        const a = this.A & 0xffff;
        const data = this.#read16BankWrapped(address);
        this.#setFlag(FLAG_Z, (a & data) === 0);
        this.#write16BankWrapped(address, (data | a) & 0xffff);
    }

    #trb(address) {
        if (this.#memory8()) {
            const a = this.A & 0xff;
            const data = this.#read8(address);
            this.#setFlag(FLAG_Z, (a & data) === 0);
            this.#write8(address, data & (~a & 0xff));
            return;
        }

        const a = this.A & 0xffff;
        const data = this.#read16BankWrapped(address);
        this.#setFlag(FLAG_Z, (a & data) === 0);
        this.#write16BankWrapped(address, data & (~a & 0xffff));
    }

    #ora(value) {
        if (this.#memory8()) {
            const result = (this.A & 0xff) | (value & 0xff);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        this.A = (this.A | value) & 0xffff;
        this.#setZN(this.A, 16);
    }

    #and(value) {
        if (this.#memory8()) {
            const result = (this.A & 0xff) & (value & 0xff);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        this.A = (this.A & value) & 0xffff;
        this.#setZN(this.A, 16);
    }

    #eor(value) {
        if (this.#memory8()) {
            const result = (this.A & 0xff) ^ (value & 0xff);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        this.A = (this.A ^ value) & 0xffff;
        this.#setZN(this.A, 16);
    }

    #adc(value) {
        if (this.#memory8()) {
            const left = this.A & 0xff;
            const right = value & 0xff;
            const carryIn = this.#flag(FLAG_C) ? 1 : 0;
            const binarySum = left + right + carryIn;
            const binaryResult = binarySum & 0xff;
            const decimalMode = this.#flag(FLAG_D);
            let result = binaryResult;
            let carryOut = binarySum > 0xff;

            if (decimalMode) {
                const decimal = this.#adcBcd(left, right, carryIn, 8);
                result = decimal.result;
                carryOut = decimal.carryOut;
            }

            this.#setFlag(FLAG_C, carryOut);
            this.#setFlag(
                FLAG_V,
                ((~(left ^ right) & (left ^ binaryResult)) & 0x80) !== 0,
            );
            this.A = (this.A & 0xff00) | (result & 0xff);
            this.#setZN(result, 8);
            return;
        }

        const left = this.A & 0xffff;
        const right = value & 0xffff;
        const carryIn = this.#flag(FLAG_C) ? 1 : 0;
        const binarySum = left + right + carryIn;
        const binaryResult = binarySum & 0xffff;
        const decimalMode = this.#flag(FLAG_D);
        let result = binaryResult;
        let carryOut = binarySum > 0xffff;

        if (decimalMode) {
            const decimal = this.#adcBcd(left, right, carryIn, 16);
            result = decimal.result;
            carryOut = decimal.carryOut;
        }

        this.#setFlag(FLAG_C, carryOut);
        this.#setFlag(
            FLAG_V,
            ((~(left ^ right) & (left ^ binaryResult)) & 0x8000) !== 0,
        );
        this.A = result & 0xffff;
        this.#setZN(result, 16);
    }

    #sbc(value) {
        if (this.#memory8()) {
            const left = this.A & 0xff;
            const right = value & 0xff;
            const borrowIn = this.#flag(FLAG_C) ? 0 : 1;
            const binaryDiff = left - right - borrowIn;
            const binaryResult = binaryDiff & 0xff;
            const decimalMode = this.#flag(FLAG_D);
            let result = binaryResult;
            let carryOut = binaryDiff >= 0;

            if (decimalMode) {
                const decimal = this.#sbcBcd(left, right, borrowIn, 8);
                result = decimal.result;
                carryOut = decimal.carryOut;
            }

            this.#setFlag(FLAG_C, carryOut);
            this.#setFlag(
                FLAG_V,
                ((left ^ right) & (left ^ binaryResult) & 0x80) !== 0,
            );
            this.A = (this.A & 0xff00) | (result & 0xff);
            this.#setZN(result, 8);
            return;
        }

        const left = this.A & 0xffff;
        const right = value & 0xffff;
        const borrowIn = this.#flag(FLAG_C) ? 0 : 1;
        const binaryDiff = left - right - borrowIn;
        const binaryResult = binaryDiff & 0xffff;
        const decimalMode = this.#flag(FLAG_D);
        let result = binaryResult;
        let carryOut = binaryDiff >= 0;

        if (decimalMode) {
            const decimal = this.#sbcBcd(left, right, borrowIn, 16);
            result = decimal.result;
            carryOut = decimal.carryOut;
        }

        this.#setFlag(FLAG_C, carryOut);
        this.#setFlag(
            FLAG_V,
            ((left ^ right) & (left ^ binaryResult) & 0x8000) !== 0,
        );
        this.A = result & 0xffff;
        this.#setZN(result, 16);
    }

    #adcBcd(left, right, carryIn, width) {
        const digits = width / 4;
        const mask = width === 8 ? 0xff : 0xffff;
        let result = 0;
        let carry = carryIn;

        for (let index = 0; index < digits; index += 1) {
            const shift = index * 4;
            let nibble = ((left >>> shift) & 0x0f) +
                ((right >>> shift) & 0x0f) +
                carry;

            if (nibble > 0x09) {
                nibble += 0x06;
            }

            carry = nibble > 0x0f ? 1 : 0;
            result |= (nibble & 0x0f) << shift;
        }

        return {
            result: result & mask,
            carryOut: carry !== 0,
        };
    }

    #sbcBcd(left, right, borrowIn, width) {
        const digits = width / 4;
        const mask = width === 8 ? 0xff : 0xffff;
        let result = 0;
        let borrow = borrowIn;

        for (let index = 0; index < digits; index += 1) {
            const shift = index * 4;
            let nibble = ((left >>> shift) & 0x0f) -
                ((right >>> shift) & 0x0f) -
                borrow;

            if (nibble < 0) {
                nibble -= 0x06;
                borrow = 1;
            } else {
                borrow = 0;
            }

            result |= (nibble & 0x0f) << shift;
        }

        return {
            result: result & mask,
            carryOut: borrow === 0,
        };
    }

    #rolAccumulator() {
        if (this.#memory8()) {
            const carryIn = this.#flag(FLAG_C) ? 1 : 0;
            const value = this.A & 0xff;
            const result = ((value << 1) | carryIn) & 0xff;

            this.#setFlag(FLAG_C, (value & 0x80) !== 0);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        const carryIn = this.#flag(FLAG_C) ? 1 : 0;
        const value = this.A & 0xffff;
        const result = ((value << 1) | carryIn) & 0xffff;

        this.#setFlag(FLAG_C, (value & 0x8000) !== 0);
        this.A = result;
        this.#setZN(result, 16);
    }

    #rolMemory(address) {
        if (this.#memory8()) {
            const carryIn = this.#flag(FLAG_C) ? 1 : 0;
            const value = this.#read8(address);
            const result = ((value << 1) | carryIn) & 0xff;

            this.#setFlag(FLAG_C, (value & 0x80) !== 0);
            this.#write8(address, result);
            this.#setZN(result, 8);
            return;
        }

        const carryIn = this.#flag(FLAG_C) ? 1 : 0;
        const value = this.#read16BankWrapped(address);
        const result = ((value << 1) | carryIn) & 0xffff;

        this.#setFlag(FLAG_C, (value & 0x8000) !== 0);
        this.#write16BankWrapped(address, result);
        this.#setZN(result, 16);
    }

    #aslAccumulator() {
        if (this.#memory8()) {
            const value = this.A & 0xff;
            const result = (value << 1) & 0xff;

            this.#setFlag(FLAG_C, (value & 0x80) !== 0);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        const value = this.A & 0xffff;
        const result = (value << 1) & 0xffff;

        this.#setFlag(FLAG_C, (value & 0x8000) !== 0);
        this.A = result;
        this.#setZN(result, 16);
    }

    #aslMemory(address) {
        if (this.#memory8()) {
            const value = this.#read8(address);
            const result = (value << 1) & 0xff;
            this.#setFlag(FLAG_C, (value & 0x80) !== 0);
            this.#write8(address, result);
            this.#setZN(result, 8);
            return;
        }

        const value = this.#read16BankWrapped(address);
        const result = (value << 1) & 0xffff;
        this.#setFlag(FLAG_C, (value & 0x8000) !== 0);
        this.#write16BankWrapped(address, result);
        this.#setZN(result, 16);
    }

    #lsrAccumulator() {
        if (this.#memory8()) {
            const value = this.A & 0xff;
            const result = (value >>> 1) & 0xff;

            this.#setFlag(FLAG_C, (value & 0x01) !== 0);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        const value = this.A & 0xffff;
        const result = (value >>> 1) & 0xffff;

        this.#setFlag(FLAG_C, (value & 0x01) !== 0);
        this.A = result;
        this.#setZN(result, 16);
    }

    #lsrMemory(address) {
        if (this.#memory8()) {
            const value = this.#read8(address);
            const result = (value >>> 1) & 0xff;
            this.#setFlag(FLAG_C, (value & 0x01) !== 0);
            this.#write8(address, result);
            this.#setZN(result, 8);
            return;
        }

        const value = this.#read16BankWrapped(address);
        const result = (value >>> 1) & 0xffff;
        this.#setFlag(FLAG_C, (value & 0x01) !== 0);
        this.#write16BankWrapped(address, result);
        this.#setZN(result, 16);
    }

    #rorAccumulator() {
        if (this.#memory8()) {
            const value = this.A & 0xff;
            const carryIn = this.#flag(FLAG_C) ? 0x80 : 0x00;
            const result = ((value >>> 1) | carryIn) & 0xff;
            this.#setFlag(FLAG_C, (value & 0x01) !== 0);
            this.A = (this.A & 0xff00) | result;
            this.#setZN(result, 8);
            return;
        }

        const value = this.A & 0xffff;
        const carryIn = this.#flag(FLAG_C) ? 0x8000 : 0x0000;
        const result = ((value >>> 1) | carryIn) & 0xffff;
        this.#setFlag(FLAG_C, (value & 0x01) !== 0);
        this.A = result;
        this.#setZN(result, 16);
    }

    #rorMemory(address) {
        if (this.#memory8()) {
            const value = this.#read8(address);
            const carryIn = this.#flag(FLAG_C) ? 0x80 : 0x00;
            const result = ((value >>> 1) | carryIn) & 0xff;
            this.#setFlag(FLAG_C, (value & 0x01) !== 0);
            this.#write8(address, result);
            this.#setZN(result, 8);
            return;
        }

        const value = this.#read16BankWrapped(address);
        const carryIn = this.#flag(FLAG_C) ? 0x8000 : 0x0000;
        const result = ((value >>> 1) | carryIn) & 0xffff;
        this.#setFlag(FLAG_C, (value & 0x01) !== 0);
        this.#write16BankWrapped(address, result);
        this.#setZN(result, 16);
    }

    #xce() {
        const carry = this.#flag(FLAG_C);
        this.#setFlag(FLAG_C, this.E);
        this.E = carry;
        this.#normalizeFlagsAndRegisters();
    }

    #xba() {
        const low = this.A & 0xff;
        const high = (this.A >>> 8) & 0xff;

        this.A = ((low << 8) | high) & 0xffff;
        this.#setZN(this.A & 0xff, 8);
    }

    #rep(mask) {
        this.P &= (~mask) & 0xff;
        this.#normalizeFlagsAndRegisters();
    }

    #sep(mask) {
        this.P |= mask & 0xff;
        this.#normalizeFlagsAndRegisters();
    }

    #branch(condition) {
        const displacement = toSigned8(this.#fetch8());

        if (!condition) {
            return 2;
        }

        this.PC = (this.PC + displacement) & 0xffff;
        return 3;
    }

    #blockMove(increment) {
        const destBank = this.#fetch8();
        const srcBank = this.#fetch8();
        const source = ((srcBank << 16) | (this.X & 0xffff)) & 0xffffff;
        const target = ((destBank << 16) | (this.Y & 0xffff)) & 0xffffff;
        const value = this.#read8(source);

        this.#write8(target, value);

        if (increment) {
            this.X = (this.X + 1) & 0xffff;
            this.Y = (this.Y + 1) & 0xffff;
        } else {
            this.X = (this.X - 1) & 0xffff;
            this.Y = (this.Y - 1) & 0xffff;
        }

        this.A = (this.A - 1) & 0xffff;
        this.DBR = destBank & 0xff;

        if (this.A !== 0xffff) {
            this.PC = (this.PC - 3) & 0xffff;
        }

        return 7;
    }

    #memory8() {
        return this.E || (this.P & FLAG_M) !== 0;
    }

    #index8() {
        return this.E || (this.P & FLAG_X) !== 0;
    }

    #normalizeFlagsAndRegisters() {
        if (this.E) {
            this.P |= FLAG_M | FLAG_X;
            this.X &= 0x00ff;
            this.Y &= 0x00ff;
            this.SP = (this.SP & 0x00ff) | 0x0100;
        }

        if ((this.P & FLAG_X) !== 0) {
            this.X &= 0x00ff;
            this.Y &= 0x00ff;
        }
    }

    #flag(bit) {
        return (this.P & bit) !== 0;
    }

    #setFlag(bit, enabled) {
        if (enabled) {
            this.P |= bit;
        } else {
            this.P &= (~bit) & 0xff;
        }
    }

    #setZN(value, width) {
        const mask = width === 8 ? 0xff : 0xffff;
        const negativeBit = width === 8 ? 0x80 : 0x8000;
        const masked = value & mask;

        this.#setFlag(FLAG_Z, masked === 0);
        this.#setFlag(FLAG_N, (masked & negativeBit) !== 0);
    }

    #fetch8() {
        const address = ((this.PBR << 16) | this.PC) & 0xffffff;
        const value = this.bus.read(address);

        this.PC = (this.PC + 1) & 0xffff;
        return value;
    }

    #fetch16() {
        const low = this.#fetch8();
        const high = this.#fetch8();
        return low | (high << 8);
    }

    #fetch24() {
        const low = this.#fetch8();
        const mid = this.#fetch8();
        const high = this.#fetch8();
        return low | (mid << 8) | (high << 16);
    }

    #read8(address) {
        return this.bus.read(address & 0xffffff);
    }

    #write8(address, value) {
        this.bus.write(address & 0xffffff, value & 0xff);
    }

    #read16BankWrapped(address) {
        const bank = address & 0xff0000;
        const lowAddress = bank | (address & 0xffff);
        const highAddress = bank | ((address + 1) & 0xffff);
        const low = this.#read8(lowAddress);
        const high = this.#read8(highAddress);
        return low | (high << 8);
    }

    #read16Linear(address) {
        const low = this.#read8(address & 0xffffff);
        const high = this.#read8((address + 1) & 0xffffff);
        return low | (high << 8);
    }

    #write16BankWrapped(address, value) {
        const bank = address & 0xff0000;
        const lowAddress = bank | (address & 0xffff);
        const highAddress = bank | ((address + 1) & 0xffff);
        this.#write8(lowAddress, value & 0xff);
        this.#write8(highAddress, (value >>> 8) & 0xff);
    }

    #write16Linear(address, value) {
        this.#write8(address & 0xffffff, value & 0xff);
        this.#write8((address + 1) & 0xffffff, (value >>> 8) & 0xff);
    }

    #read16Bank0(address) {
        const low = this.bus.read(address & 0xffff);
        const high = this.bus.read((address + 1) & 0xffff);
        return low | (high << 8);
    }

    #push8(value) {
        if (this.E) {
            const stackAddress = 0x0100 | (this.SP & 0xff);
            this.bus.write(stackAddress, value & 0xff);
            this.SP = ((this.SP - 1) & 0xff) | 0x0100;
            return;
        }

        this.bus.write(this.SP & 0xffff, value & 0xff);
        this.SP = (this.SP - 1) & 0xffff;
    }

    #push16(value) {
        this.#push8((value >>> 8) & 0xff);
        this.#push8(value & 0xff);
    }

    #pop8() {
        if (this.E) {
            this.SP = ((this.SP + 1) & 0xff) | 0x0100;
            const stackAddress = 0x0100 | (this.SP & 0xff);
            return this.bus.read(stackAddress);
        }

        this.SP = (this.SP + 1) & 0xffff;
        return this.bus.read(this.SP & 0xffff);
    }

    #pop16() {
        const low = this.#pop8();
        const high = this.#pop8();
        return low | (high << 8);
    }

    #addrAbsoluteData() {
        const address = this.#fetch16();
        return ((this.DBR << 16) | address) & 0xffffff;
    }

    #addrAbsoluteXData() {
        const address = this.#fetch16();
        const x = this.#index8() ? this.X & 0xff : this.X;
        const base = ((this.DBR << 16) | address) & 0xffffff;
        return (base + x) & 0xffffff;
    }

    #addrAbsoluteYData() {
        const address = this.#fetch16();
        const y = this.#index8() ? this.Y & 0xff : this.Y;
        const base = ((this.DBR << 16) | address) & 0xffffff;
        return (base + y) & 0xffffff;
    }

    #addrLong() {
        return this.#fetch24() & 0xffffff;
    }

    #addrLongX() {
        const base = this.#fetch24() & 0xffffff;
        const x = this.#index8() ? this.X & 0xff : this.X;
        return (base + x) & 0xffffff;
    }

    #addrDirectData() {
        const offset = this.#fetch8();
        const address = (this.D + offset) & 0xffff;
        return address;
    }

    #addrDirectXData() {
        const offset = this.#fetch8();
        const x = this.#index8() ? this.X & 0xff : this.X;
        return (this.D + offset + x) & 0xffff;
    }

    #addrDirectYData() {
        const offset = this.#fetch8();
        const y = this.#index8() ? this.Y & 0xff : this.Y;
        return (this.D + offset + y) & 0xffff;
    }

    #addrDirectIndirectLongY() {
        const offset = this.#fetch8();
        const pointer = (this.D + offset) & 0xffff;
        const low = this.bus.read(pointer);
        const high = this.bus.read((pointer + 1) & 0xffff);
        const bank = this.bus.read((pointer + 2) & 0xffff);
        const y = this.#index8() ? this.Y & 0xff : this.Y;
        const base = low | (high << 8) | (bank << 16);

        return (base + y) & 0xffffff;
    }

    #addrDirectIndirectLong() {
        const offset = this.#fetch8();
        const pointer = (this.D + offset) & 0xffff;
        const low = this.bus.read(pointer);
        const high = this.bus.read((pointer + 1) & 0xffff);
        const bank = this.bus.read((pointer + 2) & 0xffff);

        return (low | (high << 8) | (bank << 16)) & 0xffffff;
    }

    #addrDirectIndirect() {
        const offset = this.#fetch8();
        const pointer = (this.D + offset) & 0xffff;
        const low = this.bus.read(pointer);
        const high = this.bus.read((pointer + 1) & 0xffff);
        const address = low | (high << 8);

        return ((this.DBR << 16) | address) & 0xffffff;
    }

    #addrStackRelativeIndirectY() {
        const stackOffset = this.#fetch8();
        const sp = this.E
            ? (0x0100 | (this.SP & 0xff))
            : this.SP;
        const pointer = (sp + stackOffset) & 0xffff;
        const low = this.bus.read(pointer);
        const high = this.bus.read((pointer + 1) & 0xffff);
        const base = low | (high << 8);
        const y = this.#index8() ? this.Y & 0xff : this.Y;

        return ((((this.DBR << 16) | base) + y) & 0xffffff);
    }

    #addrDirectIndirectY() {
        const offset = this.#fetch8();
        const pointer = (this.D + offset) & 0xffff;
        const low = this.bus.read(pointer);
        const high = this.bus.read((pointer + 1) & 0xffff);
        const y = this.#index8() ? this.Y & 0xff : this.Y;
        const base = low | (high << 8);

        return ((((this.DBR << 16) | base) + y) & 0xffffff);
    }
}

export {
    CPU65816,
};
