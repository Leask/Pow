import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SNESKernel } from '../src/core/snes/snes-kernel.mjs';

const ROM_PATH = path.resolve(process.cwd(), 'Mario World.smc');

function runMarioWorldFrames(frameTarget) {
    const romData = fs.readFileSync(ROM_PATH);
    const kernel = new SNESKernel({
        strictOpcodes: true,
    });

    kernel.loadROMBuffer(romData);

    const checkpoints = [
        Math.floor(frameTarget * 0.25),
        Math.floor(frameTarget * 0.5),
        Math.floor(frameTarget * 0.75),
        frameTarget,
    ];
    const checksums = [];

    for (let frame = 1; frame <= frameTarget; frame += 1) {
        kernel.runFrame();

        if (checkpoints.includes(frame)) {
            checksums.push(kernel.getExecutionState().lastFrameChecksum);
        }
    }

    return {
        kernel,
        checksums,
    };
}

test('Mario World.smc runs stably for 5,000 SNES frames', () => {
    const frameTarget = 5000;
    const { kernel, checksums } = runMarioWorldFrames(frameTarget);
    const state = kernel.getExecutionState();

    assert.equal(state.system, 'snes');
    assert.equal(state.frameCount, frameTarget);
    assert.equal(state.ppu.height, 224);
    assert.equal(state.ppu.width, 256);
    assert.equal(typeof state.lastFrameChecksum, 'number');
    assert.ok(Number.isInteger(state.cpu.totalCycles));

    const uniqueChecksums = new Set(checksums);
    assert.ok(uniqueChecksums.size >= 2);
});

test('Mario World.smc remains deterministic across repeated runs', () => {
    const frameTarget = 1200;
    const runOne = runMarioWorldFrames(frameTarget);
    const runTwo = runMarioWorldFrames(frameTarget);

    const stateOne = runOne.kernel.getExecutionState();
    const stateTwo = runTwo.kernel.getExecutionState();

    assert.equal(stateOne.lastFrameChecksum, stateTwo.lastFrameChecksum);
    assert.equal(stateOne.cpu.totalCycles, stateTwo.cpu.totalCycles);
    assert.deepEqual(runOne.checksums, runTwo.checksums);
});
