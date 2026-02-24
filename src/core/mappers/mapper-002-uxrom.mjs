import { MapperBase } from './mapper-base.mjs';

class MapperUxROM extends MapperBase {
    #bankSelect = 0;

    cpuRead(address) {
        if (address >= 0x6000 && address <= 0x7fff) {
            return this.cartridge.prgRam[address - 0x6000];
        }

        if (address < 0x8000) {
            return 0;
        }

        const totalBanks = this.cartridge.prgRom.length >>> 14;
        const fixedBank = totalBanks - 1;

        if (address < 0xc000) {
            const bank = this.#bankSelect % totalBanks;
            const offset = (bank * 0x4000) + (address - 0x8000);
            return this.cartridge.prgRom[offset];
        }

        const offset = (fixedBank * 0x4000) + (address - 0xc000);
        return this.cartridge.prgRom[offset];
    }

    cpuWrite(address, value) {
        if (address >= 0x6000 && address <= 0x7fff) {
            this.cartridge.prgRam[address - 0x6000] = value & 0xff;
            return;
        }

        if (address >= 0x8000) {
            this.#bankSelect = value & 0x0f;
        }
    }

    ppuRead(address) {
        if (address < 0x2000) {
            return this.cartridge.chr[address];
        }

        return 0;
    }

    ppuWrite(address, value) {
        if (address < 0x2000 && this.cartridge.hasChrRam) {
            this.cartridge.chr[address] = value & 0xff;
        }
    }

    saveState() {
        return {
            bankSelect: this.#bankSelect,
        };
    }

    loadState(state) {
        this.#bankSelect = state.bankSelect & 0xff;
    }
}

export {
    MapperUxROM,
};
