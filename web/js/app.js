// Page controller. ESP32 board card first, then the cards of the path picked at the top
// (PATHS): GBA + Switch (adapter and play cards), Switch only (trade card), Celio, Mystery
// Gift or Tomodachi Life. Board and adapter cards render from one view object each: status line, optional
// hint, at most one primary action.

import { EspDevice, ESP_FILTERS, FAST_BAUD, newer, reopenPort, sleep } from './esp.js';
import { GbLinkSerial, GbLinkUsb, BOOTROM_VENDOR_ID, GBLINK_VENDOR_ID } from './gblink.js';
import { Bridge } from './bridge.js';
import { CableSession } from './cable/session.js';
import { CELIO_SERVER, CelioSession } from './cable/celio.js';
import { parseProdKeys } from './keys.js';
import { loadManifest, fetchBytes } from './manifest.js';
import { fromHex, toHex } from './trade/bytes.js';
import { Party, describe as describeMon } from './trade/party.js';
import { parse as parsePk3 } from './trade/pk3.js';
import { spriteUrl, spriteFallbackUrl } from './trade/sprites.js';
import { CancelledError, TradeSession } from './trade/session.js';
import { POOL_SERVER, PoolClient } from './trade/pool.js';
import { LINK_FIRMWARE, MiiLink } from './mii/link.js';
import { MAX_NAME, describe as describePayload } from './mii/payload.js';
import { CUSTOM_VOICE, PERSONALITY, Payload, VOICE_PRESETS, VOICE_RANGES } from './mii/mii.js';

const $ = (id) => document.getElementById(id);

const CHIP_NAMES = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32c5: 'ESP32-C5', esp32c6: 'ESP32-C6', esp32s3: 'ESP32-S3' };
// Standalone UART link pins: [board TX -> adapter GP9, board RX <- adapter GP8].
const LINK_PINS = { esp32: [17, 16], esp32c3: [5, 4], esp32c5: [0, 1], esp32c6: [2, 1], esp32s3: [2, 1] };
// Dev-board silkscreen labels where they differ from the GPIO number.
const LINK_PIN_LABELS = { esp32: ['TX2', 'RX2'] };
const KEY_NAMES = {
    kek: 'aes_kek_generation_source',
    gen: 'aes_key_generation_source',
    master00: 'master_key_00',
    master12: 'master_key_12',
};
const POLL_MS = 5000;
// Why the board restarted, when it was not its own doing (after each session it restarts on
// purpose, as "software").
const RESTART_REASONS = {
    brownout: 'the board restarted because its power dipped (brownout), most likely as its radio started sending. Try another USB cable or port, a powered hub, or a different board.',
    panic: 'the board restarted after a crash.',
    'interrupt-watchdog': 'the board restarted: it stopped responding (watchdog).',
    'task-watchdog': 'the board restarted: it stopped responding (watchdog).',
    watchdog: 'the board restarted: it stopped responding (watchdog).',
};

const state = {
    manifest: null,
    path: 'gba',            // shown path: gba | switch | celio | gift | mii

    esp: null,
    espPort: null,          // picked port that failed to attach
    espPhase: 'idle',       // idle | choosing | connecting | installing | starting
    espProblem: null,       // { code, text, hint } from the last attempt
    espNote: '',            // installer status text
    espProgress: null,
    askForEsp: false,       // remembered board failed, show the chooser next time
    keys: null,
    keysNote: null,         // { text, tone } for the last key operation
    replacingKeys: false,
    session: null,
    polls: 0,
    signal: null,           // Switch signal in dBm (firmware 2.0.2+)
    pollTimer: null,

    adapter: null,
    adapterInfo: null,
    adapterPhase: 'idle',   // idle | choosing | connecting
    adapterProblem: null,
    askForAdapter: false,
    bootDevice: null,       // adapter picked while already in its bootloader
    install: null,          // { step, manual, progress, image } during install
    customUf2: null,
    uf2Note: null,

    source: 'pool',         // trade source: pool | party
    poolServer: POOL_SERVER,
    poolMon: null,          // pool's Pokémon while connected
    menuOpen: false,
    trading: false,         // both sides confirmed, trade in progress
    kept: [],               // Switch's Pokémon from swaps the pool did not confirm
    party: new Party(),
    partyNote: '',
    pickerSlot: 0,
    trade: null,            // TradeSession while running
    tradeStop: null,        // its AbortController
    tradePhase: '',
    tradeTone: '',
    tradeDeclining: false,
    trades: 0,
    offered: -1,            // slot offered by this page while connected
    hiddenAt: 0,
    opponent: null,         // { name, party: [six or null] }

    resetLoop: false,       // adapter reports repeated resets by the game
    game: 'wireless',       // the GBA's game: wireless (FRLG, Emerald) | cable (Ruby, Sapphire)
    bypassNationally: false,   // skip the Kanto/Hoenn progress checks; not remembered, off on every visit
    bridge: null,           // Bridge, or CableSession for Ruby and Sapphire
    celio: null,            // CelioSession: in a Celio session, linking once started
    celioNote: null,        // { text, tone }
    celioServer: CELIO_SERVER,
    gift: null,             // GiftDistribution while the page's Mystery Gift group is open
    giftEvent: null,        // id of the chosen event
    giftFile: null,         // the event of a .wc3 opened on the page
    giftFileNote: null,     // why the last .wc3 could not be opened
    giftStatus: null,       // the link now: { stage, event, player, detail, result }
    giftDecision: null,     // the question the Switch waits on, or null
    giftResult: null,       // the last delivery, shown until the next Switch joins
    giftBackups: [],        // saves backed up while the page is open, newest first: { bytes, name, whole, time }
    giftLinkBackup: null,   // the entry for the backup in this link
    giftRestore: null,      // the .sav chosen to restore, { bytes, name }
    giftRestoreNote: null,  // why the chosen .sav can't be restored
    giftNote: null,         // { text, tone }
    giftClosing: false,     // Stop pressed: waiting for the board to close its room and restart
    mii: null,              // MiiLink while the page is in Tomodachi Life's Local Play
    miiStatus: null,        // { stage, detail } from the link
    miiNote: null,          // { text, tone }
    miiStopping: false,
    miiOutgoing: null,      // what to send, edited on the card: { payload, about, fileName }
    miiSendNote: null,      // { text, tone } about the last send
    miiReceived: [],        // what the Switch sent while the page is open, newest first: { bytes, about, time }
    bridgeTimer: null,
    bridgeNote: null,
    wiringNote: null,
};

// ---------------------------------------------------------------- small helpers

function setLine(id, text, tone = '') {
    const element = $(id);
    element.textContent = text ?? '';
    element.className = `${element.dataset.base ?? element.className.split(' ')[0]} ${tone}`.trim();
}

function setProgress(id, fraction) {
    const element = $(id);
    if (id === 'esp-progress') element.hidden = fraction === null || fraction === undefined;
    element.firstElementChild.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

// Consecutive duplicates collapse into one line with a count.
const logLines = [];
let lastLogged = { key: '', count: 0 };
function log(source, text) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    const key = `${source}\n${text}`;
    if (key === lastLogged.key && logLines.length) {
        lastLogged.count++;
        logLines[logLines.length - 1] = `${stamp}  ${source.padEnd(7)} ${text}  (×${lastLogged.count})`;
    } else {
        lastLogged = { key, count: 1 };
        logLines.push(`${stamp}  ${source.padEnd(7)} ${text}`);
        if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
    }
    const view = $('log');
    const pinned = view.scrollTop + view.clientHeight >= view.scrollHeight - 8;
    view.textContent = logLines.join('\n');
    if (pinned) view.scrollTop = view.scrollHeight;
}

function describe(error) {
    return error?.message || String(error);
}

// Opens a browser device chooser. Resolves null if nothing was picked.
async function choose(request) {
    try {
        return await request();
    } catch (error) {
        if (error?.name !== 'NotFoundError') log('page', `the browser would not show its device list: ${describe(error)}`);
        return null;
    }
}

// ---------------------------------------------------------------- ESP32 board: what to show

const ESP_PROBLEMS = {
    'no-firmware': () => ({
        tone: 'warn',
        text: 'This board doesn’t have the bridge firmware yet.',
        primary: ['Install firmware', () => onEspInstall()],
        secondary: ['Pick another port', onEspPickAnother],
    }),
    'download-mode': () => ({
        tone: 'warn',
        text: 'The board is in its bootloader, ready for firmware.',
        hint: 'If it already has the firmware, press its reset (EN) button instead and connect again.',
        primary: ['Install firmware', () => onEspInstall()],
        secondary: ['Connect again', onEspConnect],
    }),
    'crash-loop': (problem) => ({
        tone: 'bad',
        text: 'The firmware on this board crashes as it starts.',
        hint: problem.hint ? `${problem.hint} (also in the log below)` : 'Installing it again usually fixes that.',
        primary: ['Install firmware again', () => onEspInstall()],
    }),
    'port-busy': () => ({
        tone: 'bad',
        text: 'Another program has this port open.',
        hint: 'Close any serial monitor or flashing tool, then try again.',
        primary: ['Try again', onEspConnect],
        secondary: ['Pick another port', onEspPickAnother],
    }),
    'port-lost': () => ({
        tone: 'bad',
        text: 'The browser lost the port as it opened it.',
        hint: 'Unplug the board and plug it back in, then connect again. On Linux this happens after another serial program has used the port.',
        primary: ['Connect', onEspConnect],
    }),
    'install-failed': (problem) => ({
        tone: 'bad',
        text: problem.text,
        hint: problem.hint,
        primary: ['Try again', () => onEspInstall()],
        secondary: ['Pick another port', onEspPickAnother],
    }),
    'silent-after-install': () => ({
        tone: 'warn',
        text: 'Installed, but the board hasn’t answered yet.',
        hint: 'Press its reset button, or unplug it and plug it back in, then connect.',
        primary: ['Connect', onEspConnect],
    }),
    gone: (problem) => ({ tone: problem.tone ?? '', text: problem.text, primary: ['Connect', onEspConnect] }),
};

function espView() {
    if (state.espPhase === 'choosing') {
        return {
            busy: true,
            text: 'Pick the board in the list the browser is showing.',
            hint: 'It is listed as “USB JTAG/serial debug unit”, or as “CP2102” or “CH340” on boards with a separate USB chip.',
        };
    }
    if (state.espPhase === 'connecting') return { busy: true, text: 'Looking for the bridge firmware…' };
    if (state.espPhase === 'installing') return { busy: true, text: state.espNote, progress: state.espProgress };
    if (state.espPhase === 'starting') return { busy: true, text: 'Installed. Waiting for the board to start…' };

    const esp = state.esp;
    if (state.espProblem) {
        const view = (ESP_PROBLEMS[state.espProblem.code] ?? ESP_PROBLEMS.gone)(state.espProblem);
        return { ...view, connected: Boolean(esp) };
    }
    if (!esp) return { text: 'Plug the board into this computer with a USB data cable.', primary: ['Connect', onEspConnect] };
    const name = CHIP_NAMES[esp.info?.chip] ?? esp.info?.chip ?? 'board';
    if (!esp.attached) {
        return { busy: true, connected: true, done: Boolean(state.keys?.complete), text: `${name} · restarting, as it does after every session…` };
    }
    const bundled = state.manifest?.bridge.version;
    if (!esp.info || (bundled && newer(bundled, esp.info.version))) {
        return {
            connected: true,
            tone: 'warn',
            text: esp.info ? `Firmware ${esp.info.version} is installed; ${bundled} is available.` : 'This board’s firmware is older than this page expects.',
            primary: ['Update firmware', () => onEspInstall()],
        };
    }
    if (!state.keys?.complete || state.replacingKeys) {
        return {
            connected: true,
            tone: state.keys?.complete ? '' : 'warn',
            dot: state.keys?.complete ? 'good' : 'warn',
            text: state.keys?.complete ? `${name} connected. Drop a prod.keys to replace the stored keys.` : `${name} connected. It still needs your console’s keys.`,
            keys: true,
        };
    }
    return { connected: true, done: true, tone: 'good', text: `${name} · firmware ${esp.info.version} · keys stored` };
}

// ---------------------------------------------------------------- ESP32 board: doing things

async function onEspConnect() {
    if (state.espPhase !== 'idle' || state.esp) return;
    let port = (await livePort(state.espPort)) ?? (await rememberedEspPort());
    if (!port) {
        state.espPhase = 'choosing';
        render();
        port = await choose(() => EspDevice.requestPort());
        state.espPhase = 'idle';
    }
    if (port) await attachEsp(port);
    else render();
}

async function onEspPickAnother() {
    if (state.espPhase !== 'idle') return;
    state.askForEsp = true;
    state.espPort = null;
    state.espProblem = null;
    await onEspConnect();
}

// Native-USB chips re-enumerate as a new port object (same permission) on every reset,
// leaving the old object dead.
async function livePort(port) {
    if (!port) return null;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch {}
    if (ports.includes(port)) return port;
    const was = port.getInfo();
    const same = ports.filter((other) => other.getInfo().usbVendorId === was.usbVendorId && other.getInfo().usbProductId === was.usbProductId);
    return same.length === 1 ? same[0] : null;
}

// Reuses a previously granted board without prompting if exactly one matches.
async function rememberedEspPort() {
    if (state.askForEsp) return null;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch {}
    ports = ports.filter((port) => ESP_FILTERS.some((filter) => filter.usbVendorId === port.getInfo().usbVendorId));
    return ports.length === 1 ? ports[0] : null;
}

async function attachEsp(port) {
    state.espPhase = 'connecting';
    state.espProblem = null;
    render();
    const device = new EspDevice();
    try {
        await device.open(port);
    } catch (error) {
        await device.close();
        state.espPort = error.code === 'port-lost' ? null : port;
        state.espProblem = { code: error.code ?? 'no-firmware', text: describe(error), hint: error.detail };
        if (error.code === 'crash-loop') log('board', `crashing at start-up: ${error.detail || 'no detail captured'}`);
        state.espPhase = 'idle';
        render();
        return;
    }
    state.askForEsp = false;
    state.espPhase = 'idle';
    await adoptEsp(device);
}

async function adoptEsp(device) {
    state.esp = device;
    state.espPort = null;
    state.espProblem = null;
    device.addEventListener('log', (event) => onEspLine(event.detail));
    device.addEventListener('restarted', () => {
        if (state.esp !== device) return;
        log('board', 'restarted');
        state.adapter?.quiet(30000);
        lastRoomLine = '';
        state.session = null;
        render();
    });
    device.addEventListener('reattached', () => {
        if (state.esp !== device) return;
        const why = RESTART_REASONS[device.info?.reset];
        if (why) log('board', why);
        state.adapter?.quiet(15000);
        refreshEsp();
    });
    device.addEventListener('failed', (event) => { if (state.esp === device) dropEsp({ code: 'gone', tone: 'bad', text: `The board stopped answering (${describe(event.detail)}).` }); });
    device.addEventListener('disconnected', () => { if (state.esp === device) dropEsp({ code: 'gone', tone: 'warn', text: 'The board was unplugged.' }); });
    await refreshEsp();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollSession, POLL_MS);
}

