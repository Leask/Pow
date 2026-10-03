import test from 'node:test';
import assert from 'node:assert/strict';
import { N64Bus } from '../src/core/n64/bus.mjs';
import { RDP } from '../src/core/n64/rdp.mjs';
import { RSPGraphics } from '../src/core/n64/rsp-graphics.mjs';
import { RSPAudio } from '../src/core/n64/rsp-audio.mjs';
import { VideoInterface } from '../src/core/n64/video-interface.mjs';

test('RDP material interpolation fast path matches the generic combiner', () => {
    const rdp = new RDP(new N64Bus(new Uint8Array(4096)));
    rdp.combiner[1] = [3, 4, 1, 4, 3, 4, 1, 4];
    for (let i = 0; i < 256; i += 7) {
        const shade = [i, 255 - i, 100.4, i / 2];
        const texel = [40.8, i, 255, 255 - i];
        rdp.primitive = [255 - i, 50.1, i, 123];
        rdp.fastRGB = rdp.fastAlpha = -1;
        const expected = rdp.combineColor(shade, texel);
        rdp.fastRGB = rdp.fastAlpha = 9;
        const actual = rdp.combineColor(shade, texel).map(Math.round);
        assert.deepEqual(actual, expected);
    }
});

test('RDP opaque RGBA16 blit preserves generic sampling and scissor results', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    const rdp = new RDP(bus);
    rdp.colorImage = { address: 0x1000, width: 8, size: 2, format: 0 };
    Object.assign(rdp.tiles[0], {
        format: 0,
        size: 2,
        line: 1,
        sh: 12,
        th: 12,
        sMask: 2,
        tMask: 2,
        sMode: 1,
        tMode: 1,
    });
    rdp.scissor = [1, 1, 7, 7];
    for (let i = 0; i < 32; i += 1) rdp.tmem[i] = (i * 29) & 255;
    rdp.combiner[1] = [15, 15, 31, 1, 7, 7, 7, 4];
    rdp.fastRGB = rdp.fastAlpha = -1;
    rdp.textureRectangle(0xe4020020, 0, 0xffc0ffe0, 0x04000400);
    const expected = bus.ram.slice(0x1000, 0x1080);
    bus.ram.fill(0, 0x1000, 0x1080);
    rdp.fastRGB = 1;
    rdp.fastAlpha = 4;
    rdp.textureRectangle(0xe4020020, 0, 0xffc0ffe0, 0x04000400);
    assert.deepEqual(bus.ram.slice(0x1000, 0x1080), expected);
    assert.ok(expected.some((byte) => byte !== 0));
});

test('RDP fill cycle clears framebuffer even with zero alpha and blending enabled', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    const rdp = new RDP(bus);
    rdp.colorImage = { address: 0x1000, width: 4, size: 2, format: 0 };
    rdp.otherH = 3 << 20;
    rdp.otherL = 0x4001;
    rdp.blend[3] = 255;
    rdp.fillColor = 0;
    bus.ram.fill(255, 0x1000, 0x1020);
    rdp.fillRectangle(0xf600c00c, 0);
    assert.deepEqual([...bus.ram.slice(0x1000, 0x1020)], new Array(32).fill(0));
});

