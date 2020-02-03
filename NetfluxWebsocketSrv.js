/* jshint esversion: 6 */
const Crypto = require('crypto');

const LAG_MAX_BEFORE_DISCONNECT = 30000;
const LAG_MAX_BEFORE_PING = 15000;

const now = function () { return (new Date()).getTime(); };

const socketSendable = function (socket) {
    return socket && socket.readyState === 1;
};

// Try to keep 4MB of data in queue, if there's more on the buffer, hold off.
const QUEUE_CHR = 1024 * 1024 * 4;

const sendMsg = function (ctx, user, msg, cb) {
    if (!user) { return; }
    if (!socketSendable(user.socket)) { return; }
    try {
        const strMsg = JSON.stringify(msg);
        user.inQueue += strMsg.length;
        if (cb) { user.sendMsgCallbacks.push(cb); }
        user.socket.send(strMsg, () => {
            user.inQueue -= strMsg.length;
            if (user.inQueue > QUEUE_CHR) { return; }
            const smcb = user.sendMsgCallbacks;
            user.sendMsgCallbacks = [];
            try {
                smcb.forEach((cb)=>{cb();});
            } catch (e) {
                ctx.emit.error(e, 'SEND_MESSAGE_FAIL');
            }
        });
    } catch (e) {
        ctx.emit.error(e, 'SEND_MESSAGE_FAIL_2');
        ctx.dropUser(user, 'SEND_MESSAGE_FAIL_2');
    }
};

const sendChannelMessage = function (ctx, channel, msgStruct) {
    // we always put a 0 at the beginning of the array for a channel message
    // the on-wire implementation isn't a part of the netflux spec
    // though it seems like it ought to be if we want interoperability between
    // different server and client implementations
    msgStruct.unshift(0); // TODO document this

    channel.forEach(function (user) {
        // We don't want to send back a message to its sender, in order to save bandwidth
        if (msgStruct[2] !== 'MSG' || user.id !== msgStruct[1]) {
            sendMsg(ctx, user, msgStruct);
        }
    });

    if (msgStruct[2] === 'MSG' && typeof(msgStruct[4]) === 'string') {
        ctx.emit.channelMessage(ctx.Server, channel, msgStruct);
    }
};

const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

const dropUser = function (ctx, user, reason) {
    if (user.socket.readyState !== WEBSOCKET_CLOSING
        && user.socket.readyState !== WEBSOCKET_CLOSED)
    {
        try {
            user.socket.close();
        } catch (e) {
            ctx.emit.error(e, 'FAIL_TO_DISCONNECT', { id: user.id, });
            try {
                user.socket.terminate();
            } catch (ee) {
                ctx.emit.error(ee, 'FAIL_TO_TERMINATE', { id: user.id, });
            }
        }
    }
    delete ctx.users[user.id];
    Object.keys(ctx.channels).forEach(function (chanName) {
        let chan = ctx.channels[chanName];
        if (!chan) { return; }
        let idx = chan.indexOf(user);
        if (idx < 0) { return; }

        chan.splice(idx, 1);
        if (chan.length === 0) {
            delete ctx.channels[chanName];
            ctx.emit.channelClose(chanName, 'REMOVE_EMPTY_CHANNEL');
        } else {
            sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chanName, 'Quit: [ dropUser() ]']);
        }
    });
    ctx.emit.sessionClose(user.id, reason);
};

const handleChannelLeave = function (ctx, channel) {
    try {
        if (channel.length === 0) {
            delete ctx.channels[channel.id];
            ctx.emit.channelClose(channel.id);
        }
    } catch (err) {
        ctx.emit.error(err, 'HANDLE_CHANNEL_LEAVE');
    }
};

const randName = function () { return Crypto.randomBytes(16).toString('hex'); };

