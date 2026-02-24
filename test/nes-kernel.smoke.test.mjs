import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NESKernel } from '../src/core/nes-kernel.mjs';

test('loads Mario.nes and executes frames without crashing', () => {
    const romPath = path.resolve(process.cwd(), 'Mario.nes');
    const romData = fs.readFileSync(romPath);
    const kernel = new NESKernel();
    const metadata = kernel.loadROMBuffer(romData);

    assert.equal(metadata.mapperId, 0);

    const stateBefore = kernel.getExecutionState();
    kernel.runFrames(30);
    const stateAfter = kernel.getExecutionState();

    assert.equal(stateBefore.frameCount, 0);
    assert.equal(stateAfter.frameCount, 30);
    assert.notEqual(stateAfter.lastFrameChecksum, null);
    assert.equal(typeof stateAfter.lastFrameChecksum, 'number');
    assert.notEqual(stateAfter.cpu, null);
    assert.equal(stateAfter.unsupportedOpcodes.length, 0);
});

test('supports basic button input calls', () => {
    const romPath = path.resolve(process.cwd(), 'Mario.nes');
    const romData = fs.readFileSync(romPath);
    const kernel = new NESKernel();

    kernel.loadROMBuffer(romData);
    kernel.pressButton(1, 'START');
    kernel.runFrames(1);
    kernel.releaseButton(1, 'START');
    kernel.runFrames(1);

    assert.equal(kernel.getExecutionState().frameCount, 2);
});

test('can save and restore deterministic state', () => {
    const romPath = path.resolve(process.cwd(), 'Mario.nes');
    const romData = fs.readFileSync(romPath);
    const kernel = new NESKernel();

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
