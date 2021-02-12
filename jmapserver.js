import { Database, iterate, promisify as _ } from './Database.js';

const types = {
    Email: {},
    Thread: {},
    Mailbox: {},
};

class JMAPServer {
    constructor(userId) {
        this.db = new Database({
            name: `JMAP-${userId}`,
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

    addRecords(typeName, records) {
        this.db.transaction(
            ['Meta', typeName],
            'readwrite',
            async (transaction) => {
                const metaStore = transaction.objectStore('Meta');
                const typeStore = transaction.objectStore(typeName);
                const meta = await _(metaStore.get(typeName));
                const existing = await Promise.all(
                    records.map((record) => _(typeStore.get(record.id))),
                );
                let modseq = meta.highestModSeq;
                records.forEach((record, i) => {
                    modseq += 1;
                    const prevValue = existing[i];
                    typeStore.put({
                        ...prevValue,
                        ...record,
                        _createdModSeq: prevValue
                            ? prevValue._createdModSeq
                            : modseq,
                        _updatedModSeq: modseq,
                        deleted: null,
                    });
                });
                metaStore.put({
                    ...meta,
                    highestModSeq: modseq,
                });
            },
        );
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
