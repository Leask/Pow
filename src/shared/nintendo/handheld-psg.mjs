const DUTY = [0x01, 0x81, 0x87, 0x7e];
const READ_MASK = [
    0x80, 0x3f, 0, 0xff, 0xbf, 0xff, 0x3f, 0, 0xff, 0xbf, 0x7f, 0xff, 0x9f,
    0xff, 0xbf, 0xff, 0xff, 0, 0, 0xbf, 0, 0, 0x70,
];

class GBAPU {
    constructor(options = {}) {
        this.options = options;
        this.sampleRate = options.sampleRate ?? 44100;
        if (
            !Number.isInteger(this.sampleRate) ||
            this.sampleRate < 8000 ||
            this.sampleRate > 192000
        )
            throw new RangeError('Invalid sample rate.');
        this.regs = new Uint8Array(0x30);
        this.regs[0x16] = 0x80;
        this.regs[0x14] = 0x77;
        this.regs[0x15] = 0xf3;
        this.channels = Array.from({ length: 4 }, () => ({
            enabled: false,
            timer: 0,
            phase: 0,
            length: 0,
            volume: 0,
            envelope: 0,
            sweep: 0,
            shadow: 0,
            lfsr: 0x7fff,
        }));
        this.sequence = 0;
        this.samplePhase = 0;
        this.sampleCount = 0;
        this.sumLeft = 0;
        this.sumRight = 0;
        this.sumCycles = 0;
        this.capLeft = 0;
        this.capRight = 0;
        this.filter = Math.pow(0.999958, 4194304 / this.sampleRate);
    }

    read(address) {
        const index = address - 0xff10;
        if (index >= 0x20) return this.regs[index];
        if (index === 0x16) {
            return (
                (this.regs[0x16] & 128) |
                0x70 |
                this.channels.reduce(
                    (flags, ch, i) => flags | (ch.enabled ? 1 << i : 0),
                    0,
                )
            );
        }
        return (this.regs[index] ?? 255) | (READ_MASK[index] ?? 0xff);
    }

    write(address, value) {
        const index = address - 0xff10;
        if (index >= 0x20) {
            this.regs[index] = value;
            return;
        }
        if (index === 0x16) {
            if (!(value & 128)) {
                this.regs.fill(0, 0, 0x17);
                for (const ch of this.channels) ch.enabled = false;
                this.sequence = 0;
            }
            this.regs[index] = value & 128;
            return;
        }
        if (!(this.regs[0x16] & 128)) return;
        this.regs[index] = value;
        const channel = Math.floor(index / 5);
        if (channel > 3) return;
        const ch = this.channels[channel],
            local = index % 5;
        if (local === 1)
            ch.length = channel === 2 ? 256 - value : 64 - (value & 63);
        if (
            (local === 2 && channel !== 2 && !(value & 0xf8)) ||
            (channel === 2 && local === 0 && !(value & 128))
        )
            ch.enabled = false;
        if (local === 4 && value & 128) {
            ch.enabled =
                channel === 2
                    ? !!(this.regs[10] & 128)
                    : !!(this.regs[channel * 5 + 2] & 0xf8);
            if (!ch.length) ch.length = channel === 2 ? 256 : 64;
            ch.timer = this.period(channel);
            ch.volume = this.regs[channel * 5 + 2] >>> 4;
            ch.envelope = this.regs[channel * 5 + 2] & 7 || 8;
            if (channel === 2) ch.phase = 0;
            if (channel === 3) ch.lfsr = 0x7fff;
            if (channel === 0) {
                ch.shadow = this.frequency(0);
                ch.sweep = (this.regs[0] >>> 4) & 7 || 8;
                if (this.regs[0] & 7 && this.sweepFrequency() > 2047)
                    ch.enabled = false;
            }
        }
    }

