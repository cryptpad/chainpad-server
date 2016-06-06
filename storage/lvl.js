var Level = require("level");
var nThen = require('nthen');

var getIndex = function(db, cName, cb) {
    db.get(cName+'=>index', function(e, out){
        if (e) {
            if (e.notFound) {
                cb(-1);
            } else {
                throw e;
            }
            return;
        }
        cb(parseInt(out));
    });
};

var insert = function (db, channelName, content, cb) {
    var index;
    var doIt = function () {
        db.locked = true;
        nThen(function (waitFor) {
            getIndex(db, channelName, waitFor(function (i) { index = i+1; }));
        }).nThen(function (waitFor) {
            db.put(channelName+'=>'+index, content, waitFor(function (e) { if (e) { throw e; } }));
        }).nThen(function (waitFor) {
            db.put(channelName+'=>index', ''+index, waitFor(function (e) { if (e) { throw e; } }));
        }).nThen(function (waitFor) {
            db.locked = false;
            if (!db.queue.length) { return; }
            db.queue.shift()();
        }).nThen(cb);
    };
    if (db.locked) {
        db.queue.push(doIt);
    } else {
        doIt();
    }
};

var getMessages = function (db, channelName, msgHandler, cb) {
    var index;
    nThen(function (waitFor) {
        getIndex(db, channelName, waitFor(function (i) {
            index = i;
        }));
    }).nThen(function (waitFor) {
        var again = function (i) {
            db.get(channelName + '=>' + i, waitFor(function (e, out) {
                if (e) { throw e; }
                msgHandler(out);
                if (i < index) { again(i+1); }
                else if (cb) { cb(); }
            }));
        };
        if (index > -1) { again(0); }
        else if (cb) { cb(); }
    });
};

module.exports.create = function (conf, cb) {
    var db = Level(conf.levelPath || './test.level.db');
    db.locked = false;
    db.queue = [];
    cb({
        message: function (channelName, content, cb) {
            insert(db, channelName, content, cb);
        },
        getMessages: function (channelName, msgHandler, cb) {
            getMessages(db, channelName, msgHandler, cb);
        }
    });
};
