import {describe, expect, test} from 'vitest'
import {box, buildM4a, moovOf} from '../testing/mp4'
import {adtsHeader, findMoov, firstAdtsFrame, parseAacTrack} from './mp4'

function frames(...sizes: number[]) {
    return sizes.map((size, i) => new Uint8Array(size).fill(i + 1))
}

function fileReader(file: Uint8Array) {
    return (offset: number, length: number) => Promise.resolve(file.subarray(offset, offset + length))
}

/** The bytes of each frame the track points at. */
function framesIn(file: Uint8Array) {
    const track = parseAacTrack(moovOf(file))!
    return [...track.samples()].map(({offset, size}) => file.subarray(offset, offset + size))
}

describe('parseAacTrack', () => {
    test('reads the codec configuration and duration', () => {
        const track = parseAacTrack(moovOf(buildM4a({frames: frames(10, 20, 30), ticksPerFrame: 2048, timescale: 44100})))
        expect(track).toMatchObject({profile: 1, samplingIndex: 4, channels: 2, sampleCount: 3})
        expect(track?.seconds).toBeCloseTo(3 * 2048 / 44100)
    })

    test('finds every frame, whether the index precedes or follows them', () => {
        const contents = frames(10, 20, 30)
        for (const moovAtEnd of [false, true]) {
            expect(framesIn(buildM4a({frames: contents, moovAtEnd}))).toEqual(contents)
        }
    })

    test('follows chunk runs and skips what lies between chunks', () => {
        const contents = frames(5, 6, 7, 8, 9, 10, 11)
        // chunks of 2, 2, 1, 1, 1 frames
        const file = buildM4a({frames: contents, chunkRuns: [[1, 2], [3, 1]], gapBytes: 3})
        expect(framesIn(file)).toEqual(contents)
    })

    test('reads 64-bit chunk offsets', () => {
        const contents = frames(10, 20)
        expect(framesIn(buildM4a({frames: contents, co64: true}))).toEqual(contents)
    })

    test('takes the audio track of a file that also has video', () => {
        expect(parseAacTrack(moovOf(buildM4a({frames: frames(10), videoTrackFirst: true})))).toMatchObject({sampleCount: 1})
    })

    test('uses the core of explicitly signalled HE-AAC', () => {
        // type 5, 22.05 kHz, stereo, extension 44.1 kHz, core type 2
        const audioConfig = [0x2B, 0x92, 0x08, 0x00]
        expect(parseAacTrack(moovOf(buildM4a({frames: frames(10), audioConfig})))).toMatchObject({profile: 1, samplingIndex: 7, channels: 2})
    })

    test('keeps the core of backward-compatible HE-AAC, as ADTS carries it implicitly', () => {
        // 22.05 kHz mono AAC-LC, then the sync extension of an MP4 from xmcdn.com
        const audioConfig = [0x13, 0x88, 0x56, 0xE5, 0xA5, 0x48, 0x80]
        expect(parseAacTrack(moovOf(buildM4a({frames: frames(10), audioConfig})))).toMatchObject({profile: 1, samplingIndex: 7, channels: 1})
    })

    test.each([
        ['another codec', {codec: 'alac'}],
        ['MP3 in MP4', {objectTypeIndication: 0x6B}],
        ['a program config element instead of a channel count', {audioConfig: [0x12, 0x00]}],
        ['an explicit sampling rate', {audioConfig: [0x17, 0x80, 0x00, 0x00, 0x08]}],
        ['an object type ADTS cannot name', {audioConfig: [0xF8, 0x10]}],
        ['tables in fragments', {fragmented: true}],
    ])('rejects %s', (_name, options) => {
        expect(parseAacTrack(moovOf(buildM4a({frames: frames(10), ...options})))).toBeNull()
    })

    test('rejects a frame too long for an ADTS header', () => {
        expect(parseAacTrack(moovOf(buildM4a({frames: frames(8185)})))).toBeNull()
        expect(parseAacTrack(moovOf(buildM4a({frames: frames(8184)})))).not.toBeNull()
    })

    test('rejects a file without an audio track, and a truncated one', () => {
        expect(parseAacTrack(new Uint8Array(box('moov', box('mvhd'))))).toBeNull()
        expect(parseAacTrack(new Uint8Array(box('free')))).toBeNull()
        const moov = moovOf(buildM4a({frames: frames(10, 10, 10)}))
        expect(parseAacTrack(moov.subarray(0, moov.byteLength - 20))).toBeNull()
    })
})

