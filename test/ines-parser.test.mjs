import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseINESHeader } from '../src/core/ines.mjs';

test('parses Mario.nes iNES metadata correctly', () => {
    const romPath = path.resolve(process.cwd(), 'Mario.nes');
    const romBuffer = fs.readFileSync(romPath);
    const header = parseINESHeader(romBuffer);

    assert.equal(header.format, 'iNES');
    assert.equal(header.mapperId, 0);
    assert.equal(header.mirroring, 'vertical');
    assert.equal(header.prgRomBanks, 2);
    assert.equal(header.chrRomBanks, 1);
    assert.equal(header.hasTrainer, false);
    assert.equal(header.prgRomBytes, 32768);
    assert.equal(header.chrRomBytes, 8192);
});

test('throws when ROM header is invalid', () => {
    const invalidRom = Buffer.alloc(16);

    assert.throws(
        () => parseINESHeader(invalidRom),
        /Invalid iNES header magic/,
    );
});
