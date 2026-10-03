import { readAscii, toByteArray } from '../../shared/nintendo/rom-buffer.mjs';

function crc16(bytes, start, end) {
    let crc = 0xffff;
    for (let i = start; i < end; i += 1) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit += 1)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
    }
    return crc;
}
function isNDSROM(data) {
    const bytes = toByteArray(data);
    if (bytes.length < 0x200 || ![0, 2].includes(bytes[0x12])) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (crc16(bytes, 0, 0x15e) !== view.getUint16(0x15e, true)) return false;
    for (const offset of [0x20, 0x30]) {
        const source = view.getUint32(offset, true),
            length = view.getUint32(offset + 12, true);
        if (!length || source < 0x200 || source + length > bytes.length)
            return false;
    }
    return true;
}
function parseNDSHeader(data) {
    const bytes = toByteArray(data);
    if (!isNDSROM(bytes)) throw new Error('Invalid NDS cartridge header.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const executable = (offset) => ({
        offset: view.getUint32(offset, true),
        entry: view.getUint32(offset + 4, true),
        address: view.getUint32(offset + 8, true),
        size: view.getUint32(offset + 12, true),
    });
    return {
        format: 'NDS',
        title: readAscii(bytes, 0, 12),
        gameCode: readAscii(bytes, 12, 4),
        arm9: executable(0x20),
        arm7: executable(0x30),
        romSize: bytes.length,
        screen: { width: 256, height: 384 },
    };
}

export { isNDSROM, parseNDSHeader, crc16 };