test('RDP samples RGBA16, IA8 and paletted CI4 with clamp and mirror addressing', () => {
    const rdp = new RDP(new N64Bus(new Uint8Array(4096)));
    const tile = rdp.tiles[0];
    Object.assign(tile, { line: 1, sh: 4, th: 0, sMask: 1, sMode: 1 });
    rdp.tmem.set([0xf8, 0x01, 0x07, 0xc1]);
    assert.deepEqual(rdp.texture(0, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(rdp.texture(0, 2, 0), [0, 255, 0, 255]);
    tile.sMode = 2;
    assert.deepEqual(rdp.texture(0, 50, 0), [0, 255, 0, 255]);
    tile.format = 3;
    tile.size = 1;
    rdp.tmem[0] = 0x84;
    assert.deepEqual(rdp.texture(0, 0, 0), [136, 136, 136, 68]);
    tile.format = 2;
    tile.size = 0;
    tile.palette = 2;
    rdp.tmem[0] = 0x10;
    rdp.palette[33] = 0x003f;
    assert.deepEqual(rdp.texture(0, 0, 0), [0, 0, 255, 255]);
});

test('RDP depth comparison prevents a farther fragment replacing a nearer one', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    const rdp = new RDP(bus);
    rdp.colorImage = { address: 0x1000, width: 4, size: 2, format: 0 };
    rdp.otherL = 0x30;
    rdp.writePixel(1, 1, [255, 0, 0, 255], 0.25, true);
    rdp.writePixel(1, 1, [0, 255, 0, 255], 0.75, true);
    assert.equal(bus.read16(0x100a), 0xf801);
});

test('F3D decodes vertices, clips and rasterizes a real display list into VI memory', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    const graphics = new RSPGraphics(bus);
    const vertices = [
        [-1, -1, 0],
        [1, -1, 0],
        [0, 1, 0],
    ];
    vertices.forEach((position, i) => {
        position.forEach((value, axis) =>
            bus.write16(0x1000 + i * 16 + axis * 2, value),
        );
        bus.write32(0x100c + i * 16, 0xff0000ff);
    });
    const words = [
        0xff10013f, 0x2000, 0xb7000000, 0x204, 0xfcffffff, 0xfffe793c,
        0x04200030, 0x1000, 0xbf000000, 0x00000a14, 0xe9000000, 0, 0xb8000000,
        0,
    ];
    words.forEach((word, i) => bus.write32(0x100 + i * 4, word));
    graphics.run({ data: 0x100 });
    assert.ok(graphics.rdp.pixels > 10000);
    assert.equal(bus.read16(0x2000 + (120 * 320 + 160) * 2), 0xf801);
    assert.equal(bus.miInterrupt & 32, 32);
    bus.vi[0] = 2;
    bus.vi[1] = 0x2000;
    bus.vi[2] = 320;
    bus.vi[9] = 1;
    assert.equal(new VideoInterface(bus).render()[120 * 320 + 160], 0xffff0000);
});

test('ABI1 ADPCM decodes signed residuals and writes the predictor history', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    const audio = new RSPAudio(bus);
    audio.input = 0x100;
    audio.output = 0x200;
    audio.count = 32;
    audio.memory.set(
        [0x10, 0x17, 0x8f, 0x20, 0xe3, 0x17, 0x8f, 0x20, 0xe3],
        0x100,
    );
    audio.adpcm(1, 0x1000);
    const expected = [2, 14, -16, -2, 4, 0, -4, 6, 2, 14, -16, -2, 4, 0, -4, 6];
    assert.deepEqual(
        Array.from({ length: 16 }, (_, i) => audio.sample(0x220 + i * 2)),
        expected,
    );
    assert.deepEqual(
        Array.from({ length: 16 }, (_, i) =>
            bus.ramView.getInt16(0x1000 + i * 2),
        ),
        expected,
    );
    audio.count = 0;
    audio.adpcm(0, 0x1000);
    assert.deepEqual(
        Array.from({ length: 16 }, (_, i) => audio.sample(0x200 + i * 2)),
        expected,
    );
});

test('ABI1 four-tap resampling preserves history across command boundaries', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    const audio = new RSPAudio(bus);
    audio.input = 0x100;
    audio.output = 0x300;
    audio.count = 16;
    for (let i = 0; i < 64; i += 1) audio.coefficients[i * 4] = 32767;
    for (let i = 0; i < 12; i += 1) audio.put(0x100 + i * 2, (i + 1) * 100);
    audio.resample(1, 0x8000, 0x1000);
    assert.deepEqual(
        Array.from({ length: 8 }, (_, i) => audio.sample(0x300 + i * 2)),
        [0, 0, 0, 0, 99, 199, 299, 399],
    );
    assert.equal(bus.read16(0x1000), 500);
    assert.equal(bus.read16(0x1008), 0);
});
