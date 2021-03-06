'use strict';

const { Transform } = require('stream');

const PP = require('polygon-points');

const PC = require('./lib/pixel-change');

class PamDiff extends Transform {

    /**
     *
     * @param [options] {Object}
     * @param [options.difference] {Number} - Pixel difference value 1 to 255
     * @param [options.percent] {Number} - Percent of pixels that exceed difference value.
     * @param [options.regions] {Array} - Array of regions.
     * @param [options.regions[i].name] {String} - Name of region.
     * @param [options.regions[i].difference] {Number} - Difference value for region.
     * @param [options.regions[i].percent] {Number} - Percent value for region.
     * @param [options.regions[i].polygon] {Array} - Array of x y coordinates [{x:0,y:0},{x:0,y:360},{x:160,y:360},{x:160,y:0}]
     * @param [options.mask] {Boolean} - Indicate if regions should be used as masks of pixels to ignore instead of areas of interest.
     * @param [callback] {Function} - Function to be called when diff event occurs.
     */
    constructor(options, callback) {
        super(options);
        Transform.call(this, {objectMode: true});
        this.difference = PamDiff._parseOptions('difference', options);//global option, can be overridden per region
        this.percent = PamDiff._parseOptions('percent', options);//global option, can be overridden per region
        this.mask = PamDiff._parseOptions('mask', options);//should be processed before regions
        this.regions = PamDiff._parseOptions('regions', options);//can be no regions or a single region or multiple regions. if no regions, all pixels will be compared.
        this.callback = callback;//callback function to be called when pixel difference is detected
        this._parseChunk = this._parseFirstChunk;//first parsing will be reading settings and configuring internal pixel reading
    }

    /**
     *
     * @param option {String}
     * @param options {Object}
     * @return {*}
     * @private
     */
    static _parseOptions(option, options) {
        if (options && options.hasOwnProperty(option)) {
            return options[option];
        }
        return null;
    }

    /**
     *
     * @param number {Number}
     * @param def {Number}
     * @param low {Number}
     * @param high {Number}
     * @return {Number}
     * @private
     */
    static _validateNumber(number, def, low, high) {
        if (isNaN(number)) {
            return def;
        } else if (number < low) {
            return low;
        } else if (number > high) {
            return high;
        } else {
            return number;
        }
    }

    /**
     *
     * @param bool
     * @return {boolean}
     * @private
     */
    static _validateBoolean(bool) {
        return (bool === true || bool === 'true' || bool === 1 || bool === '1');
    }

    /**
     *
     * @param number {Number}
     */
    set difference(number) {
        this._difference = PamDiff._validateNumber(parseInt(number), 5, 1, 255);
        this._configurePixelDiffEngine();
    }

    /**
     *
     * @return {Number}
     */
    get difference() {
        return this._difference;
    }

    /**
     *
     * @param number {Number}
     * @return {PamDiff}
     */
    setDifference(number) {
        this.difference = number;
        return this;
    }

    /**
     *
     * @param number {Number}
     */
    set percent(number) {
        this._percent = PamDiff._validateNumber(parseInt(number), 5, 1, 100);
        this._configurePixelDiffEngine();
    }

    /**
     *
     * @return {Number}
     */
    get percent() {
        return this._percent;
    }

    /**
     *
     * @param number {Number}
     * @return {PamDiff}
     */
    setPercent(number) {
        this.percent = number;
        return this;
    }

    /**
     *
     * @param array {Array}
     */
    set regions(array) {
        if (!array) {
            delete this._regions;
            delete this._regionObj;
            delete this._maskObj;
        } else if (!Array.isArray(array) || array.length < 1) {
            throw new Error(`Regions must be an array of at least 1 region object {name: 'region1', difference: 10, percent: 10, polygon: [[0, 0], [0, 50], [50, 50], [50, 0]]}`);
        } else {
            this._regions = array;
            this._processRegions();
        }
        this._configurePixelDiffEngine();
    }

    /**
     *
     * @return {Array}
     */
    get regions() {
        return this._regions;
    }

    /**
     *
     * @param array {Array}
     * @return {PamDiff}
     */
    setRegions(array) {
        this.regions = array;
        return this;
    }

    set mask(bool) {
        this._mask = PamDiff._validateBoolean(bool);
        this._processRegions();
        this._configurePixelDiffEngine();
    }

    get mask() {
        return this._mask;
    }

    setMask(bool) {
        this.mask = bool;
        return this;
    }

    /**
     *
     * @param func {Function}
     */
    set callback(func) {
        if (!func) {
            delete this._callback;
        } else if (typeof func === 'function' && func.length === 1) {
            this._callback = func;
        } else {
            throw new Error('Callback must be a function that accepts 1 argument.');
        }
    }

    /**
     *
     * @return {Function}
     */
    get callback() {
        return this._callback;
    }

    /**
     *
     * @param func {Function}
     * @return {PamDiff}
     */
    setCallback(func) {
        this.callback = func;
        return this;
    }

    /**
     *
     * @return {PamDiff}
     */
    resetCache() {
        delete this._oldPix;
        delete this._newPix;
        delete this._width;
        delete this._height;
        delete this._tupltype;
        delete this._regionObj;
        delete this._maskObj;
        delete this._pixelDiffEngine;
        this._parseChunk = this._parseFirstChunk;
        return this;
    }

