import fs from 'node:fs';
import path from 'node:path';
import { normalizeN64ROM, parseN64Header } from '../core/n64/rom.mjs';
import { N64Bus } from '../core/n64/bus.mjs';
import { VR4300 } from '../core/n64/cpu-vr4300.mjs';
import { bootN64 } from '../core/n64/boot.mjs';
import { RSPAudio } from '../core/n64/rsp-audio.mjs';
import { RSPGraphics } from '../core/n64/rsp-graphics.mjs';
import { VideoInterface } from '../core/n64/video-interface.mjs';

const romPath = process.argv[2] ?? process.env.N64_ROM;
if (!romPath)
    throw new Error('Usage: node src/cli/debug-n64.mjs <ROM> [frames]');
const data = fs.readFileSync(romPath);
const header = parseN64Header(data);
const output = path.resolve('tmp/n64');
fs.mkdirSync(output, { recursive: true });
const bus = new N64Bus(normalizeN64ROM(data).bytes, { region: header.region });
const cpu = new VR4300(bus);
const audio = new RSPAudio(bus);
const graphics = new RSPGraphics(bus);
const video = new VideoInterface(bus);
bus.onTask = (task) => {
    if (task.type === 2) audio.run(task);
    else if (task.type === 1) graphics.run(task);
    else throw new Error(`Unhandled RSP task type ${task.type}`);
};
bootN64(cpu, bus, header);
const frames = Number(process.argv[3] ?? 60);
if (!Number.isInteger(frames) || frames <= 0) {
    throw new RangeError('frames must be a positive integer.');
}
const history = new Uint32Array(32);
let n = 0;
let failure = null;
try {
    while (bus.frame < frames) {
        history[n++ & 31] = cpu.pc;
        bus.clock(cpu.step());
    }
} catch (error) {
    failure = error.stack;
}
fs.writeFileSync(path.join(output, 'rdram.bin'), bus.ram);
fs.writeFileSync(path.join(output, 'sp.bin'), bus.spMem);
const report = {
    header,
    failure,
    frame: bus.frame,
    instructions: cpu.instructions,
    pc: cpu.pc.toString(16),
    exceptions: cpu.exceptionCount,
    registers: [...cpu.lo].map((value) => value.toString(16)),
    cp0: [...cpu.cp0].map((value) => value.toString(16)),
    vi: [...bus.vi],
    interrupts: [bus.miMask, bus.miInterrupt],
    lastTask: bus.lastTask,
    tasks: bus.taskCounts,
    audio: { nonzero: bus.audio.nonzeroSamples, peak: bus.audio.peak },
    graphics: {
        triangles: graphics.rdp.triangles,
        pixels: graphics.rdp.pixels,
        trace: graphics.trace.map((entry) =>
            entry.map((value) => value.toString(16)),
        ),
    },
    history: Array.from({ length: 32 }, (_, i) =>
        history[(n + i) & 31].toString(16),
    ),
};
fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 4),
);
const pixels = video.render();
const rgb = Buffer.alloc(pixels.length * 3);
pixels.forEach((color, index) => {
    rgb[index * 3] = (color >>> 16) & 255;
    rgb[index * 3 + 1] = (color >>> 8) & 255;
    rgb[index * 3 + 2] = color & 255;
});
fs.writeFileSync(
    path.join(output, 'frame.ppm'),
    Buffer.concat([
        Buffer.from(`P6\n${video.width} ${video.height}\n255\n`),
        rgb,
    ]),
);
console.log(JSON.stringify(report, null, 4));
if (failure) process.exitCode = 1;
