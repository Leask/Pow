'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { NESKernel } = require('../src/core/nes-kernel');

test('loads Mario.nes and executes frames without crashing', () => {
    const romPath = path.resolve(__dirname, '..', 'Mario.nes');
    const kernel = new NESKernel({ emulateSound: false });
    const metadata = kernel.loadROMFromFile(romPath);

    assert.equal(metadata.mapper, 0);

    const stateBefore = kernel.getExecutionState();
    kernel.runFrames(30);
    const stateAfter = kernel.getExecutionState();

    assert.equal(stateBefore.frameCount, 0);
    assert.equal(stateAfter.frameCount, 30);
    assert.notEqual(stateAfter.lastFrameChecksum, null);
    assert.equal(typeof stateAfter.lastFrameChecksum, 'number');
    assert.notEqual(stateAfter.cpu, null);
});

test('supports basic button input calls', () => {
    const romPath = path.resolve(__dirname, '..', 'Mario.nes');
    const kernel = new NESKernel({ emulateSound: false });

    kernel.loadROMFromFile(romPath);
    kernel.pressButton(1, 'START');
    kernel.runFrames(1);
    kernel.releaseButton(1, 'START');
    kernel.runFrames(1);

    assert.equal(kernel.getExecutionState().frameCount, 2);
});
