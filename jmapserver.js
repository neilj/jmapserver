import { Database, iterate, promisify as _ } from './Database.js';

const types = {
    Email: {},
    Thread: {
        // ontxn: async (objects, transaction)  => ())}
    },
    Mailbox: {},
};

class JMAPServer {
    constructor(accountId) {
        this.accountId = accountId;
        this.db = new Database({
            name: `JMAP-${accountId}`,
            version: 1,
            setup(db /*, newVersion, oldVersion*/) {
                const metaStore = db.createObjectStore('Meta', {
                    keyPath: 'typeName',
                });
                for (const typeName in types) {
                    const store = db.createObjectStore(typeName, {
                        keyPath: 'id',
                    });
                    store.createIndex('byModSeq', '_updatedModSeq');
                    metaStore.put({
                        typeName,
                        highestModSeq: 0,
                        lowestModSeq: 0,
                    });
                }
            },
        });
    }

    addRecords(/** @type string */ typeName, /** @type any[] */ records) {
        this.db.transaction(['Meta', typeName], 'readwrite', async (
            /** @type IDBTransaction */ transaction,
        ) => {
            const metaStore = transaction.objectStore('Meta');
            const typeStore = transaction.objectStore(typeName);
            const meta = await _(metaStore.get(typeName));
            const existing = await Promise.all(
                records.map((record) => _(typeStore.get(record.id))),
            );
            let modseq = meta.highestModSeq;
            records.forEach((record, i) => {
                if (!record.id) {
                    throw new Error('Must have an id!');
                }
                modseq += 1;
                const prevValue = existing[i];
                typeStore.put({
                    ...prevValue,
                    ...record,
                    _createdModSeq: prevValue
                        ? prevValue._createdModSeq
                        : modseq,
                    _updatedModSeq: modseq,
                    _deleted: null,
                });
            });
            metaStore.put({
                ...meta,
                highestModSeq: modseq,
            });
        });
    }

    async changes(typeName, args) {
        const sinceState = args.sinceState;
        let maxChanges = args.maxChanges || 0;
        if (!(maxChanges > 0 && maxChanges <= 1024)) {
            maxChanges = 1024;
        }
        if (typeof sinceState !== 'string') {
            // error
            return;
        }
        const sinceModSeq = parseInt(sinceState, 10);
        if (isNaN(sinceModSeq)) {
            // error
            return;
        }
        // Do stuff
        let upToModSeq = sinceModSeq;
        let hasMoreChanges = false;
        const created = [];
        const updated = [];
        const destroyed = [];
        await this.db.transaction(['Meta', typeName], 'readonly', async (
            /** @type IDBTransaction */ transaction,
        ) => {
            const metaStore = transaction.objectStore('Meta');
            const typeStore = transaction.objectStore(typeName);
            const meta = await _(metaStore.get(typeName));
            if (meta.highestModSeq === sinceModSeq) {
                return;
            }
            const cursor = typeStore
                .index('byModSeq')
                .openCursor(IDBKeyRange.lowerBound(sinceModSeq, true), 'next');
            let count = 0;
            for await (const result of iterate(cursor)) {
                if (count === maxChanges) {
                    hasMoreChanges = true;
                    break;
                }
                const record = result.value;
                const id = record.id;
                const isCreated = record._createdModSeq > sinceModSeq;
                if (record._deleted) {
                    if (!isCreated) destroyed.push(id);
                } else if (isCreated) {
                    created.push(id);
                } else {
                    updated.push(id);
                }
                upToModSeq = record._updatedModSeq;
                count += 1;
            }
            if (!hasMoreChanges) {
                upToModSeq = meta.highestModSeq;
            }
        });
        return {
            accountId: this.accountId,
            oldState: sinceState,
            newState: upToModSeq + '',
            hasMoreChanges,
            created,
            updated,
            destroyed,
        };
    }
}

// ---

const process = (request, session) => {
    return new Promise((resolve, reject) => {
        if (!request) {
            reject({
                type: 'urn:ietf:params:jmap:error:notJSON',
                status: 400,
            });
            return;
        }
        const methodCalls = request.methodCalls;
        if (!methodCalls || !Array.isArray(methodCalls)) {
            reject({
                type: 'urn:ietf:params:jmap:error:notRequest',
                status: 400,
            });
        }
        const createdIds = request.createdIds || {};
    });
};

// ---

const server = new JMAPServer('foo');
server.addRecords('Email', [
    {
        id: '123',
        subject: 'This is the subject',
    },
]);

window.server = server;