describe('findMoov', () => {
    test('hops over the boxes before it', async () => {
        const file = buildM4a({frames: frames(100), moovAtEnd: true})
        const found = await findMoov(fileReader(file), file.byteLength)
        expect(moovOf(file)).toEqual(file.subarray(found!.offset, found!.offset + found!.length))
    })

    test('understands a 64-bit box size', async () => {
        const large = [0, 0, 0, 1, ...'mdat'.split('').map(char => char.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0, 20, 1, 2, 3, 4]
        const file = new Uint8Array([...large, ...box('moov')])
        expect(await findMoov(fileReader(file), file.byteLength)).toEqual({offset: 20, length: 8})
    })

    test('gives up on a file without one, or with a box running past its end', async () => {
        const noMoov = new Uint8Array(box('mdat', [1, 2, 3]))
        expect(await findMoov(fileReader(noMoov), noMoov.byteLength)).toBeNull()
        const truncated = new Uint8Array([0, 0, 1, 0, 0x6D, 0x64, 0x61, 0x74])
        expect(await findMoov(fileReader(truncated), truncated.byteLength)).toBeNull()
        // a size of zero runs to the end of the file
        const toEnd = new Uint8Array([0, 0, 0, 0, 0x6D, 0x64, 0x61, 0x74, 1, 2])
        expect(await findMoov(fileReader(toEnd), toEnd.byteLength)).toBeNull()
    })
})

describe('adtsHeader', () => {
    test('encodes the profile, rate, channels and length', () => {
        expect([...adtsHeader({profile: 1, samplingIndex: 7, channels: 1}, 256)]).toEqual([0xFF, 0xF1, 0x5C, 0x40, 0x20, 0xFF, 0xFC])
        // a channel count of 7 straddles two bytes; 8191 is the longest frame
        expect([...adtsHeader({profile: 1, samplingIndex: 4, channels: 7}, 8184)]).toEqual([0xFF, 0xF1, 0x51, 0xC3, 0xFF, 0xFF, 0xFC])
    })
})

describe('firstAdtsFrame', () => {
    const track = {profile: 1, samplingIndex: 4, channels: 2}
    const frame = (size: number) => [...adtsHeader(track, size), ...new Array<number>(size).fill(0x11)]
    const stream = [...frame(20), ...frame(30), ...frame(25), ...frame(40), ...frame(10)]

    test('leaves a range starting on a frame alone', () => {
        expect(firstAdtsFrame(new Uint8Array(stream))).toBe(0)
    })

    test('skips the rest of the frame a cut landed in', () => {
        expect(firstAdtsFrame(new Uint8Array(stream.slice(12)))).toBe(15)
    })

    test('is not fooled by a sync word in the payload', () => {
        const fake = [0xFF, 0xF1, 0x50, 0x80, 0x01, 0x00, 0xFC, 0x11, 0x11]
        expect(firstAdtsFrame(new Uint8Array([...fake, ...stream]))).toBe(fake.length)
    })

    test('accepts a chain running off the end of a short range', () => {
        expect(firstAdtsFrame(new Uint8Array(frame(20).slice(0, 15)))).toBe(0)
    })

    test('finds nothing in other data', () => {
        expect(firstAdtsFrame(new Uint8Array(100).fill(0x42))).toBe(0)
        expect(firstAdtsFrame(new Uint8Array())).toBe(0)
    })
})
