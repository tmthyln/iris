/** Builds small MP4 files to exercise the demuxer, box by box. */

function u32(value: number) {
    return [(value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF]
}

function u64(value: number) {
    return [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)]
}

function ascii(text: string) {
    return [...text].map(char => char.charCodeAt(0))
}

export function box(type: string, ...content: number[][]) {
    const body = content.flat()
    return [...u32(body.length + 8), ...ascii(type), ...body]
}

function descriptor(tag: number, body: number[]) {
    return [tag, 0x80, 0x80, 0x80, body.length, ...body]
}

export interface M4aOptions {
    /** The frames' contents, in file order. */
    readonly frames: readonly Uint8Array[]
    /** Frames per chunk as `stsc` runs: `[[first chunk (1-based), frames per chunk], …]`. */
    readonly chunkRuns?: ReadonlyArray<readonly [number, number]>
    readonly moovAtEnd?: boolean
    readonly co64?: boolean
    /** A video track before the audio one, as a video podcast has. */
    readonly videoTrackFirst?: boolean
    /** AudioSpecificConfig; defaults to AAC-LC, 44.1 kHz, stereo. */
    readonly audioConfig?: readonly number[]
    readonly objectTypeIndication?: number
    readonly codec?: string
    readonly timescale?: number
    readonly ticksPerFrame?: number
    /** Bytes of junk between chunks, as interleaved tracks leave. */
    readonly gapBytes?: number
    /** Leave out the sample tables' contents, as a fragmented file does. */
    readonly fragmented?: boolean
}

function audioTrak(options: M4aOptions, chunkOffsets: readonly number[]) {
    const {frames, co64 = false, audioConfig = [0x12, 0x10], objectTypeIndication = 0x40, codec = 'mp4a', timescale = 44100, ticksPerFrame = 1024, chunkRuns = [[1, frames.length]], fragmented = false} = options
    const esds = box('esds', u32(0), descriptor(0x03, [
        0, 1, 0,  // ES id, flags
        ...descriptor(0x04, [objectTypeIndication, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...descriptor(0x05, [...audioConfig])]),
        ...descriptor(0x06, [2]),
    ]))
    const sampleEntry = box(codec, new Array<number>(28).fill(0), esds)
    const counted = fragmented ? 0 : frames.length
    const stbl = box('stbl',
        box('stsd', u32(0), u32(1), sampleEntry),
        box('stts', u32(0), u32(fragmented ? 0 : 1), fragmented ? [] : [...u32(counted), ...u32(ticksPerFrame)]),
        box('stsc', u32(0), u32(chunkRuns.length), chunkRuns.flatMap(([first, count]) => [...u32(first), ...u32(count), ...u32(1)])),
        box('stsz', u32(0), u32(0), u32(counted), fragmented ? [] : frames.flatMap(frame => u32(frame.byteLength))),
        co64
            ? box('co64', u32(0), u32(chunkOffsets.length), chunkOffsets.flatMap(u64))
            : box('stco', u32(0), u32(chunkOffsets.length), chunkOffsets.flatMap(u32)),
    )
    return box('trak', box('mdia',
        box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0)),
        box('hdlr', u32(0), u32(0), ascii('soun'), new Array<number>(12).fill(0), [0]),
        box('minf', stbl),
    ))
}

const VIDEO_TRAK = box('trak', box('mdia', box('hdlr', u32(0), u32(0), ascii('vide'), new Array<number>(12).fill(0), [0])))

function framesPerChunk({frames, chunkRuns = [[1, frames.length]]}: M4aOptions) {
    const counts: number[] = []
    let remaining = frames.length
    for (let chunk = 1; remaining > 0; chunk++) {
        const run = [...chunkRuns].reverse().find(([first]) => first <= chunk)!
        const count = Math.min(run[1], remaining)
        counts.push(count)
        remaining -= count
    }
    return counts
}

export function buildM4a(options: M4aOptions) {
    const {frames, moovAtEnd = false, gapBytes = 0, videoTrackFirst = false} = options
    const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('isom'))
    const counts = framesPerChunk(options)

    const moovFor = (offsets: readonly number[]) => box('moov', box('mvhd', u32(0)), videoTrackFirst ? VIDEO_TRAK : [], audioTrak(options, offsets))
    const moovBytes = moovFor(counts.map(() => 0)).length
    const payloadStart = ftyp.length + (moovAtEnd ? 0 : moovBytes) + 8  // past the mdat header

    const offsets: number[] = []
    const media: number[] = []
    let frame = 0
    for (const count of counts) {
        offsets.push(payloadStart + media.length)
        for (const end = frame + count; frame < end; frame++) media.push(...frames[frame])
        media.push(...new Array<number>(gapBytes).fill(0xFF))
    }
    const mdat = box('mdat', media)
    const moov = moovFor(offsets)
    return new Uint8Array(moovAtEnd ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat])
}

/** The bytes of the file's `moov` box. */
export function moovOf(file: Uint8Array) {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    for (let offset = 0; offset + 8 <= file.byteLength; offset += view.getUint32(offset)) {
        if (String.fromCharCode(...file.subarray(offset + 4, offset + 8)) === 'moov') return file.subarray(offset, offset + view.getUint32(offset))
    }
    throw new Error('no moov box')
}
