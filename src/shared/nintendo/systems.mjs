const NINTENDO_SYSTEMS = Object.freeze({
    NES: 'nes',
    SNES: 'snes',
    N64: 'n64',
});

function normalizeNintendoSystem(system) {
    const normalized = String(system ?? '').trim().toLowerCase();

    if (normalized === NINTENDO_SYSTEMS.NES) {
        return NINTENDO_SYSTEMS.NES;
    }

    if (normalized === NINTENDO_SYSTEMS.SNES) {
        return NINTENDO_SYSTEMS.SNES;
    }

    if (normalized === NINTENDO_SYSTEMS.N64) {
        return NINTENDO_SYSTEMS.N64;
    }

    throw new RangeError(
        `Unsupported system "${system}". ` +
        'Use: nes, snes, or n64.',
    );
}

export {
    NINTENDO_SYSTEMS,
    normalizeNintendoSystem,
};
