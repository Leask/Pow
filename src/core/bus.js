import { Controller } from './controller.js';
import { APU } from './apu.js';
import { PPU } from './ppu.js';

class Bus {
    constructor(cartridge) {
        this.cartridge = cartridge;
        this.ram = new Uint8Array(0x0800);
        this.controllers = [new Controller(), new Controller()];
        this.apu = new APU();
        this.ppu = new PPU(this, cartridge);

        this.nmiPending = false;
        this.irqPending = false;
        this.stallCycles = 0;
        this.cpuCycles = 0;
    }

    read(address) {
        const mapped = address & 0xffff;

        if (mapped < 0x2000) {
            return this.ram[mapped & 0x07ff];
        }

        if (mapped < 0x4000) {
            return this.ppu.readRegister(mapped & 0x2007);
        }

        if (mapped === 0x4015) {
            return this.apu.readStatus();
        }

        if (mapped === 0x4016) {
            return this.controllers[0].read();
        }

        if (mapped === 0x4017) {
            return this.controllers[1].read();
        }

        if (mapped >= 0x4020) {
            return this.cartridge.cpuRead(mapped);
        }

        return 0;
    }

    write(address, value) {
        const mapped = address & 0xffff;
        const byte = value & 0xff;

        if (mapped < 0x2000) {
            this.ram[mapped & 0x07ff] = byte;
            return;
        }

        if (mapped < 0x4000) {
            this.ppu.writeRegister(mapped & 0x2007, byte);
            return;
        }

        if (mapped >= 0x4000 && mapped <= 0x4013) {
            this.apu.writeRegister(mapped, byte);
            return;
        }

        if (mapped === 0x4014) {
            this.#doOamDma(byte);
            return;
        }

        if (mapped === 0x4015 || mapped === 0x4017) {
            this.apu.writeRegister(mapped, byte);
            return;
        }

        if (mapped === 0x4016) {
            this.controllers[0].write(byte);
            this.controllers[1].write(byte);
            return;
        }

        if (mapped >= 0x4020) {
            this.cartridge.cpuWrite(mapped, byte);
        }
    }

    #doOamDma(page) {
        const base = (page & 0xff) << 8;

        for (let index = 0; index < 256; index += 1) {
            const byte = this.read((base + index) & 0xffff);
            this.ppu.writeOamDma(byte);
        }

        this.stallCycles += 513 + (this.cpuCycles & 1);
    }

    clock(cycles) {
        this.cpuCycles += cycles;
        this.apu.clock(cycles);
        this.ppu.clock(cycles * 3);
    }

    consumeStallCycles() {
        const cycles = this.stallCycles;
        this.stallCycles = 0;
        return cycles;
    }

    requestNMI() {
        this.nmiPending = true;
    }

    requestIRQ() {
        this.irqPending = true;
    }

    pollNMI() {
        if (!this.nmiPending) {
            return false;
        }

        this.nmiPending = false;
        return true;
    }

    pollIRQ() {
        if (!this.irqPending) {
            return false;
        }

        this.irqPending = false;
        return true;
    }

    saveState() {
        return {
            ram: Array.from(this.ram),
            controllers: this.controllers.map((controller) =>
                controller.saveState(),
            ),
            apu: this.apu.saveState(),
            ppu: this.ppu.saveState(),
            nmiPending: this.nmiPending,
            irqPending: this.irqPending,
            stallCycles: this.stallCycles,
            cpuCycles: this.cpuCycles,
        };
    }

    loadState(state) {
        this.ram.set(state.ram);
        this.controllers[0].loadState(state.controllers[0]);
        this.controllers[1].loadState(state.controllers[1]);
        this.apu.loadState(state.apu);
        this.ppu.loadState(state.ppu);
        this.nmiPending = state.nmiPending;
        this.irqPending = state.irqPending;
        this.stallCycles = state.stallCycles;
        this.cpuCycles = state.cpuCycles;
    }
}

export {
    Bus,
};
