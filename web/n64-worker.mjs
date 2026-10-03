import { N64Kernel } from '../src/core/n64/n64-kernel.mjs';
import { ButtonLatch } from './button-latch.mjs';

let kernel;
let epoch = 0;
let running = false;
let timer;
let submitted = 0;
let played = 0;
let target = 0;
let samples;
let sampleOffset = 0;
const scheduler = new MessageChannel();
scheduler.port1.onmessage = ({ data }) => {
    if (data === epoch) pump();
};
const buttons = new ButtonLatch(
    (button) => kernel.pressButton(1, button),
    (button) => kernel.releaseButton(1, button),
);

function sendFrame() {
    const pixels = kernel.lastFrameBuffer.slice();
    const audio = samples.slice(0, sampleOffset);
    submitted += sampleOffset / 2;
    sampleOffset = 0;
    self.postMessage(
        {
            type: 'frame',
            epoch,
            pixels,
            audio,
            state: kernel.getExecutionState(),
        },
        [pixels.buffer, audio.buffer],
    );
}

function step() {
    kernel.runFrame();
    buttons.advance(kernel.frameCount);
    sendFrame();
}

function fail(error) {
    running = false;
    clearTimeout(timer);
    self.postMessage({ type: 'error', epoch, message: error.message });
}

function pump() {
    if (!running) return;
    try {
        if (submitted - played < target) step();
        // Audio consumption, not requestAnimationFrame, paces emulation.
        if (submitted - played < target) {
            scheduler.port2.postMessage(epoch);
        } else {
            const token = epoch;
            timer = setTimeout(() => {
                if (token === epoch) pump();
            }, 4);
        }
    } catch (error) {
        fail(error);
    }
}

self.onmessage = ({ data }) => {
    try {
        if (
            data.type === 'load' ||
            data.type === 'reset' ||
            data.type === 'pause'
        ) {
            epoch = data.epoch;
            running = false;
            clearTimeout(timer);
            submitted = played = sampleOffset = 0;
        } else if (data.epoch !== epoch) return;
        switch (data.type) {
            case 'load': {
                buttons.clear();
                const rate = data.sampleRate;
                samples = new Float32Array(Math.ceil(rate / 50) * 2 + 16);
                target = Math.ceil(rate * 0.18);
                kernel = new N64Kernel({
                    sampleRate: rate,
                    onAudioFrame: (left, right) => {
                        samples[sampleOffset++] = left;
                        samples[sampleOffset++] = right;
                    },
                });
                kernel.loadROMBuffer(data.rom);
                break;
            }
            case 'reset':
                buttons.clear();
                kernel.reset();
                break;
            case 'pause':
                sendFrame();
                break;
            case 'step':
                step();
                break;
            case 'start':
                if (!running) {
                    running = true;
                    pump();
                }
                break;
            case 'played':
                played = data.played;
                break;
            case 'button':
                buttons.update(data.button, data.pressed, kernel.frameCount, 3);
                break;
            case 'stick':
                kernel.setAnalogStick(1, data.x, data.y);
                break;
        }
    } catch (error) {
        fail(error);
    }
};