async function refreshEsp() {
    const esp = state.esp;
    if (!esp) return;
    const info = esp.info;
    const bundled = state.manifest?.bridge.version;
    $('esp-chip').textContent = CHIP_NAMES[info?.chip] ?? info?.chip ?? 'Unknown';
    $('esp-version').textContent = !info ? 'Older than 2.0' : bundled && newer(bundled, info.version) ? `${info.version} (${bundled} available)` : info.version;
    $('esp-transport').textContent = info ? (info.transport === 'UART' ? `UART, ${esp.baudRate} baud` : info.transport) : '–';
    try {
        // Left over from a page closed while bridging.
        if (!state.bridge && !state.gift && (await esp.adapterPort()) === 'host') await esp.setAdapterPort('uart');
        await refreshKeys();
    } catch (error) {
        log('page', describe(error));
    }
    render();
    pollSoon();
}


async function dropEsp(problem = null) {
    const device = state.esp;
    if (state.bridge) await stopBridge('The ESP32 board went away.');
    if (state.celio?.running) await celioLeave({ text: 'The ESP32 board went away, so the Celio session ended.', tone: 'bad' });
    if (state.gift) await giftStop({ text: 'The ESP32 board went away, so the Mystery Gift stopped.', tone: 'bad' });
    if (state.mii) await miiStop({ text: 'The ESP32 board went away, so Local Play stopped.', tone: 'bad' });
    clearInterval(state.pollTimer);
    state.esp = null;
    state.keys = null;
    state.keysNote = null;
    state.replacingKeys = false;
    state.session = null;
    state.espProblem = problem;
    await device?.close();
    render();
}

// While scanning the board reports raw advertisements (4/s) and the decoded room. Only room
// changes are logged.
let lastRoomLine = '';
function onEspLine(line) {
    if (line.startsWith('LDN_HELLO') || line.startsWith('LDN_ADV ') || line.startsWith('LDN_TAP_FRAME ')) return;
    if (line.startsWith('LDN_ROOM ')) {
        if (line === lastRoomLine) return;
        lastRoomLine = line;
    }
    log('board', line);
    if (line === 'LDN_BRIDGE no keys') refreshKeys();
    if (line.startsWith('LDN_BRIDGE ')) pollSoon();
    if (line.startsWith('LDN_BRIDGE session (')) state.adapter?.quiet(30000);
}

let pollSoonTimer = null;
function pollSoon() {
    clearTimeout(pollSoonTimer);
    pollSoonTimer = setTimeout(pollSession, 400);
}

async function onEspInstall(eraseAll = false) {
    if (state.espPhase !== 'idle') return;
    if (!state.manifest) {
        state.espProblem = { code: 'install-failed', text: 'The firmware bundled with this page could not be loaded.' };
        render();
        return;
    }
    let port = state.esp?.port ?? (await livePort(state.espPort)) ?? (await rememberedEspPort());
    if (!port) {
        state.espPhase = 'choosing';
        render();
        port = await choose(() => EspDevice.requestPort());
        state.espPhase = 'idle';
        if (!port) { render(); return; }
    }
    $('esp-more').open = false;
    state.espPhase = 'installing';
    state.espNote = 'Preparing…';
    state.espProgress = 0;
    render();
    try {
        if (state.esp) await dropEsp();
        state.espProblem = null;
        const { flashBridge } = await import('./flash-esp.js');
        const done = await flashBridge(port, state.manifest, {
            eraseAll,
            onStatus: (text) => { state.espNote = text; render(); },
            onProgress: (fraction) => { state.espProgress = fraction; setProgress('esp-progress', fraction); },
            onLog: (text) => log('flasher', text),
        });
        log('page', `firmware ${done.version} installed on the ${done.chip}`);
        state.espPhase = 'starting';
        state.espProgress = null;
        render();
        let device = null;
        try { device = await reopenPort(port); } catch (error) { log('page', describe(error)); }
        state.espPhase = 'idle';
        if (device) await adoptEsp(device);
        else {
            state.espPort = port;
            state.espProblem = { code: 'silent-after-install' };
            render();
        }
    } catch (error) {
        log('flasher', describe(error));
        state.espPort = port;
        state.espPhase = 'idle';
        state.espProgress = null;
        state.espProblem = { code: 'install-failed', ...installAdvice(error) };
        render();
    }
}

function installAdvice(error) {
    const text = describe(error);
    if (/device has been lost/i.test(text)) {
        return { text: 'The browser lost the port as it opened it.', hint: 'Unplug the board and plug it back in, then try again.' };
    }
    if (/failed to connect|timed? ?out|no serial data|invalid head/i.test(text)) {
        return { text: 'The chip did not enter its bootloader.', hint: 'Hold the BOOT button, press and release RESET (or plug the board in with BOOT held), then try again.' };
    }
    if (/failed to open|already open/i.test(text)) return { text: 'Another program has this port open.', hint: 'Close it, then try again.' };
    return { text: 'Installing failed.', hint: text };
}

// Two-click confirm instead of a dialog. The first click arms the button for 6 s.
const armed = new Map();   // button -> { label, timer }
function twice(button, warning, action) {
    if (!armed.has(button)) {
        armed.set(button, { label: button.textContent, timer: setTimeout(() => disarm(button), 6000) });
        button.textContent = warning;
        return;
    }
    disarm(button);
    action();
}

function disarm(button) {
    const pending = armed.get(button);
    if (!pending) return;
    clearTimeout(pending.timer);
    armed.delete(button);
    button.textContent = pending.label;
}

// ---------------------------------------------------------------- keys

async function refreshKeys() {
    const esp = state.esp;
    if (!esp?.attached) return;
    state.keys = await esp.keyStatus();
    render();
}

async function onKeysFile(file) {
    const esp = state.esp;
    if (!file || !esp?.attached) return;
    const note = (text, tone) => { state.keysNote = { text, tone }; render(); };
    if (file.size > 1024 * 1024) { note('That file is too large to be a prod.keys.', 'bad'); return; }
    const parsed = parseProdKeys(await file.text());
    if (parsed.missing.length || parsed.malformed.length) {
        const problems = [];
        if (parsed.missing.length) problems.push(`not in the file: ${parsed.missing.join(', ')}`);
        if (parsed.malformed.length) problems.push(`not 32 hex digits: ${parsed.malformed.join(', ')}`);
        note(`That file cannot be used (${problems.join('; ')}).`, 'bad');
        return;
    }
    note('Storing the keys on the board…');
    try {
        const rejected = await esp.storeKeys(parsed.keys);
        if (rejected.length) { note(`The board did not accept: ${rejected.join(', ')}.`, 'bad'); return; }
        state.replacingKeys = false;
        state.keysNote = null;
        await refreshKeys();
        if (state.keys?.complete) {
            await esp.startBridge();
            log('page', 'keys stored; the board is looking for a room');
            pollSoon();
        }
    } catch (error) {
        note(`The keys could not be stored (${describe(error)}).`, 'bad');
    }
}

async function onKeysErase() {
    const esp = state.esp;
    if (!esp?.attached) return;
    try {
        await esp.eraseKeys();
        log('page', 'keys erased from the board');
        await refreshKeys();
    } catch (error) {
        state.keysNote = { text: describe(error), tone: 'bad' };
        render();
    }
}

function keysLine() {
    if (state.keysNote) return state.keysNote;
    const keys = state.keys;
    if (!keys || keys.complete) return { text: '' };
    const missing = Object.entries(KEY_NAMES).filter(([flag]) => !keys[flag]).map(([, name]) => name);
    return missing.length && missing.length < 4 ? { text: `Still missing: ${missing.join(', ')}.`, tone: 'warn' } : { text: '' };
}

// ---------------------------------------------------------------- session status

async function pollSession() {
    const esp = state.esp;
    if (!esp?.attached || state.espPhase !== 'idle' || state.trade || state.mii) return;
    try {
        state.session = await esp.bridgeStatus();
        if (state.polls++ % 3 === 0) state.signal = await esp.signal();
        $('esp-signal').textContent = roomWord(esp, state.session, state.signal);
    } catch {
        return;   // board restarting, retry next poll
    }
    renderSession();
    renderCelio();
    renderGift();
}

// The board joins as soon as it reads a room and stops reporting advertisements once in,
// so bridge state is checked first. While scanning, reports show whether a room is heard
// and whether the keys can read it.
function roomWord(esp, status, signal) {
    const dbm = signal === null || signal === undefined ? '' : `, ${signal} dBm`;
    if (status && status.state === 'run') return `joined${dbm}`;
    if (status && status.state !== 'scan' && status.state !== 'stopped' && status.state !== 'idle') return `joining${dbm}`;
    const now = Date.now();
    if (now - esp.readAt < 10000) return `heard and read${dbm}`;
    if (now - esp.heardAt < 5000) return `heard, but the keys cannot read it${dbm}`;
    return 'not heard';
}

function renderSession() {
    const status = state.session;
    const box = $('session');
    box.hidden = !state.esp;
    if (!state.esp) { $('play-dot').className = 'dot'; return; }
    let headline = 'Waiting for the board…';
    let hint = '';
    let tone = '';
    if (state.resetLoop && state.adapter) {
        headline = 'The game keeps restarting the wireless adapter.';
        hint = 'On the GBA this looks like a freeze. It is usually the link cable: it must be a Game Boy Color cable, not a Game Boy Advance one, and the adapter needs the firmware from step 2.';
        tone = 'warn';
    } else if (state.keys && !state.keys.complete) {
        headline = 'The board needs its keys.';
        hint = 'Without them it cannot read the Switch\'s wireless. Add your prod.keys in step 1.';
        tone = 'warn';
    } else if (state.bridge instanceof CableSession) {
        ({ headline, hint, tone } = cableView(state.bridge, status));
    } else if (state.game === 'cable') {
        headline = 'Press Start to link Ruby or Sapphire with the Switch.';
        hint = 'Both boards stay on USB: this page does the linking.';
    } else if (status) {
        const running = status.state === 'run';
        if (status.state === 'stopped' || status.state === 'idle') {
            headline = 'The bridge is stopped.';
            hint = 'Unplug the board and plug it back in.';
            tone = 'warn';
        } else if (status.state === 'scan' && state.esp.hearsUnreadableRoom) {
            headline = 'The board hears a Switch’s room but cannot read it.';
            hint = 'The keys it holds do not match. Replace the keys in step 1 with a prod.keys from your own Switch.';
            tone = 'warn';
        } else if (status.state === 'scan') {
            headline = 'Looking for a FireRed or LeafGreen room…';
            hint = 'On the Switch, open the Trade Center or Colosseum as the group leader, or lead a group on the Game Boy Advance and the board hosts the room instead.';
        } else if (status.state === 'host' && status.child === '1') {
            headline = 'The Switch is in the Game Boy Advance’s group.';
            hint = 'Leave the group on both consoles when you are done; the board then gets ready for the next one.';
            tone = 'good';
        } else if (status.state === 'host' && Number(status.members) > 0) {
            headline = 'The Switch is in the room. Waiting for it to join the group.';
            hint = 'On the Switch, pick the group the Game Boy Advance is leading.';
            tone = 'good';
        } else if (status.state === 'host') {
            headline = 'Hosting a room for the Switch.';
            hint = 'The Game Boy Advance is leading. On the Switch, open the same activity in the Direct Corner and join the group.';
        } else if (!running) {
            headline = 'Joining the Switch’s room…';
        } else if (status.child === '1') {
            headline = 'The Game Boy Advance and the Switch are linked.';
            hint = 'Leave the room on both consoles when you are done; the board then gets ready for the next one.';
            tone = 'good';
        } else if (status.conn_state === '2') {
            headline = 'In the Switch’s room. Waiting for the Game Boy Advance.';
            hint = 'On the GBA, choose the same activity and join the group.';
            if (status.national === '0' && !state.bypassNationally) hint += ' Emerald cannot trade with this game yet: the Switch player has to finish the Sevii Islands story first (Cerulean Cave shows on the town map once it is done). Until then Emerald says the other trainer is not ready; the National Dex bypass above lets it trade anyway. FireRed and LeafGreen can trade now, and battles work with any game.';
            tone = 'good';
        } else {
            headline = 'In the Switch’s room, setting up the session…';
        }
    }
    $('session-headline').textContent = headline;
    $('session-hint').textContent = hint;
    box.className = `session ${tone}`.trim();
    $('play-dot').className = `dot ${tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'busy'}`;
}

// Ruby or Sapphire: the board finds and joins the Switch's room; the page joins the group
// once the game has linked on the cable.
function cableView(cable, status) {
    if (cable.linked) return { headline: 'Ruby or Sapphire and the Switch are linked.', hint: 'Leave the room on both consoles when you are done; the board then gets ready for the next one.', tone: 'good' };
    if (!status || status.state === 'scan') return { headline: 'Looking for the Switch’s room…', hint: 'On the Switch, open the Trade Center or the Colosseum in the Direct Corner as the group leader.', tone: '' };
    if (status.state !== 'run') return { headline: 'Joining the Switch’s room…', hint: '', tone: '' };
    if (cable.switchNotReady) return { headline: 'The Switch’s game cannot trade with Ruby or Sapphire yet.', hint: 'Ruby and Sapphire trade with FireRed and LeafGreen only once that game has finished the Sevii Islands story (Cerulean Cave shows on its town map). Two Game Boy Advance games have the same rule. Ruby and Sapphire have no message for it, so the GBA says the link partners made different selections.', tone: 'warn' };
    if (cable.tradeReady) return { headline: 'Joining the Switch’s group…', hint: 'Accept the join on the Switch.', tone: 'good' };
    if (cable.cableOpen) return { headline: 'Ruby or Sapphire is linking…', hint: '', tone: 'good' };
    return { headline: 'In the Switch’s room. Waiting for Ruby or Sapphire.', hint: 'On the Game Boy Advance, upstairs in a Pokémon Center, talk to the attendant at the middle counter to trade, or the left one for the same kind of battle as on the Switch.', tone: 'good' };
}

// ---------------------------------------------------------------- adapter: what to show

const ADAPTER_PROBLEMS = {
    denied: () => ({
        tone: 'bad',
        text: 'The browser was refused access to the adapter.',
        hint: 'Close other pages or programs that use it. On Linux it also needs a udev rule; connecting over serial, under More options, works without one.',
        primary: ['Try again', () => onAdapterConnect()],
    }),
    'port-lost': () => ({
        tone: 'bad',
        text: 'The browser lost the port as it opened it.',
        hint: 'Unplug the adapter and plug it back in, then connect again.',
        primary: ['Connect', () => onAdapterConnect()],
    }),
    'install-failed': (problem) => ({
        tone: 'bad',
        text: 'Installing failed.',
        hint: problem.hint,
        primary: ['Try again', onAdapterInstall],
    }),
    'no-webusb': () => ({
        tone: 'warn',
        text: 'This browser cannot reach the adapter’s bootloader.',
        hint: 'Use Chrome or Edge, or install by hand as described under More options.',
    }),
    cancelled: () => ({
        text: 'Cancelled.',
        hint: 'If the adapter is still in update mode, unplug it and plug it back in to use it as it was.',
        primary: ['Connect', () => onAdapterConnect()],
    }),
    gone: (problem) => ({ tone: problem.tone ?? '', text: problem.text, hint: problem.hint, primary: ['Connect', () => onAdapterConnect()] }),
};

