'use strict';

const NES_MAGIC = [0x4e, 0x45, 0x53, 0x1a];
const HEADER_SIZE = 16;
const TRAINER_SIZE = 512;
const PRG_BANK_SIZE = 16 * 1024;
const CHR_BANK_SIZE = 8 * 1024;

function toBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    if (data instanceof Uint8Array) {
        return Buffer.from(data);
    }

    throw new TypeError('ROM data must be a Buffer or Uint8Array.');
}

function parseINESHeader(data) {
    const rom = toBuffer(data);

    if (rom.length < HEADER_SIZE) {
        throw new RangeError('ROM is too small to contain an iNES header.');
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
    const hasTrainer = (flags6 & 0x04) !== 0;
    const trainerBytes = hasTrainer ? TRAINER_SIZE : 0;
    const mapper = ((flags7 & 0xf0) | (flags6 >> 4)) & 0xff;
    const hasBatteryRam = (flags6 & 0x02) !== 0;
    const hasFourScreenMirroring = (flags6 & 0x08) !== 0;
    const usesVerticalMirroring = (flags6 & 0x01) !== 0;
    const format = (flags7 & 0x0c) === 0x08 ? 'NES 2.0' : 'iNES';
    const mirroring = hasFourScreenMirroring
        ? 'four-screen'
        : usesVerticalMirroring
            ? 'vertical'
            : 'horizontal';

    const prgRomBytes = prgRomBanks * PRG_BANK_SIZE;
    const chrRomBytes = chrRomBanks * CHR_BANK_SIZE;
    const prgRomOffset = HEADER_SIZE + trainerBytes;
    const chrRomOffset = prgRomOffset + prgRomBytes;
    const minimumExpectedSize = chrRomOffset + chrRomBytes;

    if (rom.length < minimumExpectedSize) {
        throw new RangeError(
            'ROM size is smaller than the size declared in iNES header.',
        );
    }

    return {
        format,
        mapper,
        mirroring,
        hasBatteryRam,
        hasTrainer,
        prgRomBanks,
        chrRomBanks,
        prgRomBytes,
        chrRomBytes,
        prgRomOffset,
        chrRomOffset,
    };
}

module.exports = {
    parseINESHeader,
    constants: {
        HEADER_SIZE,
        TRAINER_SIZE,
        PRG_BANK_SIZE,
        CHR_BANK_SIZE,
    },
};
