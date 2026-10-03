import { toByteArray, readAscii } from '../../shared/nintendo/rom-buffer.mjs';

const ROM_ORDERS = new Map([
    [0x80371240, 'z64'],
    [0x37804012, 'v64'],
    [0x40123780, 'n64'],
]);

function isN64ROM(data) {
    const bytes = toByteArray(data);
    return (
        bytes.length >= 4 &&
        ROM_ORDERS.has(
            new DataView(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
            ).getUint32(0),
        )
    );
}

function normalizeN64ROM(data) {
    const input = toByteArray(data);
    if (input.length < 0x1000 || (input.length & 3) !== 0) {
        throw new Error(
            'N64 ROM must contain a complete, word-aligned header.',
        );
    }
    const order = ROM_ORDERS.get(
        new DataView(
            input.buffer,
            input.byteOffset,
            input.byteLength,
        ).getUint32(0),
    );
    if (!order) {
        throw new Error('Invalid N64 ROM byte-order signature.');
    }
    const bytes = new Uint8Array(input.length);
    const xor = order === 'v64' ? 1 : order === 'n64' ? 3 : 0;
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = input[i ^ xor];
    }
    return { bytes, order };
}

function parseN64Header(data) {
    const { bytes, order } = normalizeN64ROM(data);
    const view = new DataView(bytes.buffer);
    return {
        format: order,
        title: readAscii(bytes, 0x20, 20).trim(),
        entryPoint: view.getUint32(8),
        crc1: view.getUint32(0x10),
        crc2: view.getUint32(0x14),
        countryCode: bytes[0x3e],
        region: [0x44, 0x46, 0x49, 0x50, 0x53, 0x55, 0x58, 0x59].includes(
            bytes[0x3e],
        )
            ? 'PAL'
            : 'NTSC',
        revision: bytes[0x3f],
        romSize: bytes.length,
    };
}

export { isN64ROM, normalizeN64ROM, parseN64Header };