const handleJoin = function (ctx, args) {
    let obj = args.obj;
    let user = args.user;
    let seq = args.seq;

    let chanName = obj || randName();
    let chan = ctx.channels[chanName] = ctx.channels[chanName] || [];

    if (chan.indexOf(user) !== -1) {
        // If the user is already in the channel, don't add it again.
        // Send an EJOINED, and send the userlist.
        // Don't broadcast the JOIN to the channel because other members
        // already know this user is in the channel.
        sendMsg(ctx, user, [seq, 'ERROR', 'EJOINED', chanName]);
        ctx.emit.channelOpen(ctx.Server, chanName, user.id);
        chan.forEach(function (u) {
            if (u === user) { return; }
            sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]);
        });
        return void sendMsg(ctx, user, [0, user.id, 'JOIN', chanName]);
    }

    sendMsg(ctx, user, [seq, 'JACK', chanName]);

    chan.id = chanName;
    ctx.emit.channelOpen(ctx.Server, chanName, user.id);
    chan.forEach(function (u) { sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]); });
    chan.push(user);
    sendChannelMessage(ctx, chan, [user.id, 'JOIN', chanName]);
};

const handleMsg = function (ctx, args) {
    let obj = args.obj;
    let seq = args.seq;
    let user = args.user;
    let json = args.json;

    if (typeof(ctx.registered[obj]) === 'function') {
        return void ctx.registered[obj](ctx.Server, seq, user, json);
    }

    if (obj && !ctx.channels[obj] && !ctx.users[obj]) {
        return void sendMsg(ctx, user, [seq, 'ERROR', 'ENOENT', obj]);
    }
    sendMsg(ctx, user, [seq, 'ACK']);
    let target;
    json.unshift(user.id);
    if ((target = ctx.channels[obj])) {
        return void sendChannelMessage(ctx, target, json);
    }
    if ((target = ctx.users[obj])) {
        json.unshift(0);
        return void sendMsg(ctx, target, json);
    }
};

const handleLeave = function (ctx, args) {
    let obj = args.obj;
    let user = args.user;
    let seq = args.seq;

    let err;
    let chan;
    let idx;
    if (!obj) {
        err = 'EINVAL';
        obj = 'undefined';
    } else if (!(chan = ctx.channels[obj])) {
        err = 'ENOENT';
    } else if ((idx = chan.indexOf(user)) === -1) {
        err = 'NOT_IN_CHAN';
    } else {
        sendMsg(ctx, user, [seq, 'ACK']);
        sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chan.id]);
        chan.splice(idx, 1);
        handleChannelLeave(ctx, chan);
        return;
    }
    sendMsg(ctx, user, [seq, 'ERROR', err, obj]);
};

const handlePing = function (ctx, args) {
    sendMsg(ctx, args.user, [args.seq, 'ACK']);
};

const commands = {
    JOIN: handleJoin,
    MSG: handleMsg,
    LEAVE: handleLeave,
    PING: handlePing,
};

const handleMessage = function (ctx, user, msg) {
    // this parse is safe because handleMessage
    // is only ever called in a try-catch
    let json = JSON.parse(msg);
    let seq = json.shift();
    let cmd = json[0];

    user.timeOfLastMessage = now();
    user.pingOutstanding = false;

    if (typeof(commands[cmd]) !== 'function') { return; }
    commands[cmd](ctx, {
        user: user,
        json: json,
        seq: seq,
        obj: json[1],
    });
};

const checkUserActivity = function (ctx) {
    var time = now();
    Object.keys(ctx.users).forEach(function (userId) {
        let u = ctx.users[userId];
        if (time - u.timeOfLastMessage > LAG_MAX_BEFORE_DISCONNECT) {
            ctx.dropUser(u, "INACTIVITY");
        }
        if (!u.pingOutstanding && time - u.timeOfLastMessage > LAG_MAX_BEFORE_PING) {
            sendMsg(ctx, u, [0, '', 'PING', now()]);
            u.pingOutstanding = true;
        }
    });
};

const dropEmptyChannels = function (ctx) {
    Object.keys(ctx.channels).forEach(function (chanName) {
        let chan = ctx.channels[chanName];
        if (!chan) { return; }
        if (chan.length === 0) {
            delete ctx.channels[chanName];
            ctx.emit.channelClose(chanName, 'REMOVE_EMPTY_CHANNEL_INTERVAL');
        }
    });
};

