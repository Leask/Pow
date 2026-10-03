const CPU_CLOCK = 93_750_000;

class AudioInterface {
    constructor(bus, options = {}) {
        this.bus = bus;
        this.sampleRate = options.sampleRate ?? 44100;
        if (!Number.isFinite(this.sampleRate) || this.sampleRate < 8000) {
            throw new RangeError('sampleRate must be at least 8000 Hz.');
        }
        this.onSample = options.onAudioSample ?? null;
        this.onStereo = options.onAudioFrame ?? null;
        this.queue = [];
        this.dacRate = 0;
        this.enabled = false;
        this.samplePhase = 0;
        this.sourcePhase = 0;
        this.samples = 0;
        this.nonzeroSamples = 0;
        this.peak = 0;
        this.completedBuffers = 0;
        this.clockRate = options.region === 'PAL' ? 49_656_530 : 48_681_812;
    }

    enqueue(address, length) {
        if (length === 0 || this.queue.length === 2) return;
        this.queue.push({
            address: address & 0x00fffff8,
            length: length & 0x3fff8,
            offset: 0,
        });
    }

    get status() {
        return (
            (this.queue.length ? 0x40000000 : 0) |
            (this.queue.length === 2 ? 0x80000000 : 0)
        );
    }

    get remaining() {
        const buffer = this.queue[0];
        return buffer ? (buffer.length - buffer.offset) & ~7 : 0;
    }

    clock(cycles) {
        this.samplePhase += cycles * this.sampleRate;
        while (this.samplePhase >= CPU_CLOCK) {
            this.samplePhase -= CPU_CLOCK;
            let left = 0;
            let right = 0;
            const buffer = this.queue[0];
            if (buffer && this.enabled) {
                const address = buffer.address + buffer.offset;
                left = ((this.bus.read16(address) << 16) >> 16) / 32768;
                right = ((this.bus.read16(address + 2) << 16) >> 16) / 32768;
                const next =
                    buffer.offset + 4 < buffer.length
                        ? address + 4
                        : (this.queue[1]?.address ?? address);
                const nextLeft = ((this.bus.read16(next) << 16) >> 16) / 32768;
                const nextRight =
                    ((this.bus.read16(next + 2) << 16) >> 16) / 32768;
                left += (nextLeft - left) * this.sourcePhase;
                right += (nextRight - right) * this.sourcePhase;
                this.sourcePhase +=
                    this.clockRate / ((this.dacRate + 1) * this.sampleRate);
                while (this.sourcePhase >= 1 && this.queue.length) {
                    this.sourcePhase -= 1;
                    const current = this.queue[0];
                    current.offset += 4;
                    if (current.offset >= current.length) {
                        this.queue.shift();
                        this.completedBuffers += 1;
                        this.bus.raiseInterrupt(4);
                    }
                }
            }
            this.samples += 1;
            if (left !== 0 || right !== 0) this.nonzeroSamples += 1;
            this.peak = Math.max(this.peak, Math.abs(left), Math.abs(right));
            this.onSample?.((left + right) / 2, this.samples);
            this.onStereo?.(left, right, this.samples);
        }
    }
}

export { AudioInterface, CPU_CLOCK };
