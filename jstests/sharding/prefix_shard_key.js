// Test that you can shard with shard key that's only a prefix of an existing index.
//
// Part 1: Shard new collection on {num : 1} with an index on {num : 1, x : 1}.
//         Test that you can split and move chunks around.
// Part 2: Test that adding an array value for x doesn't make it unusuable.
// Part 3: Shard new collection on {skey : 1} but with a longer index.
//         Insert docs with same val for 'skey' but different vals for 'extra'.
//         Move chunks around and check that [min,max) chunk boundaries are properly obeyed.
import {findChunksUtil} from "jstests/sharding/libs/find_chunks_util.js";

// Shard key index does not exactly match shard key, so it is not compatible with $min/$max.
TestData.skipCheckOrphans = true;

var checkDocCounts = function(expectedShardCount) {
    for (var shardName in expectedShardCount) {
        var shard = (shardName == s.shard0.shardName ? s.shard0 : s.shard1);
        assert.eq(expectedShardCount[shardName], shard.getDB('test').user.find().count());
    }
};

var s = new ShardingTest({shards: 2});

var db = s.getDB("test");
var admin = s.getDB("admin");
var config = s.getDB("config");

assert.commandWorked(s.s0.adminCommand({enablesharding: "test"}));
s.ensurePrimaryShard('test', s.shard1.shardName);

//******************Part 1********************

var coll = db.foo;

var longStr = 'a';
while (longStr.length < 1024 * 128) {
    longStr += longStr;
}
var bulk = coll.initializeUnorderedBulkOp();
for (i = 0; i < 100; i++) {
    bulk.insert({num: i, str: longStr});
    bulk.insert({num: i + 100, x: i, str: longStr});
}
assert.commandWorked(bulk.execute());

// no usable index yet, should throw
assert.throws(function() {
    s.adminCommand({shardCollection: coll.getFullName(), key: {num: 1}});
});

// create usable index
assert.commandWorked(coll.createIndex({num: 1, x: 1}));

// usable index, doc with empty 'num' value
assert.commandWorked(coll.insert({x: -5}));
assert.commandWorked(s.s0.adminCommand({shardCollection: coll.getFullName(), key: {num: 1}}));

// make sure extra index is not created
assert.eq(2, coll.getIndexes().length);

// make sure balancing happens
s.startBalancer();
s.awaitBalance(coll.getName(), db.getName());

// Make sure our initial balance cleanup doesn't interfere with later migrations.
assert.soon(function() {
    print("Waiting for migration cleanup to occur...");
    return coll.count() == coll.find().itcount();
});

s.stopBalancer();

// test splitting
assert.commandWorked(s.s0.adminCommand({split: coll.getFullName(), middle: {num: 50}}));

// test moving
assert.commandWorked(s.s0.adminCommand({
    movechunk: coll.getFullName(),
    find: {num: 20},
    to: s.getOther(s.getPrimaryShard("test")).name,
    _waitForDelete: true
}));

//******************Part 2********************

// Migrations and splits will still work on a sharded collection that only has multi key
// index.
db.user.createIndex({num: 1, x: 1});
db.adminCommand({shardCollection: 'test.user', key: {num: 1}});

var indexCount = db.user.getIndexes().length;
assert.eq(2,
          indexCount,  // indexes for _id_ and num_1_x_1
          'index count not expected: ' + tojson(db.user.getIndexes()));

var array = [];
for (var item = 0; item < 50; item++) {
    array.push(item);
}

for (var docs = 0; docs < 1000; docs++) {
    db.user.insert({num: docs, x: array});
}

assert.eq(1000, db.user.find().itcount());

assert.commandWorked(admin.runCommand({
    movechunk: 'test.user',
    find: {num: 70},
    to: s.getOther(s.getPrimaryShard("test")).name,
    _waitForDelete: true
}));

var expectedShardCount = {};
findChunksUtil.findChunksByNs(config, 'test.user').forEach(function(chunkDoc) {
    var min = chunkDoc.min.num;
    var max = chunkDoc.max.num;

    if (min < 0 || min == MinKey) {
        min = 0;
    }

    if (max > 1000 || max == MaxKey) {
        max = 1000;
    }

    if (!(chunkDoc.shard in expectedShardCount)) {
        expectedShardCount[chunkDoc.shard] = 0;
    }

    if (max > 0) {
        expectedShardCount[chunkDoc.shard] += (max - min);
    }
});

checkDocCounts(expectedShardCount);
assert.commandWorked(admin.runCommand({split: 'test.user', middle: {num: 70}}));
checkDocCounts(expectedShardCount);

//******************Part 3********************

// Check chunk boundaries obeyed when using prefix shard key.
// This test repeats with shard key as the prefix of different longer indices.

for (i = 0; i < 3; i++) {
    // setup new collection on shard0
    var coll2 = db.foo2;
    coll2.drop();
    if (s.getPrimaryShardIdForDatabase(coll2.getDB()) != s.shard0.shardName) {
        var moveRes = admin.runCommand({movePrimary: coll2.getDB() + "", to: s.shard0.shardName});
        assert.eq(moveRes.ok, 1, "primary not moved correctly");
    }

    // declare a longer index
    if (i == 0) {
        assert.commandWorked(coll2.createIndex({skey: 1, extra: 1}));
    } else if (i == 1) {
        assert.commandWorked(coll2.createIndex({skey: 1, extra: -1}));
    } else if (i == 2) {
        assert.commandWorked(coll2.createIndex({skey: 1, extra: 1, superfluous: -1}));
    }

    // then shard collection on prefix
    var shardRes = admin.runCommand({shardCollection: coll2 + "", key: {skey: 1}});
    assert.eq(shardRes.ok, 1, "collection not sharded");

    // insert docs with same value for skey
    bulk = coll2.initializeUnorderedBulkOp();
    for (var i = 0; i < 5; i++) {
        for (var j = 0; j < 5; j++) {
            bulk.insert({skey: 0, extra: i, superfluous: j});
        }
    }
    assert.commandWorked(bulk.execute());

    // split on that key, and check it makes 2 chunks
    var splitRes = admin.runCommand({split: coll2 + "", middle: {skey: 0}});
    assert.eq(splitRes.ok, 1, "split didn't work");
    assert.eq(findChunksUtil.findChunksByNs(config, coll2.getFullName()).count(), 2);

    // movechunk should move ALL docs since they have same value for skey
    moveRes = admin.runCommand(
        {moveChunk: coll2 + "", find: {skey: 0}, to: s.shard1.shardName, _waitForDelete: true});
    assert.eq(moveRes.ok, 1, "movechunk didn't work");

    // Make sure our migration eventually goes through before testing individual shards
    assert.soon(function() {
        print("Waiting for migration cleanup to occur...");
        return coll2.count() == coll2.find().itcount();
    });

    // check no orphaned docs on the shards
    assert.eq(0, s.shard0.getCollection(coll2 + "").find().itcount());
    assert.eq(25, s.shard1.getCollection(coll2 + "").find().itcount());

    // and check total
    assert.eq(25, coll2.find().itcount(), "bad total number of docs after move");

    s.printShardingStatus();
}

s.stop();