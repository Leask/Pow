import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createNintendoKernel,
    createNintendoKernelFromROM,
    detectNintendoSystem,
} from '../src/index.mjs';
import { NESKernel } from '../src/core/nes-kernel.mjs';
import { SNESKernel } from '../src/core/snes/snes-kernel.mjs';

test('detectNintendoSystem identifies NES and SNES ROMs', () => {
    const nesRomPath = path.resolve(process.cwd(), 'Mario.nes');
    const snesRomPath = path.resolve(process.cwd(), 'Mario World.smc');
    const nesRom = fs.readFileSync(nesRomPath);
    const snesRom = fs.readFileSync(snesRomPath);

    assert.equal(detectNintendoSystem(nesRom), 'nes');
    assert.equal(detectNintendoSystem(snesRom), 'snes');
});

test('createNintendoKernel creates requested kernel type', () => {
    assert.ok(createNintendoKernel('nes') instanceof NESKernel);
    assert.ok(createNintendoKernel('snes') instanceof SNESKernel);
});

test('createNintendoKernelFromROM returns kernel matching ROM format', () => {
    const nesRomPath = path.resolve(process.cwd(), 'Mario.nes');
    const snesRomPath = path.resolve(process.cwd(), 'Mario World.smc');
    const nesRom = fs.readFileSync(nesRomPath);
    const snesRom = fs.readFileSync(snesRomPath);

    const nesResult = createNintendoKernelFromROM(nesRom);
    const snesResult = createNintendoKernelFromROM(snesRom);

    assert.equal(nesResult.system, 'nes');
    assert.equal(snesResult.system, 'snes');
    assert.ok(nesResult.kernel instanceof NESKernel);
    assert.ok(snesResult.kernel instanceof SNESKernel);
});
