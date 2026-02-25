const NINTENDO_SYSTEMS = Object.freeze({
    NES: 'nes',
    SNES: 'snes',
});

function normalizeNintendoSystem(system) {
    const normalized = String(system ?? '').trim().toLowerCase();

    if (normalized === NINTENDO_SYSTEMS.NES) {
        return NINTENDO_SYSTEMS.NES;
    }

    if (normalized === NINTENDO_SYSTEMS.SNES) {
        return NINTENDO_SYSTEMS.SNES;
    }

    throw new RangeError(
        `Unsupported system "${system}". ` +
        `Use: ${NINTENDO_SYSTEMS.NES} or ${NINTENDO_SYSTEMS.SNES}.`,
    );
}

export {
    NINTENDO_SYSTEMS,
    normalizeNintendoSystem,
};
