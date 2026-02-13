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

    _compactItems() {
        const allGuids = this.getItems()
        this.clearQueue()

        allGuids.forEach(guid => this.enqueueItem(guid))
    }

    clearQueue(): string[] {
        this.sql.exec(`DELETE FROM queue_item WHERE true;`);
        return []
    }

    enqueueItem(itemGuid: string): string[] {
        if (!this._hasItem(itemGuid)) {
            const nextOrder = this._getNextOrder()
            this.sql.exec(`INSERT INTO queue_item (queue_order, feed_item_guid) VALUES (?, ?);`, nextOrder, itemGuid)
        }

        return this.getItems()
    }

    insertItem(itemGuid: string, index: number): string[] {
        this.removeItem(itemGuid, false)
        const allGuids = this.getItems()
        index = Math.max(0, Math.min(index, allGuids.length))
        allGuids.splice(index, 0, itemGuid)
        this.clearQueue()
        allGuids.forEach(guid => this.enqueueItem(guid))
        return this.getItems()
    }

    removeItem(itemGuid: string, compact: boolean = true): string[] {
        this.sql.exec(`DELETE FROM queue_item WHERE feed_item_guid = ?;`, itemGuid)

        compact && this._compactItems()
        return this.getItems()
    }
}
