import {
    splitINESRom,
    PRG_RAM_BANK_SIZE,
} from './ines.mjs';
import { MapperNROM } from './mappers/mapper-000-nrom.mjs';
import { MapperUxROM } from './mappers/mapper-002-uxrom.mjs';
import { MapperCNROM } from './mappers/mapper-003-cnrom.mjs';

const MAPPER_FACTORY = Object.freeze({
    0: (cartridge) => new MapperNROM(cartridge),
    2: (cartridge) => new MapperUxROM(cartridge),
    3: (cartridge) => new MapperCNROM(cartridge),
});

class Cartridge {
    constructor(romData) {
        const { header, prgRom, chrRom } = splitINESRom(romData);
        this.header = header;
        this.prgRom = Uint8Array.from(prgRom);
        this.hasChrRam = chrRom.length === 0;
        this.chr = this.hasChrRam
            ? new Uint8Array(0x2000)
            : Uint8Array.from(chrRom);
        this.prgRam = new Uint8Array(
            Math.max(header.prgRamBytes, PRG_RAM_BANK_SIZE),
        );

        const mapperFactory = MAPPER_FACTORY[header.mapperId];

        if (!mapperFactory) {
            throw new Error(
                `Mapper ${header.mapperId} is not implemented yet.`,
            );
        }

        this.mapper = mapperFactory(this);
    }

    cpuRead(address) {
        return this.mapper.cpuRead(address & 0xffff) & 0xff;
    }

    cpuWrite(address, value) {
        this.mapper.cpuWrite(address & 0xffff, value & 0xff);
    }

    ppuRead(address) {
        return this.mapper.ppuRead(address & 0x3fff) & 0xff;
    }

    ppuWrite(address, value) {
        this.mapper.ppuWrite(address & 0x3fff, value & 0xff);
    }

    saveState() {
        return {
            prgRam: Array.from(this.prgRam),
            chr: this.hasChrRam ? Array.from(this.chr) : null,
            mapper: this.mapper.saveState(),
        };
    }

    loadState(state) {
        this.prgRam.set(state.prgRam);

        if (this.hasChrRam && state.chr) {
            this.chr.set(state.chr);
        }

        this.mapper.loadState(state.mapper);
    }
}

export {
    Cartridge,
};
