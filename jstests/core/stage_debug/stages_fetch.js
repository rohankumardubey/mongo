// Test basic fetch functionality.
//
// @tags: [
//   # The test runs commands that are not allowed with security token: stageDebug.
//   not_allowed_with_security_token,
//   does_not_support_stepdowns,
//   uses_testing_only_commands,
//   no_selinux,
// ]

let t = db.stages_fetch;
t.drop();
var collname = "stages_fetch";

var N = 50;
for (var i = 0; i < N; ++i) {
    t.insert({foo: i, bar: N - i, baz: i});
}

t.createIndex({foo: 1});

// 20 <= foo <= 30
// bar == 25 (not covered, should error.)
let ixscan1 = {
    ixscan: {
        args: {
            keyPattern: {foo: 1},
            startKey: {"": 20},
            endKey: {"": 30},
            startKeyInclusive: true,
            endKeyInclusive: true,
            direction: 1
        },
        filter: {bar: 25}
    }
};
let res = db.runCommand({stageDebug: {collection: collname, plan: ixscan1}});
assert.eq(res.ok, 0);

// Now, add a fetch.  We should be able to filter on the non-covered field since we fetched the obj.
let ixscan2 = {
    ixscan: {
        args: {
            keyPattern: {foo: 1},
            startKey: {"": 20},
            endKey: {"": 30},
            startKeyInclusive: true,
            endKeyInclusive: true,
            direction: 1
        }
    }
};
let fetch = {fetch: {args: {node: ixscan2}, filter: {bar: 25}}};
res = db.runCommand({stageDebug: {collection: collname, plan: fetch}});
printjson(res);
assert.eq(res.ok, 1);
assert.eq(res.results.length, 1);
