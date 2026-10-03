// Snapshot explicit device roots, excluding their live graph/ROM/callbacks.
const OMIT = new Set([
    'options',
    'rom',
    'header',
    'bus',
    'machine',
    'cartridge',
    'cpu',
    'cpus',
    'buses',
    'ppu',
    'apu',
    'audio',
    'lastFrameBuffer',
    'vramMappings',
    'vramPages',
]);
function copy(value) {
    if (ArrayBuffer.isView(value)) return value.slice();
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (!OMIT.has(key) && typeof item !== 'function')
                result[key] = copy(item);
        }
        return result;
    }
    return value;
}
function validate(target, state) {
    if (ArrayBuffer.isView(target)) {
        if (
            !(state instanceof target.constructor) ||
            state.length !== target.length
        )
            throw new Error('Invalid state buffer.');
        if (state instanceof Float32Array || state instanceof Float64Array) {
            for (const value of state) {
                if (!Number.isFinite(value))
                    throw new Error('Invalid state number.');
            }
        }
    } else if (Array.isArray(target)) {
        if (!Array.isArray(state)) throw new Error('Invalid state array.');
        // FIFO arrays intentionally vary in length.
        if (target.length && typeof target[0] === 'object') {
            if (state.length !== target.length)
                throw new Error('Invalid state device count.');
            target.forEach((item, i) => validate(item, state[i]));
        } else
            for (const value of state) {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    throw new Error('Invalid state FIFO value.');
                }
            }
    } else if (target && typeof target === 'object') {
        if (!state || typeof state !== 'object')
            throw new Error('Invalid device state.');
        for (const key of Object.keys(target)) {
            if (OMIT.has(key) || typeof target[key] === 'function') continue;
            if (!(key in state)) throw new Error(`Missing state field ${key}`);
            validate(target[key], state[key]);
        }
    } else if (typeof target === 'number' && !Number.isFinite(state))
        throw new Error('Invalid state number.');
    else if (typeof target !== typeof state)
        throw new Error('Invalid state value.');
}
function restore(target, state) {
    if (ArrayBuffer.isView(target)) {
        target.set(state);
        return;
    }
    for (const key of Object.keys(target)) {
        if (OMIT.has(key) || typeof target[key] === 'function') continue;
        const value = state[key];
        if (ArrayBuffer.isView(target[key])) target[key].set(value);
        else if (Array.isArray(target[key])) target[key] = copy(value);
        else if (target[key] && typeof target[key] === 'object')
            restore(target[key], value);
        else target[key] = value;
    }
}
function roots(kernel) {
    if (kernel.machine) {
        const m = kernel.machine;
        return [kernel, m, ...kernel.cpus, ...m.buses, m.ppu, m.audio];
    }
    return [
        kernel,
        kernel.cpu,
        kernel.bus,
        kernel.bus.ppu,
        kernel.bus.apu,
        ...(kernel.cartridge ? [kernel.cartridge] : []),
    ];
}
function saveHandheldState(kernel) {
    const devices = roots(kernel);
    return {
        version: 1,
        system: stateSystem(kernel),
        identity: kernel.romIdentity,
        devices: devices.map(copy),
    };
}
function stateSystem(kernel) {
    return kernel.cartridge
        ? kernel.bus.color
            ? 'GBC'
            : 'GB'
        : kernel.getROMMetadata().format;
}
function loadHandheldState(kernel, state) {
    if (
        !state ||
        state.version !== 1 ||
        state.system !== stateSystem(kernel) ||
        state.identity !== kernel.romIdentity
    ) {
        throw new Error('State version, system, or cartridge mismatch.');
    }
    const devices = roots(kernel);
    if (
        !Array.isArray(state.devices) ||
        devices.length !== state.devices.length
    )
        throw new Error('Invalid state device count.');
    devices.forEach((device, i) => validate(device, state.devices[i]));
    devices.forEach((device, i) => restore(device, state.devices[i]));
    if (kernel.machine) kernel.machine.remapVRAM();
    kernel.lastFrameBuffer =
        kernel.machine?.ppu.frameBuffer ?? kernel.bus.ppu.frameBuffer;
}
export { saveHandheldState, loadHandheldState };
