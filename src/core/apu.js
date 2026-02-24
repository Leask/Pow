class APU {
    constructor() {
        this.registers = new Uint8Array(0x18);
        this.cycle = 0;
    }

    clock(cycles) {
        this.cycle += cycles;
    }

    readStatus() {
        return this.registers[0x15];
    }

    writeRegister(address, value) {
        const index = address - 0x4000;

        if (index >= 0 && index < this.registers.length) {
            this.registers[index] = value & 0xff;
        }
    }

    saveState() {
        return {
            registers: Array.from(this.registers),
            cycle: this.cycle,
        };
    }

    loadState(state) {
        this.registers.set(state.registers);
        this.cycle = state.cycle >>> 0;
    }
}

export {
    APU,
};
