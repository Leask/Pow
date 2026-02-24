import { MapperBase } from './mapper-base.mjs';

class MapperCNROM extends MapperBase {
    #chrBank = 0;

    cpuRead(address) {
        if (address >= 0x6000 && address <= 0x7fff) {
            return this.cartridge.prgRam[address - 0x6000];
        }

        if (address < 0x8000) {
            return 0;
        }

        if (this.cartridge.prgRom.length === 0x4000) {
            return this.cartridge.prgRom[(address - 0x8000) & 0x3fff];
        }

        return this.cartridge.prgRom[address - 0x8000];
    }

    cpuWrite(address, value) {
        if (address >= 0x6000 && address <= 0x7fff) {
            this.cartridge.prgRam[address - 0x6000] = value & 0xff;
            return;
        }

        if (address >= 0x8000) {
            this.#chrBank = value & 0x03;
        }
    }

    ppuRead(address) {
        if (address < 0x2000) {
            const bankOffset = this.#chrBank * 0x2000;
            return this.cartridge.chr[bankOffset + address];
        }

        return 0;
    }

    ppuWrite(address, value) {
        if (address < 0x2000 && this.cartridge.hasChrRam) {
            const bankOffset = this.#chrBank * 0x2000;
            this.cartridge.chr[bankOffset + address] = value & 0xff;
        }
    }

    saveState() {
        return {
            chrBank: this.#chrBank,
        };
    }

    loadState(state) {
        this.#chrBank = state.chrBank & 0xff;
    }
}

export {
    MapperCNROM,
};
