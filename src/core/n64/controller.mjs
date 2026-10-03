const BUTTON_MASKS = Object.freeze({
    A: 0x8000,
    B: 0x4000,
    Z: 0x2000,
    START: 0x1000,
    UP: 0x0800,
    DOWN: 0x0400,
    LEFT: 0x0200,
    RIGHT: 0x0100,
    L: 0x0020,
    R: 0x0010,
    C_UP: 0x0008,
    C_DOWN: 0x0004,
    C_LEFT: 0x0002,
    C_RIGHT: 0x0001,
});

class N64Controller {
    constructor(connected = true) {
        this.connected = connected;
        this.buttons = 0;
        this.stickX = 0;
        this.stickY = 0;
    }

    setButton(name, pressed) {
        const mask = BUTTON_MASKS[String(name).toUpperCase()];
        if (mask === undefined)
            throw new RangeError(`Unknown N64 button: ${name}`);
        this.buttons = pressed ? this.buttons | mask : this.buttons & ~mask;
    }

    setStick(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new RangeError('N64 stick coordinates must be finite.');
        }
        this.stickX = Math.max(-80, Math.min(80, Math.round(x)));
        this.stickY = Math.max(-80, Math.min(80, Math.round(y)));
    }
}

export { N64Controller, BUTTON_MASKS as N64_BUTTON_MASKS };
