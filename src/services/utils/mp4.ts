/**
 * Just enough of the MP4 container to get AAC frames out of an M4A: the sample
 * tables of its first audio track, and the ADTS header that makes each frame
 * self-describing. Fragmented files keep their tables in `moof` boxes and carry
 * no samples here, so they read as having no usable track.
 */

export const ADTS_HEADER_BYTES = 7

// A frame's length is 13 bits in the ADTS header, itself included.
const ADTS_MAX_FRAME_BYTES = (1 << 13) - 1

const SOUND_HANDLER = 0x736F756E  // "soun"

const AOT_SBR = 5
const AOT_PS = 29

// Object type indications of AAC in an `esds`: MPEG-4 audio, and MPEG-2 Main/LC/SSR.
const AAC_OBJECT_TYPE_INDICATIONS = [0x40, 0x66, 0x67, 0x68]

interface Box {
    readonly type: string
    /** Offset of the first byte after the box's header. */
    readonly start: number
    readonly end: number
}

export interface AacTrack {
    /** ADTS `profile`: the audio object type of the AAC-LC (or other) core, minus one. */
    readonly profile: number
    readonly samplingIndex: number
    readonly channels: number
    readonly sampleCount: number
    readonly seconds: number
    readonly samples: () => Generator<{offset: number, size: number}>
}

function* readBoxes(view: DataView, start: number, end: number): Generator<Box> {
    let offset = start
    while (offset + 8 <= end) {
        const header = readBoxHeader(view, offset, end)
        if (!header) return
        yield {type: header.type, start: offset + header.headerBytes, end: offset + header.size}
        offset += header.size
    }
}

/** A box header at `offset`; null if it is malformed or runs past `end`. */
function readBoxHeader(view: DataView, offset: number, end: number) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7))
    let headerBytes = 8
    if (size === 1) {
        if (offset + 16 > end) return null
        size = Number(view.getBigUint64(offset + 8))
        headerBytes = 16
    } else if (size === 0) {
        size = end - offset  // runs to the end of its parent
    }
    if (size < headerBytes || offset + size > end) return null
    return {type, size, headerBytes}
}

function child(view: DataView, parent: Box | undefined, type: string) {
    if (!parent) return undefined
    for (const box of readBoxes(view, parent.start, parent.end)) {
        if (box.type === type) return box
    }
    return undefined
}

/**
 * Finds the top-level `moov` box of a file by hopping from box header to box
 * header, as it may follow a media box of any size.
 */
export async function findMoov(read: (offset: number, length: number) => Promise<Uint8Array>, fileSize: number) {
    let offset = 0
    while (offset + 8 <= fileSize) {
        const head = await read(offset, Math.min(16, fileSize - offset))
        const header = readBoxHeader(new DataView(head.buffer, head.byteOffset, head.byteLength), 0, fileSize - offset)
        if (!header) return null
        if (header.type === 'moov') return {offset, length: header.size}
        offset += header.size
    }
    return null
}

