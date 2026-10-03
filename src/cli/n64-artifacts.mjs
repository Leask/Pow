import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const name = Buffer.from(type);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    name.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
}

function writePNG(file, pixels, width, height) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const rows = Buffer.alloc(height * (width * 3 + 1));
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixel = pixels[y * width + x];
            const offset = y * (width * 3 + 1) + 1 + x * 3;
            rows[offset] = (pixel >>> 16) & 255;
            rows[offset + 1] = (pixel >>> 8) & 255;
            rows[offset + 2] = pixel & 255;
        }
    }
    fs.writeFileSync(
        file,
        Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk('IHDR', header),
            chunk('IDAT', deflateSync(rows)),
            chunk('IEND', Buffer.alloc(0)),
        ]),
    );
}

function writeWAV(file, samples, rate = 44100) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) {
        data.writeInt16LE(
            Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))),
            i * 2,
        );
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(data.length + 36, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([header, data]));
}

export { writePNG, writeWAV };
