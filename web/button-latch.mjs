// Keep short keyboard taps visible until the emulated pad has been polled.
class ButtonLatch {
    constructor(press, release) {
        this.press = press;
        this.release = release;
        this.buttons = new Map();
    }

    update(button, pressed, frame, minimumFrames) {
        if (pressed) {
            if (!this.buttons.has(button)) {
                this.press(button);
                this.buttons.set(button, { until: frame + minimumFrames });
            }
            this.buttons.get(button).released = false;
        } else {
            const state = this.buttons.get(button);
            if (state) state.released = true;
            this.advance(frame);
        }
    }

    advance(frame) {
        for (const [button, state] of this.buttons) {
            if (state.released && frame >= state.until) {
                this.release(button);
                this.buttons.delete(button);
            }
        }
    }

    clear() {
        for (const button of this.buttons.keys()) this.release(button);
        this.buttons.clear();
    }
}

export { ButtonLatch };
