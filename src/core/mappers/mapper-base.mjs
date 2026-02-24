class MapperBase {
    constructor(cartridge) {
        this.cartridge = cartridge;
    }

    cpuRead(_address) {
        return 0;
    }

    cpuWrite(_address, _value) {
        return;
    }

    ppuRead(_address) {
        return 0;
    }

    ppuWrite(_address, _value) {
        return;
    }

    saveState() {
        return {};
    }

    loadState(_state) {
        return;
    }
}

export {
    MapperBase,
};