function adapterView() {
    if (state.install) {
        const waiting = state.install.step === 'restart' || state.install.step === 'choose';
        return { busy: true, steps: true, text: 'Installing the firmware…', secondary: waiting ? ['Cancel', cancelAdapterInstall] : null };
    }
    if (state.adapterPhase === 'choosing') {
        return { busy: true, text: 'Pick the adapter in the list the browser is showing.', hint: 'It is listed as “GBLink USB”.' };
    }
    if (state.adapterPhase === 'connecting') return { busy: true, text: 'Connecting…' };

    const adapter = state.adapter;
    if (state.adapterProblem) {
        const view = (ADAPTER_PROBLEMS[state.adapterProblem.code] ?? ADAPTER_PROBLEMS.gone)(state.adapterProblem);
        return { ...view, connected: Boolean(adapter) };
    }
    if (state.bootDevice) {
        return { tone: 'warn', text: 'The adapter is in update mode, ready for firmware.', primary: [installLabel(), onAdapterInstall] };
    }
    if (!adapter) return { text: 'Plug the adapter into this computer.', primary: ['Connect', () => onAdapterConnect()] };
    const info = state.adapterInfo;
    const bundled = state.manifest?.adapter.version;
    if (!info?.wireless) {
        return { connected: true, tone: 'warn', text: 'This adapter’s firmware doesn’t have the wireless adapter mode yet.', primary: [installLabel(), onAdapterInstall] };
    }
    if (bundled && info.version && newer(bundled, info.version)) {
        return { connected: true, tone: 'warn', text: `Firmware ${info.version} is installed; ${bundled} is available.`, primary: ['Update firmware', onAdapterInstall] };
    }
    if (state.customUf2) {
        return { connected: true, text: `${state.customUf2.name} is ready to install.`, primary: [installLabel(), onAdapterInstall] };
    }
    return { connected: true, done: true, tone: 'good', text: `GB-Link · firmware ${info.version ?? 'unknown'} · wireless adapter mode` };
}

function installLabel() {
    return state.customUf2 ? `Install ${state.customUf2.name}` : 'Install firmware';
}

// ---------------------------------------------------------------- adapter: doing things

async function onAdapterConnect(kind = GbLinkUsb.available() ? 'usb' : 'serial') {
    if (state.adapterPhase !== 'idle' || state.adapter || state.install) return;
    state.adapterProblem = null;
    if (kind === 'usb') {
        let device = await rememberedAdapter();
        if (!device) {
            state.adapterPhase = 'choosing';
            render();
            device = await choose(() => GbLinkUsb.requestDevice());
            state.adapterPhase = 'idle';
        }
        if (!device) { render(); return; }
        if (device.vendorId === BOOTROM_VENDOR_ID) {
            state.bootDevice = device;
            render();
            return;
        }
        await openAdapter(new GbLinkUsb(), device);
    } else {
        state.adapterPhase = 'choosing';
        render();
        const port = await choose(() => GbLinkSerial.requestPort());
        state.adapterPhase = 'idle';
        if (port) await openAdapter(new GbLinkSerial(), port);
        else render();
    }
}

async function rememberedAdapter() {
    if (state.askForAdapter) return null;
    let devices = [];
    try { devices = await navigator.usb.getDevices(); } catch {}
    devices = devices.filter((device) => device.vendorId === GBLINK_VENDOR_ID);
    return devices.length === 1 ? devices[0] : null;
}

async function openAdapter(adapter, handle) {
    state.adapterPhase = 'connecting';
    state.bootDevice = null;
    render();
    try {
        await adapter.open(handle);
        const info = await adapter.identify();
        state.adapter = adapter;
        state.adapterInfo = info;
        state.askForAdapter = false;
        state.adapterProblem = null;
        adapter.addEventListener('disconnected', () => { if (state.adapter === adapter) dropAdapter({ code: 'gone', tone: 'warn', text: 'The adapter was unplugged.' }); });
        adapter.addEventListener('resetloop', (event) => { if (state.adapter === adapter) onResetLoop(event.detail); });
        $('adapter-version').textContent = info.version ?? 'Unknown';
        $('adapter-wireless').textContent = info.wireless ? 'Yes' : 'No';
        $('adapter-kind').textContent = adapter.kind === 'usb' ? 'WebUSB' : 'Serial';
    } catch (error) {
        await adapter.close();
        state.askForAdapter = true;
        const denied = error?.name === 'SecurityError' || /access denied/i.test(describe(error));
        state.adapterProblem = denied ? { code: 'denied' }
            : error.code === 'port-lost' ? { code: 'port-lost' }
            : { code: 'gone', tone: 'bad', text: 'The adapter could not be opened.', hint: describe(error) };
    } finally {
        state.adapterPhase = 'idle';
        render();
    }
}

// Shown on the page because on the GBA a reset loop is a silent freeze.
function onResetLoop({ looping, startedUp }) {
    state.resetLoop = looping;
    if (looping) log('adapter', `the game keeps restarting the wireless adapter (${startedUp ? 'its commands are not getting through' : 'the adapter is not being recognised'})`);
    renderSession();
}

async function dropAdapter(problem = null) {
    const adapter = state.adapter;
    if (state.bridge) await stopBridge('The adapter went away.');
    state.adapter = null;
    state.adapterInfo = null;
    state.bootDevice = null;
    state.resetLoop = false;
    state.adapterProblem = problem;
    await adapter?.close();
    render();
}

async function adapterImage() {
    if (state.customUf2) return state.customUf2.image;
    const { parseUf2 } = await import('./flash-pico.js');
    return parseUf2(await fetchBytes(state.manifest.base + state.manifest.adapter.path));
}

// Install goes through the RP2040 USB bootloader, a separate USB device that needs its own
// permission grant. The card's steps guide the user through it.
async function onAdapterInstall() {
    if (state.install || state.adapterPhase !== 'idle') return;
    if (!GbLinkUsb.available()) {
        $('adapter-more').open = true;
        state.adapterProblem = { code: 'no-webusb' };
        render();
        return;
    }
    state.adapterProblem = null;
    $('adapter-more').open = false;
    let image;
    try {
        if (!state.manifest && !state.customUf2) throw new Error('the firmware bundled with this page could not be loaded');
        image = await adapterImage();
    } catch (error) {
        state.adapterProblem = { code: 'install-failed', hint: describe(error) };
        render();
        return;
    }
    if (state.bootDevice) {
        const { bootloaderFrom } = await import('./flash-pico.js');
        state.install = { step: 'write', manual: false, image };
        await flashBootloader(bootloaderFrom(state.bootDevice));
        return;
    }
    const adapter = state.adapter;
    const install = (state.install = { step: 'restart', manual: !adapter, image });
    render();
    if (!adapter) return;
    if (state.bridge) await stopBridge();
    // Release first: it drops off the bus on restart, which is not an unplug.
    state.adapter = null;
    state.adapterInfo = null;
    try {
        await adapter.rebootToBootloader();
        await sleep(200);
    } catch (error) {
        log('page', `the adapter would not restart: ${describe(error)}`);
        install.manual = true;
    }
    await adapter.close();
    if (state.install === install && !install.started) install.step = install.manual ? 'restart' : 'choose';
    render();
}

function cancelAdapterInstall() {
    const install = state.install;
    if (!install || install.started) return;
    state.install = null;
    state.adapterProblem = install.manual ? null : { code: 'cancelled' };
    render();
}

// Fires for a bootloader already granted to this page. Otherwise the button opens the
// chooser.
async function onUsbConnect(event) {
    const install = state.install;
    if (event.device?.vendorId !== BOOTROM_VENDOR_ID || !install || install.started) return;
    const { bootloaderFrom } = await import('./flash-pico.js');
    let picoboot;
    try { picoboot = bootloaderFrom(event.device); } catch { return; }
    await flashBootloader(picoboot);
}

async function onAdapterSelect() {
    const install = state.install;
    if (!install || install.started) return;
    const { chooseBootloader } = await import('./flash-pico.js');
    let picoboot;
    try {
        picoboot = await chooseBootloader();
    } catch (error) {
        if (error?.name !== 'NotFoundError') log('page', describe(error));
        return;
    }
    await flashBootloader(picoboot);
}

async function flashBootloader(picoboot) {
    const install = state.install;
    if (!install || install.started) return;
    install.started = true;
    install.step = 'write';
    render();
    try {
        const { flashAdapter } = await import('./flash-pico.js');
        await flashAdapter(picoboot, install.image, {
            onStatus: (text) => log('flasher', text),
            onProgress: (fraction) => setProgress('adapter-progress', fraction),
        });
        log('page', `adapter firmware installed: ${state.customUf2?.name ?? `bundled ${state.manifest?.adapter.version ?? ''}`.trim()}`);
        state.bootDevice = null;
        state.customUf2 = null;
        $('adapter-file').value = '';
        install.step = 'reconnect';
        render();
        await reconnectAdapter();
    } catch (error) {
        log('page', `adapter install failed: ${describe(error)}`);
        state.install = null;
        state.adapterProblem = { code: 'install-failed', hint: describe(error) };
        render();
    }
}

// Running firmware is a different USB device from the bootloader. Permission exists only
// if it was connected here before.
async function reconnectAdapter() {
    for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(700);
        let devices = [];
        try { devices = await navigator.usb.getDevices(); } catch {}
        const device = devices.find((candidate) => candidate.vendorId === GBLINK_VENDOR_ID);
        let ports = [];
        try { ports = (await navigator.serial?.getPorts()) ?? []; } catch {}
        const port = ports.find((candidate) => candidate.getInfo().usbVendorId === GBLINK_VENDOR_ID);
        if (device || (port && attempt >= 3)) {
            await openAdapter(device ? new GbLinkUsb() : new GbLinkSerial(), device ?? port);
            state.install = null;
            render();
            return;
        }
    }
    state.install = null;
    state.adapterProblem = { code: 'gone', tone: 'good', text: 'Installed. Connect the adapter to carry on.' };
    render();
}

async function onAdapterFile(file) {
    if (!file) return;
    try {
        const { parseUf2 } = await import('./flash-pico.js');
        state.customUf2 = { name: file.name, image: parseUf2(new Uint8Array(await file.arrayBuffer())) };
        state.adapterProblem = null;
        $('adapter-more').open = false;
        state.uf2Note = null;
    } catch (error) {
        state.customUf2 = null;
        $('adapter-file').value = '';
        state.uf2Note = `That is not a usable .uf2 file (${describe(error)}).`;
    }
    render();
}

// ---------------------------------------------------------------- play

function bridgeBlocker() {
    if (state.trade) return 'This page is trading with the Switch itself. Disconnect there first.';
    if (state.celio?.running) return 'This page is linking with Celio. Leave that session first.';
    if (state.gift) return 'This page is sending Mystery Gifts. Stop that first.';
    if (!state.esp?.attached) return 'Connect the ESP32 board in step 1.';
    if (!state.adapter) return 'Connect the adapter in step 2.';
    if (state.esp.info?.transport === 'UART' && state.esp.baudRate < FAST_BAUD) return 'This board’s firmware runs its console at 115200 baud, which cannot carry the link. Update it in step 1.';
    if (state.game === 'cable' ? !state.adapterInfo?.version : !state.adapterInfo?.wireless) return 'The adapter needs the firmware from step 2.';
    if (!state.keys?.complete) return 'The board needs its keys from step 1.';
    return null;
}

async function onBridgeStart() {
    if (state.bridge || bridgeBlocker()) return;
    const cable = state.game === 'cable';
    const options = { bypassNationally: state.bypassNationally };
    const bridge = cable ? new CableSession(state.esp, state.adapter, options) : new Bridge(state.esp, state.adapter, options);
    bridge.addEventListener('failed', (event) => stopBridge(`Stopped: ${describe(event.detail)}`, 'bad'));
    if (cable) {
        bridge.addEventListener('log', (event) => log('cable', event.detail));
        bridge.addEventListener('change', () => renderSession());
    }
    state.bridgeNote = null;
    setLine('bridge-status', 'Starting…');
    try {
        await bridge.start();
    } catch (error) {
        state.bridgeNote = { text: describe(error), tone: 'bad' };
        render();
        return;
    }
    state.bridge = bridge;
    state.bridgeTimer = setInterval(renderBridge, 1000);
    log('page', cable ? 'linking Ruby or Sapphire with the Switch' : 'carrying the link between the boards');
    render();
    renderBridge();
    pollSoon();
}

async function stopBridge(message = null, tone = '') {
    const bridge = state.bridge;
    if (!bridge) return;
    state.bridge = null;
    clearInterval(state.bridgeTimer);
    await bridge.stop();
    state.bridgeNote = message ? { text: message, tone } : null;
    log('page', 'no longer carrying the link');
    render();
}

function renderBridge() {
    const stats = state.bridge?.stats;
    if (!stats) return;   // CableSession has none
    $('bridge-out').textContent = `${stats.toAdapterFrames.toLocaleString()} ${stats.toAdapterFrames === 1 ? 'frame' : 'frames'}`;
    $('bridge-in').textContent = `${(stats.fromAdapterBytes / 1024).toFixed(1)} KB`;
    $('bridge-sessions').textContent = String(stats.reattached);
}

// The adapter answers whichever side spoke last. If it was answering this page over USB,
// a silent first listen is followed by LDN_PICO_MODE to reclaim it over the wires
// (skipped while a GBA is linked).
async function onWiringCheck() {
    const esp = state.esp;
    if (!esp?.attached || state.bridge) return;
    const note = (text, tone) => { state.wiringNote = { text, tone }; render(); };
    note('Listening on the wires…');
    const frames = async () => {
        const lines = await esp.command('LDN_PICO_STATS');
        const match = lines.join(' ').match(/rx_frames=(\d+)/);
        return match ? Number(match[1]) : null;
    };
    const heard = async (milliseconds) => {
        const before = await frames();
        await sleep(milliseconds);
        const after = await frames();
        return before === null || after === null ? null : after > before;
    };
    try {
        let result = await heard(2000);
        if (result === false && state.session?.child !== '1') {
            await esp.command('LDN_PICO_MODE');
            result = await heard(1500);
        }
        if (result === null) note('The board did not report on its link.', 'warn');
        else if (result) note('The board hears the adapter over the wires.', 'good');
        else note('Nothing is arriving from the adapter. The two link wires may be the wrong way round: swap them and check again. Otherwise check ground, and that the adapter has power and the firmware from step 2.', 'bad');
    } catch (error) {
        note(describe(error), 'bad');
    }
}

// ---------------------------------------------------------------- the page's two trees

// gba: GBA linked with the Switch (adapter and play cards). switch: Switch alone (trade
// card). celio: online. gift: Mystery Gift. mii: Tomodachi Life. Board setup is the same for all.
const PATHS = ['gba', 'switch', 'celio', 'gift', 'mii'];
const PATH_STORE = 'gblink-switch-path';

