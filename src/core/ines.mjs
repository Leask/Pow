const NES_MAGIC = [0x4e, 0x45, 0x53, 0x1a];
const HEADER_SIZE = 16;
const TRAINER_SIZE = 512;
const PRG_ROM_BANK_SIZE = 16 * 1024;
const CHR_ROM_BANK_SIZE = 8 * 1024;
const PRG_RAM_BANK_SIZE = 8 * 1024;

function toByteArray(data) {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    throw new TypeError(
        'ROM data must be Uint8Array, ArrayBuffer, or TypedArray view.',
    );
}

function parseINESHeader(data) {
    const rom = toByteArray(data);

    if (rom.length < HEADER_SIZE) {
        throw new RangeError('ROM is too small for iNES header.');
    }

    for (let index = 0; index < NES_MAGIC.length; index += 1) {
        if (rom[index] !== NES_MAGIC[index]) {
            throw new Error('Invalid iNES header magic.');
        }
    }

    const prgRomBanks = rom[4];
    const chrRomBanks = rom[5];
    const flags6 = rom[6];
    const flags7 = rom[7];
    const flags8 = rom[8];
    const hasTrainer = (flags6 & 0x04) !== 0;
    const hasBatteryRam = (flags6 & 0x02) !== 0;
    const fourScreen = (flags6 & 0x08) !== 0;
    const verticalMirroring = (flags6 & 0x01) !== 0;
    const mapperId = ((flags7 & 0xf0) | (flags6 >> 4)) & 0xff;
    const format = (flags7 & 0x0c) === 0x08 ? 'NES2.0' : 'iNES';
    const trainerBytes = hasTrainer ? TRAINER_SIZE : 0;
    const prgRomBytes = prgRomBanks * PRG_ROM_BANK_SIZE;
    const chrRomBytes = chrRomBanks * CHR_ROM_BANK_SIZE;
    const prgRamBanks = Math.max(flags8 || 0, 1);
    const prgRamBytes = prgRamBanks * PRG_RAM_BANK_SIZE;
    const romDataOffset = HEADER_SIZE + trainerBytes;
    const chrDataOffset = romDataOffset + prgRomBytes;
    const minimumSize = chrDataOffset + chrRomBytes;

    if (rom.length < minimumSize) {
        throw new RangeError(
            'ROM size is smaller than header-declared content size.',
        );
    }

    return {
        format,
        mapperId,
        mirroring: fourScreen
            ? 'four-screen'
            : verticalMirroring
                ? 'vertical'
                : 'horizontal',
        hasTrainer,
        hasBatteryRam,
        prgRomBanks,
        chrRomBanks,
        prgRamBanks,
        prgRomBytes,
        chrRomBytes,
        prgRamBytes,
        romDataOffset,
        chrDataOffset,
    };
}

function splitINESRom(data) {
    const rom = toByteArray(data);
    const header = parseINESHeader(rom);
    const prgRomEnd = header.romDataOffset + header.prgRomBytes;
    const chrRomEnd = prgRomEnd + header.chrRomBytes;
    const prgRom = rom.subarray(header.romDataOffset, prgRomEnd);
    const chrRom = rom.subarray(prgRomEnd, chrRomEnd);

    return {
        header,
        prgRom,
        chrRom,
    };
}

export {
    parseINESHeader,
    splitINESRom,
    HEADER_SIZE,
    TRAINER_SIZE,
    PRG_ROM_BANK_SIZE,
    CHR_ROM_BANK_SIZE,
    PRG_RAM_BANK_SIZE,
};