    /**
     *
     * @private
     */
    _processRegions() {
        if (!this._regions || !this._width || !this._height) {
            return;
        }
        if (this._mask) {
            const wxh = this._width * this._height;
            const buffer = Buffer.alloc(wxh, 1);
            for (const region of this._regions) {
                if (!region.hasOwnProperty('polygon')) {
                    throw new Error('Region must include a polygon property');
                }
                const pp = new PP(region.polygon);
                const bitset = pp.getBitset(this._width, this._height);
                const bitsetBuffer = bitset.buffer;
                for (let i = 0; i < wxh; i++) {
                    if (bitsetBuffer[i]) {
                        buffer[i] = 0;
                    }
                }
            }
            let count = 0;
            for (let i = 0; i < wxh; i++) {
                if (buffer[i]) {
                    count++;
                }
            }
            this._maskObj = {count: count, bitset: buffer};
        } else {
            const regions = [];
            let minDiff = 255;
            for (const region of this._regions) {
                if (!region.hasOwnProperty('name') || !region.hasOwnProperty('polygon')) {
                    throw new Error('Region must include a name and a polygon property');
                }
                const pp = new PP(region.polygon);
                const bitset = pp.getBitset(this._width, this._height);
                const difference = PamDiff._validateNumber(parseInt(region.difference), this._difference, 1, 255);
                const percent = PamDiff._validateNumber(parseInt(region.percent), this._percent, 1, 100);
                minDiff = Math.min(minDiff, difference);
                regions.push(
                    {
                        name: region.name,
                        diff: difference,
                        percent: percent,
                        count: bitset.count,
                        bitset: bitset.buffer
                    }
                );
            }
            this._regionObj = {minDiff: minDiff, length: regions.length, regions: regions};
        }

    }

    /**
     *
     * @private
     */
    _configurePixelDiffEngine() {
        if (!this._tupltype || !this._width || ! this._height) {
            return;
        }
        const wxh = this._width * this._height;
        switch (this._tupltype) {
            case 'grayscale':
                if (this._regionObj) {
                    this._pixelDiffEngine = PC.compareGrayRegions.bind(this, this._regionObj.minDiff, this._regionObj.length, this._regionObj.regions, wxh);
                } else if (this._maskObj) {
                    this._pixelDiffEngine = PC.compareGrayMask.bind(this, this._difference, this._percent, this._maskObj.count, this._maskObj.bitset, wxh);
                } else {
                    this._pixelDiffEngine = PC.compareGrayPixels.bind(this, this._difference, this._percent, wxh, wxh);
                }
                break;
            case 'rgb':
                if (this._regionObj) {
                    this._pixelDiffEngine = PC.compareRgbRegions.bind(this, this._regionObj.minDiff, this._regionObj.length, this._regionObj.regions, wxh * 3);
                } else if (this._maskObj) {
                    this._pixelDiffEngine = PC.compareRgbMask.bind(this, this._difference, this._percent, this._maskObj.count, this._maskObj.bitset, wxh * 3);
                } else {
                    this._pixelDiffEngine = PC.compareRgbPixels.bind(this, this._difference, this._percent, wxh, wxh * 3);
                }
                break;
            case 'rgb_alpha':
                if (this._regionObj) {
                    this._pixelDiffEngine = PC.compareRgbaRegions.bind(this, this._regionObj.minDiff, this._regionObj.length, this._regionObj.regions, wxh * 4);
                } else if (this._maskObj) {
                    this._pixelDiffEngine = PC.compareRgbaMask.bind(this, this._difference, this._percent, this._maskObj.count, this._maskObj.bitset, wxh * 4);
                } else {
                    this._pixelDiffEngine = PC.compareRgbaPixels.bind(this, this._difference, this._percent, wxh, wxh * 4);
                }
                break;
            default:
                throw new Error('Did not find a matching tupltype');
        }
        if (process.env.NODE_ENV === 'development') {
            this._parseChunk = this._parsePixelsDebug;
        } else {
            this._parseChunk = this._parsePixels;
        }
    }

    /**
     *
     * @param chunk
     * @private
     */
    _parsePixels(chunk) {
        this._newPix = chunk.pixels;
        const results = this._pixelDiffEngine(this._oldPix, this._newPix);
        if (results.length) {
            const data = {trigger: results, pam:chunk.pam};
            if (this._callback) {
                this._callback(data);
            }
            if (this._readableState.pipesCount > 0) {
                this.push(data);
            }
            if (this.listenerCount('diff') > 0) {
                this.emit('diff', data);
            }
        }
        this._oldPix = this._newPix;
    }

    /**
     *
     * @param chunk
     * @private
     */
    _parsePixelsDebug(chunk) {
        console.time(this._pixelDiffEngine.name);
        this._newPix = chunk.pixels;
        const results = this._pixelDiffEngine(this._oldPix, this._newPix);
        if (results.length) {
            const data = {trigger: results, pam:chunk.pam};
            if (this._callback) {
                this._callback(data);
            }
            if (this._readableState.pipesCount > 0) {
                this.push(data);
            }
            if (this.listenerCount('diff') > 0) {
                this.emit('diff', data);
            }
        }
        this._oldPix = this._newPix;
        console.timeEnd(this._pixelDiffEngine.name);
    }

    /**
     *
     * @param chunk
     * @private
     */
    _parseFirstChunk(chunk) {
        this._width = parseInt(chunk.width);
        this._height = parseInt(chunk.height);
        this._oldPix = chunk.pixels;
        this._tupltype = chunk.tupltype;
        this._processRegions();
        this._configurePixelDiffEngine();
    }

    /**
     *
     * @param chunk
     * @param encoding
     * @param callback
     * @private
     */
    _transform(chunk, encoding, callback) {
        this._parseChunk(chunk);
        callback();
    }

    /**
     *
     * @param callback
     * @private
     */
    _flush(callback) {
        this.resetCache();
        callback();
    }
}

/**
 *
 * @type {PamDiff}
 */
module.exports = PamDiff;