function remembered(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {}
}

function pathBusy() {
    return Boolean(state.bridge || state.trade || state.celio?.running || state.gift || state.mii);
}

function choosePath(path, { keep = true } = {}) {
    if (!PATHS.includes(path) || (path !== state.path && pathBusy())) return;
    state.path = path;
    if (keep) {
        remember(PATH_STORE, path);
        history.replaceState(null, '', `${location.pathname}${location.search}#${path}`);
    }
    render();
}

const GAME_STORE = 'gblink-switch-game';
const GAMES = ['wireless', 'cable'];

function chooseGame(game) {
    if (state.bridge || !GAMES.includes(game) || game === state.game) return;
    state.game = game;
    state.bridgeNote = null;
    remember(GAME_STORE, game);
    render();
}

function setBypass(value) {
    state.bypassNationally = value;
    state.bridge?.setBypass(value);
    state.celio?.setBypass(value);
    render();
}

// ---------------------------------------------------------------- online with Celio

const CELIO_STORE = 'gblink-switch-celio-server';

function celioServer() {
    const address = state.celioServer.trim();
    return /^wss?:\/\/\S+$/.test(address) ? address : null;
}

// Why the board cannot play over Celio yet, or null. Sessions are only created or joined
// once it can, so the Celio server never hears from a page that is not ready.
function celioBoardBlocker() {
    const esp = state.esp;
    if (!esp) return 'Connect the ESP32 board in step 1.';
    if (!esp.attached) return 'The ESP32 board is restarting…';
    const bundled = state.manifest?.bridge.version;
    if (!esp.info || (bundled && newer(bundled, esp.info.version))) return `Update the board’s firmware${bundled ? ` to ${bundled}` : ''} in step 1 first.`;
    if (!state.keys?.complete) return 'The board needs its keys from step 1.';
    if (esp.info.transport === 'UART' && esp.baudRate < FAST_BAUD) return 'This board’s firmware runs its console at 115200 baud, which cannot carry the link. Update it in step 1.';
    return null;
}

// Why the link cannot start, or null.
function celioBlocker() {
    if (state.bridge) return 'This page is carrying the link for a Game Boy Advance. Stop that first.';
    if (state.trade) return 'This page is trading with the Switch itself. Disconnect there first.';
    if (state.gift) return 'This page is sending Mystery Gifts. Stop that first.';
    return celioBoardBlocker();
}

function celioNote(text, tone = '') {
    state.celioNote = text ? { text, tone } : null;
    renderCelio();
}

async function celioEnter(join) {
    if (state.celio || celioBoardBlocker()) return;
    const server = celioServer();
    if (!server) { celioNote('The Celio server’s address has to start with wss:// or ws://.', 'bad'); return; }
    const code = $('celio-code').value.trim();
    if (join && !code) return;
    const session = new CelioSession(state.esp, { server, bypassNationally: state.bypassNationally });
    session.addEventListener('change', () => { if (state.celio === session) renderCelio(); });
    session.addEventListener('notice', (event) => { if (state.celio === session || !state.celio) celioNote(event.detail.text, event.detail.tone); });
    session.addEventListener('log', (event) => log('celio', event.detail));
    session.addEventListener('refused', (event) => {
        const text = `${CELIO_REFUSALS[event.detail]} To trade anyway, turn on “Bypass the National Dex requirement” and start a new session.`;
        setTimeout(() => { if (state.celio === session) celioLeave({ text, tone: 'bad' }); }, CELIO_REFUSAL_END_MS);
    });
    session.addEventListener('failed', (event) => { if (state.celio === session) celioLeave({ text: `Stopped: ${describe(event.detail)}`, tone: 'bad' }); });
    session.addEventListener('ended', () => {
        if (state.celio !== session) return;
        state.celio = null;
        log('page', 'left the Celio session');
        render();
    });
    state.celio = session;
    celioNote(join ? 'Joining the session…' : 'Creating a session…');
    try {
        const id = join ? await session.join(code) : await session.create();
        log('celio', `${join ? 'joined' : 'created'} session ${id}`);
        state.celioNote = null;
        $('celio-code').value = '';
    } catch (error) {
        if (state.celio === session) state.celio = null;
        await session.end();
        state.celioNote = { text: describe(error), tone: 'bad' };
    }
    render();
}

async function celioStart() {
    const session = state.celio;
    if (!session?.sessionId || session.running || celioBlocker()) return;
    session.esp = state.esp;
    try {
        await session.start();
        log('page', 'linking the Switch with the Celio session');
        state.celioNote = null;
    } catch (error) {
        state.celioNote = { text: describe(error), tone: 'bad' };
    }
    render();
    pollSoon();
}

async function celioLeave(note = null) {
    const session = state.celio;
    state.celio = null;
    if (session) await session.leave();
    state.celioNote = note;
    render();
}

const ROOMS = { 4: 'Trade Center', 1: 'Colosseum (single battle)', 2: 'Colosseum (double battle)' };
const CELIO_REFUSALS = {
    'emerald-not-champion': 'Emerald cannot trade with FireRed or LeafGreen until its player has become Champion.',
    'switch-not-sevii': 'Emerald cannot trade with the Switch’s game until it has finished the Sevii Islands story (Cerulean Cave shows on the town map).',
};
// Time for the other Game Boy Advance to show its own message and close before the session ends.
const CELIO_REFUSAL_END_MS = 3000;
const ROOM_OF_LINK_TYPE = { 0x1133: 4, 0x2233: 1, 0x2244: 2 };

// As the parent the board finds the Switch's room and its group, and the page joins the group
// once the other side is ready; as the child the page opens a group the Switch joins, and the
// two exchange players once the other side's is in.
function celioView(session, status) {
    if (!session.role) return { headline: 'Waiting for the Celio server…', hint: 'It decides which side leads once both have pressed Start.', tone: '' };
    if (session.leading) return celioLeadView(session, status);
    if (session.linked) return { headline: 'Linked with the other player.', hint: 'Leaving the room on both consoles ends the session.', tone: 'good' };
    if (!status || status.state === 'scan') return { headline: 'Your Switch leads. Looking for its group…', hint: 'On the Switch: upstairs in a Pokémon Center, the Direct Corner, then the Trade Center or the Colosseum. Become the group leader.', tone: '' };
    if (status.state !== 'run') return { headline: 'Joining the Switch’s room…', hint: '', tone: '' };
    if (session.switchNotReady) return { headline: 'The Switch’s game cannot trade with Ruby or Sapphire yet.', hint: 'It has to finish the Sevii Islands story first (Cerulean Cave shows on its town map). The other player’s game says the link partners made different selections.', tone: 'warn' };
    if (session.switchJoining) return { headline: 'Joining the Switch’s group…', hint: 'Accept CELIO on the Switch.', tone: 'good' };
    if (session.switchGroupOpen) return { headline: 'The Switch’s group is open. Waiting for the other player.', hint: 'They join the group on their side, then this page joins yours.', tone: 'good' };
    return { headline: 'In the Switch’s room. Waiting for its group.', hint: 'On the Switch: the Trade Center or the Colosseum, and become the group leader.', tone: 'good' };
}

function celioLeadView(session, status) {
    if (session.needsRoom) return { headline: 'Your Switch joins a group this page opens. Which room?', hint: 'Pick the room the Switch player will go to in the Direct Corner. The other player goes to the same one.', tone: 'good' };
    const room = ROOMS[session.activity];
    if (session.switchLeft) return { headline: 'The Switch left the group.', hint: 'Leave the session and start a new one to play again.', tone: 'warn' };
    if (session.linked) return { headline: 'Linked with the other player.', hint: 'Leaving the room on both consoles ends the session.', tone: 'good' };
    if (session.refused) return { headline: CELIO_REFUSALS[session.refused], hint: 'Ending the session…', tone: 'warn' };
    if (session.otherChoice !== null) {
        const theirs = ROOMS[ROOM_OF_LINK_TYPE[session.otherChoice]];
        return { headline: `The other player chose ${theirs ? `the ${theirs}` : 'another room'}.`, hint: `The Switch is in the ${room}. They talk to the attendant again and choose it, or you both leave and start a new session.`, tone: 'warn' };
    }
    if (session.switchKnown) return { headline: 'The Switch is in the group. Waiting for the other player.', hint: `They talk to the Cable Club attendant for the ${room}.`, tone: 'good' };
    if (session.switchJoined) return { headline: 'The Switch is joining the group…', hint: '', tone: 'good' };
    if (!status || status.state !== 'host') return { headline: 'Opening a group for the Switch…', hint: 'If the Switch is leading a group, leave it: this time the Switch joins.', tone: '' };
    return { headline: 'Your Switch joins. On the Switch, join the group called CELIO.', hint: `Upstairs in a Pokémon Center, the Direct Corner, then the ${room}. Join a group; do not lead one.`, tone: 'good' };
}

function renderCelio() {
    const session = state.celio;
    const inSession = Boolean(session?.sessionId);
    const running = Boolean(session?.running);
    const board = celioBoardBlocker();
    $('celio-start').hidden = inSession;
    $('celio-in').hidden = !inSession;
    $('celio-create').disabled = Boolean(session || board);
    $('celio-join').disabled = Boolean(session || board) || !$('celio-code').value.trim();
    $('celio-code').disabled = Boolean(session);
    if (inSession) {
        $('celio-id').textContent = session.sessionId;
        $('celio-partner').textContent = session.partner ? 'The other player is in the session.' : 'Waiting for the other player…';
        $('celio-partner').className = `status ${session.partner ? 'good' : ''}`.trim();
    }
    const blocker = celioBlocker();
    $('celio-link').hidden = running;
    $('celio-rooms').hidden = !(running && session.needsRoom);
    $('celio-link').disabled = !session?.partner || Boolean(blocker);
    const waiting = session ? inSession && !running && session.partner && blocker : board;
    const note = state.celioNote ?? (waiting ? { text: waiting, tone: '' } : null);
    setLine('celio-note', note?.text ?? '', note?.tone ?? '');
    $('celio-session').hidden = !running;
    let tone = inSession ? 'busy' : '';
    if (running) {
        const view = celioView(session, state.session);
        $('celio-headline').textContent = view.headline;
        $('celio-hint').textContent = view.hint;
        $('celio-session').className = `session ${view.tone}`.trim();
        tone = view.tone === 'good' ? 'good' : view.tone === 'warn' ? 'warn' : 'busy';
    }
    $('celio-dot').className = `dot ${tone}`.trim();
    $('celio-bypass').checked = state.bypassNationally;
    $('celio-bypass-warning').hidden = !state.bypassNationally;
    if (document.activeElement !== $('celio-server')) $('celio-server').value = state.celioServer;
    $('celio-server').disabled = Boolean(session);
    $('celio-server-reset').hidden = state.celioServer === CELIO_SERVER;
}

// ---------------------------------------------------------------- Mystery Gift

const GIFT_STORE = 'gblink-switch-gift';
// The board leads groups from firmware 2.1.0 on.
const GIFT_FIRMWARE = '2.1.0';
let gift = null;            // the gift modules (events, distribution, .wc3 files), loaded with the tab
let giftLoading = null;

function loadGift() {
    giftLoading ??= Promise.all([import('./gift/events.js'), import('./gift/distribution.js'), import('./gift/mystery-gift.js'), import('./gift/wc3.js'), import('./gift/save-backup.js')]).then(
        ([events, distribution, link, wc3, saves]) => {
            gift = { ...events, ...distribution, ...wc3, ...saves, describeGameCode: link.describeGameCode };
            const select = $('gift-event');
            select.replaceChildren(...gift.EVENT_GROUPS.map((group) => {
                const list = document.createElement('optgroup');
                list.label = group.label;
                for (const event of group.events) list.append(new Option(event.label, event.id));
                return list;
            }));
            if (!gift.findEvent(state.giftEvent)) state.giftEvent = gift.EVENTS[0].id;
            select.value = state.giftEvent;
            renderGift();
        },
        (error) => {
            state.giftNote = { text: `The Wonder Cards could not be loaded: ${describe(error)}`, tone: 'bad' };
            renderGift();
        },
    );
}

function giftEventById(id) {
    const event = id === state.giftFile?.id ? state.giftFile : gift?.findEvent(id);
    return event?.kind === 'restore' && state.giftRestore ? { ...event, save: state.giftRestore.bytes, saveName: state.giftRestore.name } : event;
}

// A .sav chosen for the restore: 128 KB of flash (a 16-byte emulator footer is
// dropped), with at least one whole copy of the game.
async function onGiftSav(file) {
    if (!file) return;
    await giftLoading;
    if (!gift) return;
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === gift.SAVE_BYTES + 16) bytes = bytes.subarray(0, gift.SAVE_BYTES);
    state.giftRestore = null;
    state.giftRestoreNote = null;
    if (bytes.length !== gift.SAVE_BYTES) state.giftRestoreNote = `${file.name} is not a FireRed or LeafGreen save: those are 128 KB.`;
    else if (!gift.describeSave(bytes).sound) state.giftRestoreNote = `${file.name} has no whole copy of a game in it.`;
    else state.giftRestore = { bytes: bytes.slice(), name: file.name };
    log('gift', state.giftRestore ? `chose ${file.name} to restore` : state.giftRestoreNote);
    state.gift?.setEvent(giftEventById(state.giftEvent));
    renderGift();
}

function chooseGiftEvent(id) {
    const event = giftEventById(id);
    if (!event) return;
    state.giftEvent = id;
    state.giftFileNote = null;
    if (event !== state.giftFile) remember(GIFT_STORE, id);
    state.gift?.setEvent(event);
    renderGift();
}

