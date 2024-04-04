-- Migration number: 0004 	 2024-03-18T00:58:00.592Z

CREATE VIRTUAL TABLE text_search USING fts5(
    title,
    alias,
    description,
    author,
    content,
    categories,
    keywords,

    guid UNINDEXED,
    table UNINDEXED,

    prefix='2 3',
    tokenize='trigram'
);
