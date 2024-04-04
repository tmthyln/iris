-- Migration number: 0005 	 2024-03-18T23:41:03.150Z

DROP TABLE IF EXISTS text_search;

CREATE VIRTUAL TABLE text_search USING fts5(
    title,
    alias,
    description,
    author,
    content,
    categories,
    keywords,

    guid UNINDEXED,
    table_name UNINDEXED,

    prefix='2 3',
    tokenize='trigram'
);
