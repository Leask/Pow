const APU_CPU_CLOCK = 1_789_773;
const DUTY_TABLE = [0.125, 0.25, 0.5, 0.75];
const NOISE_PERIOD_TABLE = [
    4, 8, 16, 32, 64, 96, 128, 160,
    202, 254, 380, 508, 762, 1016, 2034, 4068,
];

function clampSample(value) {
    if (value > 1) {
        return 1;
    }

    if (value < -1) {
        return -1;
    }

    return value;
}

class APU {
    constructor(options = {}) {
        this.registers = new Uint8Array(0x18);
        this.cycle = 0;
        this.sampleRate = options.sampleRate ?? 44100;
        this.onSample = typeof options.onSample === 'function'
            ? options.onSample
            : null;
        this.cyclesPerSample = APU_CPU_CLOCK / this.sampleRate;
        this.sampleCycleAccumulator = 0;
        this.pulsePhase = [0, 0];
        this.trianglePhase = 0;
        this.noisePhase = 0;
        this.noiseShift = 1;
    }

    clock(cycles) {
        this.cycle += cycles;
        this.sampleCycleAccumulator += cycles;

        if (!this.onSample) {
            return;
        }

        while (this.sampleCycleAccumulator >= this.cyclesPerSample) {
            this.sampleCycleAccumulator -= this.cyclesPerSample;
            this.onSample(this.#mixSample());
        }
    }

    readStatus() {
        return this.registers[0x15];
    }

    writeRegister(address, value) {
        const index = address - 0x4000;

        if (index < 0 || index >= this.registers.length) {
            return;
        }

        const byte = value & 0xff;
        this.registers[index] = byte;

        if (index === 0x03) {
            this.pulsePhase[0] = 0;
        }

        if (index === 0x07) {
            this.pulsePhase[1] = 0;
        }

        if (index === 0x0b) {
            this.trianglePhase = 0;
        }
    }

    #mixSample() {
        const status = this.registers[0x15];
        let mixed = 0;
        let activeChannels = 0;

        if ((status & 0x01) !== 0) {
            mixed += this.#pulseSample(0);
            activeChannels += 1;
        }

        if ((status & 0x02) !== 0) {
            mixed += this.#pulseSample(1);
            activeChannels += 1;
        }

        if ((status & 0x04) !== 0) {
            mixed += this.#triangleSample();
            activeChannels += 1;
        }

        if ((status & 0x08) !== 0) {
            mixed += this.#noiseSample();
            activeChannels += 1;
        }

        if (activeChannels === 0) {
            return 0;
        }

        return clampSample((mixed / activeChannels) * 0.8);
    }

    #pulseSample(channel) {
        const base = channel === 0 ? 0x00 : 0x04;
        const control = this.registers[base];
        const timerLow = this.registers[base + 2];
        const timerHigh = this.registers[base + 3] & 0x07;
        const timer = (timerHigh << 8) | timerLow;

        if (timer < 8) {
            return 0;
        }

        const frequency = APU_CPU_CLOCK / (16 * (timer + 1));
        this.pulsePhase[channel] += frequency / this.sampleRate;
        this.pulsePhase[channel] %= 1;

        const duty = DUTY_TABLE[(control >> 6) & 0x03];
        const raw = this.pulsePhase[channel] < duty ? 1 : -1;
        const volume = (control & 0x0f) / 15;

        return raw * volume;
    }

    #triangleSample() {
        const timerLow = this.registers[0x0a];
        const timerHigh = this.registers[0x0b] & 0x07;
        const timer = (timerHigh << 8) | timerLow;

        if (timer < 2) {
            return 0;
        }

        const frequency = APU_CPU_CLOCK / (32 * (timer + 1));
        this.trianglePhase += frequency / this.sampleRate;
        this.trianglePhase %= 1;

        const triangle = 1 - 4 * Math.abs(this.trianglePhase - 0.5);
        return triangle * 0.6;
    }

    #noiseSample() {
        const control = this.registers[0x0c];
        const modeAndPeriod = this.registers[0x0e];
        const mode = (modeAndPeriod & 0x80) !== 0;
        const periodIndex = modeAndPeriod & 0x0f;
        const period = NOISE_PERIOD_TABLE[periodIndex];
        const frequency = APU_CPU_CLOCK / period;
        const volume = (control & 0x0f) / 15;

        this.noisePhase += frequency / this.sampleRate;

        while (this.noisePhase >= 1) {
            this.noisePhase -= 1;
            this.#stepNoiseLfsr(mode);
        }

        const bit0 = this.noiseShift & 0x01;
        const raw = bit0 === 0 ? 1 : -1;

        return raw * volume * 0.5;
    }

    #stepNoiseLfsr(mode) {
        const bit0 = this.noiseShift & 0x01;
        const tap = mode
            ? ((this.noiseShift >> 6) & 0x01)
            : ((this.noiseShift >> 1) & 0x01);
        const feedback = bit0 ^ tap;
        this.noiseShift = (this.noiseShift >> 1) | (feedback << 14);
        this.noiseShift &= 0x7fff;
    }

    saveState() {
        return {
            registers: Array.from(this.registers),
            cycle: this.cycle,
            sampleRate: this.sampleRate,
            sampleCycleAccumulator: this.sampleCycleAccumulator,
            pulsePhase: [...this.pulsePhase],
            trianglePhase: this.trianglePhase,
            noisePhase: this.noisePhase,
            noiseShift: this.noiseShift,
        };
    }

    loadState(state) {
        this.registers.set(state.registers);
        this.cycle = state.cycle >>> 0;
        this.sampleRate = state.sampleRate ?? this.sampleRate;
        this.cyclesPerSample = APU_CPU_CLOCK / this.sampleRate;
        this.sampleCycleAccumulator = state.sampleCycleAccumulator ?? 0;
        this.pulsePhase[0] = state.pulsePhase?.[0] ?? 0;
        this.pulsePhase[1] = state.pulsePhase?.[1] ?? 0;
        this.trianglePhase = state.trianglePhase ?? 0;
        this.noisePhase = state.noisePhase ?? 0;
        this.noiseShift = state.noiseShift ?? 1;
    }
}

export {
    APU,
};