// A .wc3 opened or dropped on the card: listed under its own group and chosen.
async function onGiftFile(file) {
    if (!file) return;
    loadGift();
    await giftLoading;
    if (!gift) return;
    let event;
    try {
        event = gift.wc3Event(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (error) {
        state.giftFileNote = error instanceof gift.Wc3Error ? error.message : `${file.name} could not be read.`;
        log('gift', `${file.name}: ${state.giftFileNote}`);
        renderGift();
        return;
    }
    state.giftFile = event;
    const select = $('gift-event');
    let group = select.querySelector('optgroup[data-file]');
    if (!group) {
        group = document.createElement('optgroup');
        group.label = 'Your .wc3 file';
        group.dataset.file = '';
        select.append(group);
    }
    group.replaceChildren(new Option(event.label, event.id));
    select.value = event.id;
    log('gift', `opened ${file.name}`);
    chooseGiftEvent(event.id);
}

// Why the group cannot open, or null.
function giftBlocker() {
    if (state.bridge) return 'This page is carrying the link for a Game Boy Advance. Stop that first.';
    if (state.trade) return 'This page is trading with the Switch itself. Disconnect there first.';
    if (state.celio?.running) return 'This page is linking with Celio. Leave that session first.';
    if (!state.esp?.attached) return 'Connect the ESP32 board in step 1.';
    if (!state.esp.info) return 'Install the firmware in step 1 first.';
    if (newer(GIFT_FIRMWARE, state.esp.info.version)) return `Mystery Gift needs the board’s firmware ${GIFT_FIRMWARE} or newer. Install it again in step 1.`;
    if (!state.keys?.complete) return 'The board needs its keys from step 1.';
    if (state.esp.info.transport === 'UART' && state.esp.baudRate < FAST_BAUD) return 'This board’s firmware runs its console at 115200 baud, which cannot carry the link. Update it in step 1.';
    if (giftEventById(state.giftEvent)?.kind === 'restore' && !state.giftRestore) return 'Choose the .sav file to restore.';
    return null;
}

async function giftStart() {
    const event = giftEventById(state.giftEvent);
    if (state.gift || !event || giftBlocker()) return;
    const distribution = new gift.GiftDistribution(state.esp);
    distribution.addEventListener('log', (e) => log('gift', e.detail));
    distribution.addEventListener('status', (e) => {
        if (state.gift !== distribution || state.giftClosing) return;
        const status = e.detail;
        if (status.stage === 'joining') { state.giftResult = null; state.giftWhole = false; state.giftLinkBackup = null; }
        if (status.stage === 'checked') state.giftGame = status.detail;
        if (status.stage === 'backing-up' && status.detail.save) {
            keepGiftBackup(status.detail.save, saveFileName({ game: state.giftGame, player: status.player }), status.detail.summary?.sound);
            state.giftWhole = true;
            log('gift', 'the whole save is in');
        }
        if (status.stage === 'checked') log('gift', `the Switch runs ${gift.describeGameCode(status.detail.gameCode)}, revision ${status.detail.revision}`);
        const before = state.giftStatus?.stage === 'backing-up' ? state.giftStatus.detail.done : -1;
        if (status.stage === 'backing-up' && (before < 0 || Math.floor(status.detail.done / 16) > Math.floor(before / 16))) {
            log('gift', `backing up: ${status.detail.done} of ${status.detail.total} KB in`);
        }
        if (status.stage === 'restoring' && status.detail.done !== state.giftStatus?.detail?.done) {
            log('gift', `restoring: ${status.detail.done} of ${status.detail.total} sectors written`);
        }
        state.giftStatus = status;
        renderGift();
        if (status.stage === 'open' || status.stage === 'restarting') pollSoon();
    });
    distribution.addEventListener('decision', (e) => {
        if (state.gift !== distribution || state.giftClosing) return;
        state.giftDecision = e.detail;
        renderGift();
    });
    distribution.addEventListener('result', (e) => {
        if (state.gift !== distribution || state.giftClosing) return;
        state.giftResult = e.detail;
        state.giftDecision = null;
        if (e.detail.save) keepGiftBackup(e.detail.save, saveFileName(e.detail), e.detail.summary?.sound);
        const view = giftResultView(e.detail);
        if (view) log('gift', view.headline);
        renderGift();
    });
    distribution.addEventListener('failed', (e) => { if (state.gift === distribution) giftStop({ text: `Stopped: ${describe(e.detail)}`, tone: 'bad' }); });
    state.gift = distribution;
    state.giftNote = null;
    state.giftStatus = null;
    state.giftResult = null;
    render();
    try {
        await distribution.start(event);
        log('page', 'the Mystery Gift group is open');
    } catch (error) {
        if (state.gift === distribution) state.gift = null;
        state.giftNote = { text: describe(error), tone: 'bad' };
    }
    render();
    pollSoon();
}

// The group stays in state.gift until the board is back, so nothing else takes the board
// while it closes the room.
async function giftStop(note = null) {
    const distribution = state.gift;
    if (!distribution || state.giftClosing) return;
    state.giftClosing = true;
    state.giftDecision = null;
    render();
    await distribution.stop();
    state.gift = null;
    state.giftClosing = false;
    state.giftStatus = null;
    state.giftNote = note;
    log('page', 'the Mystery Gift group is closed');
    render();
}

function giftDecide(send) {
    if (!state.giftDecision) return;
    state.giftDecision = null;
    log('gift', send ? 'sending it again' : 'leaving the Switch its card');
    state.gift?.decide(send);
    renderGift();
}

// What a delivery came to, or null when there is nothing to say.
function giftResultView(result) {
    const name = result.event?.label ?? 'The card';
    const who = result.player?.name || 'the Switch';
    switch (result.outcome) {
        case 'sent': return { headline: `${name}: delivered to ${who}.`, hint: 'Let the Switch finish saving, then talk to the deliveryman in green upstairs in a Pokémon Center.', tone: 'good' };
        case 'had-card': return { headline: `Not sent: ${who} already had this Wonder Card.`, hint: '', tone: 'warn' };
        case 'kept-card': return { headline: `Not sent: ${who} kept the Wonder Card it had.`, hint: '', tone: 'warn' };
        case 'cant-accept': return { headline: 'The Switch could not take a Wonder Card.', hint: '', tone: 'warn' };
        case 'unsupported': if (result.event?.kind === 'backup') return { headline: `The backup does not run on ${gift.describeGameCode(result.game.gameCode)}.`, hint: 'It works on the Switch’s FireRed and LeafGreen.', tone: 'warn' };
            return { headline: `Not sent: ${name} does not run on ${gift.describeGameCode(result.game.gameCode)}.`, hint: 'The GB-Link Team’s cards run on the Switch’s FireRed and LeafGreen in English, French, German, Italian and Spanish.', tone: 'warn' };
        case 'unverified': {
            const save = result.event?.kind === 'backup' || result.event?.kind === 'restore';
            const what = save ? `The ${result.event.kind}` : `Not sent: ${name}`;
            return { headline: `${what} does not work with this copy of ${gift.describeGameCode(result.game.gameCode)}.`, hint: `${save ? 'Nothing ran' : 'Nothing was sent'}, and the Switch is as it was.`, tone: 'warn' };
        }
        case 'backed-up': return result.summary.sound
            ? { headline: `${who}’s save is backed up.`, hint: 'Download the .sav file below.', tone: 'good' }
            : { headline: `${who}’s save came over, but neither of its two copies is whole.`, hint: 'Download the .sav file below to keep it, and try the backup again.', tone: 'warn' };
        case 'restored': return { headline: `${who}’s save is now ${result.event?.saveName ?? 'the chosen .sav'}.`, hint: 'Let the Switch finish saving; CONTINUE then loads it.', tone: 'good' };
        case 'restore-failed': return result.reason === 'unsound'
            ? { headline: 'Not restored: the .sav has no whole copy of a game in it.', hint: 'Nothing on the Switch changed.', tone: 'warn' }
            : { headline: `${who} could not take the save, so the game saved nothing.`, hint: 'It keeps the save it had.', tone: 'warn' };
        case 'lost':
            if (result.event?.kind === 'restore') return { headline: 'The link to the Switch dropped during the restore, so the game saved nothing yet.', hint: `Choose MYSTERY GIFT, WONDER CARDS, FRIEND, GBLINK again: the restore goes on from where it stopped. Until it is done, the Switch keeps the save it had.`, tone: 'warn' };
            if (result.event?.kind === 'backup' && state.giftWhole) return { headline: 'The whole save came over before the link dropped.', hint: 'Download the .sav file below. The Switch shows a communication error, and its save is as it was.', tone: 'good' };
            if (result.event?.kind === 'backup') return { headline: 'The link to the Switch dropped before the backup was done.', hint: 'Choose MYSTERY GIFT, WONDER CARDS, FRIEND, GBLINK again: the backup goes on from where it stopped, as long as this page stays open.', tone: 'warn' };
            return { headline: 'The link to the Switch dropped before the card was delivered.', hint: '', tone: 'warn' };
        case 'error': return { headline: result.message ?? 'The Mystery Gift exchange failed.', hint: result.event?.kind === 'restore' ? 'The Switch keeps the save it had.' : '', tone: 'warn' };
        default: return null;
    }
}

// The .sav a backup came to: game, player and day.
function saveFileName(result) {
    const game = gift.describeGameCode(result.game.gameCode).replace(/ \(.*\)$/, '');
    const player = (result.player?.name || 'save').replace(/[^\p{L}\p{N}_-]+/gu, '');
    return `${game}-${player}-${new Date().toISOString().slice(0, 10)}.sav`;
}

// The whole save arrives before the exchange ends, and the end may still mark it whole or
// not, so one link keeps one entry.
function keepGiftBackup(bytes, name, whole) {
    const entry = state.giftLinkBackup;
    if (entry) Object.assign(entry, { bytes, name, whole: whole ?? entry.whole });
    else state.giftBackups.unshift(state.giftLinkBackup = { bytes, name, whole, time: new Date() });
    renderGiftBackups();
}

function renderGiftBackups() {
    $('gift-backups').hidden = !state.giftBackups.length;
    $('gift-backups-list').replaceChildren(...state.giftBackups.map((backup) => {
        const item = document.createElement('li');
        const copy = document.createElement('div');
        copy.className = 'backup-copy';
        const name = document.createElement('p');
        name.className = 'backup-name';
        name.textContent = backup.name;
        const meta = document.createElement('p');
        meta.className = 'backup-meta';
        const time = backup.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        meta.textContent = backup.whole === false ? `${time} · neither copy is whole` : time;
        copy.append(name, meta);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Download';
        button.addEventListener('click', () => downloadGiftBackup(backup));
        item.append(copy, button);
        return item;
    }));
}

function downloadGiftBackup(backup) {
    downloadBytes(backup.bytes, backup.name);
    log('gift', `downloaded ${backup.name}`);
}

function downloadBytes(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const GIFT_WHERE = 'On the Switch: MYSTERY GIFT, WONDER CARDS, FRIEND, then choose GBLINK.';

function giftView() {
    if (state.giftClosing) return { headline: 'Closing the group…', hint: 'The board restarts before the group can open again.', tone: '' };
    const status = state.giftStatus;
    const name = status?.player?.name;
    if (state.giftDecision) return { headline: `${name || 'The Switch'} already has this Wonder Card.`, hint: 'Send it again to replace it, or leave the one it has. The Switch waits on “Communicating…” until you choose.', tone: 'warn' };
    switch (status?.stage) {
        case 'restarting': return { headline: 'The board is restarting…', hint: 'The group opens again once it is back, in about half a minute.', tone: '' };
        case 'joining': return { headline: 'The Switch is joining…', hint: 'Keep this tab open.', tone: 'good' };
        case 'linked':
        case 'checking':
        case 'checked':
        case 'deciding': return { headline: `Linked with ${name || 'the Switch'}.`, hint: 'Checking its Wonder Card…', tone: 'good' };
        case 'asking': return { headline: `${name || 'The Switch'} has another Wonder Card.`, hint: 'On the Switch, choose whether to throw it away for this one.', tone: 'good' };
        case 'sending': return { headline: `Sending ${status.event?.label ?? 'the card'}…`, hint: 'Keep this tab open until the Switch says the card was received.', tone: 'good' };
        case 'restoring': return { headline: `Restoring the save: ${status.detail?.done ?? 0} of ${status.detail?.total ?? 32} sectors written`, hint: 'Keep this tab open and the Switch near the board; the Switch shows “Communicating…” until it is done, then saves.', tone: 'good' };
        case 'backing-up': return { headline: `Backing up the save: ${status.detail?.done ?? 0} of ${status.detail?.total ?? 128} KB`, hint: 'Keep this tab open and the Switch near the board; the Switch shows “Communicating…” until it is done.', tone: 'good' };
        case 'closing': return { headline: 'Finishing the link…', hint: '', tone: 'good' };
    }
    const hosting = state.session?.state === 'host';
    const result = state.giftResult ? giftResultView(state.giftResult) : null;
    if (result) return { ...result, hint: [result.hint, hosting ? `For another card, pick it above. ${GIFT_WHERE}` : ''].filter(Boolean).join(' ') };
    if (!hosting) return { headline: 'Opening the group…', hint: '', tone: '' };
    return { headline: GIFT_WHERE, hint: 'The page sends the card chosen above to the next Switch that joins.', tone: 'good' };
}

// The starter of the game being backed up or restored walks along the bar, evolving at a
// third and two thirds: Black and White's animated sprites, from PokeAPI's sprite set.
const PROGRESS_SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated';
const STARTERS = { BPG: [1, 2, 3], BPR: [4, 5, 6] };

function giftProgress() {
    const status = state.giftStatus;
    if (!state.gift || state.giftClosing || (status?.stage !== 'backing-up' && status?.stage !== 'restoring')) return null;
    const { done = 0, total = 1 } = status.detail ?? {};
    return Math.max(0, Math.min(1, total ? done / total : 0));
}

function renderGiftProgress() {
    const share = giftProgress();
    $('gift-progress').hidden = share === null;
    if (share === null) { delete $('gift-progress-mon').dataset.species; return; }
    const percent = Math.round(share * 100);
    $('gift-progress-fill').style.width = `${percent}%`;
    $('gift-progress-bar').setAttribute('aria-valuenow', String(percent));
    const mon = $('gift-progress-mon');
    mon.style.setProperty('--at', `${percent}%`);
    const line = STARTERS[state.giftGame?.gameCode?.slice(0, 3)] ?? STARTERS.BPR;
    const species = line[share >= 1 ? 2 : Math.min(2, Math.floor(share * 3))];
    if (mon.dataset.species === String(species)) return;
    const evolving = line.indexOf(Number(mon.dataset.species)) >= 0 && Number(mon.dataset.species) < species;
    mon.dataset.species = String(species);
    mon.onload = () => { mon.hidden = false; };
    mon.onerror = () => { mon.hidden = true; };
    mon.src = `${PROGRESS_SPRITES}/${species}.gif`;
    if (evolving) {
        mon.classList.remove('evolving');
        void mon.offsetWidth;
        mon.classList.add('evolving');
    }
}

function renderGift() {
    if (state.path === 'gift') loadGift();
    const running = Boolean(state.gift);
    const event = giftEventById(state.giftEvent);
    setLine('gift-description', event?.description ?? '', event?.emerald ? 'warn' : '');
    setLine('gift-file-note', state.giftFileNote ?? '', 'bad');
    $('gift-sav-row').hidden = event?.kind !== 'restore';
    setLine('gift-sav-note', event?.kind !== 'restore' ? '' : state.giftRestoreNote ?? (state.giftRestore ? `${state.giftRestore.name} is ready.` : ''), state.giftRestoreNote ? 'bad' : '');
    const blocker = giftBlocker();
    $('gift-start').hidden = running;
    $('gift-start').disabled = Boolean(blocker) || !event;
    $('gift-stop').hidden = !running;
    $('gift-stop').disabled = state.giftClosing;
    const note = state.giftNote ?? (!running && blocker ? { text: blocker, tone: '' } : null);
    setLine('gift-note', note?.text ?? '', note?.tone ?? '');
    $('gift-session').hidden = !running;
    $('gift-decision').hidden = !(running && state.giftDecision);
    let tone = '';
    if (running) {
        const view = giftView();
        $('gift-headline').textContent = view.headline;
        $('gift-hint').textContent = view.hint;
        $('gift-session').className = `session ${view.tone}`.trim();
        tone = view.tone === 'good' ? 'good' : view.tone === 'warn' ? 'warn' : 'busy';
    }
    $('gift-dot').className = `dot ${tone}`.trim();
    renderGiftProgress();
}

// ---------------------------------------------------------------- Tomodachi Life

// Why Local Play cannot start, or null.
function miiBlocker() {
    if (!state.esp?.attached) return 'Connect the ESP32 board in step 1.';
    if (!state.esp.info) return 'Install the firmware in step 1 first.';
    if (newer(LINK_FIRMWARE, state.esp.info.version)) return `Tomodachi Life needs the board’s firmware ${LINK_FIRMWARE} or newer. Install it again in step 1.`;
    if (!state.keys?.complete) return 'The board needs its keys from step 1.';
    return null;
}

async function miiStart() {
    if (state.mii || miiBlocker()) return;
    const link = new MiiLink(state.esp);
    link.addEventListener('log', (e) => log('mii', e.detail));
    link.addEventListener('status', (e) => {
        if (state.mii !== link) return;
        state.miiStatus = e.detail;
        renderMii();
    });
    link.addEventListener('received', (e) => {
        let about;
        try { about = describePayload(e.detail); } catch { about = { kind: 'Item', name: '' }; }
        state.miiReceived.unshift({ bytes: e.detail, about, time: new Date() });
        log('mii', `received ${about.kind.toLowerCase()} ${about.name || '(no name)'}`);
        renderMii();
    });
    link.addEventListener('answer', (e) => {
        const shown = state.miiSendNote?.name ?? 'it';
        state.miiSendNote = {
            ACCEPT: { text: `The Switch took ${shown}.`, tone: 'good' },
            REJECT: { text: 'The Switch declined it: the player said no, or the island is full.', tone: 'warn' },
            CANCEL: { text: 'The Switch cancelled the exchange.', tone: 'warn' },
        }[e.detail];
        log('mii', `the Switch answered ${e.detail}`);
        renderMii();
    });
    link.addEventListener('ended', (e) => { if (state.mii === link) miiEnded(e.detail); });
    state.mii = link;
    state.miiNote = null;
    state.miiStatus = null;
    state.miiSendNote = null;
    render();
    try {
        await link.start();
        log('page', 'looking for Tomodachi Life\'s Local Play');
    } catch (error) {
        if (state.mii === link) state.mii = null;
        state.miiNote = { text: describe(error), tone: 'bad' };
    }
    render();
}

function miiEnded(reason) {
    state.mii = null;
    state.miiStatus = null;
    state.miiNote = { text: reason, tone: 'warn' };
    log('page', `Local Play ended: ${reason}`);
    render();
    pollSoon();
}

async function miiStop(note = null) {
    const link = state.mii;
    if (!link || state.miiStopping) return;
    state.miiStopping = true;
    render();
    await link.stop();
    state.mii = null;
    state.miiStopping = false;
    state.miiStatus = null;
    state.miiNote = note;
    log('page', 'left Local Play');
    render();
    pollSoon();
}

async function onMiiFile(file) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { state.miiSendNote = { text: `${file.name} is too large to be something the game sent.`, tone: 'bad' }; renderMii(); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    chooseOutgoing(bytes, file.name);
}

function chooseOutgoing(bytes, fileName) {
    try {
        const about = describePayload(bytes);
        state.miiOutgoing = { payload: new Payload(bytes), about, fileName };
        state.miiSendNote = null;
        fillMiiForm();
        log('mii', `chose ${fileName} to send`);
    } catch (error) {
        state.miiSendNote = { text: `${fileName} is not something Tomodachi Life sent (${describe(error)}).`, tone: 'bad' };
    }
    renderMii();
}

function miiSend() {
    const outgoing = state.miiOutgoing, link = state.mii;
    if (!outgoing || !link?.ready) return;
    const payload = outgoing.payload;
    payload.name = payload.name.trim() || outgoing.about.name;
    try {
        const bytes = payload.build();
        state.miiSendNote = { text: '', tone: '', name: payload.name || 'it' };
        link.send(bytes);
    } catch (error) {
        state.miiSendNote = { text: `It could not be sent: ${describe(error)}`, tone: 'bad' };
    }
    renderMii();
}

// The sliders and month names, made once.
const VOICE_SLIDERS = [
    { key: 'speed', label: 'Speed' }, { key: 'pitch', label: 'Pitch' }, { key: 'formant', label: 'Depth' },
    { key: 'tension', label: 'Delivery' }, { key: 'intonation', label: 'Tone' },
];

function miiSlider(key, label, [min, max], low = '', high = '') {
    const row = document.createElement('label');
    row.className = 'mii-row';
    row.dataset.needs = key;
    const name = document.createElement('span');
    name.textContent = label;
    const slider = document.createElement('span');
    slider.className = 'mii-slider';
    const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step: 1 });
    input.dataset.field = key;
    const ends = [low, high].map((text) => Object.assign(document.createElement('span'), { textContent: text }));
    const value = document.createElement('output');
    slider.append(ends[0], input, ends[1], value);
    row.append(name, slider);
    return row;
}

function buildMiiForm() {
    $('mii-personality').replaceChildren(...PERSONALITY.map((p) => miiSlider(p.key, p.label, [1, 8], p.low, p.high)));
    $('mii-voice').replaceChildren(...VOICE_SLIDERS.map((v) => miiSlider(v.key, v.label, VOICE_RANGES[v.key])));
    const month = document.querySelector('#mii-fields [data-field="month"]');
    month.replaceChildren(...Array.from({ length: 12 }, (_, i) => new Option(new Date(2000, i, 1).toLocaleString([], { month: 'long' }), i + 1)));
    $('mii-voice-preset').replaceChildren(new Option('Custom', CUSTOM_VOICE), ...VOICE_PRESETS.map((v, i) => new Option(v.name, i)));
}

// The form shows what the payload holds; a Mii's own fields only for a Mii, and only
// those it has.
function fillMiiForm() {
    const outgoing = state.miiOutgoing;
    if (!outgoing) return;
    const payload = outgoing.payload;
    $('mii-name').value = payload.name;
    $('mii-fields').hidden = !payload.isMii;
    if (!payload.isMii) return;
    for (const row of $('mii-fields').querySelectorAll('[data-needs]')) row.hidden = !payload.has(row.dataset.needs);
    for (const input of $('mii-fields').querySelectorAll('[data-field]')) {
        if (payload.has(input.dataset.field)) input.value = payload.get(input.dataset.field);
    }
    const year = payload.has('year') ? payload.get('year') : -1;
    $('mii-year').value = year < 0 ? '' : year;
    $('mii-phrase').value = payload.phrase;
    const loves = payload.has('loves') ? payload.get('loves') : 0;
    for (const box of $('mii-loves').querySelectorAll('[data-bit]')) box.checked = Boolean(loves >> Number(box.dataset.bit) & 1);
    $('mii-voice-preset').value = payload.has('voicePreset') ? payload.get('voicePreset') : CUSTOM_VOICE;
    showSliderValues();
}

function showSliderValues() {
    for (const input of $('mii-fields').querySelectorAll('input[type="range"]')) input.nextElementSibling.nextElementSibling.value = input.value;
}

// One edit on the form, into the payload.
function onMiiEdit(event) {
    const outgoing = state.miiOutgoing, target = event.target;
    if (!outgoing) return;
    const payload = outgoing.payload;
    try {
        if (target.id === 'mii-name') {
            // The game says the name itself unless told otherwise; a pronunciation that
            // was the old name follows it.
            const said = document.querySelector('#mii-fields [data-field="pronunciation"]');
            if (payload.isMii && payload.has('pronunciation') && payload.get('pronunciation') === payload.name) {
                payload.set('pronunciation', target.value);
                said.value = target.value;
            }
            payload.name = target.value;
        } else if (target.id === 'mii-phrase') payload.phrase = target.value;
        else if (target.id === 'mii-year') {
            const year = target.value === '' ? -1 : Number(target.value);
            if (Number.isInteger(year)) payload.set('year', year);
        } else if (target.dataset.bit !== undefined) {
            let bits = 0;
            for (const box of $('mii-loves').querySelectorAll('[data-bit]')) if (box.checked) bits |= 1 << Number(box.dataset.bit);
            payload.set('loves', bits);
        } else if (target.id === 'mii-voice-preset') {
            payload.setVoicePreset(Number(target.value));
            fillMiiForm();
        } else if (target.dataset.field) {
            const key = target.dataset.field;
            const value = target.type === 'text' ? target.value : Number(target.value);
            if (key === 'day' && !(Number.isInteger(value) && value >= 1 && value <= 31)) return;
            payload.set(key, value);
            // Moving a voice slider makes the voice a custom one, as in the game.
            if (key in VOICE_RANGES && payload.has('voicePreset') && payload.get('voicePreset') !== CUSTOM_VOICE) {
                payload.set('voicePreset', CUSTOM_VOICE);
                $('mii-voice-preset').value = CUSTOM_VOICE;
            }
            showSliderValues();
        }
    } catch (error) {
        state.miiSendNote = { text: describe(error), tone: 'bad' };
    }
    renderMii();
}

function aboutLine(about) {
    const parts = [about.kind];
    if (about.gender) parts.push(about.gender);
    if (about.birthday) parts.push(`born ${about.birthday.month}/${about.birthday.day}`);
    return parts.join(' · ');
}

function payloadFileName(about) {
    const name = (about.name || about.kind).replace(/[^\p{L}\p{N}_ -]+/gu, '').trim().replace(/\s+/g, '-') || 'item';
    return `${name}.bin`;
}

function miiView() {
    const status = state.miiStatus;
    const done = (detail) => detail?.total ? ` (${Math.round(100 * detail.done / detail.total)}%)` : '';
    if (state.miiStopping) return { headline: 'Leaving Local Play…', hint: '', tone: '' };
    switch (status?.stage) {
        case 'joining': return { headline: `Joining ${status.detail?.host || 'the Switch'}…`, hint: '', tone: '' };
        case 'connecting': return { headline: `In ${status.detail?.host || 'the Switch'}'s Local Play, connecting to the game…`, hint: '', tone: '' };
        case 'ready': return { headline: `Connected to ${status.detail?.host || 'the Switch'}.`, hint: 'Send a Mii from the Switch, or send one from this page.', tone: 'good' };
        case 'receiving': return { headline: `The Switch is sending something${done(status.detail)}…`, hint: '', tone: '' };
        case 'sending': return { headline: 'Sent. Waiting for the Switch to answer…', hint: 'Accept it on the Switch.', tone: '' };
        default: return { headline: 'Looking for Tomodachi Life…', hint: 'On the Switch: Local Play, then Look for another player.', tone: '' };
    }
}

function renderMii() {
    const running = Boolean(state.mii);
    const blocker = miiBlocker();
    $('mii-start').hidden = running;
    $('mii-start').disabled = Boolean(blocker);
    $('mii-stop').hidden = !running;
    $('mii-stop').disabled = state.miiStopping;
    const note = state.miiNote ?? (!running && blocker ? { text: blocker, tone: '' } : null);
    setLine('mii-note', note?.text ?? '', note?.tone ?? '');
    $('mii-session').hidden = !running;
    let tone = '';
    if (running) {
        const view = miiView();
        $('mii-headline').textContent = view.headline;
        $('mii-hint').textContent = view.hint;
        $('mii-session').className = `session ${view.tone}`.trim();
        tone = view.tone === 'good' ? 'good' : 'busy';
    }
    $('mii-dot').className = `dot ${tone}`.trim();

    const outgoing = state.miiOutgoing;
    $('mii-outgoing').hidden = !outgoing;
    if (outgoing) {
        $('mii-outgoing-about').textContent = `${outgoing.fileName}: ${aboutLine(outgoing.about)}`;
        $('mii-name-warning').hidden = [...outgoing.payload.name.trim()].length <= MAX_NAME;
        $('mii-send').disabled = !state.mii?.ready;
        $('mii-send').title = state.mii?.ready ? '' : running ? 'Wait until the Switch is connected.' : 'Press Start first.';
    }
    setLine('mii-send-note', state.miiSendNote?.text ?? '', state.miiSendNote?.tone ?? '');

    $('mii-received').hidden = !state.miiReceived.length;
    $('mii-received-list').replaceChildren(...state.miiReceived.map((entry) => {
        const item = document.createElement('li');
        const copy = document.createElement('div');
        copy.className = 'backup-copy';
        const name = document.createElement('p');
        name.className = 'backup-name';
        name.textContent = entry.about.name || '(no name)';
        const meta = document.createElement('p');
        meta.className = 'backup-meta';
        meta.textContent = `${aboutLine(entry.about)} · ${entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        copy.append(name, meta);
        const actions = document.createElement('div');
        actions.className = 'backup-actions';
        const download = document.createElement('button');
        download.type = 'button';
        download.textContent = 'Download';
        download.addEventListener('click', () => downloadBytes(entry.bytes, payloadFileName(entry.about)));
        const again = document.createElement('button');
        again.type = 'button';
        again.className = 'quiet';
        again.textContent = 'Send back';
        again.addEventListener('click', () => chooseOutgoing(entry.bytes, payloadFileName(entry.about)));
        actions.append(download, again);
        item.append(copy, actions);
        return item;
    }));
}

function renderGame() {
    const cable = state.game === 'cable';
    for (const button of $('play-game').children) {
        button.setAttribute('aria-pressed', String(button.dataset.game === state.game));
        button.disabled = Boolean(state.bridge);
    }
    $('game-note-cable').hidden = !cable;
    $('bypass-panel').hidden = false;
    $('bypass-nationally').checked = state.bypassNationally;
    $('bypass-warning').hidden = !state.bypassNationally;
    $('play-sub').textContent = cable ? 'Both boards on USB, with this page linking the game to the Switch.' : 'Let this page carry the link, or connect the two boards with three wires.';
    $('play-standalone').hidden = cable;
    $('consoles-cable').hidden = !cable;
    $('consoles-wireless').hidden = cable;
}

function renderPaths() {
    for (const tab of $('paths').children) {
        const chosen = tab.dataset.path === state.path;
        tab.setAttribute('aria-selected', String(chosen));
        tab.disabled = !chosen && pathBusy();
        tab.title = tab.disabled ? (state.trade ? 'Disconnect from the Switch first.' : state.gift ? 'Stop the Mystery Gift first.' : state.mii ? 'Stop Tomodachi Life first.' : 'Stop carrying the link first.') : '';
    }
    for (const card of document.querySelectorAll('main > [data-path]')) card.hidden = card.dataset.path !== state.path;
}

// ---------------------------------------------------------------- trading from here

const SOURCE_STORE = 'gblink-switch-source';
const SERVER_STORE = 'gblink-switch-pool-server';
const KEPT_STORE = 'gblink-switch-kept';
const SOURCES = ['pool', 'party'];

const pooling = () => state.source === 'pool';

// Returns why a trade cannot start, or null.
function tradeBlocker() {
    if (!state.esp) return 'Connect the ESP32 board in step 1 first.';
    if (!state.esp.info) return 'Install the firmware in step 1 first.';
    if (!state.keys?.complete) return 'The board needs its keys before it can read the Switch\'s wireless.';
    if (state.bridge) return 'This page is carrying the link for a Game Boy Advance. Stop that first.';
    if (state.celio?.running) return 'This page is linking with Celio. Leave that session first.';
    if (state.gift) return 'This page is sending Mystery Gifts. Stop that first.';
    if (pooling()) return poolServer() ? null : 'The trade pool server\'s address has to start with wss:// or ws://.';
    if (!state.party.canTrade) return 'Two Pokémon are needed: one to offer and one to keep.';
    return null;
}

function poolServer() {
    const address = state.poolServer.trim();
    return /^wss?:\/\/\S+$/.test(address) ? address : null;
}

// tools: [act, glyph, label with % for the name, disabled reason] per slot button.
function drawSlots(id, mons, { pick = false, marked = -1, mark = 'chosen', tools = [], empty = '–' } = {}) {
    const box = $(id);
    box.replaceChildren();
    mons.forEach((pk, index) => {
        const slot = document.createElement('div');
        slot.className = `slot${pick ? '' : ' theirs'}${pk ? '' : ' empty'}`;
        slot.dataset.slot = String(index);
        if (index === marked) slot.classList.add(mark);
        const face = document.createElement(pick ? 'button' : 'div');
        face.className = 'slot-pick';
        if (pick) { face.type = 'button'; face.dataset.act = 'pick'; }
        if (pk) {
            const about = describeMon(pk);
            const image = document.createElement('img');
            image.alt = about.kind;
            image.loading = 'lazy';
            image.src = spriteUrl(pk) ?? '';
            image.addEventListener('error', () => {
                const fallback = spriteFallbackUrl(pk);
                if (fallback && image.src !== fallback) image.src = fallback;
                else image.replaceWith(Object.assign(document.createElement('div'), { className: 'empty-art' }));
            }, { once: true });
            const who = document.createElement('div');
            who.className = 'who';
            who.append(text('div', 'name', about.name));
            const line = text('div', 'about', `${about.kind}${about.level ? ` · ${about.level}` : ''}${about.gender ? ` ${about.gender}` : ''}`);
            if (about.shiny) line.append(text('span', 'shiny', ' ★'));
            who.append(line);
            face.append(image, who);
        } else {
            face.append(text('div', 'empty-art', ''), text('div', 'name', empty));
        }
        slot.append(face);
        if (pk && tools.length) slot.append(slotTools(tools, describeMon(pk).name));
        box.append(slot);
    });
}

// Save/replace buttons act on the slot itself and do not change the current offer.
function slotTools(tools, name) {
    const box = document.createElement('div');
    box.className = 'slot-tools';
    for (const [act, glyph, what, disabled] of tools) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool';
        button.dataset.act = act;
        button.textContent = glyph;
        button.disabled = Boolean(disabled);
        button.title = disabled || what.replace('%', name);
        button.setAttribute('aria-label', what.replace('%', name));
        box.append(button);
    }
    return box;
}

function text(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
}

function renderTrade() {
    const running = Boolean(state.trade);
    const blocker = tradeBlocker();
    const pool = pooling();
    for (const button of $('trade-source').children) {
        button.setAttribute('aria-pressed', String(button.dataset.source === state.source));
        button.disabled = running;
    }
    $('source-note-pool').hidden = !pool;
    $('source-note-party').hidden = pool;

    drawSlots('their-slots', state.opponent?.party ?? [null, null, null, null, null, null]);
    $('their-name').textContent = state.opponent?.name ?? 'The Switch';
    $('our-name').textContent = pool ? 'The pool' : 'Yours';
    if (pool) {
        // Pool Pokémon appears together with the Switch's team, as on the Switch.
        drawSlots('our-slots', [state.opponent ? state.poolMon : null], { marked: state.offered === 0 ? 0 : -1, mark: 'offered', empty: 'Shown with the Switch\'s team' });
    } else {
        // The Switch has already seen this party, so slots are replaceable only when disconnected.
        const locked = running ? 'Disconnect to put a different Pokémon here.' : '';
        drawSlots('our-slots', state.party.slots, {
            pick: true, empty: 'Empty',
            marked: state.party.selected, mark: running && state.offered === state.party.selected ? 'offered' : 'chosen',
            tools: [['save', '↓', 'Save % as a .pk3 file'], ['swap', '↑', 'Replace % from a .pk3 file', locked]],
        });
    }
    $('party-note').hidden = $('party-board').hidden = $('party-fine').hidden = $('party-options').hidden = pool;
    $('pool-note').hidden = $('pool-options').hidden = !pool;
    $('kept').hidden = state.kept.length === 0;
    drawSlots('kept-slots', state.kept, { tools: [['save', '↓', 'Save % as a .pk3 file'], ['forget', '×', 'Remove % from this list']] });

    // The last result stays shown until a blocker replaces it.
    const idle = 'Create a Trade Center room on the Switch, then connect.';
    const status = running ? state.tradePhase : blocker ?? (state.tradePhase || idle);
    setLine('trade-status', status, running ? state.tradeTone : blocker ? 'warn' : state.tradeTone);
    $('trade-hint').textContent = pool ? '' : state.partyNote;
    $('trade-dot').className = `dot ${running ? state.tradeTone || 'busy' : blocker ? '' : 'good'}`.trim();
    $('trade-connect').hidden = running;
    $('trade-connect').disabled = Boolean(blocker);
    // Pool: Accept/Cancel under the Pokémon. Until one is chosen the Switch can leave the
    // menu with a single cancel. Both lock once the trade is under way.
    const answering = running && pool && Boolean(state.opponent && state.poolMon);
    $('pool-answers').hidden = !answering;
    $('pool-accept').setAttribute('aria-pressed', String(state.offered === 0));
    $('pool-cancel').setAttribute('aria-pressed', String(state.tradeDeclining));
    $('pool-accept').disabled = $('pool-cancel').disabled = !state.menuOpen || state.trading;
    $('trade-decline').hidden = !running || pool || state.tradeDeclining || !state.opponent;
    $('trade-decline').disabled = state.trading;
    $('trade-stop').hidden = !running;
    for (const id of ['trade-clear', 'trade-reset']) $(id).disabled = running;
    const server = $('pool-server');
    if (document.activeElement !== server) server.value = state.poolServer;
    server.disabled = running;
    $('pool-server-reset').hidden = running || state.poolServer === POOL_SERVER;
}

function chooseSource(source) {
    if (state.trade || !SOURCES.includes(source) || source === state.source) return;
    state.source = source;
    state.tradePhase = '';
    state.tradeTone = '';
    remember(SOURCE_STORE, source);
    renderTrade();
}

function setPoolServer(address) {
    state.poolServer = address.trim() || POOL_SERVER;
    remember(SERVER_STORE, state.poolServer === POOL_SERVER ? null : state.poolServer);
    renderTrade();
}

async function onTradeConnect() {
    if (state.trade || tradeBlocker()) return;
    const pool = pooling();
    const controller = new AbortController();
    state.tradeStop = controller;
    state.tradePhase = 'Asking the board for its link to the adapter';
    state.tradeTone = '';
    state.tradeDeclining = false;
    state.opponent = null;
    state.poolMon = null;
    state.menuOpen = false;
    state.trading = false;
    state.partyNote = '';
    state.trades = 0;
    state.offered = -1;
    clearInterval(state.pollTimer);
    const session = new TradeSession({
        device: state.esp,
        party: pool ? null : state.party.export(),
        selected: state.party.selected,
        pool: pool ? new PoolClient(poolServer()) : null,
        emit: onTradeEvent,
    });
    state.trade = session;
    render();
    try {
        await session.run(controller.signal);
        const count = state.trades === 1 ? 'One Pokémon' : `${state.trades} Pokémon`;
        state.tradePhase = state.trades === 0 ? 'Finished without trading.' : pool ? `Finished. ${count} went to the Switch from the pool.` : `Finished. ${count} came across.`;
        state.tradeTone = state.trades > 0 ? 'good' : '';
    } catch (error) {
        const stopped = error instanceof CancelledError;
        const gone = !state.esp;
        state.tradePhase = stopped ? 'Disconnected.' : gone ? 'The ESP32 board stopped answering during the trade.' : describe(error);
        state.tradeTone = stopped ? '' : 'bad';
        if (!stopped) log('trade', describe(error));
    } finally {
        // The board may have disconnected, ending the session.
        state.trade = null;
        state.tradeStop = null;
        state.opponent = null;
        state.poolMon = null;
        state.menuOpen = false;
        state.trading = false;
        state.tradeDeclining = false;
        state.offered = -1;
        clearInterval(state.pollTimer);
        state.pollTimer = setInterval(pollSession, POLL_MS);
        pollSoon();
        render();
    }
}

function readMon(bytes) {
    try { return bytes ? parsePk3(bytes) : null; } catch { return null; }
}

function onTradeEvent(event) {
    const pool = pooling();
    switch (event.event) {
        case 'phase':
            state.tradePhase = event.message;
            state.tradeTone = event.tone || (state.opponent ? 'good' : '');
            break;
        case 'log':
            log('trade', event.message);
            return;
        case 'opponent_party':
            state.opponent = { name: event.name, party: event.party.map(readMon) };
            state.tradeTone = 'good';
            break;
        case 'menu': {
            // Nothing is offered until the local player chooses, so the Switch can leave the
            // menu with a single cancel.
            state.menuOpen = true;
            const name = state.poolMon ? describeMon(state.poolMon).name : 'the pool\'s Pokémon';
            state.tradePhase = pool
                ? `The trade menu is open. Press Accept trade for ${name}; for a different one, CANCEL on the Switch and sit down again.`
                : `The trade menu is open${state.trades ? ' again' : ''}. Click a Pokémon to offer it.`;
            state.tradeTone = 'good';
            break;
        }
        case 'offer': {
            const pk = pool ? state.poolMon : state.party.slots[event.slot];
            if (event.taken && pk) {
                state.offered = event.slot;
                state.tradePhase = pool
                    ? `Trade accepted. Choose what to give for ${describeMon(pk).name} on the Switch.`
                    : `Offering ${describeMon(pk).name}. Choose one on the Switch.`;
                state.tradeTone = 'good';
            } else if (!state.opponent) {
                state.tradePhase = 'Sit down at the trade table on the Switch first.';
            }
            break;
        }
        case 'trading':
            state.trading = true;
            state.tradePhase = 'The trade is under way.';
            state.tradeTone = 'good';
            break;
        case 'declining':
            state.tradeDeclining = event.value;
            if (event.value) state.offered = -1;
            break;
        case 'room':
            state.menuOpen = state.trading = false;
            state.opponent = null;
            state.offered = -1;
            state.tradeDeclining = false;
            state.tradePhase = pool
                ? 'Back in the room. Sit down at the trade table again for a different Pokémon from the pool, or leave the room to finish.'
                : 'Back in the room. Sit down at the trade table again to trade some more, or leave the room to finish.';
            state.tradeTone = '';
            break;
        case 'received':
            try {
                state.menuOpen = state.trading = false;
                state.party.receive(event.slot, event.pk3);
                state.trades++;
                state.offered = -1;
                // The Switch's party changed too; it resends it after both games save.
                state.opponent = null;
                state.tradePhase = `Traded. ${describeMon(state.party.slots[event.slot]).name} is now in slot ${event.slot + 1}.`;
                state.tradeTone = 'good';
            } catch (error) {
                state.tradePhase = describe(error);
                state.tradeTone = 'bad';
            }
            break;
        case 'pool_mon':
            state.poolMon = readMon(event.pk3);
            state.offered = -1;
            break;
        case 'pool_traded': {
            const gave = readMon(event.gave), got = readMon(event.got);
            state.menuOpen = state.trading = false;
            state.trades++;
            state.offered = -1;
            state.poolMon = null;
            state.opponent = null;
            const names = `${got ? describeMon(got).name : 'The pool\'s Pokémon'} went to the Switch`;
            if (event.sealed) {
                state.tradePhase = `Traded. ${names}, and ${gave ? describeMon(gave).name : 'the Switch\'s'} is in the pool.`;
                state.tradeTone = 'good';
            } else {
                if (gave) keep(gave);
                state.tradePhase = `${names}, but the pool did not confirm the swap. ${gave ? describeMon(gave).name : 'What the Switch gave'} is kept below instead: save it as a file.`;
                state.tradeTone = 'warn';
            }
            break;
        }
        default:
            break;
    }
    renderTrade();
}

function onSlotClick(event) {
    const button = event.target.closest('[data-act]');
    const slot = event.target.closest('.slot');
    if (!button || !slot || button.disabled) return;
    const index = Number(slot.dataset.slot);
    if (pooling()) return;
    if (button.dataset.act === 'save') { savePk3(state.party.slots[index]); return; }
    if (button.dataset.act === 'swap') { openPk3Picker(index); return; }
    if (!state.party.slots[index]) {
        if (!state.trade) openPk3Picker(index);
        return;
    }
    state.party.select(index);
    state.partyNote = '';
    if (state.trade) state.trade.offerSlot(index);
    renderTrade();
}

function openPk3Picker(slot = state.party.selected) {
    if (state.trade) return;
    state.pickerSlot = slot;
    $('trade-file').value = '';
    $('trade-file').click();
}

async function onPk3File(file, slot = state.pickerSlot) {
    if (!file || state.trade) return;
    try {
        state.party.set(slot, parsePk3(new Uint8Array(await file.arrayBuffer())));
        state.party.select(slot);
        state.partyNote = '';
    } catch (error) {
        state.partyNote = describe(error);
    }
    renderTrade();
}

function savePk3(pk) {
    if (!pk) return;
    const blob = new Blob([pk.export()], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${describeMon(pk).name || pk.speciesName}.pk3`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

// Switch's Pokémon from an unconfirmed pool swap. Kept in localStorage until removed.
function keep(pk) {
    state.kept.push(pk);
    storeKept();
}

function storeKept() {
    remember(KEPT_STORE, state.kept.length ? JSON.stringify(state.kept.map((pk) => toHex(pk.export()))) : null);
}

function loadKept() {
    try { state.kept = JSON.parse(remembered(KEPT_STORE) ?? '[]').map((hex) => parsePk3(fromHex(hex))); }
    catch { state.kept = []; }
}

function onKeptClick(event) {
    const button = event.target.closest('[data-act]');
    const slot = event.target.closest('.slot');
    if (!button || !slot) return;
    const index = Number(slot.dataset.slot);
    if (button.dataset.act === 'save') savePk3(state.kept[index]);
    else if (button.dataset.act === 'forget') twice(button, 'Sure?', () => { state.kept.splice(index, 1); storeKept(); renderTrade(); });
}

// ---------------------------------------------------------------- rendering

let espActions = {};
let adapterActions = {};

function drawCard(prefix, view) {
    const card = $(`${prefix}-card`);
    card.classList.toggle('done', Boolean(view.done));
    $(`${prefix}-dot`).className = `dot ${view.busy ? 'busy' : view.dot ?? view.tone ?? ''}`.trim();
    setLine(`${prefix}-status`, view.text, view.tone);
    $(`${prefix}-hint`).textContent = view.hint ?? '';
    const primary = $(`${prefix}-primary`);
    primary.hidden = !view.primary;
    if (view.primary && !armed.has(primary)) primary.textContent = view.primary[0];
    const secondary = $(`${prefix}-secondary`);
    secondary.hidden = !view.secondary;
    if (view.secondary) secondary.textContent = view.secondary[0];
    $(`${prefix}-actions`).classList.toggle('empty', !view.primary && !view.secondary);
    return { primary: view.primary?.[1], secondary: view.secondary?.[1] };
}

function render() {
    renderPaths();
    const esp = espView();
    espActions = drawCard('esp', esp);
    setProgress('esp-progress', esp.progress ?? null);
    $('keys-panel').hidden = !esp.keys;
    const keys = keysLine();
    setLine('keys-status', keys.text, keys.tone);
    $('esp-details').hidden = !esp.connected;
    $('esp-more').hidden = !esp.connected || esp.busy;
    $('keys-replace').hidden = !state.keys?.complete;
    if (!armed.has($('keys-replace'))) $('keys-replace').textContent = state.replacingKeys ? 'Keep the stored keys' : 'Replace the keys';
    $('keys-erase').hidden = !state.keys || !Object.keys(KEY_NAMES).some((flag) => state.keys[flag]);

    renderTrade();

    const adapter = adapterView();
    adapterActions = drawCard('adapter', adapter);
    $('adapter-details').hidden = !adapter.connected;
    $('adapter-more').hidden = Boolean(adapter.busy);
    $('adapter-reinstall').hidden = !adapter.done;
    $('adapter-disconnect').hidden = !state.adapter && !state.bootDevice;
    $('adapter-connect-serial').hidden = Boolean(state.adapter) || !GbLinkSerial.available() || !GbLinkUsb.available();
    $('adapter-file-clear').hidden = !state.customUf2;
    setLine('adapter-file-status', state.uf2Note, 'bad');
    $('adapter-bootsel').hidden = !state.adapter;
    drawSteps();

    const pins = LINK_PINS[state.esp?.info?.chip];
    const labels = LINK_PIN_LABELS[state.esp?.info?.chip];
    const pin = (index) => `GPIO${pins[index]}${labels ? ` (${labels[index]})` : ''}`;
    $('wiring').hidden = Boolean(pins);
    $('wires').hidden = !pins;
    if (pins) {
        $('wire-tx').textContent = pin(0);
        $('wire-rx').textContent = pin(1);
    }
    $('wiring-check').disabled = !state.esp?.attached || Boolean(state.bridge);
    setLine('wiring-status', state.wiringNote?.text, state.wiringNote?.tone);

    const blocker = bridgeBlocker();
    $('bridge-start').hidden = Boolean(state.bridge);
    $('bridge-start').disabled = Boolean(blocker);
    $('bridge-stop').hidden = !state.bridge;
    $('bridge-facts').hidden = !state.bridge?.stats;
    renderGame();
    renderCelio();
    renderGift();
    renderMii();
    if (state.bridge) setLine('bridge-status', 'Carrying the link. Keep this tab open and in view.', 'good');
    else if (state.bridgeNote) setLine('bridge-status', state.bridgeNote.text, state.bridgeNote.tone);
    else setLine('bridge-status', blocker ?? 'Ready.');
    renderSession();
}

function drawSteps() {
    const list = $('adapter-steps');
    const install = state.install;
    list.hidden = !install;
    if (!install) return;
    const order = ['restart', 'choose', 'write', 'reconnect'];
    const at = order.indexOf(install.step);
    $('adapter-step-restart').textContent = install.manual
        ? 'Hold the adapter’s BOOTSEL button while plugging it in'
        : 'Restart the adapter in update mode';
    for (const item of list.children) {
        const index = order.indexOf(item.dataset.step);
        // Manual install: the first two steps both wait on the user's BOOTSEL press.
        const current = index === at || (install.manual && install.step === 'restart' && index <= 1);
        item.className = current ? 'current' : index < at ? 'done' : '';
    }
}

// ---------------------------------------------------------------- start-up

function wireUp() {
    for (const id of ['esp-status', 'keys-status', 'adapter-status', 'adapter-file-status', 'bridge-status', 'wiring-status', 'trade-status', 'gift-note']) $(id).dataset.base = 'status';

    $('esp-primary').addEventListener('click', () => espActions.primary?.());
    $('esp-secondary').addEventListener('click', () => espActions.secondary?.());
    $('esp-reinstall').addEventListener('click', () => onEspInstall());
    $('esp-wipe').addEventListener('click', (event) => twice(event.currentTarget, 'Click again: this erases the keys too', () => onEspInstall(true)));
    $('esp-disconnect').addEventListener('click', () => dropEsp());
    $('keys-replace').addEventListener('click', () => { state.replacingKeys = !state.replacingKeys; state.keysNote = null; render(); });
    $('keys-erase').addEventListener('click', (event) => twice(event.currentTarget, 'Click again to erase the keys', onKeysErase));
    $('keys-file').addEventListener('change', (event) => {
        onKeysFile(event.target.files[0]);
        event.target.value = '';
    });
    const drop = $('keys-drop');
    for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('over'); });
    for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (event) => onKeysFile(event.dataTransfer?.files?.[0]));
    // Stops a file dropped outside the target from replacing the page.
    for (const name of ['dragover', 'drop']) window.addEventListener(name, (event) => event.preventDefault());

    $('adapter-primary').addEventListener('click', () => adapterActions.primary?.());
    $('adapter-secondary').addEventListener('click', () => adapterActions.secondary?.());
    $('adapter-select').addEventListener('click', onAdapterSelect);
    $('adapter-reinstall').addEventListener('click', onAdapterInstall);
    $('adapter-connect-serial').addEventListener('click', () => onAdapterConnect('serial'));
    $('adapter-disconnect').addEventListener('click', () => dropAdapter());
    $('adapter-file').addEventListener('change', (event) => onAdapterFile(event.target.files[0]));
    $('adapter-file-clear').addEventListener('click', () => {
        state.customUf2 = null;
        $('adapter-file').value = '';
        render();
    });
    $('adapter-bootsel').addEventListener('click', async () => {
        const adapter = state.adapter;
        if (!adapter) return;
        if (state.bridge) await stopBridge();
        await adapter.rebootToBootloader();
        await sleep(200);
        await dropAdapter({ code: 'gone', text: 'The adapter is restarting in update mode; an RPI-RP2 drive should appear.' });
    });

    $('paths').addEventListener('click', (event) => choosePath(event.target.closest('[data-path]')?.dataset.path));
    window.addEventListener('hashchange', () => choosePath(location.hash.slice(1), { keep: false }));
    $('trade-source').addEventListener('click', (event) => chooseSource(event.target.closest('[data-source]')?.dataset.source));
    $('pool-accept').addEventListener('click', () => { if (pooling() && state.poolMon) state.trade?.offerSlot(0); });
    $('pool-cancel').addEventListener('click', () => { state.trade?.declineTrade(); state.tradeDeclining = true; renderTrade(); });
    $('pool-server').addEventListener('change', (event) => setPoolServer(event.target.value));
    $('pool-server-reset').addEventListener('click', () => setPoolServer(''));
    $('kept-slots').addEventListener('click', onKeptClick);
    $('trade-connect').addEventListener('click', onTradeConnect);
    $('trade-decline').addEventListener('click', () => { state.trade?.declineTrade(); state.tradeDeclining = true; renderTrade(); });
    $('trade-stop').addEventListener('click', () => state.tradeStop?.abort());
    $('our-slots').addEventListener('click', onSlotClick);
    $('trade-clear').addEventListener('click', () => {
        state.party.set(state.party.selected, null);
        renderTrade();
    });
    $('trade-reset').addEventListener('click', (event) => twice(event.currentTarget, 'Click again to replace your party', async () => {
        localStorage.removeItem('gblink-switch-party');
        await state.party.load();
        state.partyNote = '';
        renderTrade();
    }));
    $('trade-file').addEventListener('change', (event) => onPk3File(event.target.files[0]));
    $('our-slots').addEventListener('dragover', (event) => {
        const slot = event.target.closest('.slot');
        if (!slot || state.trade || pooling()) return;
        event.preventDefault();
        slot.classList.add('drop-target');
    });
    $('our-slots').addEventListener('dragleave', (event) => event.target.closest('.slot')?.classList.remove('drop-target'));
    $('our-slots').addEventListener('drop', (event) => {
        const slot = event.target.closest('.slot');
        if (!slot || state.trade || pooling()) return;
        event.preventDefault();
        slot.classList.remove('drop-target');
        onPk3File(event.dataTransfer?.files?.[0], Number(slot.dataset.slot));
    });

    $('play-game').addEventListener('click', (event) => chooseGame(event.target.closest('[data-game]')?.dataset.game));
    $('bypass-nationally').addEventListener('change', (event) => setBypass(event.target.checked));
    $('celio-bypass').addEventListener('change', (event) => setBypass(event.target.checked));
    $('celio-create').addEventListener('click', () => celioEnter(false));
    $('celio-join').addEventListener('click', () => celioEnter(true));
    $('celio-code').addEventListener('input', () => renderCelio());
    $('celio-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') celioEnter(true); });
    $('celio-link').addEventListener('click', celioStart);
    $('celio-rooms').addEventListener('click', (event) => {
        const button = event.target.closest('[data-activity]');
        if (button) state.celio?.chooseRoom(Number(button.dataset.activity));
    });
    $('celio-leave').addEventListener('click', () => celioLeave());
    $('celio-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(state.celio?.sessionId ?? ''); celioNote('Session Id copied', 'good'); }
        catch { celioNote('Copy it by hand: the browser did not allow copying.', 'warn'); }
    });
    $('celio-server').addEventListener('change', (event) => {
        state.celioServer = event.target.value.trim() || CELIO_SERVER;
        remember(CELIO_STORE, state.celioServer === CELIO_SERVER ? null : state.celioServer);
        renderCelio();
    });
    $('celio-server-reset').addEventListener('click', () => { state.celioServer = CELIO_SERVER; remember(CELIO_STORE, null); renderCelio(); });
    $('gift-event').addEventListener('change', (event) => chooseGiftEvent(event.target.value));
    $('gift-file').addEventListener('change', (event) => {
        onGiftFile(event.target.files[0]);
        event.target.value = '';
    });
    // A .wc3 can be dropped anywhere on the card, its own section folded or not.
    const giftCard = $('gift-card'), giftDrop = $('gift-drop');
    for (const name of ['dragenter', 'dragover']) giftCard.addEventListener(name, (event) => { event.preventDefault(); giftDrop.classList.add('over'); });
    for (const name of ['dragleave', 'drop']) giftCard.addEventListener(name, (event) => { event.preventDefault(); giftDrop.classList.remove('over'); });
    giftCard.addEventListener('drop', (event) => onGiftFile(event.dataTransfer?.files?.[0]));
    $('gift-start').addEventListener('click', giftStart);
    $('gift-stop').addEventListener('click', () => giftStop());
    $('gift-again').addEventListener('click', () => giftDecide(true));
    $('gift-keep').addEventListener('click', () => giftDecide(false));
    $('gift-sav').addEventListener('change', (event) => onGiftSav(event.target.files?.[0]));
    $('mii-file').addEventListener('change', (event) => {
        onMiiFile(event.target.files[0]);
        event.target.value = '';
    });
    const miiCard = $('mii-card'), miiDrop = $('mii-drop');
    for (const name of ['dragenter', 'dragover']) miiCard.addEventListener(name, (event) => { event.preventDefault(); miiDrop.classList.add('over'); });
    for (const name of ['dragleave', 'drop']) miiCard.addEventListener(name, (event) => { event.preventDefault(); miiDrop.classList.remove('over'); });
    miiCard.addEventListener('drop', (event) => onMiiFile(event.dataTransfer?.files?.[0]));
    $('mii-start').addEventListener('click', miiStart);
    $('mii-stop').addEventListener('click', () => miiStop());
    $('mii-send').addEventListener('click', miiSend);
    buildMiiForm();
    $('mii-outgoing').addEventListener('input', onMiiEdit);
    $('bridge-start').addEventListener('click', onBridgeStart);
    $('bridge-stop').addEventListener('click', () => stopBridge());
    $('wiring-check').addEventListener('click', onWiringCheck);

    $('log-clear').addEventListener('click', () => {
        logLines.length = 0;
        lastLogged = { key: '', count: 0 };
        $('log').textContent = '';
    });
    $('log-copy').addEventListener('click', () => navigator.clipboard?.writeText(logLines.join('\n')));

    // Hidden tabs throttle timers to ~1/s, too slow to hold the Switch link.
    document.addEventListener('visibilitychange', () => {
        if (!state.trade) return;
        if (document.hidden) state.hiddenAt = Date.now();
        else if (state.hiddenAt) {
            const away = Math.round((Date.now() - state.hiddenAt) / 1000);
            state.hiddenAt = 0;
            if (away >= 2) {
                state.tradePhase = `This tab was in the background for ${away}s, which stops the link. Keep it in view while you trade.`;
                state.tradeTone = 'warn';
                renderTrade();
            }
        }
    });

    navigator.usb?.addEventListener('connect', onUsbConnect);
    // Release the adapter port if the page closes while bridging.
    window.addEventListener('pagehide', () => { if (state.bridge) state.bridge.stop(); state.celio?.leave(); state.gift?.stop(); });
}

