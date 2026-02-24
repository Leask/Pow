import { MapperBase } from './mapper-base.js';

class MapperNROM extends MapperBase {
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
}

export {
    MapperNROM,
};
