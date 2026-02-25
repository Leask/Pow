import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSNESHeader } from '../src/core/snes/smc.mjs';

test('parses Mario World.smc SNES metadata correctly', () => {
    const romPath = path.resolve(process.cwd(), 'Mario World.smc');
    const romBuffer = fs.readFileSync(romPath);
    const header = parseSNESHeader(romBuffer);

    assert.equal(header.format, 'SNES');
    assert.equal(header.system, 'snes');
    assert.equal(header.layout, 'lorom');
    assert.equal(header.mapMode, 0x20);
    assert.equal(header.hasCopierHeader, true);
    assert.equal(header.title, 'SUPER MARIOWORLD');
    assert.equal(header.region, 'USA/Canada');
});

test('throws when SNES ROM is too small', () => {
    const invalidRom = new Uint8Array(32);

    assert.throws(
        () => parseSNESHeader(invalidRom),
        /too small/i,
    );
});
