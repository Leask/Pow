import { parseSNESHeader } from './snes/smc.mjs';
import { isN64ROM } from './n64/rom.mjs';
import { isGBROM, parseGBHeader } from './gb/cartridge.mjs';
import { isGBAROM } from './gba/rom.mjs';
import { isNDSROM } from './nds/rom.mjs';
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

    if (isN64ROM(rom)) {
        return NINTENDO_SYSTEMS.N64;
    }

    if (isGBROM(rom)) return parseGBHeader(rom).color ? 'gbc' : 'gb';
    if (isGBAROM(rom)) return 'gba';
    if (isNDSROM(rom)) return 'nds';

    try {
        parseSNESHeader(rom);
        return NINTENDO_SYSTEMS.SNES;
    } catch {
        throw new Error(
            'Unsupported ROM format. Expected NES, SNES, N64, GB, GBC, GBA, or NDS ROM.',
        );
    }
}

export {
    detectNintendoSystem,
};
