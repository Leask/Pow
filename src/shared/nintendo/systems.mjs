const NINTENDO_SYSTEMS = Object.freeze({
    NES: 'nes',
    SNES: 'snes',
    N64: 'n64',
    GB: 'gb',
    GBC: 'gbc',
    GBA: 'gba',
    NDS: 'nds',
});

function normalizeNintendoSystem(system) {
    const normalized = String(system ?? '').trim().toLowerCase();

    if (Object.values(NINTENDO_SYSTEMS).includes(normalized)) return normalized;

    throw new RangeError(
        `Unsupported system "${system}". ` +
            'Use: nes, snes, n64, gb, gbc, gba, or nds.',
    );
}

export {
    NINTENDO_SYSTEMS,
    normalizeNintendoSystem,
};
