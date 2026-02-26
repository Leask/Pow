const SNES_BUTTON_ORDER = Object.freeze([
    'B',
    'Y',
    'SELECT',
    'START',
    'UP',
    'DOWN',
    'LEFT',
    'RIGHT',
    'A',
    'X',
    'L',
    'R',
]);

const SERIAL_BIT_COUNT = 16;
const BUTTON_BIT_COUNT = SNES_BUTTON_ORDER.length;

const SNES_BUTTON_MASK = Object.freeze(
    SNES_BUTTON_ORDER.reduce((lookup, buttonName, index) => {
        lookup[buttonName] = 1 << index;
        return lookup;
    }, {}),
);

function toAutoJoypadWord(serialMask) {
    let word = 0;

    for (let index = 0; index < BUTTON_BIT_COUNT; index += 1) {
        if (((serialMask >>> index) & 0x01) !== 0) {
            word |= 1 << (15 - index);
        }
    }

    return word & 0xffff;
}

class SNESController {
    constructor() {
        this.currentMask = 0;
        this.latchedMask = 0;
        this.shiftIndex = 0;
        this.strobe = false;
    }

    setButton(buttonName, pressed) {
        const normalized = String(buttonName).trim().toUpperCase();
        const mask = SNES_BUTTON_MASK[normalized];

        if (mask === undefined) {
            throw new RangeError(
                `Unsupported button "${buttonName}". ` +
                `Use: ${SNES_BUTTON_ORDER.join(', ')}`,
            );
        }

        if (pressed) {
            this.currentMask |= mask;
        } else {
            this.currentMask &= ~mask;
        }

        this.currentMask &= 0x0fff;
    }

    getLatchedState() {
        return toAutoJoypadWord(this.latchedMask & 0x0fff);
    }

    latch() {
        this.latchedMask = this.currentMask & 0x0fff;
        this.shiftIndex = 0;
    }

    setStrobe(enabled) {
        const next = Boolean(enabled);

        if (next) {
            this.latch();
        } else if (this.strobe && !next) {
            this.latch();
        }

        this.strobe = next;
    }

    readSerialBit() {
        if (this.strobe) {
            return this.#readSerialBitAt(this.currentMask, 0);
        }

        if (this.shiftIndex < SERIAL_BIT_COUNT) {
            const bit = this.#readSerialBitAt(
                this.latchedMask,
                this.shiftIndex,
            );
            this.shiftIndex += 1;
            return bit;
        }

        return 1;
    }

    saveState() {
        return {
            currentMask: this.currentMask & 0x0fff,
            latchedMask: this.latchedMask & 0x0fff,
            shiftIndex: this.shiftIndex & 0xff,
            strobe: this.strobe,
        };
    }

    loadState(state) {
        this.currentMask = state.currentMask & 0x0fff;
        this.latchedMask = (state.latchedMask ?? state.currentMask) & 0x0fff;
        this.shiftIndex = (state.shiftIndex ?? 0) & 0xff;
        this.strobe = Boolean(state.strobe);
    }

    #readSerialBitAt(mask, index) {
        const bitIndex = index >>> 0;

        if (bitIndex >= BUTTON_BIT_COUNT) {
            return 0;
        }

        return (mask >>> bitIndex) & 0x01;
    }
}

export {
    SNESController,
    SNES_BUTTON_ORDER,
};
