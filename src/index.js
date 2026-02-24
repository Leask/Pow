'use strict';

const { NESKernel, BUTTONS } = require('./core/nes-kernel');
const { parseINESHeader } = require('./core/ines');

module.exports = {
    NESKernel,
    BUTTONS,
    parseINESHeader,
};
