import { parseSNESHeader } from './snes/smc.mjs';
import { toByteArray } from '../shared/nintendo/rom-buffer.mjs';
import { NINTENDO_SYSTEMS } from '../shared/nintendo/systems.mjs';

const NES_MAGIC = [0x4e, 0x45, 0x53, 0x1a];

function hasINESMagic(rom) {
    if (rom.length < NES_MAGIC.length) {
        return false;
    }

    for (let index = 0; index < NES_MAGIC.length; index += 1) {
        if (rom[index] !== NES_MAGIC[index]) {
            return false;
        }
    }

    return true;
}

function detectNintendoSystem(romData) {
    const rom = toByteArray(romData);

    if (hasINESMagic(rom)) {
        return NINTENDO_SYSTEMS.NES;
    }

    try {
        parseSNESHeader(rom);
        return NINTENDO_SYSTEMS.SNES;
    } catch {
        throw new Error(
            'Unsupported ROM format. Expected iNES (.nes) or SNES (.smc/.sfc).',
        );
    }
}

export {
    detectNintendoSystem,
};
