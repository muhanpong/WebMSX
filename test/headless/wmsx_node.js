// Headless WebMSX for Node: loads the same sources as test/index.html into a vm context
// with a minimal DOM stub, then drives frames by hand (no clock, no audio output).
//   var W = require("./wmsx_node.js").create({ MACHINE: "MSX2J" });
//   W.loadROM(bytes, "game.rom", "KonamiSCC"?)  W.power()  W.frame(n)  W.ram()  W.vram()  W.key(...)
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.resolve(__dirname, "../..");

function scriptList() {
    var html = fs.readFileSync(path.join(ROOT, "test/index.html"), "utf8");
    var re = /<script[^>]*src="\.\.\/([^"]+)"/g, m, list = [];
    while ((m = re.exec(html))) list.push(m[1]);
    return list.filter(function(f) { return f !== "test/Test.js"; });
}

// Anything: callable, constructible, every property is another Anything. Used for DOM nodes
// the GUI builds but nobody reads back.
function anything() {
    var store = {};
    var f = function() { return p; };
    var p = new Proxy(f, {
        get: function(t, k) {
            if (k in store) return store[k];
            if (k === Symbol.toPrimitive) return function(hint) { return hint === "number" ? 0 : ""; };
            if (k === "length") return 0;
            if (k === "then") return undefined;
            if (k === "style" || k === "classList" || k === "dataset") return (store[k] = anything());
            return anything();
        },
        set: function(t, k, v) { store[k] = v; return true; },
        apply: function() { return anything(); },
        construct: function() { return anything(); },
        has: function() { return true; }
    });
    return p;
}

var lastFrame = null;

function fakeCanvas() {
    var c = anything();
    c.width = 0; c.height = 0;
    var ctx = anything();
    ctx.createImageData = function(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; };
    ctx.getImageData = function(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; };
    ctx.putImageData = function(img, dx, dy, sx, sy, w, h) { lastFrame = { img: img, w: w || img.width, h: h || img.height }; };
    c.getContext = function() { return ctx; };
    return c;
}