    frequency(index) {
        return this.regs[index * 5 + 3] | ((this.regs[index * 5 + 4] & 7) << 8);
    }
    period(index) {
        if (index === 3) {
            const nr43 = this.regs[18];
            return (
                [8, 16, 32, 48, 64, 80, 96, 112][nr43 & 7] * 2 ** (nr43 >>> 4)
            );
        }
        return (2048 - this.frequency(index)) * (index === 2 ? 2 : 4);
    }
    sweepFrequency() {
        const delta = this.channels[0].shadow >>> (this.regs[0] & 7);
        return this.channels[0].shadow + (this.regs[0] & 8 ? -delta : delta);
    }
    frameClock() {
        if (!(this.regs[0x16] & 128)) return;
        const step = this.sequence;
        this.sequence = (step + 1) & 7;
        this.channels.forEach((ch, i) => {
            if (!(step & 1) && this.regs[i * 5 + 4] & 64 && ch.length > 0) {
                if (--ch.length === 0) ch.enabled = false;
            }
            if (step === 7 && i !== 2 && ch.enabled && --ch.envelope === 0) {
                const value = this.regs[i * 5 + 2];
                ch.envelope = value & 7 || 8;
                if (value & 7) {
                    const next = ch.volume + (value & 8 ? 1 : -1);
                    if (next >= 0 && next <= 15) ch.volume = next;
                }
            }
        });
        const ch = this.channels[0];
        if ((step === 2 || step === 6) && --ch.sweep === 0) {
            ch.sweep = (this.regs[0] >>> 4) & 7 || 8;
            if (ch.enabled && this.regs[0] & 0x70) {
                const frequency = this.sweepFrequency();
                if (frequency > 2047) ch.enabled = false;
                else if (this.regs[0] & 7) {
                    ch.shadow = frequency;
                    this.regs[3] = frequency & 255;
                    this.regs[4] = (this.regs[4] & 0xf8) | (frequency >>> 8);
                    if (this.sweepFrequency() > 2047) ch.enabled = false;
                }
            }
        }
    }

    digital(index) {
        const ch = this.channels[index];
        if (!ch.enabled) return 0;
        if (index < 2) {
            return DUTY[this.regs[index * 5 + 1] >>> 6] & (1 << ch.phase)
                ? ch.volume
                : 0;
        }
        if (index === 2) {
            const level = (this.regs[12] >>> 5) & 3;
            const byte = this.regs[0x20 + (ch.phase >>> 1)];
            const nibble = ch.phase & 1 ? byte & 15 : byte >>> 4;
            return level ? nibble >>> (level - 1) : 0;
        }
        return ch.lfsr & 1 ? 0 : ch.volume;
    }

    clock(cycles) {
        // Integrate the waveform across the host sample interval to avoid
        // aliasing high-frequency pulse/noise transitions into loud artifacts.
        while (cycles > 0) {
            let delta = Math.min(
                cycles,
                Math.ceil((4194304 - this.samplePhase) / this.sampleRate),
            );
            for (const ch of this.channels)
                if (ch.enabled) delta = Math.min(delta, ch.timer);
            delta = Math.max(1, delta);
            let left = 0,
                right = 0;
            if (this.regs[0x16] & 128) {
                for (let i = 0; i < 4; i += 1) {
                    const dac =
                        i === 2
                            ? this.regs[10] & 128
                            : this.regs[i * 5 + 2] & 0xf8;
                    const value = dac ? 1 - this.digital(i) / 7.5 : 0;
                    if (this.regs[0x15] & (1 << i)) right += value;
                    if (this.regs[0x15] & (16 << i)) left += value;
                }
                left *= (((this.regs[0x14] >>> 4) & 7) + 1) / 32;
                right *= ((this.regs[0x14] & 7) + 1) / 32;
            }
            this.sumLeft += left * delta;
            this.sumRight += right * delta;
            this.sumCycles += delta;
            this.channels.forEach((ch, i) => {
                if (!ch.enabled) return;
                ch.timer -= delta;
                while (ch.timer <= 0) {
                    ch.timer += this.period(i);
                    ch.phase = (ch.phase + 1) & (i === 2 ? 31 : 7);
                    if (i === 3) {
                        const feedback = (ch.lfsr ^ (ch.lfsr >>> 1)) & 1;
                        ch.lfsr = (ch.lfsr >>> 1) | (feedback << 14);
                        if (this.regs[18] & 8)
                            ch.lfsr = (ch.lfsr & ~64) | (feedback << 6);
                    }
                }
            });
            this.samplePhase += delta * this.sampleRate;
            cycles -= delta;
            if (this.samplePhase >= 4194304) {
                this.samplePhase -= 4194304;
                const l = this.sumLeft / this.sumCycles - this.capLeft;
                const r = this.sumRight / this.sumCycles - this.capRight;
                this.capLeft = this.sumLeft / this.sumCycles - l * this.filter;
                this.capRight =
                    this.sumRight / this.sumCycles - r * this.filter;
                this.sumLeft = this.sumRight = this.sumCycles = 0;
                this.sampleCount += 1;
                this.options.onAudioFrame?.(l, r);
                this.options.onAudioSample?.((l + r) / 2, this.sampleCount);
            }
        }
    }
}

export { GBAPU };
