const RGBA16_COLORS = Uint32Array.from(
    { length: 65536 },
    (_, value) =>
        (0xff000000 |
            (Math.round((((value >>> 11) & 31) * 255) / 31) << 16) |
            (Math.round((((value >>> 6) & 31) * 255) / 31) << 8) |
            Math.round((((value >>> 1) & 31) * 255) / 31)) >>>
        0,
);

class VideoInterface {
    constructor(bus) {
        this.bus = bus;
        this.width = 320;
        this.height = 240;
        this.frameBuffer = new Uint32Array(this.width * this.height);
    }

    render() {
        const vi = this.bus.vi;
        const format = vi[0] & 3;
        const origin = vi[1] & 0x00ffffff;
        const stride = vi[2] & 4095;
        if (format < 2 || stride === 0 || vi[9] === 0) {
            this.frameBuffer.fill(0xff000000);
            return this.frameBuffer;
        }
        const bytes = format === 3 ? 4 : 2;
        for (let y = 0; y < this.height; y += 1) {
            for (let x = 0; x < this.width; x += 1) {
                const address = origin + (y * stride + x) * bytes;
                let color;
                if (format === 2) {
                    color = RGBA16_COLORS[this.bus.read16(address)];
                } else color = 0xff000000 | (this.bus.read32(address) >>> 8);
                this.frameBuffer[y * this.width + x] = color;
            }
        }
        return this.frameBuffer;
    }
}

export { VideoInterface };
