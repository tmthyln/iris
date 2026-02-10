import {describe, it, expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseRssText} from './files'

const BLOG_RSS = readFileSync(
    resolve(__dirname, '../../assets/test/test_rss_johndcook.rss'),
    'utf-8',
)

// Minimal podcast RSS with iTunes/enclosure data for testing podcast-specific parsing
const PODCAST_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Test Podcast</title>
  <atom:link href="https://example.com/podcast/feed.xml" rel="self" type="application/rss+xml" />
  <link>https://example.com/podcast</link>
  <description>A test podcast feed</description>
  <itunes:author>Test Author</itunes:author>
  <itunes:summary>A test podcast about testing</itunes:summary>
  <itunes:type>episodic</itunes:type>
  <itunes:image href="https://example.com/podcast/cover.jpg" />
  <podcast:guid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</podcast:guid>
  <pubDate>Mon, 03 Feb 2026 12:00:00 +0000</pubDate>
  <item>
    <title>Episode 1: The Beginning</title>
    <guid>ep-001</guid>
    <link>https://example.com/podcast/ep1</link>
    <description>The very first episode</description>
    <pubDate>Mon, 03 Feb 2026 12:00:00 +0000</pubDate>
    <enclosure url="https://example.com/podcast/ep1.mp3" length="12345678" type="audio/mpeg" />
    <itunes:duration>1:23:45</itunes:duration>
    <itunes:season>1</itunes:season>
    <itunes:episode>1</itunes:episode>
    <itunes:keywords>testing, first, intro</itunes:keywords>
    <content:encoded><![CDATA[<p>Full show notes for episode 1</p>]]></content:encoded>
  </item>
  <item>
    <title>Episode 2: Continuing</title>
    <guid>ep-002</guid>
    <link>https://example.com/podcast/ep2</link>
    <description>The second episode</description>
    <pubDate>Tue, 04 Feb 2026 12:00:00 +0000</pubDate>
    <enclosure url="https://example.com/podcast/ep2.mp3" length="9876543" type="audio/mpeg" />
    <itunes:duration>45:30</itunes:duration>
    <itunes:season>1</itunes:season>
    <itunes:episode>2</itunes:episode>
    <content:encoded><![CDATA[<p>Full show notes for episode 2</p>]]></content:encoded>
  </item>
</channel>
</rss>`

// Minimal RSS with a single item and no namespaces
const MINIMAL_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Minimal Feed</title>
  <link>https://example.com</link>
  <description>A minimal feed</description>
  <pubDate>Wed, 01 Jan 2026 00:00:00 +0000</pubDate>
  <item>
    <title>Only Post</title>
    <guid>only-post-guid</guid>
    <link>https://example.com/only-post</link>
    <description>The only post in this feed</description>
    <pubDate>Wed, 01 Jan 2026 00:00:00 +0000</pubDate>
  </item>
</channel>
</rss>`

/******************************************************************************
 * parseRssText — blog feed (johndcook)
 *****************************************************************************/