/** The channel layout and sampling rate an `esds` box declares, or null if they don't fit an ADTS header. */
function parseEsds(view: DataView, esds: Box) {
    let offset = esds.start + 4  // version and flags
    const readDescriptor = () => {
        if (offset >= esds.end) return null
        const tag = view.getUint8(offset++)
        let length = 0
        for (let i = 0; i < 4 && offset < esds.end; i++) {
            const byte = view.getUint8(offset++)
            length = (length << 7) | (byte & 0x7F)
            if (!(byte & 0x80)) break
        }
        return offset + length <= esds.end ? {tag, length} : null
    }

    if (readDescriptor()?.tag !== 0x03) return null  // ES descriptor
    const flags = view.getUint8(offset + 2)
    offset += 3
    if (flags & 0x80) offset += 2  // depends on another stream
    if (flags & 0x40) offset += 1 + view.getUint8(offset)  // URL
    if (flags & 0x20) offset += 2  // OCR stream
    if (offset >= esds.end || readDescriptor()?.tag !== 0x04) return null  // decoder config
    if (!AAC_OBJECT_TYPE_INDICATIONS.includes(view.getUint8(offset))) return null
    offset += 13
    const config = readDescriptor()
    if (config?.tag !== 0x05 || config.length < 2) return null  // AudioSpecificConfig

    // 5 bits of object type, 4 of sampling index, 4 of channels, then for
    // explicitly signalled SBR/PS 4 of extension sampling index and 5 of core type.
    let take = 0
    for (let i = 0; i < 4; i++) take = take * 256 + (i < config.length ? view.getUint8(offset + i) : 0)
    const objectType = take >>> 27
    const samplingIndex = (take >>> 23) & 0xF
    const channels = (take >>> 19) & 0xF
    const explicitExtension = objectType === AOT_SBR || objectType === AOT_PS
    const coreType = explicitExtension ? (take >>> 10) & 0x1F : objectType
    if (explicitExtension && ((take >>> 15) & 0xF) === 15) return null
    // ADTS can name neither an explicit sampling rate, nor a channel layout
    // that lives in a program config element, nor object types above 4.
    if (coreType < 1 || coreType > 4 || samplingIndex > 12 || channels < 1 || channels > 7) return null
    return {profile: coreType - 1, samplingIndex, channels}
}

/** The first audio track of a `moov` box, if it is AAC with frames that fit ADTS. */
export function parseAacTrack(moov: Uint8Array): AacTrack | null {
    const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)
    try {
        const [root] = readBoxes(view, 0, moov.byteLength)
        if (root?.type !== 'moov') return null

        for (const trak of readBoxes(view, root.start, root.end)) {
            if (trak.type !== 'trak') continue
            const mdia = child(view, trak, 'mdia')
            const hdlr = child(view, mdia, 'hdlr')
            // version and flags, predefined, then the handler type
            if (!hdlr || hdlr.start + 12 > hdlr.end || view.getUint32(hdlr.start + 8) !== SOUND_HANDLER) continue
            return parseAudioTrak(view, mdia!)
        }
        return null
    } catch (err) {
        // A table claiming to extend past the box: not a file we can read.
        if (err instanceof RangeError) return null
        throw err
    }
}

function parseAudioTrak(view: DataView, mdia: Box): AacTrack | null {
    const mdhd = child(view, mdia, 'mdhd')
    const stbl = child(view, child(view, mdia, 'minf'), 'stbl')
    const stsd = child(view, stbl, 'stsd')
    const stts = child(view, stbl, 'stts')
    const stsc = child(view, stbl, 'stsc')
    const stsz = child(view, stbl, 'stsz')
    const stco = child(view, stbl, 'stco')
    const co64 = child(view, stbl, 'co64')
    const chunkTable = stco ?? co64
    if (!mdhd || !stsd || !stts || !stsc || !stsz || !chunkTable) return null

    // version and flags, the entry count, then the first entry's box
    if (stsd.start + 16 > stsd.end) return null
    const entry = readBoxHeader(view, stsd.start + 8, stsd.end)
    if (entry?.type !== 'mp4a') return null
    // An audio sample entry has 28 bytes of fields before its child boxes.
    const entryStart = stsd.start + 8 + entry.headerBytes + 28
    let esds: Box | undefined
    for (const box of readBoxes(view, entryStart, stsd.start + 8 + entry.size)) {
        if (box.type === 'esds') esds = box
    }
    const config = esds && parseEsds(view, esds)
    if (!config) return null

    const fixedSize = view.getUint32(stsz.start + 4)
    const sampleCount = view.getUint32(stsz.start + 8)
    if (sampleCount === 0 || (!fixedSize && stsz.start + 12 + sampleCount * 4 > stsz.end)) return null
    const sizeOf = (sample: number) => fixedSize || view.getUint32(stsz.start + 12 + sample * 4)
    for (let sample = 0; sample < sampleCount; sample++) {
        if (sizeOf(sample) + ADTS_HEADER_BYTES > ADTS_MAX_FRAME_BYTES) return null
    }

    const chunkCount = view.getUint32(chunkTable.start + 4)
    const entryBytes = chunkTable === stco ? 4 : 8
    if (chunkTable.start + 8 + chunkCount * entryBytes > chunkTable.end) return null
    const chunkOffset = (chunk: number) => chunkTable === stco
        ? view.getUint32(chunkTable.start + 8 + chunk * 4)
        : Number(view.getBigUint64(chunkTable.start + 8 + chunk * 8))

    const runCount = view.getUint32(stsc.start + 4)
    if (runCount === 0 || stsc.start + 8 + runCount * 12 > stsc.end) return null
    const runField = (run: number, field: number) => view.getUint32(stsc.start + 8 + run * 12 + field)

    return {
        ...config,
        sampleCount,
        seconds: trackSeconds(view, mdhd, stts),
        * samples() {
            let sample = 0
            let run = 0
            for (let chunk = 0; chunk < chunkCount && sample < sampleCount; chunk++) {
                while (run + 1 < runCount && runField(run + 1, 0) <= chunk + 1) run++
                let offset = chunkOffset(chunk)
                for (let i = runField(run, 4); i > 0 && sample < sampleCount; i--, sample++) {
                    const size = sizeOf(sample)
                    yield {offset, size}
                    offset += size
                }
            }
        },
    }
}

