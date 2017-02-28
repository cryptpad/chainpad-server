var Fs = require("fs");
var Path = require("path");
var nThen = require("nthen");

var mkPath = function (env, channelId) {
    return Path.join(env.root, channelId.slice(0, 2), channelId) + '.ndjson';
};

var readMessages = function (path, msgHandler, cb) {
    var remainder = '';
    var stream = Fs.createReadStream(path, 'utf8');
    var complete = function (err) {
        var _cb = cb;
        cb = undefined;
        if (_cb) { _cb(err); }
    };
    stream.on('data', function (chunk) {
        var lines = chunk.split('\n');
        lines[0] = remainder + lines[0];
        remainder = lines.pop();
        lines.forEach(msgHandler);
    });
    stream.on('end', function () {
        msgHandler(remainder);
        complete();
    });
    stream.on('error', function (e) { complete(e); });
};

var checkPath = function (path, callback) {
    Fs.stat(path, function (err, stats) {
        if (!err) {
            callback(undefined, true);
            return;
        }
        if (err.code !== 'ENOENT') {
            callback(err);
            return;
        }
        Fs.mkdir(Path.dirname(path), function (err) {
            if (err && err.code !== 'EEXIST') {
                callback(err);
                return;
            }
            callback(undefined, false);
        });
    });
};

var removeChannel = function (env, channelName, cb) {
    var filename = Path.join(env.root, channelName.slice(0, 2), channelName + '.ndjson');
    Fs.unlink(filename, cb);
};

var closeChannel = function (env, channelName, cb) {
    if (!env.channels[channelName]) { return; }
    try {
        env.channels[channelName].writeStream.close();
        delete env.channels[channelName];
        env.openFiles--;
        cb();
    } catch (err) {
        cb(err);
    }
};

var flushUnusedChannels = function (env, cb, frame) {
    var currentTime = +new Date();

    var expiration = typeof(frame) === 'undefined'?  env.channelExpirationMs: frame;
    Object.keys(env.channels).forEach(function (chanId) {
        var chan = env.channels[chanId];
        if (typeof(chan.atime) !== 'number') { return; }
        if (currentTime >= expiration + chan.atime) {
            closeChannel(env, chanId, function (err) {
                if (err) {
                    console.error(err);
                    return;
                }
                if (env.verbose) {
                    console.log("Closed channel [%s]", chanId);
                }
            });
        }
    });
    cb();
};

var getChannel = function (env, id, callback) {
    if (env.channels[id]) {
        var chan = env.channels[id];
        chan.atime = +new Date();
        if (chan.whenLoaded) {
            chan.whenLoaded.push(callback);
        } else {
            callback(undefined, chan);
        }
        return;
    }

    if (env.openFiles >= env.openFileLimit) {
        // if you're running out of open files, asynchronously clean up expired files
        // do it on a shorter timeframe, though (half of normal)
        setTimeout(function () {
            flushUnusedChannels(env, function () {
                if (env.verbose) {
                    console.log("Approaching open file descriptor limit. Cleaning up");
                }
            }, env.channelExpirationMs / 2);
        });
    }

    var channel = env.channels[id] = {
        atime: +new Date(),
        messages: [],
        writeStream: undefined,
        whenLoaded: [ callback ],
        onError: [ ]
    };
    var complete = function (err) {
        var whenLoaded = channel.whenLoaded;
        // no guarantee stream.on('error') will not cause this to be called multiple times
        if (!whenLoaded) { return; }
        channel.whenLoaded = undefined;
        if (err) {
            delete env.channels[id];
        }
        whenLoaded.forEach(function (wl) { wl(err, (err) ? undefined : channel); });
    };
    var path = mkPath(env, id);
    var fileExists;
    var errorState;
    nThen(function (waitFor) {
        checkPath(path, waitFor(function (err, exists) {
            if (err) {
                errorState = true;
                complete(err);
                return;
            }
            fileExists = exists;
        }));
    }).nThen(function (waitFor) {
        if (errorState) { return; }
        if (!fileExists) { return; }
        readMessages(path, function (msg) {
            channel.messages.push(msg);
        }, waitFor(function (err) {
            if (err) {
                errorState = true;
                complete(err);
            }
        }));
    }).nThen(function (waitFor) {
        if (errorState) { return; }
        var stream = channel.writeStream = Fs.createWriteStream(path, { flags: 'a' });
        env.openFiles++;
        stream.on('open', waitFor());
        stream.on('error', function (err) {
            env.openFiles--;
            // this might be called after this nThen block closes.
            if (channel.whenLoaded) {
                complete(err);
            } else {
                channel.onError.forEach(function (handler) {
                    handler(err);
                });
            }
        });
    }).nThen(function (waitFor) {
        if (errorState) { return; }
        complete();
    });
};

var message = function (env, chanName, msg, cb) {
    getChannel(env, chanName, function (err, chan) {
        if (err) {
            cb(err);
            return;
        }
        var complete = function (err) {
            var _cb = cb;
            cb = undefined;
            if (_cb) { _cb(err); }
        };
        chan.onError.push(complete);
        chan.writeStream.write(msg + '\n', function () {
            chan.onError.splice(chan.onError.indexOf(complete) - 1, 1);
            if (!cb) { return; }
            chan.messages.push(msg);
            chan.atime = +new Date();
            complete();
        });
    });
};

var getMessages = function (env, chanName, handler, cb) {
    getChannel(env, chanName, function (err, chan) {
        if (err) {
            cb(err);
            return;
        }
        try {
            chan.messages
                .forEach(function (message) {
                    if (!message) { return; }
                    handler(message);
                });
        } catch (err2) {
            console.error(err2);
            cb(err2);
            return;
        }
        chan.atime = +new Date();
        cb();
    });
};

module.exports.create = function (conf, cb) {
    var env = {
        root: conf.filePath || './datastore',
        channels: { },
        channelExpirationMs: conf.channelExpirationMs || 30000,
        verbose: conf.verbose,
        openFiles: 0,
        openFileLimit: conf.openFileLimit || 2048,
    };
    Fs.mkdir(env.root, function (err) {
        if (err && err.code !== 'EEXIST') {
            // TODO: somehow return a nice error
            throw err;
        }
        cb({
            message: function (channelName, content, cb) {
                message(env, channelName, content, cb);
            },
            getMessages: function (channelName, msgHandler, cb) {
                getMessages(env, channelName, msgHandler, cb);
            },
            removeChannel: function (channelName, cb) {
                removeChannel(env, channelName, function (err) {
                    cb(err);
                });
            },
            closeChannel: function (channelName, cb) {
                closeChannel(env, channelName, cb);
            },
            flushUnusedChannels: function (cb) {
                flushUnusedChannels(env, cb);
            },
        });
    });
    setInterval(function () {
        flushUnusedChannels(env, function () { });
    }, 5000);
};