describe('parseRssText with blog RSS (johndcook)', () => {
    const parsed = parseRssText(BLOG_RSS)

    describe('channel metadata', () => {
        it('extracts channel title', () => {
            expect(parsed.channel.title).toBe('John D. Cook')
        })

        it('extracts channel description', () => {
            expect(parsed.channel.description).toBe('Applied Mathematics Consulting')
        })

        it('extracts channel link', () => {
            expect(parsed.channel.link).toBe('https://www.johndcook.com/blog')
        })

        it('extracts source_url from atom:link', () => {
            expect(parsed.channel.source_url).toBe('https://www.johndcook.com/blog/feed/')
        })

        it('extracts channel guid', () => {
            expect(parsed.channel.guid).not.toBeNull()
            expect(parsed.channel.guid).toBeTruthy()
        })

        it('extracts last_updated date', () => {
            expect(parsed.channel.last_updated).toBe('Sat, 07 Feb 2026 14:02:45 +0000')
        })

        it('extracts image_src', () => {
            expect(parsed.channel.image_src).toBe(
                'https://www.johndcook.com/wp-content/uploads/2020/01/cropped-favicon_512-32x32.png'
            )
        })

        it('extracts image_alt from image.title', () => {
            expect(parsed.channel.image_alt).toBe('John D. Cook')
        })

        it('classifies as blog (no iTunes/podcast namespace)', () => {
            expect(parsed.channel.type).toBe('blog')
        })

        it('has author extracted from dc:creator or empty', () => {
            expect(typeof parsed.channel.author).toBe('string')
        })
    })

    describe('items', () => {
        it('parses all 30 items', () => {
            expect(parsed.items).toHaveLength(30)
        })

        it('items are ChannelItemData objects with required fields', () => {
            for (const item of parsed.items) {
                expect(item).toHaveProperty('guid')
                expect(item).toHaveProperty('title')
                expect(item).toHaveProperty('description')
                expect(item).toHaveProperty('link')
                expect(item).toHaveProperty('date')
                expect(item).toHaveProperty('encoded_content')
            }
        })

        describe('first item (Minimum of cosine sum)', () => {
            const item = parsed.items[0]

            it('has correct title', () => {
                expect(item.title).toBe('Minimum of cosine sum')
            })

            it('has correct link', () => {
                expect(item.link).toBe('https://www.johndcook.com/blog/2026/02/07/chowla/')
            })

            it('has correct guid', () => {
                expect(item.guid).toBe('https://www.johndcook.com/blog/?p=246836')
            })

            it('has pubDate', () => {
                expect(item.date).toBe('Sat, 07 Feb 2026 14:02:45 +0000')
            })

            it('has description as a non-empty string', () => {
                expect(item.description).toBeTruthy()
                expect(typeof item.description).toBe('string')
            })

            it('has content:encoded with HTML content', () => {
                expect(item.encoded_content).toBeTruthy()
                expect(item.encoded_content).toContain('<p>')
                expect(item.encoded_content).toContain('Chowla cosine conjecture')
            })

            it('has no enclosure (blog post, not podcast)', () => {
                expect(item.enclosure_url).toBeNull()
                expect(item.enclosure_type).toBeNull()
            })

            it('has no season/episode', () => {
                expect(item.season).toBeNull()
                expect(item.episode).toBeNull()
            })

            it('has duration as 0 (not a podcast)', () => {
                expect(item.duration).toBe(0)
            })
        })

        describe('all items have non-null essential fields', () => {
            it('every item has a non-null title', () => {
                for (const item of parsed.items) {
                    expect(item.title, `item guid=${item.guid}`).not.toBeNull()
                    expect(item.title, `item guid=${item.guid}`).toBeTruthy()
                }
            })

            it('every item has a non-null guid', () => {
                for (const item of parsed.items) {
                    expect(item.guid).not.toBeNull()
                    expect(item.guid).toBeTruthy()
                }
            })

            it('every item has a non-null link', () => {
                for (const item of parsed.items) {
                    expect(item.link).not.toBeNull()
                    expect(item.link).toBeTruthy()
                }
            })

            it('every item has a pubDate', () => {
                for (const item of parsed.items) {
                    expect(item.date).not.toBeNull()
                }
            })

            it('every item has content:encoded', () => {
                for (const item of parsed.items) {
                    expect(item.encoded_content).toBeTruthy()
                }
            })
        })
    })
})

/******************************************************************************
 * parseRssText — podcast feed
 *****************************************************************************/

