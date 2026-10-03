// Snapshots copy mutable data only; buses and callbacks keep their live identity.
const EXCLUDED = new Set([
    'bus',
    'rom',
    'romView',
    'ramView',
    'spView',
    'pifView',
    'view',
    'fpScratch',
    'fprSingle',
    'fprDouble',
    'onSample',
    'onStereo',
    'onTask',
    'trace',
    'texelCache',
]);

function snapshot(value) {
    if (typeof value === 'bigint') return { bigint: value.toString() };
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return value.slice();
    if (value instanceof Map)
        return { map: [...value].map(([key, item]) => [key, snapshot(item)]) };
    if (Array.isArray(value)) return value.map(snapshot);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (EXCLUDED.has(key) || typeof item === 'function') continue;
        result[key] = snapshot(item);
    }
    return result;
}

function restore(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (EXCLUDED.has(key)) continue;
        if (ArrayBuffer.isView(target[key])) target[key].set(value);
        else if (target[key] instanceof Map) {
            target[key].clear();
            for (const [entry, item] of value.map)
                target[key].set(entry, snapshot(item));
        } else if (Array.isArray(value)) {
            const previous = target[key];
            target[key] = value.map((item, index) => {
                if (item?.bigint !== undefined) return BigInt(item.bigint);
                if (
                    item &&
                    !Array.isArray(item) &&
                    previous?.[index] &&
                    typeof previous[index] === 'object'
                ) {
                    restore(previous[index], item);
                    return previous[index];
                }
                return snapshot(item);
            });
        } else if (value && typeof value === 'object') {
            if (value.bigint !== undefined) target[key] = BigInt(value.bigint);
            else if (target[key] && typeof target[key] === 'object')
                restore(target[key], value);
            else target[key] = snapshot(value);
        } else target[key] = value;
    }
}

export { snapshot, restore };
