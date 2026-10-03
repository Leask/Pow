import { readAscii, toByteArray } from '../../shared/nintendo/rom-buffer.mjs';

const LOGO =
    'ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6' +
    'ddddd999bbbb67636e0eecccdddc999fbbb9333e';
const RAM_SIZES = [0, 2048, 8192, 32768, 131072, 65536];

function mapperForType(type) {
    if ([0, 8, 9].includes(type)) return 0;
    if ([1, 2, 3].includes(type)) return 1;
    if ([5, 6].includes(type)) return 2;
    if (type >= 0x0f && type <= 0x13) return 3;
    if (type >= 0x19 && type <= 0x1e) return 5;
    throw new Error(`Unsupported GB cartridge type 0x${type.toString(16)}`);
}

function isGBROM(data) {
    const bytes = toByteArray(data);
    if (bytes.length < 0x150) return false;
    for (let i = 0; i < 48; i += 1) {
        if (bytes[0x104 + i] !== parseInt(LOGO.slice(i * 2, i * 2 + 2), 16)) {
            return false;
        }
    }
    let check = 0;
    for (let i = 0x134; i <= 0x14c; i += 1)
        check = (check - bytes[i] - 1) & 255;
    return check === bytes[0x14d];
}

function parseGBHeader(data) {
    const bytes = toByteArray(data);
    if (!isGBROM(bytes)) throw new Error('Invalid GB/GBC cartridge header.');
    const color = (bytes[0x143] & 128) !== 0;
    return {
        format: color ? 'GBC' : 'GB',
        title: readAscii(bytes, 0x134, color ? 15 : 16),
        color,
        colorOnly: bytes[0x143] === 0xc0,
        cartridgeType: bytes[0x147],
        mapperId: mapperForType(bytes[0x147]),
        romBanks: bytes.length / 0x4000,
        ramSize: RAM_SIZES[bytes[0x149]] ?? 0,
        headerChecksum: bytes[0x14d],
        screen: { width: 160, height: 144 },
    };
}

class GBCartridge {
    constructor(data) {
        this.header = parseGBHeader(data);
        this.rom = toByteArray(data).slice();
        this.mapper = this.header.mapperId;
        this.ram = new Uint8Array(
            this.mapper === 2 ? 512 : this.header.ramSize,
        );
        this.ram.fill(255);
        this.rtc = new Uint8Array(5);
        this.latchedRTC = new Uint8Array(5);
        this.latch = 0;
        this.rtcCycles = 0;
        this.reset();
    }

    reset() {
        this.ramEnabled = this.mapper === 0;
        this.romBank = 1;
        this.highBank = this.ramBank = this.mode = this.latch = 0;
    }

    clock(cycles) {
        if (this.mapper !== 3 || this.rtc[4] & 64) return;
        this.rtcCycles += cycles;
        while (this.rtcCycles >= 4194304) {
            this.rtcCycles -= 4194304;
            if (++this.rtc[0] < 60) continue;
            this.rtc[0] = 0;
            if (++this.rtc[1] < 60) continue;
            this.rtc[1] = 0;
            if (++this.rtc[2] < 24) continue;
            this.rtc[2] = 0;
            const days = this.rtc[3] | ((this.rtc[4] & 1) << 8);
            this.rtc[3] = days + 1;
            this.rtc[4] =
                (this.rtc[4] & 0xc0) |
                (((days + 1) >>> 8) & 1) |
                (days === 511 ? 128 : 0);
        }
    }

    read(address) {
        if (address < 0x8000) {
            let bank =
                address < 0x4000
                    ? this.mapper === 1 && this.mode
                        ? this.highBank << 5
                        : 0
                    : this.romBank |
                      (this.mapper === 1 ? this.highBank << 5 : 0);
            bank %= this.header.romBanks;
            return this.rom[bank * 0x4000 + (address & 0x3fff)] ?? 255;
        }
        if (!this.ramEnabled) return 255;
        if (this.mapper === 3 && this.ramBank >= 8 && this.ramBank <= 12) {
            return this.latchedRTC[this.ramBank - 8];
        }
        if (!this.ram.length) return 255;
        const bank =
            this.mapper === 1 ? (this.mode ? this.highBank : 0) : this.ramBank;
        const index = (bank * 8192 + (address & 8191)) % this.ram.length;
        return this.ram[index] | (this.mapper === 2 ? 0xf0 : 0);
    }

    write(address, value) {
        if (address >= 0xa000) {
            if (!this.ramEnabled) return;
            if (this.mapper === 3 && this.ramBank >= 8 && this.ramBank <= 12) {
                this.rtc[this.ramBank - 8] = value;
                return;
            }
            if (!this.ram.length) return;
            const bank =
                this.mapper === 1
                    ? this.mode
                        ? this.highBank
                        : 0
                    : this.ramBank;
            const index = (bank * 8192 + (address & 8191)) % this.ram.length;
            this.ram[index] = this.mapper === 2 ? value & 15 : value;
            return;
        }
        if (!this.mapper) return;
        if (this.mapper === 2) {
            if (address < 0x4000) {
                if (address & 0x100) this.romBank = value & 15 || 1;
                else this.ramEnabled = (value & 15) === 10;
            }
            return;
        }
        if (address < 0x2000) this.ramEnabled = (value & 15) === 10;
        else if (address < 0x4000) {
            if (this.mapper === 5) {
                this.romBank =
                    address < 0x3000
                        ? (this.romBank & 256) | value
                        : (this.romBank & 255) | ((value & 1) << 8);
            } else this.romBank = value & (this.mapper === 1 ? 31 : 127) || 1;
        } else if (address < 0x6000) {
            if (this.mapper === 1) this.highBank = value & 3;
            else
                this.ramBank =
                    value &
                    (this.mapper === 5
                        ? this.header.cartridgeType >= 0x1c
                            ? 7
                            : 15
                        : 255);
        } else if (this.mapper === 1) this.mode = value & 1;
        else if (this.mapper === 3) {
            if (this.latch === 0 && value === 1) this.latchedRTC.set(this.rtc);
            this.latch = value;
        }
    }
}

export { GBCartridge, parseGBHeader, isGBROM };
