import {DurableObject} from "cloudflare:workers";

export function getQueue(env: Env, name: string = 'default') {
    const id: DurableObjectId = env.ITEM_QUEUE.idFromName(name)
    return env.ITEM_QUEUE.get(id)
}

export class ItemQueue extends DurableObject<Env> {
    sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;

        this.sql.exec(`CREATE TABLE IF NOT EXISTS queue_item (
            queue_order INTEGER PRIMARY KEY,
            feed_item_guid TEXT UNIQUE NOT NULL);`);
    }

    getItems(): string[] {
        const rows = this.sql.exec<{feed_item_guid: string}>(`SELECT feed_item_guid FROM queue_item ORDER BY queue_order;`).toArray()
        return rows.map(row => row.feed_item_guid)
    }

    _getNextOrder() {
        const maxOrderResult = this.sql.exec<{ maxOrder: number }>(`SELECT MAX(queue_order) as maxOrder
                                                                    FROM queue_item`).toArray()
        return (maxOrderResult[0]?.maxOrder ?? -1) + 1
    }

    _hasItem(itemGuid: string) {
        return this.sql.exec(`SELECT * FROM queue_item WHERE feed_item_guid = ?;`, itemGuid).toArray().length > 0
    }

    clearQueue(): string[] {
        this.sql.exec(`DELETE FROM queue_item WHERE true;`);
        return []
    }

    /** Empties the queue except for its first (playing) item, in one step, so
     * no other change to the queue can land between reading and clearing it. */
    clearExceptFirst(): string[] {
        this.sql.exec(`DELETE FROM queue_item
                       WHERE queue_order > (SELECT MIN(queue_order) FROM queue_item);`)
        return this.getItems()
    }

    enqueueItem(itemGuid: string): string[] {
        if (!this._hasItem(itemGuid)) {
            const nextOrder = this._getNextOrder()
            this.sql.exec(`INSERT INTO queue_item (queue_order, feed_item_guid) VALUES (?, ?);`, nextOrder, itemGuid)
        }

        return this.getItems()
    }

    /** Moves (or adds) an item to `index` in the queue, clamped to its bounds.
     * Orders may have gaps (removal doesn't renumber), so the index is resolved
     * to the order of the item currently there, and only the items from there
     * on are shifted. */
    insertItem(itemGuid: string, index: number): string[] {
        this.ctx.storage.transactionSync(() => {
            this.sql.exec(`DELETE FROM queue_item WHERE feed_item_guid = ?;`, itemGuid)
            const at = this.sql.exec<{queue_order: number}>(
                `SELECT queue_order FROM queue_item ORDER BY queue_order LIMIT 1 OFFSET ?;`,
                Math.max(0, Math.floor(index)),
            ).toArray()[0]?.queue_order

            if (at === undefined) {
                // past the end (or an empty queue): append
                this.sql.exec(`INSERT INTO queue_item (queue_order, feed_item_guid) VALUES (?, ?);`,
                    this._getNextOrder(), itemGuid)
                return
            }

            // SQLite checks the primary key row by row, so shifting by one in
            // place could collide with the next row: flip the shifted rows
            // negative first, then back.
            this.sql.exec(`UPDATE queue_item SET queue_order = -(queue_order + 1) WHERE queue_order >= ?;`, at)
            this.sql.exec(`UPDATE queue_item SET queue_order = -queue_order WHERE queue_order < 0;`)
            this.sql.exec(`INSERT INTO queue_item (queue_order, feed_item_guid) VALUES (?, ?);`, at, itemGuid)
        })
        return this.getItems()
    }

    removeItem(itemGuid: string): string[] {
        this.sql.exec(`DELETE FROM queue_item WHERE feed_item_guid = ?;`, itemGuid)
        return this.getItems()
    }
}
