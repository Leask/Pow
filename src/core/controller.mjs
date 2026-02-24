const BUTTON_ORDER = [
    'A',
    'B',
    'SELECT',
    'START',
    'UP',
    'DOWN',
    'LEFT',
    'RIGHT',
];

const BUTTON_BIT = Object.freeze(
    BUTTON_ORDER.reduce((accumulator, name, index) => {
        accumulator[name] = index;
        return accumulator;
    }, {}),
);

class Controller {
    #state = 0;
    #shift = 0;
    #strobe = 0;

    setButton(name, pressed) {
        const normalized = String(name).trim().toUpperCase();
        const bit = BUTTON_BIT[normalized];

        if (bit === undefined) {
            throw new RangeError(
                `Unsupported button "${name}". ` +
                `Use: ${BUTTON_ORDER.join(', ')}`,
            );
        }

        const mask = 1 << bit;
        this.#state = pressed
            ? (this.#state | mask)
            : (this.#state & ~mask);

        if (this.#strobe) {
            this.#shift = this.#state;
        }
    }

    write(value) {
        this.#strobe = value & 1;

        if (this.#strobe) {
            this.#shift = this.#state;
        }
    }

    read() {
        if (this.#strobe) {
            return 0x40 | (this.#state & 1);
        }

        const value = 0x40 | (this.#shift & 1);
        this.#shift = (this.#shift >> 1) | 0x80;
        return value;
    }

    saveState() {
        return {
            state: this.#state,
            shift: this.#shift,
            strobe: this.#strobe,
        };
    }

    loadState(state) {
        this.#state = state.state & 0xff;
        this.#shift = state.shift & 0xff;
        this.#strobe = state.strobe & 1;
    }
}

export {
    Controller,
    BUTTON_ORDER,
};
