import test from 'node:test';
import assert from 'node:assert/strict';
import { N64Kernel } from '../src/index.mjs';

function testROM() {
    const rom = new Uint8Array(8192);
    rom.set([0x80, 0x37, 0x12, 0x40]);
    const view = new DataView(rom.buffer);
    view.setUint32(8, 0x80000400);
    view.setUint32(0x1000, 0x1000ffff); // BEQ zero, zero, self; NOP.
    rom[0x3e] = 0x45;
    return rom;
}

test('N64 public kernel replays copied snapshots and stereo callbacks', () => {
    let samples = [];
    const kernel = new N64Kernel({
        onAudioFrame: (left, right) => samples.push([left, right]),
    });
    kernel.loadROMBuffer(testROM());
    kernel.cpu.cp0[12] |= 1;
    kernel.pressButton(1, 'A');
    kernel.setAnalogStick(1, -65, 70);
    kernel.runFrame();
    const state = structuredClone(kernel.saveState());
    samples = [];
    kernel.runFrames(2);
    const expected = kernel.getExecutionState();
    const audio = samples;
    kernel.releaseButton(1, 'A');
    kernel.setAnalogStick(1, 0, 0);
    kernel.loadState(state);
    samples = [];
    kernel.runFrames(2);
    assert.deepEqual(kernel.getExecutionState(), expected);
    assert.deepEqual(samples, audio);
    assert.equal(samples.length, 1470);
    assert.equal(kernel.bus.controllers[0].buttons, 0x8000);
    assert.equal(kernel.bus.controllers[0].stickX, -65);
});

test('N64 reset retains EEPROM but loading another cartridge does not', () => {
    const kernel = new N64Kernel();
    assert.throws(() => kernel.runFrame(), /No ROM/);
    kernel.loadROMBuffer(testROM());
    kernel.bus.eeprom[10] = 42;
    kernel.reset();
    assert.equal(kernel.bus.eeprom[10], 42);
    kernel.loadROMBuffer(testROM());
    assert.equal(kernel.bus.eeprom[10], 255);
    assert.throws(() => kernel.runFrames(0), /positive integer/);
    assert.throws(() => kernel.pressButton(0, 'A'), /1 through 4/);
});
