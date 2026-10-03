import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createNintendoKernelFromROM } from '../index.mjs';
import { writePNG, writeWAV } from './n64-artifacts.mjs';

// Reference-game input schedules belong here, never in the emulation core.
const scenarios = {
    gb: {
        sha: '0b6670e44cc2edc6fbf32fc78f499e774cf0802019480f2bf7bdb836ee15c433',
        title: 'Operation C (USA)',
        frames: 3000,
        audioStart: 2400,
        captures: [
            [900, 'title'],
            [2500, 'stage'],
            [3000, 'gameplay'],
        ],
        input(kernel, frame) {
            if (frame > 1000 && frame % 120 === 0)
                kernel.pressButton(1, 'START');
            if (frame % 120 === 10) kernel.releaseButton(1, 'START');
            if (frame === 2900) kernel.pressButton(1, 'RIGHT');
            if (frame === 2960) kernel.releaseButton(1, 'RIGHT');
        },
    },
    gba: {
        sha: '7292c8ad88c1416392e5fd98cf2444a4bcc9a612b28c1f736233ad0b1d1eb8a8',
        title: 'Contra Advance (Europe)',
        frames: 1500,
        audioStart: 900,
        captures: [
            [300, 'title'],
            [1200, 'stage'],
            [1500, 'gameplay'],
        ],
        input(kernel, frame) {
            if (frame > 450 && frame % 120 === 0)
                kernel.pressButton(1, 'START');
            if (frame % 120 === 10) kernel.releaseButton(1, 'START');
            if (frame === 1300) kernel.pressButton(1, 'RIGHT');
            if (frame === 1360) kernel.releaseButton(1, 'RIGHT');
        },
    },
    nds: {
        sha: 'b284d4bbc29364787eee7bd1f24ee2a3224367f32401f12b1045d8079ef92253',
        title: 'Chessmaster (Europe)',
        frames: 4794,
        audioStart: 200,
        audioEnd: 800,
        captures: [
            [300, 'language'],
            [600, 'title'],
            [1200, 'profile-menu'],
            [1500, 'keyboard'],
            [1704, 'profile'],
            [4514, 'board'],
            [4794, 'e2-e4'],
        ],
        input(kernel, frame) {
            if (frame === 360 || frame === 1704) kernel.pressButton(1, 'A');
            if (frame === 370 || frame === 1714) kernel.releaseButton(1, 'A');
            if ([450, 850, 1150].includes(frame))
                kernel.setTouch(128, 120, true);
            if ([465, 865, 1165].includes(frame))
                kernel.setTouch(128, 120, false);
            if (frame === 1300) kernel.setTouch(55, 171, true);
            if (frame === 1315) kernel.setTouch(55, 171, false);
            const letters = [
                [58, 82],
                [106, 121],
                [87, 82],
                [196, 82],
                [111, 103],
                [215, 103],
                [235, 121],
            ];
            const index = Math.floor((frame - 1500) / 12);
            if (index >= 0 && index < letters.length) {
                if ((frame - 1500) % 12 === 0)
                    kernel.setTouch(...letters[index], true);
                if ((frame - 1500) % 12 === 6)
                    kernel.setTouch(...letters[index], false);
            }
            if (frame >= 1914 && frame < 4514) {
                const start = frame < 2914 ? 1914 : 2914;
                if ((frame - start) % 120 === 0) kernel.pressButton(1, 'A');
                if ((frame - start) % 120 === 10) kernel.releaseButton(1, 'A');
            }
            if (frame === 4514) kernel.setTouch(112, 156, true);
            if (frame === 4522) kernel.setTouch(112, 156, false);
            if (frame === 4534) kernel.setTouch(112, 108, true);
            if (frame === 4542) kernel.setTouch(112, 108, false);
        },
    },
};

let system = process.argv[2] ?? 'all';
let romPath,
    output = path.resolve('tmp/handheld/verification');
