const STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
    3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
    29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
class NDSAudio {
    constructor(machine, options) {
        this.machine = machine;
        this.options = options;
        this.rate = options.sampleRate ?? 44100;
        if (
            !Number.isInteger(this.rate) ||
            this.rate < 8000 ||
            this.rate > 192000
        )
            throw new RangeError('Invalid sample rate.');
        this.phase = 0;
        this.sampleCount = 0;
        this.channels = Array.from({ length: 16 }, () => ({
            position: 0,
            phase: 0,
            sample: 0,
            predictor: 0,
            index: 0,
            loopPredictor: 0,
            loopIndex: 0,
            lfsr: 0x7fff,
        }));
        this.capLeft = this.capRight = 0;
    }
    trigger(index) {
        const bus = this.machine.buses[1],
            offset = 0x400 + index * 16;
        const ch = this.channels[index];
        ch.phase = ch.position = 0;
        ch.sample = 0;
        ch.lfsr = 0x7fff;
        if ((bus.reg32(offset) & 0xe0000000) === 0xc0000000) {
            const header = bus.read32(bus.reg32(offset + 4));
            ch.predictor = (header << 16) >> 16;
            ch.index = Math.min(88, (header >>> 16) & 127);
            ch.position = 8;
        }
    }
    next(index) {
        const bus = this.machine.buses[1],
            offset = 0x400 + index * 16;
        const control = bus.reg32(offset),
            format = (control >>> 29) & 3;
        const ch = this.channels[index],
            source = bus.reg32(offset + 4) & 0x07ffffff;
        const loopBytes = bus.reg(offset + 10) * 4;
        const end = loopBytes + (bus.reg32(offset + 12) & 0x3fffff) * 4;
        if (format < 3) {
            const bytes =
                format === 2
                    ? ch.position >>> 1
                    : ch.position * (format === 1 ? 2 : 1);
            if (bytes >= end && end > 0) {
                if (((control >>> 27) & 3) === 1) {
                    ch.position =
                        format === 2
                            ? loopBytes * 2
                            : loopBytes / (format === 1 ? 2 : 1);
                    if (format === 2) {
                        ch.predictor = ch.loopPredictor;
                        ch.index = ch.loopIndex;
                    }
                } else {
                    bus.io[offset + 3] &= 127;
                    ch.sample = 0;
                    return;
                }
            }
        }
        if (format === 0)
            ch.sample = ((bus.read8(source + ch.position++) << 24) >> 24) / 128;
        else if (format === 1)
            ch.sample =
                ((bus.read16(source + ch.position++ * 2) << 16) >> 16) / 32768;
        else if (format === 2) {
            if (ch.position === loopBytes * 2) {
                ch.loopPredictor = ch.predictor;
                ch.loopIndex = ch.index;
            }
            const byte = bus.read8(source + (ch.position >>> 1));
            const nibble = (byte >>> ((ch.position & 1) * 4)) & 15;
            ch.position += 1;
            const step = STEP[ch.index];
            let diff = step >>> 3;
            if (nibble & 1) diff += step >>> 2;
            if (nibble & 2) diff += step >>> 1;
            if (nibble & 4) diff += step;
            ch.predictor = Math.max(
                -32768,
                Math.min(32767, ch.predictor + (nibble & 8 ? -diff : diff)),
            );
            ch.index = Math.max(0, Math.min(88, ch.index + INDEX[nibble & 7]));
            ch.sample = ch.predictor / 32768;
        } else if (index >= 8 && index < 14) {
            ch.position = (ch.position + 1) & 7;
            ch.sample = ch.position <= ((control >>> 24) & 7) ? -1 : 1;
        } else if (index >= 14) {
            const feedback = (ch.lfsr ^ (ch.lfsr >>> 1)) & 1;
            ch.lfsr = (ch.lfsr >>> 1) | (feedback << 14);
            ch.sample = ch.lfsr & 1 ? -1 : 1;
        }
    }
    clock(cycles) {
        this.phase += cycles * this.rate;
        const bus = this.machine.buses[1];
        while (this.phase >= 33513982) {
            this.phase -= 33513982;
            let left = 0,
                right = 0;
            for (let i = 0; i < 16; i += 1) {
                const control = bus.reg32(0x400 + i * 16);
                if (!(control & 0x80000000)) continue;
                const ch = this.channels[i];
                const period = Math.max(
                    2,
                    (65536 - bus.reg(0x408 + i * 16)) * 2,
                );
                ch.phase += 33513982 / this.rate;
                while (ch.phase >= period) {
                    ch.phase -= period;
                    this.next(i);
                }
                const volume =
                    (control & 127) === 127 ? 1 : (control & 127) / 128;
                const divisor = [1, 2, 4, 16][(control >>> 8) & 3];
                const pan = ((control >>> 16) & 127) / 127;
                const sample = (ch.sample * volume) / divisor;
                left += sample * (1 - pan);
                right += sample * pan;
            }
            const master = bus.reg(0x500);
            const gain =
                master & 0x8000
                    ? ((master & 127) === 127 ? 1 : (master & 127) / 128) / 4
                    : 0;
            left *= gain;
            right *= gain;
            const l = left - this.capLeft,
                r = right - this.capRight;
            this.capLeft = left - l * 0.995;
            this.capRight = right - r * 0.995;
            this.sampleCount += 1;
            this.options.onAudioFrame?.(
                Math.max(-1, Math.min(1, l)),
                Math.max(-1, Math.min(1, r)),
                this.sampleCount,
            );
            this.options.onAudioSample?.((l + r) / 2, this.sampleCount);
        }
    }
}
export { NDSAudio };