/** Sums the sample durations: `mdhd` only provides the timescale they are in. */
function trackSeconds(view: DataView, mdhd: Box, stts: Box) {
    const timescale = view.getUint32(mdhd.start + (view.getUint8(mdhd.start) === 1 ? 20 : 12))
    const entries = view.getUint32(stts.start + 4)
    let ticks = 0
    for (let i = 0; i < entries && stts.start + 16 + i * 8 <= stts.end; i++) {
        ticks += view.getUint32(stts.start + 8 + i * 8) * view.getUint32(stts.start + 12 + i * 8)
    }
    return timescale > 0 ? ticks / timescale : 0
}

export function adtsHeader(track: Pick<AacTrack, 'profile' | 'samplingIndex' | 'channels'>, frameBytes: number) {
    const length = frameBytes + ADTS_HEADER_BYTES
    return new Uint8Array([
        0xFF,
        0xF1,  // MPEG-4, no CRC
        (track.profile << 6) | (track.samplingIndex << 2) | (track.channels >> 2),
        ((track.channels & 0b11) << 6) | (length >> 11),
        (length >> 3) & 0xFF,
        ((length & 0b111) << 5) | 0x1F,  // the buffer fullness is all ones: variable bitrate
        0xFC,
    ])
}

/**
 * The offset of the first ADTS frame in a byte range cut from a stream. The
 * range may start mid-frame, where the payload can pass for a sync word and make
 * the decoder give up on the whole range, so a frame only counts if the next few
 * follow on from it. Returns 0 if no such chain exists.
 */
export function firstAdtsFrame(bytes: Uint8Array) {
    const CHAIN = 4
    const frameLength = (offset: number) => {
        if (offset + ADTS_HEADER_BYTES > bytes.byteLength) return 0
        if (bytes[offset] !== 0xFF || (bytes[offset + 1] & 0xF6) !== 0xF0) return 0
        return ((bytes[offset + 3] & 0b11) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5)
    }
    for (let start = 0; start + ADTS_HEADER_BYTES <= bytes.byteLength; start++) {
        let offset = start
        let frames = 0
        for (; frames < CHAIN; frames++) {
            const length = frameLength(offset)
            if (length < ADTS_HEADER_BYTES) break
            offset += length
        }
        // A chain may legitimately run off the end of a very short range.
        if (frames === CHAIN || (frames > 0 && offset >= bytes.byteLength)) return start
    }
    return 0
}