async function start() {
    wireUp();
    // URL hash overrides the remembered tree.
    const asked = location.hash.slice(1);
    state.path = PATHS.includes(asked) ? asked : PATHS.includes(remembered(PATH_STORE)) ? remembered(PATH_STORE) : 'gba';
    state.source = remembered(SOURCE_STORE) === 'party' ? 'party' : 'pool';
    state.game = remembered(GAME_STORE) === 'cable' ? 'cable' : 'wireless';
    state.celioServer = remembered(CELIO_STORE) ?? CELIO_SERVER;
    state.giftEvent = remembered(GIFT_STORE);
    state.poolServer = remembered(SERVER_STORE) || POOL_SERVER;
    loadKept();
    const serial = EspDevice.available();
    if (!serial || !window.isSecureContext) {
        const notice = $('unsupported');
        notice.hidden = false;
        notice.textContent = serial
            ? 'Browsers only allow access to USB devices from https:// pages or from localhost.'
            : 'This browser has no Web Serial, which this page needs to reach the boards. Use Chrome, Edge or another Chromium browser on a computer.';
    }
    try {
        state.partyNote = (await state.party.load()) === 'empty' ? 'Drop a .pk3 file on a slot to add a Pokémon.' : '';
    } catch (error) {
        log('page', describe(error));
    }
    try {
        state.manifest = await loadManifest();
        const adapter = state.manifest.adapter;
        $('adapter-download').href = state.manifest.base + adapter.path;
        $('adapter-download').textContent = `the firmware file (${adapter.version})`;
    } catch (error) {
        log('page', describe(error));
    }
    render();
    if (!serial) for (const id of ['esp-primary', 'adapter-primary']) $(id).disabled = true;
}

start();
