import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonLatch } from '../web/button-latch.mjs';

test('short controller taps survive polling and held keys release promptly', () => {
    const events = [];
    const latch = new ButtonLatch(
        (key) => events.push(['press', key]),
        (key) => events.push(['release', key]),
    );
    latch.update('A', true, 10, 3);
    latch.update('A', false, 10, 3);
    latch.advance(12);
    assert.deepEqual(events, [['press', 'A']]);
    latch.advance(13);
    assert.deepEqual(events[1], ['release', 'A']);
    latch.update('B', true, 20, 3);
    latch.update('B', true, 25, 3);
    latch.update('B', false, 26, 3);
    assert.deepEqual(events.slice(2), [
        ['press', 'B'],
        ['release', 'B'],
    ]);
    latch.update('START', true, 30, 3);
    latch.clear();
    assert.deepEqual(events.at(-1), ['release', 'START']);
    assert.equal(latch.buttons.size, 0);
});
