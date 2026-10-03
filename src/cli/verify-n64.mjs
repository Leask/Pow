import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { N64Kernel } from '../core/n64/n64-kernel.mjs';
import { normalizeN64ROM } from '../core/n64/rom.mjs';
import { writePNG, writeWAV } from './n64-artifacts.mjs';

const expectedSHA =
    '17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91';
let romPath = process.env.N64_ROM;
let output = path.resolve('tmp/n64/verification');
for (let i = 2; i < process.argv.length; i += 1) {
    const argument = process.argv[i];
    if (argument === '--rom') romPath = process.argv[++i];
    else if (argument === '--output') output = path.resolve(process.argv[++i]);
    else if (argument === '--help') {
        console.log(
            'Usage: npm run smoke:n64 -- --rom <SM64 US ROM> [--output <dir>]',
        );
        console.log(
            'N64_ROM can supply the ROM path. Runs boot, menus, movement, audio and replay checks.',
        );
        process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
}
if (!romPath)
    throw new Error(
        'Supply --rom <path> or set N64_ROM. No N64 ROM is bundled.',
    );
const rom = fs.readFileSync(romPath);
const sha256 = createHash('sha256')
    .update(normalizeN64ROM(rom).bytes)
    .digest('hex');
assert.equal(
    sha256,
    expectedSHA,
    'This scenario requires the original Super Mario 64 NTSC-U ROM.',
);
fs.mkdirSync(output, { recursive: true });

const audio = [];
let capture = false;
const kernel = new N64Kernel({
    onAudioFrame: (left, right) => {
        if (capture) audio.push(left, right);
    },
});
kernel.loadROMBuffer(rom);
const report = { sha256, frames: [], controls: [], audio: null, replay: null };
const captures = new Map([
    [240, 'logo'],
    [480, 'title'],
    [600, 'file-select'],
    [1100, 'letter'],
    [2400, 'castle'],
    [3400, 'mario'],
    [3800, 'jump'],
    [4000, 'before-walk'],
    [4150, 'after-walk'],
    [4300, 'courtyard'],
]);
const now = performance.now();

// Game-specific addresses are diagnostic assertions only, never core behavior.
function position() {
    return [0x33b1ac, 0x33b1b0, 0x33b1b4].map((address) =>
        kernel.bus.ramView.getFloat32(address),
    );
}

for (let frame = 1; frame <= 4300; frame += 1) {
    if (frame === 520) kernel.pressButton(1, 'START');
    if (frame === 524) kernel.releaseButton(1, 'START');
    if (frame === 640) kernel.pressButton(1, 'A');
    if (frame === 644) kernel.releaseButton(1, 'A');
    if (frame >= 3500 && frame % 60 === 0) kernel.pressButton(1, 'A');
    if (frame >= 3500 && frame % 60 === 6) kernel.releaseButton(1, 'A');
    if (frame === 4000) kernel.setAnalogStick(1, 0, 70);
    if (frame === 4150) kernel.setAnalogStick(1, 0, 0);
    capture = frame > 3700;
    kernel.runFrame();
    if (captures.has(frame)) {
        const name = `${frame}-${captures.get(frame)}.png`;
        writePNG(path.join(output, name), kernel.lastFrameBuffer, 320, 240);
        const colors = new Set(kernel.lastFrameBuffer).size;
        assert.ok(
            colors > 50,
            `Frame ${frame} must contain a rendered scene, not a solid screen.`,
        );
        report.frames.push({
            frame,
            file: name,
            colors,
            checksum: kernel.lastFrameChecksum,
        });
        if (frame >= 3400)
            report.controls.push({ frame, position: position() });
        console.log(`Frame ${frame}: ${captures.get(frame)}, ${colors} colors`);
    }
}
const positions = new Map(
    report.controls.map((item) => [item.frame, item.position]),
);
assert.ok(
    positions.get(3800)[1] > positions.get(3400)[1] + 50,
    'A must make Mario jump.',
);
assert.ok(
    Math.abs(positions.get(4150)[2] - positions.get(4000)[2]) > 500,
    'Analog input must move Mario through the world.',
);

writeWAV(path.join(output, 'courtyard-stereo.wav'), audio);
const windows = [];
let clipped = 0;
let stereoDifference = 0;
for (let start = 0; start < audio.length; start += 88200) {
    const end = Math.min(audio.length, start + 88200);
    let energy = 0;
    let nonzero = 0;
    for (let i = start; i < end; i += 1) {
        assert.ok(Number.isFinite(audio[i]) && Math.abs(audio[i]) <= 1);
        energy += audio[i] ** 2;
        if (Math.abs(audio[i]) > 0.0001) nonzero += 1;
        if (Math.abs(audio[i]) >= 0.999) clipped += 1;
        if ((i & 1) === 0)
            stereoDifference += Math.abs(audio[i] - audio[i + 1]);
    }
    const rms = Math.sqrt(energy / (end - start));
    windows.push({ rms, nonzeroFraction: nonzero / (end - start) });
    assert.ok(
        rms > 0.002 && rms < 0.8,
        'Every gameplay audio second must carry an unsaturated signal.',
    );
    assert.ok(
        nonzero / (end - start) > 0.9,
        'Gameplay music must be sustained.',
    );
}
report.audio = {
    seconds: audio.length / 88200,
    windows,
    clippedFraction: clipped / audio.length,
    stereoDifference,
};
assert.ok(
    report.audio.clippedFraction < 0.001,
    'PCM must not be persistently clipped.',
);
assert.ok(
    stereoDifference > 1,
    'Stereo output must preserve channel differences.',
);

capture = false;
const state = kernel.saveState();
const replayStart = audio.length;
capture = true;
kernel.runFrames(20);
const expected = kernel.getExecutionState();
const expectedSnapshot = kernel.saveState();
const expectedAudio = audio.slice(replayStart);
audio.length = replayStart;
kernel.loadState(state);
kernel.runFrames(20);
capture = false;
assert.deepEqual(kernel.getExecutionState(), expected);
assert.deepEqual(kernel.saveState(), expectedSnapshot);
assert.deepEqual(audio.slice(replayStart), expectedAudio);
report.replay = '20-frame full-state and stereo replay matched';
report.finalState = expected;
report.wallSeconds = (performance.now() - now) / 1000;
fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 4),
);
console.log(
    JSON.stringify(
        {
            result: 'passed',
            output,
            seconds: report.wallSeconds,
            audioSeconds: report.audio.seconds,
            replay: report.replay,
        },
        null,
        4,
    ),
);
