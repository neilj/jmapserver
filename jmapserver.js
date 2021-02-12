import { Database, iterate, promisify as _ } from './Database.js';

class JMAPServer {
    constructor(options) {
        this.accountId = options.accountId;
        this.types = options.types;
        this.db = new Database({
            name: `JMAP-${options.accountId}`,
            version: 1,
            setup(db /*, newVersion, oldVersion*/) {
                const metaStore = db.createObjectStore('Meta', {
                    keyPath: 'typeName',
                });
                for (const typeName in options.types) {
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

    // ---

    async process(request, session) {
        if (!request) {
            reject({
                type: 'urn:ietf:params:jmap:error:notJSON',
                status: 400,
            });
            return;
        }
        const methodCalls = request.methodCalls;
        const isInvocation = (item) =>
            Array.isArray(item) &&
            typeof item[0] === 'string' &&
            item[1] &&
            typeof item[1] === 'object';
        if (
            !methodCalls ||
            !Array.isArray(methodCalls) ||
            !methodCalls.every(isInvocation)
        ) {
            reject({
                type: 'urn:ietf:params:jmap:error:notRequest',
                status: 400,
            });
        }
        const createdIds = request.createdIds || {};
        const types = this.types;
        const output = [];
        for (const [name, args, callId] of methodCalls) {
            const [typeName, method] = name.split('/');
            const config = types[typeName];
            if (!config || !config[method]) {
                output.push([
                    'error',
                    {
                        type: 'unknownMethod',
                    },
                    callId,
                ]);
                continue;
            }
            const [ok, result] = await this[method](typeName, args, output);
            output.push([ok ? name : 'error', result, callId]);
        }
        return output;
    }

    // ---

    async changes(typeName, args) {
        const sinceState = args.sinceState;
        let maxChanges = args.maxChanges || 0;
        if (!(maxChanges > 0 && maxChanges <= 1024)) {
            maxChanges = 1024;
        }
        if (typeof sinceState !== 'string') {
            return [
                false,
                {
                    type: 'invalidArguments',
                },
            ];
        }
        const sinceModSeq = parseInt(sinceState, 10);
        if (isNaN(sinceModSeq)) {
            return [
                false,
                {
                    type: 'cannotCalculateChanges',
                },
            ];
        }
        // Do stuff
        let upToModSeq = sinceModSeq;
        let hasMoreChanges = false;
        const created = [];
        const updated = [];
        const destroyed = [];
        return await this.db.transaction(
            ['Meta', typeName],
            'readonly',
            async (transaction) => {
                const metaStore = transaction.objectStore('Meta');
                const typeStore = transaction.objectStore(typeName);
                const meta = await _(metaStore.get(typeName));
                if (meta.lowestModSeq > sinceModSeq) {
                    return [
                        false,
                        {
                            type: 'cannotCalculateChanges',
                        },
                    ];
                }
                if (meta.highestModSeq !== sinceModSeq) {
                    const cursor = typeStore
                        .index('byModSeq')
                        .openCursor(
                            IDBKeyRange.lowerBound(sinceModSeq, true),
                            'next',
                        );
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
                }
                return [
                    true,
                    {
                        accountId: this.accountId,
                        oldState: sinceState,
                        newState: upToModSeq + '',
                        hasMoreChanges,
                        created,
                        updated,
                        destroyed,
                    },
                ];
            },
        );
    }

    async get(typeName, args) {
        const { ids, properties, accountId } = args;
        if (ids != null && ids.length > this.maxObjectsInGet) {
            return [
                false,
                {
                    type: 'requestTooLarge',
                },
            ];
        }
        return await this.db.transaction(
            ['Meta', typeName],
            'readonly',
            async (transaction) => {
                const metaStore = transaction.objectStore('Meta');
                const typeStore = transaction.objectStore(typeName);
                const meta = await _(metaStore.get(typeName));
                const modseq = meta.highestModSeq;
                let found = [];
                const notFound = [];
                if (ids == null) {
                    // Get all documents in collection
                    const numRecords = await _(typeStore.count());
                    if (numRecords > this.maxObjectsInGet) {
                        return [
                            false,
                            {
                                type: 'requestTooLarge',
                            },
                        ];
                    }
                    found = await _(typeStore.getAll(null));
                } else {
                    await Promise.all(
                        ids.map(async (id) => {
                            const val = await _(typeStore.get(id));
                            if (val == null) notFound.push(id);
                            else {
                                // TODO: Remove _xxx fields.
                                if (properties == null) found.push(val);
                                else {
                                    const result = { id: val.id };
                                    for (const prop of properties) {
                                        const propVal = val[prop];
                                        if (propVal != null)
                                            result[prop] = propVal;
                                    }
                                    found.push(result);
                                }
                            }
                        }),
                    );
                }

                return [
                    true,
                    {
                        accountId,
                        state: '' + modseq,
                        list: found,
                        notFound,
                    },
                ];
            },
        );
    }
}

// ---

(async () => {
    const server = new JMAPServer({
        accountId: 'foo',
        methods: {
            'Email/get': (server, args) => server.get('Email', args),
            'Email/changes': (server, args) => server.changes('Email', args),
            'Thread/get'(server, args) {},
        },
        stores: {
            Email: {
                indexes: {
                    byThreadId: 'threadId',
                },
            },
            Mailbox: {},
        },
        maxObjectsInGet: 1000,
    });
    window.server = server;

    server.addRecords('Email', [
        {
            id: '123',
            subject: 'This is the subject',
        },
    ]);

    console.log(
        await server.process({
            methodCalls: [
                ['Email/get', {}, '1'],
                [
                    'Email/changes',
                    {
                        sinceState: '0',
                    },
                    'a',
                ],
                [
                    'Email/changes',
                    {
                        sinceState: 'adsfadsf',
                    },
                    'a',
                ],
                ['Email/get', { ids: ['123'] }, '2'],
                [
                    'Email/get',
                    {
                        ids: ['123', '321'],
                        properties: ['subject'],
                    },
                    '3',
                ],
            ],
        }),
    );
})();
