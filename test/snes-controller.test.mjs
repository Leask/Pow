import test from 'node:test';
import assert from 'node:assert/strict';
import { SNESController } from '../src/core/snes/controller.mjs';

test('SNESController auto-joypad word uses SNES bit layout', () => {
    const controller = new SNESController();
    controller.setButton('B', true);
    controller.setButton('START', true);
    controller.setButton('A', true);
    controller.setButton('R', true);
    controller.latch();

    const word = controller.getLatchedState();
    const expected =
        (1 << 15) |
        (1 << 12) |
        (1 << 7) |
        (1 << 4);

    assert.equal(word, expected);
});

test('SNESController serial read order matches standard pad order', () => {
    const controller = new SNESController();
    controller.setButton('B', true);
    controller.setButton('SELECT', true);
    controller.setButton('RIGHT', true);
    controller.setButton('X', true);
    controller.setButton('R', true);

    controller.setStrobe(true);
    assert.equal(controller.readSerialBit(), 1);

    controller.setStrobe(false);

    const bits = [];

    for (let index = 0; index < 16; index += 1) {
        bits.push(controller.readSerialBit());
    }

    assert.deepEqual(bits, [
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0,
    ]);
    assert.equal(controller.readSerialBit(), 1);
});