for (let i = 3; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--rom') romPath = process.argv[++i];
    else if (process.argv[i] === '--output')
        output = path.resolve(process.argv[++i]);
    else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
if (system === '--help') {
    console.log(
        'Usage: node src/cli/verify-handhelds.mjs <gb|gba|nds|all> [--rom <path>] [--output <dir>]',
    );
    console.log(
        'GB_ROM, GBA_ROM and NDS_ROM provide external reference ROMs. No ROM is bundled.',
    );
    process.exit(0);
}
if (system !== 'all' && !scenarios[system])
    throw new Error(`Unknown scenario: ${system}`);
if (system === 'all' && romPath) throw new Error('--rom requires one system.');

function signal(samples) {
    const windows = [];
    let peak = 0,
        clipped = 0;
    for (let offset = 0; offset < samples.length; offset += 88200) {
        const end = Math.min(samples.length, offset + 88200);
        let energy = 0;
        for (let i = offset; i < end; i += 1) {
            const value = samples[i];
            assert.ok(Number.isFinite(value), 'Audio samples must be finite.');
            peak = Math.max(peak, Math.abs(value));
            if (Math.abs(value) >= 0.999) clipped += 1;
            energy += value * value;
        }
        windows.push(Math.sqrt(energy / (end - offset)));
    }
    assert.ok(peak > 0.02, 'Reference audio must be audible, not silent.');
    assert.ok(
        windows.filter((rms) => rms > 0.002).length >= 3,
        'Audio must persist across multiple one-second windows.',
    );
    assert.ok(
        clipped / samples.length < 0.01,
        'Audio must not be heavily clipped.',
    );
    return {
        samples: samples.length / 2,
        seconds: samples.length / 88200,
        peak,
        clipped,
        rmsPerSecond: windows,
    };
}

for (const name of system === 'all' ? Object.keys(scenarios) : [system]) {
    const scenario = scenarios[name];
    const file = romPath ?? process.env[`${name.toUpperCase()}_ROM`];
    if (!file)
        throw new Error(
            `Supply ${name.toUpperCase()}_ROM or --rom. No reference ROM is bundled.`,
        );
    const rom = fs.readFileSync(file);
    const sha = createHash('sha256').update(rom).digest('hex');
    assert.equal(
        sha,
        scenario.sha,
        `This scenario requires ${scenario.title}.`,
    );
    const directory = path.join(output, name);
    fs.mkdirSync(directory, { recursive: true });
    const audio = [];
    let capture = false;
    const { kernel, system: detected } = createNintendoKernelFromROM(rom, {
        onAudioFrame: (left, right) => {
            if (capture) audio.push(left, right);
        },
    });
    assert.equal(detected, name);
    const metadata = kernel.loadROMBuffer(rom);
    const report = {
        system: name,
        sha256: sha,
        frames: [],
        audio: null,
        replay: null,
    };
    const checkpoints = new Map(scenario.captures);
    const start = performance.now();
    for (let frame = 0; frame < scenario.frames; frame += 1) {
        scenario.input(kernel, frame);
        capture =
            frame >= scenario.audioStart &&
            frame < (scenario.audioEnd ?? scenario.frames);
        kernel.runFrame();
        if (checkpoints.has(frame + 1)) {
            const label = checkpoints.get(frame + 1),
                colors = new Set(kernel.lastFrameBuffer).size;
            const image = `${frame + 1}-${label}.png`;
            writePNG(
                path.join(directory, image),
                kernel.lastFrameBuffer,
                metadata.screen.width,
                metadata.screen.height,
            );
            assert.ok(
                colors >= 3,
                `Frame ${frame + 1} is not a rendered scene.`,
            );
            report.frames.push({
                frame: frame + 1,
                image,
                colors,
                checksum: kernel.lastFrameChecksum,
            });
            console.log(
                `${name}: frame ${frame + 1}, ${label}, ${colors} colors`,
            );
        }
    }
    if (name === 'nds') {
        assert.equal(
            report.frames.at(-2).checksum,
            3354448841,
            'The reference must reach the interactive chess board.',
        );
        assert.equal(
            report.frames.at(-1).checksum,
            1933705762,
            'Touch e2-e4 must move the pawn and receive an opponent reply.',
        );
    }
    report.audio = signal(audio);
    writeWAV(path.join(directory, 'stereo.wav'), audio);
    const state = kernel.saveState();
    audio.length = 0;
    capture = true;
    kernel.runFrames(6);
    const expected = kernel.saveState(),
        expectedAudio = audio.slice();
    const { kernel: reloaded } = createNintendoKernelFromROM(rom, {
        onAudioFrame: (left, right) => audio.push(left, right),
    });
    reloaded.loadROMBuffer(rom);
    reloaded.loadState(state);
    audio.length = 0;
    reloaded.runFrames(6);
    assert.deepEqual(
        reloaded.saveState(),
        expected,
        'Copied state replay must be deterministic.',
    );
    assert.deepEqual(
        audio,
        expectedAudio,
        'Audio replay must be deterministic.',
    );
    report.replay = { frames: 6, freshKernel: true, deterministic: true };
    report.elapsedSeconds = (performance.now() - start) / 1000;
    fs.writeFileSync(
        path.join(directory, 'report.json'),
        JSON.stringify(report, null, 2),
    );
    console.log(
        `${name}: audio peak ${report.audio.peak.toFixed(3)}, replay passed`,
    );
}
