class PowAudioOutput extends AudioWorkletProcessor {
    constructor() {
        super();
        this.left = new Float32Array(32768);
        this.right = new Float32Array(32768);
        this.read = 0;
        this.write = 0;
        this.size = 0;
        this.played = 0;
        this.underruns = 0;
        this.peak = 0;
        this.nonzero = 0;
        this.active = false;
        this.started = false;
        this.epoch = 0;
        this.blocks = 0;
        this.port.onmessage = ({ data }) => {
            if (data.type === 'clear') {
                this.read = this.write = this.size = this.played = 0;
                this.started = false;
                this.epoch = data.epoch;
                this.peak = this.nonzero = this.underruns = 0;
            } else if (data.type === 'active') this.active = data.value;
            else if (data.type === 'samples' && data.epoch === this.epoch) {
                const samples = data.samples;
                for (let i = 0; i < samples.length; i += 2) {
                    if (this.size === this.left.length) break;
                    this.left[this.write] = samples[i];
                    this.right[this.write] = samples[i + 1];
                    this.write = (this.write + 1) & 32767;
                    this.size += 1;
                }
            }
        };
    }

    process(inputs, outputs) {
        const [left, right] = outputs[0];
        if (!this.started && this.size >= 2048) this.started = true;
        let underflow = false;
        for (let i = 0; i < left.length; i += 1) {
            if (this.active && this.started && this.size > 0) {
                left[i] = this.left[this.read];
                right[i] = this.right[this.read];
                const amplitude = Math.max(
                    Math.abs(left[i]),
                    Math.abs(right[i]),
                );
                this.peak = Math.max(this.peak, amplitude);
                if (amplitude > 0.0001) this.nonzero += 1;
                this.read = (this.read + 1) & 32767;
                this.size -= 1;
                this.played += 1;
            } else {
                left[i] = right[i] = 0;
                if (this.active && this.started) underflow = true;
            }
        }
        if (underflow) {
            this.underruns += 1;
            this.started = false;
        }
        if ((this.blocks++ & 3) === 0) {
            this.port.postMessage({
                epoch: this.epoch,
                played: this.played,
                underruns: this.underruns,
                started: this.started,
                peak: this.peak,
                nonzero: this.nonzero,
            });
        }
        return true;
    }
}

registerProcessor('pow-audio-output', PowAudioOutput);
