import { NESKernel } from './nes-kernel.mjs';
import { SNESKernel } from './snes/snes-kernel.mjs';
import { detectNintendoSystem } from './system-detect.mjs';
import {
    NINTENDO_SYSTEMS,
    normalizeNintendoSystem,
} from '../shared/nintendo/systems.mjs';

function createNintendoKernel(system, options = {}) {
    const normalized = normalizeNintendoSystem(system);

    if (normalized === NINTENDO_SYSTEMS.NES) {
        return new NESKernel(options);
    }

    if (normalized === NINTENDO_SYSTEMS.SNES) {
        return new SNESKernel(options);
    }

    throw new Error(`Unsupported system: ${system}`);
}

function createNintendoKernelFromROM(romData, options = {}) {
    const system = detectNintendoSystem(romData);

    return {
        system,
        kernel: createNintendoKernel(system, options),
    };
}

export {
    createNintendoKernel,
    createNintendoKernelFromROM,
};
