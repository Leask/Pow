import { readAscii, toByteArray } from '../../shared/nintendo/rom-buffer.mjs';

function isGBAROM(data) {
    const bytes = toByteArray(data);
    if (bytes.length < 192 || bytes[0xb2] !== 0x96) return false;
    let check = 0;
    for (let i = 0xa0; i <= 0xbc; i += 1) check += bytes[i];
    return (
        ((check + bytes[0xbd] + 0x19) & 255) === 0 &&
        bytes[4] === 0x24 &&
        bytes[5] === 0xff
    );
}
function parseGBAHeader(data) {
    const bytes = toByteArray(data);
    if (!isGBAROM(bytes)) throw new Error('Invalid GBA cartridge header.');
    return {
        format: 'GBA',
        title: readAscii(bytes, 0xa0, 12),
        gameCode: readAscii(bytes, 0xac, 4),
        romSize: bytes.length,
        screen: { width: 240, height: 160 },
    };
}
export { isGBAROM, parseGBAHeader };
