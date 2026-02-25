import { readAscii, toByteArray } from '../../shared/nintendo/rom-buffer.mjs';

const SNES_HEADER_SIZE = 0x50;
const SNES_TITLE_LENGTH = 21;

const HEADER_CANDIDATES = Object.freeze([
    {
        offset: 0x7fc0,
        layout: 'lorom',
    },
    {
        offset: 0xffc0,
        layout: 'hirom',
    },
]);

const REGION_NAMES = Object.freeze({
    0x00: 'Japan',
    0x01: 'USA/Canada',
    0x02: 'Europe',
    0x03: 'Sweden',
    0x04: 'Finland',
    0x05: 'Denmark',
    0x06: 'France',
    0x07: 'Netherlands',
    0x08: 'Spain',
    0x09: 'Germany/Austria/Switzerland',
    0x0a: 'Italy',
    0x0b: 'Hong Kong/China',
    0x0c: 'Indonesia',
    0x0d: 'South Korea',
});

function hasCopierHeader(romLength) {
    return (romLength & 0x3ff) === 0x200;
}

function isPrintableAscii(code) {
    return code >= 0x20 && code <= 0x7e;
}

function scoreCandidate(rom, headerOffset, layout) {
    const mapMode = rom[headerOffset + 0x15];
    const checksumComplement =
        rom[headerOffset + 0x1c] | (rom[headerOffset + 0x1d] << 8);
    const checksum =
        rom[headerOffset + 0x1e] | (rom[headerOffset + 0x1f] << 8);
    const resetVector =
        rom[headerOffset + 0x3c] | (rom[headerOffset + 0x3d] << 8);

    let score = 0;

    if ((checksumComplement ^ checksum) === 0xffff) {
        score += 8;
    }

    if (resetVector >= 0x8000 && resetVector <= 0xffff) {
        score += 4;
    }

    if (layout === 'lorom' && (mapMode & 0x01) === 0) {
        score += 3;
    }

    if (layout === 'hirom' && (mapMode & 0x01) === 1) {
        score += 3;
    }

    let printableCount = 0;

    for (let index = 0; index < SNES_TITLE_LENGTH; index += 1) {
        const code = rom[headerOffset + index];

        if (isPrintableAscii(code) || code === 0) {
            printableCount += 1;
        }
    }

    score += Math.floor((printableCount / SNES_TITLE_LENGTH) * 4);
    return score;
}

function parseCandidate(rom, headerOffset, layout, copierHeaderBytes) {
    const title = readAscii(rom, headerOffset, SNES_TITLE_LENGTH).trim();
    const mapMode = rom[headerOffset + 0x15];
    const cartridgeType = rom[headerOffset + 0x16];
    const romSizeCode = rom[headerOffset + 0x17];
    const sramSizeCode = rom[headerOffset + 0x18];
    const regionCode = rom[headerOffset + 0x19];
    const licenseeCode = rom[headerOffset + 0x1a];
    const version = rom[headerOffset + 0x1b];
    const checksumComplement =
        rom[headerOffset + 0x1c] | (rom[headerOffset + 0x1d] << 8);
    const checksum =
        rom[headerOffset + 0x1e] | (rom[headerOffset + 0x1f] << 8);
    const nativeResetVector =
        rom[headerOffset + 0x3c] | (rom[headerOffset + 0x3d] << 8);
    const emulationResetVector =
        rom[headerOffset + 0x4c] | (rom[headerOffset + 0x4d] << 8);
    const romBytes = 1 << (romSizeCode + 10);
    const sramBytes = sramSizeCode === 0 ? 0 : (1 << (sramSizeCode + 10));

    return {
        system: 'snes',
        format: 'SNES',
        layout,
        mapMode,
        mapperId: mapMode,
        fastRom: (mapMode & 0x10) !== 0,
        title,
        cartridgeType,
        romSizeCode,
        sramSizeCode,
        romBytes,
        sramBytes,
        regionCode,
        region: REGION_NAMES[regionCode] ?? 'Unknown',
        licenseeCode,
        version,
        checksum,
        checksumComplement,
        hasCopierHeader: copierHeaderBytes > 0,
        copierHeaderBytes,
        headerOffset,
        nativeResetVector,
        emulationResetVector,
    };
}

function parseSNESHeader(data) {
    const rom = toByteArray(data);

    if (rom.length < 0x8000) {
        throw new RangeError('ROM is too small for SNES header parsing.');
    }

    const copierHeaderBytes = hasCopierHeader(rom.length) ? 512 : 0;
    const baseOffset = copierHeaderBytes;
    const parsedCandidates = [];

    for (const candidate of HEADER_CANDIDATES) {
        const headerOffset = baseOffset + candidate.offset;
        const headerEnd = headerOffset + SNES_HEADER_SIZE;

        if (headerEnd > rom.length) {
            continue;
        }

        const score = scoreCandidate(rom, headerOffset, candidate.layout);
        const metadata = parseCandidate(
            rom,
            headerOffset,
            candidate.layout,
            copierHeaderBytes,
        );

        parsedCandidates.push({
            score,
            metadata,
        });
    }

    if (parsedCandidates.length === 0) {
        throw new Error('Unable to locate a valid SNES header.');
    }

    parsedCandidates.sort((left, right) => right.score - left.score);
    const best = parsedCandidates[0];

    if (best.score < 7) {
        throw new Error('Unable to validate SNES ROM header heuristics.');
    }

    return best.metadata;
}

function splitSMCRom(data) {
    const rom = toByteArray(data);
    const header = parseSNESHeader(rom);
    const contentStart = header.copierHeaderBytes;

    return {
        header,
        rom: rom.subarray(contentStart),
    };
}

export {
    parseSNESHeader,
    splitSMCRom,
    SNES_HEADER_SIZE,
    SNES_TITLE_LENGTH,
};
