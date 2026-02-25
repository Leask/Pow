import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SNESKernel } from '../src/core/snes/snes-kernel.mjs';

test('loads Mario World.smc and executes frames without crashing', () => {
    const romPath = path.resolve(process.cwd(), 'Mario World.smc');
    const romData = fs.readFileSync(romPath);
    const kernel = new SNESKernel();
    const metadata = kernel.loadROMBuffer(romData);

    assert.equal(metadata.format, 'SNES');
    assert.equal(metadata.layout, 'lorom');

    const stateBefore = kernel.getExecutionState();
    kernel.runFrames(10);
    const stateAfter = kernel.getExecutionState();

    assert.equal(stateBefore.frameCount, 0);
    assert.equal(stateAfter.frameCount, 10);
    assert.notEqual(stateAfter.lastFrameChecksum, null);
    assert.equal(typeof stateAfter.lastFrameChecksum, 'number');
    assert.equal(stateAfter.system, 'snes');
});

test('supports SNES button input calls', () => {
    const romPath = path.resolve(process.cwd(), 'Mario World.smc');
    const romData = fs.readFileSync(romPath);
    const kernel = new SNESKernel();

    kernel.loadROMBuffer(romData);
    kernel.pressButton(1, 'X');
    kernel.runFrames(1);
    kernel.releaseButton(1, 'X');
    kernel.runFrames(1);

    assert.equal(kernel.getExecutionState().frameCount, 2);
});

test('can save and restore deterministic SNES kernel state', () => {
    const romPath = path.resolve(process.cwd(), 'Mario World.smc');
    const romData = fs.readFileSync(romPath);
    const kernel = new SNESKernel();

    kernel.loadROMBuffer(romData);
    kernel.runFrames(5);
    const snapshot = kernel.saveState();
    kernel.runFrames(20);
    const checksumAfter20 = kernel.getExecutionState().lastFrameChecksum;

    kernel.loadState(snapshot);
    kernel.runFrames(20);
    const checksumReloaded = kernel.getExecutionState().lastFrameChecksum;

    assert.equal(checksumReloaded, checksumAfter20);
});