describe('parseRssText with podcast RSS', () => {
    const parsed = parseRssText(PODCAST_RSS)

    describe('channel metadata', () => {
        it('extracts podcast title', () => {
            expect(parsed.channel.title).toBe('Test Podcast')
        })

        it('extracts description', () => {
            expect(parsed.channel.description).toBeTruthy()
        })

        it('extracts itunes:author as author', () => {
            expect(parsed.channel.author).toBe('Test Author')
        })

        it('classifies as podcast (has itunes namespace)', () => {
            expect(parsed.channel.type).toBe('podcast')
        })

        it('extracts podcast:guid as guid', () => {
            expect(parsed.channel.guid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        })

        it('extracts source_url from atom:link', () => {
            expect(parsed.channel.source_url).toBe('https://example.com/podcast/feed.xml')
        })

        it('extracts itunes:image as image_src', () => {
            expect(parsed.channel.image_src).toBe('https://example.com/podcast/cover.jpg')
        })

        it('extracts link', () => {
            expect(parsed.channel.link).toBe('https://example.com/podcast')
        })
    })

    describe('items', () => {
        it('parses both episodes', () => {
            expect(parsed.items).toHaveLength(2)
        })

        describe('episode 1', () => {
            const ep = parsed.items[0]

            it('has correct title', () => {
                expect(ep.title).toBe('Episode 1: The Beginning')
            })

            it('has correct guid', () => {
                expect(ep.guid).toBe('ep-001')
            })

            it('has enclosure URL', () => {
                expect(ep.enclosure_url).toBe('https://example.com/podcast/ep1.mp3')
            })

            it('has enclosure length (returned as string from XML attribute)', () => {
                // NOTE: fast-xml-parser returns attributes as strings.
                // ChannelItemData declares this as number | null, but the
                // parser does not coerce it. Downstream consumers (e.g.
                // ServerFeedItem) should handle the conversion.
                expect(ep.enclosure_length).toBe('12345678')
            })

            it('has enclosure type', () => {
                expect(ep.enclosure_type).toBe('audio/mpeg')
            })

            it('parses HH:MM:SS duration to seconds', () => {
                // 1:23:45 = 1*3600 + 23*60 + 45 = 3600 + 1380 + 45 = 5025
                expect(ep.duration).toBe(5025)
            })

            it('has duration_unit as seconds', () => {
                expect(ep.duration_unit).toBe('seconds')
            })

            it('has season', () => {
                expect(ep.season).toBe(1)
            })

            it('has episode number', () => {
                expect(ep.episode).toBe(1)
            })

            it('parses comma-separated keywords', () => {
                expect(ep.keywords).toBe('testing,first,intro')
            })

            it('has content:encoded', () => {
                expect(ep.encoded_content).toContain('Full show notes for episode 1')
            })
        })

        describe('episode 2', () => {
            const ep = parsed.items[1]

            it('parses MM:SS duration to seconds', () => {
                // 45:30 = 45*60 + 30 = 2730
                expect(ep.duration).toBe(2730)
            })

            it('has empty keywords when none specified', () => {
                expect(ep.keywords).toBe('')
            })
        })
    })
})

/******************************************************************************
 * parseRssText — minimal feed
 *****************************************************************************/

describe('parseRssText with minimal RSS', () => {
    const parsed = parseRssText(MINIMAL_RSS)

    it('handles single-item feeds (not wrapped in array)', () => {
        expect(parsed.items).toHaveLength(1)
    })

    it('extracts channel title from plain text element', () => {
        expect(parsed.channel.title).toBe('Minimal Feed')
    })

    it('extracts channel description', () => {
        expect(parsed.channel.description).toBe('A minimal feed')
    })

    it('extracts channel link', () => {
        expect(parsed.channel.link).toBe('https://example.com')
    })

    it('classifies as blog when no podcast namespaces present', () => {
        expect(parsed.channel.type).toBe('blog')
    })

    it('has empty author when none provided', () => {
        expect(parsed.channel.author).toBe('')
    })

    it('has null image when none provided', () => {
        expect(parsed.channel.image_src).toBeNull()
        expect(parsed.channel.image_alt).toBeNull()
    })

    describe('single item', () => {
        const item = parsed.items[0]

        it('extracts item title', () => {
            expect(item.title).toBe('Only Post')
        })

        it('extracts item guid', () => {
            expect(item.guid).toBe('only-post-guid')
        })

        it('extracts item link', () => {
            expect(item.link).toBe('https://example.com/only-post')
        })

        it('has null enclosure fields', () => {
            expect(item.enclosure_url).toBeNull()
            expect(item.enclosure_length).toBeNull()
            expect(item.enclosure_type).toBeNull()
        })

        it('has null season/episode', () => {
            expect(item.season).toBeNull()
            expect(item.episode).toBeNull()
        })

        it('has empty encoded_content when content:encoded not present', () => {
            // Falls back to 'content' key, which also doesn't exist
            expect(item.encoded_content).toBeFalsy()
        })
    })
})

/******************************************************************************
 * parseRssText — edge cases
 *****************************************************************************/

describe('parseRssText edge cases', () => {
    it('handles guid with isPermaLink attribute (extracts #text)', () => {
        const rss = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
        <channel>
          <title>Attr Test</title>
          <link>https://example.com</link>
          <description>Test</description>
          <item>
            <title>Post</title>
            <guid isPermaLink="false">https://example.com/?p=123</guid>
            <link>https://example.com/post</link>
            <description>A post</description>
            <pubDate>Wed, 01 Jan 2026 00:00:00 +0000</pubDate>
          </item>
        </channel>
        </rss>`

        const parsed = parseRssText(rss)
        expect(parsed.items[0].guid).toBe('https://example.com/?p=123')
    })

    it('coalesces guid fallback to title when guid element missing', () => {
        const rss = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
        <channel>
          <title>No Guid Feed</title>
          <link>https://example.com</link>
          <description>Test</description>
          <item>
            <title>Post Without Guid</title>
            <link>https://example.com/post</link>
            <description>No guid here</description>
          </item>
        </channel>
        </rss>`

        const parsed = parseRssText(rss)
        // Should fall back to title for guid
        expect(parsed.items[0].guid).toBe('Post Without Guid')
    })

    it('handles CDATA sections in description', () => {
        const rss = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
        <channel>
          <title>CDATA Test</title>
          <link>https://example.com</link>
          <description><![CDATA[Description with <b>HTML</b> inside CDATA]]></description>
          <item>
            <title>CDATA Post</title>
            <guid>cdata-post</guid>
            <link>https://example.com/cdata</link>
            <description><![CDATA[Item <em>description</em> with CDATA]]></description>
          </item>
        </channel>
        </rss>`

        const parsed = parseRssText(rss)
        expect(parsed.channel.description).toContain('HTML')
        expect(parsed.items[0].description).toContain('description')
    })
})