module.exports.create = function (socketServer) {
    const Server = {};
    const emit = {};
    const handlers = {};

    [
        'channelMessage', // (Server, channelName, msgStruct)
        'channelClose',   // (channelName, reason)
        'channelOpen',    // (Server, channelName, userId)
        'sessionClose',   // (userId, reason)
        'error',          // (err, label, info)
    ].forEach(function (key) {
        const stack = handlers[key] = [];
        emit[key] = function () {
            var l = stack.length;
            for (var i = 0; i < l; i++) {
                stack[i].apply(null, arguments);
            }
        };
    });

    Server.on = function (key, handler) {
        if (!Array.isArray(handlers[key])) {
            return void console.error(new Error("Unsupported event type"));
        }
        if (typeof(handler) !== 'function') {
            return void console.error(new Error("no function supplied"));
        }
        handlers[key].push(handler);
        return Server;
    };

    Server.off = function (key, handler) {
        if (!Array.isArray(handlers[key])) {
            return void console.error(new Error("Unsupported event type"));
        }
        if (typeof(handler) !== 'function') {
            return void console.error(new Error("no function supplied"));
        }
        var index = handlers[key].indexOf(handler);

        if (index < 0) { return; }
        handlers[key].splice(index, 1);
    };

    const registered = {};

    // register a special id to receive direct messages
    Server.register = function (id, f) { // (ctx, seq, user, json)
        registered[id] = f;
        return Server;
    };

    Server.unregister = function (id) {
        delete registered[id];
        return Server;
    };

    let ctx = {
        users: {},
        channels: {},
        timeouts: {},
        sendMsg: sendMsg,
        emit: emit,
        registered: registered,
        Server: Server,
    };

    Server.channelBroadcast = function (channel, msg, from) {
        const chan = ctx.channels[channel] || [];
        chan.forEach(function (user) {
            sendMsg(ctx, user, [0, from, 'MSG', user.id, JSON.stringify(msg)]);
        });
    };

    Server.send = function (userId, msg, cb) {
        sendMsg(ctx, ctx.users[userId], msg, cb);
    };

    Server.getSessionStats = function () {
        var users = Object.keys(ctx.users);
        var total = users.length;

        var ips = [];
        users.forEach(function (u) {
            var user = ctx.users[u];
            var socket = user.socket;
            var req = socket.upgradeReq;
            var conn = req && req.connection;
            var ip = (req && req.headers && req.headers['x-forwarded-for']) || (conn && conn.remoteAddress);
            if (ip && ips.indexOf(ip) === -1) {
                ips.push(ip);
            }
        });
        return {
            total: total,
            unique: ips.length
        };
    };

    Server.getActiveChannelCount = function () {
        return Object.keys(ctx.channels);
    };

    ctx.dropUser = function (user, reason) {
        dropUser(ctx, user, reason);
    };

    ctx.clearChannel = function (channel) {
        delete ctx.channels[channel];
    };

    ctx.userActivityInterval = setInterval(function () {
        checkUserActivity(ctx);
    }, 5000);
    ctx.channelActivityInterval = setInterval(function () {
        dropEmptyChannels(ctx);
    }, 60000);

    var createUniqueName = function () {
        var name = randName();
        if (typeof(ctx.users[name]) === 'undefined') { return name; }
        return createUniqueName();
    };

    socketServer.on('connection', function(socket, req) {
        if (!socket.upgradeReq) { socket.upgradeReq = req; }
        let conn = socket.upgradeReq.connection;
        let user = {
            addr: conn.remoteAddress + '|' + conn.remotePort,
            socket: socket,
            id: createUniqueName(),
            timeOfLastMessage: now(),
            pingOutstanding: false,
            inQueue: 0,
            sendMsgCallbacks: []
        };
        ctx.users[user.id] = user;
        sendMsg(ctx, user, [0, '', 'IDENT', user.id]);
        socket.on('message', function(message) {
            try {
                handleMessage(ctx, user, message);
            } catch (e) {
                emit.error(e, 'NETFLUX_BAD_MESSAGE', {
                    user: user.id,
                    message: message,
                });
                ctx.dropUser(user, 'BAD_MESSAGE');
            }
        });
        socket.on('close', function () {
            ctx.dropUser(user, 'SOCKET_CLOSED');
        });
        socket.on('error', function (err) {
            emit.error(err, 'NETFLUX_WEBSOCKET_ERROR');
            ctx.dropUser(user, 'SOCKET_ERROR');
        });
    });

    return Server;
};
