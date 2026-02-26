import { splitSMCRom } from './smc.mjs';

function normalizeOffset(offset, length) {
    if (length === 0) {
        return 0;
    }

    return offset % length;
}

class SNESCartridge {
    constructor(romData) {
        const { header, rom } = splitSMCRom(romData);
        this.header = header;
        this.rom = Uint8Array.from(rom);
        this.sram = new Uint8Array(Math.max(header.sramBytes, 0));
    }

    read(bank, address) {
        const mappedBank = bank & 0xff;
        const mappedAddress = address & 0xffff;

        const sramOffset = this.#resolveSRAMOffset(mappedBank, mappedAddress);

        if (sramOffset !== null) {
            return this.sram[sramOffset];
        }

        const romOffset = this.#resolveROMOffset(mappedBank, mappedAddress);

        if (romOffset === null) {
            return 0xff;
        }

        return this.rom[romOffset];
    }

    write(bank, address, value) {
        const mappedBank = bank & 0xff;
        const mappedAddress = address & 0xffff;
        const byte = value & 0xff;

        const sramOffset = this.#resolveSRAMOffset(mappedBank, mappedAddress);

        if (sramOffset !== null) {
            this.sram[sramOffset] = byte;
        }
    }

    #resolveROMOffset(bank, address) {
        if (this.header.layout === 'lorom') {
            return this.#resolveLoROMOffset(bank, address);
        }

        if (this.header.layout === 'hirom') {
            return this.#resolveHiROMOffset(bank, address);
        }

        return null;
    }

    #resolveLoROMOffset(bank, address) {
        const bankClass = bank & 0x7f;
        const isHighArea = address >= 0x8000;
        const isFullBankROM = bankClass >= 0x40 && bankClass <= 0x7d;

        if (!isHighArea && !isFullBankROM) {
            return null;
        }

        const offset = (bankClass * 0x8000) + (address & 0x7fff);
        return normalizeOffset(offset, this.rom.length);
    }

    #resolveHiROMOffset(bank, address) {
        const bankClass = bank & 0x7f;
        const offset = (bankClass * 0x10000) + address;

        if (offset >= this.rom.length && bankClass < 0x40 && address < 0x8000) {
            return null;
        }

        return normalizeOffset(offset, this.rom.length);
    }

    #resolveSRAMOffset(bank, address) {
        if (this.sram.length === 0) {
            return null;
        }

        if (address >= 0x8000) {
            return null;
        }

        if (this.header.layout === 'lorom') {
            const bankClass = bank & 0x7f;
            const isSRAMBank =
                (bankClass >= 0x70 && bankClass <= 0x7d) ||
                (bank >= 0xf0 && bank <= 0xff);

            if (!isSRAMBank) {
                return null;
            }

            const offset = ((bankClass & 0x0f) * 0x8000) + address;
            return normalizeOffset(offset, this.sram.length);
        }

        if (this.header.layout === 'hirom') {
            const bankClass = bank & 0x7f;
            const isSRAMBank = bankClass >= 0x20 && bankClass <= 0x3f;

            if (!isSRAMBank || address < 0x6000 || address > 0x7fff) {
                return null;
            }

            const offset = ((bankClass - 0x20) * 0x2000) + (address - 0x6000);
            return normalizeOffset(offset, this.sram.length);
        }

        return null;
    }

    saveState() {
        return {
            sram: Array.from(this.sram),
        };
    }

    loadState(state) {
        if (!state?.sram || state.sram.length !== this.sram.length) {
            return;
        }

        this.sram.set(state.sram);
    }
}

export {
    SNESCartridge,
};
