// A Tomodachi Life payload opened for editing: the name of any item, and for a Mii its
// pronunciation, phrase, gender, pronouns, clothing style, who it dates, birthday,
// personality and voice. A port of the field editing in firmware/tools/tomodachi/mii.py:
// fields keep their node types, and what is not edited stays as the Switch sent it.

import { INT, Reader, UINT, Value, Writer } from './byml.js';
import { CORE, INNER, NAME, murmur3, prepare } from './payload.js';

const field = (name) => murmur3(new TextEncoder().encode(name));

// The payload numbers the save's enums from 0. Voice presets count from Boy; Custom is -1.
export const GENDERS = ['Male', 'Female', 'Non-binary'];
export const PRONOUNS = ['He', 'She', 'They'];
export const CUSTOM_VOICE = -1;
// Each preset's sliders, as the game sets them (from ltd-save-editor's voice editor).
export const VOICE_PRESETS = [
    { name: 'Boy', speed: 25, pitch: 28, formant: 28, tension: 5, intonation: 0 },
    { name: 'Girl', speed: 25, pitch: 39, formant: 31, tension: 5, intonation: 0 },
    { name: 'Male', speed: 28, pitch: 16, formant: 20, tension: 5, intonation: 0 },
    { name: 'Female', speed: 28, pitch: 34, formant: 25, tension: 5, intonation: 0 },
    { name: 'Old man', speed: 12, pitch: 14, formant: 25, tension: 5, intonation: 0 },
    { name: 'Old woman', speed: 12, pitch: 27, formant: 30, tension: 5, intonation: 0 },
    { name: 'Big', speed: 22, pitch: 13, formant: 6, tension: 5, intonation: 0 },
    { name: 'Small', speed: 35, pitch: 45, formant: 40, tension: 15, intonation: 0 },
    { name: 'Robot L', speed: 22, pitch: 10, formant: 33, tension: 0, intonation: 0 },
    { name: 'Robot S', speed: 32, pitch: 45, formant: 50, tension: 0, intonation: 3 },
];
export const VOICE_RANGES = {
    speed: [0, 50], pitch: [0, 50], formant: [0, 50], tension: [-25, 25], intonation: [0, 5],
};
// The game's five sliders, 1 to 8, with the words at either end.
export const PERSONALITY = [
    { key: 'gaiety', label: 'Movement', low: 'Slow', high: 'Quick' },
    { key: 'activeness', label: 'Speech', low: 'Polite', high: 'Honest' },
    { key: 'audaciousness', label: 'Energy', low: 'Flat', high: 'Varied' },
    { key: 'sociability', label: 'Thinking', low: 'Serious', high: 'Chill' },
    { key: 'commonsense', label: 'Overall', low: 'Normal', high: 'Quirky' },
];

const FIELDS = {
    pronunciation: field('CallName'), gender: field('Gender'), pronouns: field('PronounType'),
    clothStyle: field('ClothStyle'), loves: field('LoveGender'),
    year: field('BirthYear'), month: field('BirthMonth'), day: field('BirthDay'),
    gaiety: field('CharacterGaiety'), activeness: field('CharacterActiveness'),
    audaciousness: field('CharacterAudaciousness'), sociability: field('CharacterSociability'),
    commonsense: field('CharacterCommonsense'),
    voicePreset: 0xa90584fa,   // name not known
    speed: field('VoiceSpeed'), pitch: field('VoicePitch'), formant: field('VoiceFormant'),
    tension: field('VoiceTension'), intonation: field('VoiceIntonation'),
    language: field('NameRegionLanguageID'),
};
// The phrase: these fields exist only once a Mii has one (names not known).
const PHRASE = 0xc3f3d6a6, PHRASE_SAYS = 0x87c1aff6, PHRASE_LANGUAGE = 0x51110d81, PHRASE_FLAG = 0xe5da2956;

export class Payload {
    constructor(data) {
        this.outer = new Reader(data);
        this.inner = new Reader(this.outer.root.get(INNER));
        this.isMii = this.inner.root.has(CORE);
    }

    get name() { return this.outer.root.get(NAME) ?? ''; }
    set name(text) { this.outer.root.set(NAME, text); }

    // A number field of a Mii, or a string one.
    get(key) {
        const v = this.inner.root.get(FIELDS[key] ?? key);
        return v instanceof Value ? v.value : v;
    }

    has(key) { return this.inner.root.has(FIELDS[key] ?? key); }

    // Set a field the Mii has, keeping its node type; numbers only replace numbers.
    set(key, value) {
        const hash = FIELDS[key] ?? key;
        const old = this.inner.root.get(hash);
        if (old === undefined) throw new Error(`this Mii has no ${key}`);
        if (old instanceof Value) {
            if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`${key} takes a whole number`);
            this.inner.root.set(hash, new Value(old.type, old.type === UINT ? value >>> 0 : value));
        } else {
            if (typeof value !== typeof old) throw new TypeError(`${key} holds ${typeof old}, not ${typeof value}`);
            this.inner.root.set(hash, value);
        }
    }

    // '' for none.
    get phrase() { return this.inner.root.get(PHRASE) ?? ''; }

    set phrase(text) {
        const root = this.inner.root;
        if (!root.has(PHRASE)) {
            if (!text) return;
            // As the game adds them; the language is the name's.
            root.set(PHRASE_SAYS, '');
            root.set(PHRASE_FLAG, new Value(INT, 0));
            root.set(PHRASE_LANGUAGE, new Value(INT, this.has('language') ? this.get('language') : 5));
        }
        root.set(PHRASE, text);
    }

    // The voice preset with its sliders, as the game sets them; Custom keeps the sliders.
    setVoicePreset(preset) {
        this.set('voicePreset', preset);
        const values = VOICE_PRESETS[preset];
        if (values) for (const key of Object.keys(VOICE_RANGES)) if (this.has(key)) this.set(key, values[key]);
    }

    // The payload as sent: the edits, then new transfer UUIDs and (for a Mii) a new Mii ID.
    build(options = {}) {
        this.outer.root.set(INNER, new Writer(this.inner.root, [], this.inner.version).build());
        return prepare(new Writer(this.outer.root, [], this.outer.version).build(), options);
    }
}