exports.create = function(params) {
    params = params || {};
    var document = anything();
    document.createElement = function(tag) { return tag === "canvas" ? fakeCanvas() : anything(); };
    document.getElementById = function() { return anything(); };
    document.querySelector = function() { return anything(); };
    document.readyState = "complete";

    var ctx = {
        console: console, Math: Math, Date: Date, JSON: JSON,
        Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray, Uint16Array: Uint16Array, Uint32Array: Uint32Array,
        Int8Array: Int8Array, Int16Array: Int16Array, Int32Array: Int32Array, Float32Array: Float32Array, Float64Array: Float64Array,
        ArrayBuffer: ArrayBuffer, DataView: DataView, Promise: Promise, Proxy: Proxy, Symbol: Symbol,
        setTimeout: function() { return 0; }, clearTimeout: function() {},
        setInterval: function() { return 0; }, clearInterval: function() {},
        requestAnimationFrame: function() { return 0; }, cancelAnimationFrame: function() {},
        document: document,
        navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", appName: "Netscape", appVersion: "5.0", platform: "Linux", language: "en", languages: ["en"], maxTouchPoints: 0, getGamepads: function() { return []; } },
        location: { href: "http://localhost/", pathname: "/", port: "", search: "", hash: "", protocol: "http:", hostname: "localhost", origin: "http://localhost" },
        localStorage: { _d: {}, getItem: function(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem: function(k, v) { this._d[k] = "" + v; }, removeItem: function(k) { delete this._d[k]; } },
        performance: { now: function() { return Date.now(); } },
        Image: function() { return anything(); },
        XMLHttpRequest: function() { return anything(); },
        Event: function() {}, KeyboardEvent: function() {}, MouseEvent: function() {},
        addEventListener: function() {}, removeEventListener: function() {},
        matchMedia: function() { return { matches: false, addListener: function() {}, addEventListener: function() {} }; },
        getComputedStyle: function() { return anything(); },
        screen: { width: 1920, height: 1080 }, devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
        atob: function(s) { return Buffer.from(s, "base64").toString("binary"); },
        btoa: function(s) { return Buffer.from(s, "binary").toString("base64"); },
        WMSX_IMAGES_PATH: ""
    };
    ctx.window = ctx; ctx.self = ctx; ctx.top = ctx; ctx.parent = ctx;
    vm.createContext(ctx);

    var logs = [];
    ctx.console = { log: function() { logs.push([].join.call(arguments, " ")); }, info: function() {}, warn: function() {}, error: function() { logs.push("ERR " + [].join.call(arguments, " ")); }, debug: function() {} };

    scriptList().forEach(function(f) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
    });

    var W = ctx.WMSX;
    W.AUTO_POWER_ON_DELAY = -1;
    Object.keys(params).forEach(function(k) { W[k] = params[k]; });
    ctx.wmsx.Util.log = function(s) { logs.push(s); };
    ctx.wmsx.Util.message = function(s) { logs.push("MSG " + s); };

    // Same steps as WMSX.start, without media download and without the host clock
    var started = false;
    ctx.wmsx.Configurator.applyConfig(function() {
        W.userPreferences.load();
        W.room = new ctx.wmsx.Room(document.getElementById(), false);
        W.room.powerOn();
        ctx.wmsx.ROMDatabase.uncompress();
        // BIOS and expansions from the machine preset (embedded "@..." files load synchronously)
        var specs = ctx.wmsx.Configurator.slotURLSpecs().concat(ctx.wmsx.Configurator.extensionsInitialURLSpecs());
        new ctx.wmsx.MultiDownloader(specs, function() { started = true; }, function(u) { logs.push("LOAD ERR " + u.url + " " + u.errorMessage); }).start();
    });
    if (!started) throw new Error("config did not apply synchronously");

    var room = W.room, machine = room.machine;
    room.setLoading(false);
    machine.preStart();

    // Keyboard: the harness owns the matrix (same row/bit layout as openMSX keymatrixdown/up)
    var matrix = new Array(16).fill(0xff);
    room.controllersHub.readKeyboardPort = function(row) { return matrix[row]; };

    var frames = 0, timers = [];

    var api = {
        ctx: ctx, room: room, machine: machine, logs: logs,
        loadROM: function(bytes, name, format) {
            room.fileLoader.loadFromContentAsSlot(name || "game.rom", new Uint8Array(bytes), W.CARTRIDGE1_SLOT || [1], false, format);
        },
        power: function() { machine.powerOn(); },
        // Runs n frames. Callbacks from after() run at the start of their frame.
        frame: function(n) {
            for (var i = 0; i < (n || 1); i++) {
                if (timers.length) {
                    var due = timers.filter(function(t) { return t.at <= frames; });
                    timers = timers.filter(function(t) { return t.at > frames; });
                    due.forEach(function(t) { t.fn(); });
                }
                room.mainVideoClockPulse();
                ++frames;
            }
        },
        frames: function() { return frames; },
        after: function(nFrames, fn) { timers.push({ at: frames + nFrames, fn: fn }); },
        hook: function(pc, fn) { machine.cpu.setPCHook(pc, fn); },
        keyDown: function(row, mask) { matrix[row] &= ~mask & 0xff; },
        keyUp: function(row, mask) { matrix[row] |= mask; },
        cpu: function(expr) { return machine.cpu.eval(expr); },
        read: function(a) { return machine.bus.read(a); },
        ram: function(from, len) { var out = new Uint8Array(len); for (var i = 0; i < len; i++) out[i] = machine.bus.read((from + i) & 0xffff); return out; },
        vram: function() { return machine.vdp.vram; },
        key: function(msxKey, press) { room.keyboard.processMSXKey(msxKey, press); },
        // Last finished frame as RGBA (rows of the VDP frame canvas, width = signal width)
        screen: function() {
            if (!lastFrame) return null;
            var W0 = lastFrame.img.width, w = lastFrame.w, h = lastFrame.h, src = lastFrame.img.data, out = new Uint8Array(w * h * 4);
            for (var y = 0; y < h; y++) out.set(src.subarray(y * W0 * 4, y * W0 * 4 + w * 4), y * w * 4);
            return { w: w, h: h, rgba: out };
        },
        png: function(file) {
            var s = this.screen(), zlib = require("zlib");
            var raw = Buffer.alloc((s.w * 4 + 1) * s.h);
            for (var y = 0; y < s.h; y++) { raw[y * (s.w * 4 + 1)] = 0; Buffer.from(s.rgba.buffer, y * s.w * 4, s.w * 4).copy(raw, y * (s.w * 4 + 1) + 1); }
            for (var i = 0; i < s.w * s.h; i++) raw[Math.floor(i / s.w) * (s.w * 4 + 1) + 1 + (i % s.w) * 4 + 3] = 255;
            function chunk(t, d) { var l = Buffer.alloc(4); l.writeUInt32BE(d.length); var td = Buffer.concat([Buffer.from(t), d]); var c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([l, td, c]); }
            var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(s.w, 0); ihdr.writeUInt32BE(s.h, 4); ihdr[8] = 8; ihdr[9] = 6;
            fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
        }
    };
    return api;
};
