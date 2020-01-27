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
    if (!socketSendable(user.socket)) { return; }
    let log = ctx.log;
    try {
        const strMsg = JSON.stringify(msg);
        log.silly('RAW_NETFLUX', strMsg);
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
                log.error("SEND_MESSAGE_FAIL", e);
            }
        });
    } catch (e) {
        log.error("SEND_MESSAGE_FAIL_2", e.stack);
        ctx.dropUser(user);
    }
};

const sendChannelMessage = function (ctx, channel, msgStruct) {
    msgStruct.unshift(0);
    channel.forEach(function (user) {
        // We don't want to send back a message to its sender, in order to save bandwidth
        if (msgStruct[2] !== 'MSG' || user.id !== msgStruct[1]) {
            sendMsg(ctx, user, msgStruct);
        }
    });
    if (ctx.historyKeeper && msgStruct[2] === 'MSG' && typeof(msgStruct[4]) === 'string') {
        ctx.historyKeeper.onChannelMessage(ctx, channel, msgStruct);
    }
};

const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

const dropUser = function (ctx, user) {
    var log = ctx.log;
    if (user.socket.readyState !== WEBSOCKET_CLOSING
        && user.socket.readyState !== WEBSOCKET_CLOSED)
    {
        try {
            user.socket.close();
        } catch (e) {
            log.error('FAIL_TO_DISCONNECT', user.id);
            try {
                user.socket.terminate();
            } catch (ee) {
                log.error('FAIL_TO_TERMINATE', user.id);
            }
        }
    }
    delete ctx.users[user.id];
    Object.keys(ctx.channels).forEach(function (chanName) {
        let chan = ctx.channels[chanName];
        if (!chan) { return; }
        let idx = chan.indexOf(user);
        if (idx < 0) { return; }

        log.verbose("REMOVE_FROM_CHANNEL", {
            user: user.id,
            channel: chanName,
        });
        chan.splice(idx, 1);
        if (chan.length === 0) {
            log.verbose('REMOVE_EMPTY_CHANNEL', chanName);
            delete ctx.channels[chanName];
            if (ctx.historyKeeper) {
                ctx.historyKeeper.dropChannel(chanName);
            }
        } else {
            sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chanName, 'Quit: [ dropUser() ]']);
        }
    });
};

const handleChannelLeave = function (ctx, channel) {
    var log = ctx.log;
    try {
        if (channel.length === 0) {
            delete ctx.channels[channel.id];
            ctx.historyKeeper.dropChannel(channel.id);
        }
    } catch (err) {
        log.error(err);
    }
};

const randName = function () { return Crypto.randomBytes(16).toString('hex'); };

const handleJoin = function (ctx, args) {
    let obj = args.obj;
    let user = args.user;
    let seq = args.seq;

    let chanName = obj || randName();
    let chan = ctx.channels[chanName] = ctx.channels[chanName] || (([] /*:any*/) /*:Chan_t*/);

    if (chan.indexOf(user) !== -1) {
        // If the user is already in the channel, don't add it again.
        // Send an EJOINED, and send the userlist.
        // Don't broadcast the JOIN to the channel because other members
        // already know this user is in the channel.
        sendMsg(ctx, user, [seq, 'ERROR', 'EJOINED', chanName]);

        if (ctx.historyKeeper) {
            // XXX magic historyKeeper-specific behaviour
            // historyKeeper needs to be in every channel already when a user joins
            // there are probably better ways to do this
            sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'JOIN', chanName]);
        }

        chan.forEach(function (u) {
            if (u === user) { return; }
            sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]);
        });
        return void sendMsg(ctx, user, [0, user.id, 'JOIN', chanName]);
    }

    sendMsg(ctx, user, [seq, 'JACK', chanName]);

    chan.id = chanName;
    if (ctx.historyKeeper) {
        sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'JOIN', chanName]);
    }
    chan.forEach(function (u) { sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]); });
    chan.push(user);
    sendChannelMessage(ctx, chan, [user.id, 'JOIN', chanName]);
};

const handleMsg = function (ctx, args) {
    let obj = args.obj;
    let seq = args.seq;
    let user = args.user;
    let json = args.json;

    if (ctx.historyKeeper) {
        // XXX it seems like we can just let historyKeeper handle this
        // in sendChannelMessage
        // it's not a big deal if somebody receives a message for an expired channel
        // before historyKeeper has a chance to kick everyone
        // the main thing is that new messages aren't stored
        ctx.historyKeeper.checkExpired(ctx, obj);
        if (obj === ctx.historyKeeper.id) {
            return void ctx.historyKeeper.onDirectMessage(ctx, seq, user, json);
        }
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
            ctx.dropUser(u);
        }
        if (!u.pingOutstanding && time - u.timeOfLastMessage > LAG_MAX_BEFORE_PING) {
            sendMsg(ctx, u, [0, '', 'PING', now()]);
            u.pingOutstanding = true;
        }
    });
};

const dropEmptyChannels = function (ctx) {
    var log = ctx.log;
    Object.keys(ctx.channels).forEach(function (chanName) {
        let chan = ctx.channels[chanName];
        if (!chan) { return; }
        if (chan.length === 0) {
            log.debug('REMOVE_EMPTY_CHANNEL_INTERVAL', chanName);
            delete ctx.channels[chanName];
            if (ctx.historyKeeper) {
                ctx.historyKeeper.dropChannel(chanName);
            }
        }
    });
};

module.exports.run = function (socketServer, config, historyKeeper) {
    var log = config.log;

    let ctx = {
        users: {},
        channels: {},
        timeouts: {},
        config: config,
        historyKeeper: historyKeeper,
        log: config.log,
    };

    ctx.dropUser = function (user) {
        dropUser(ctx, user);
    };

    ctx.userActivityInterval = setInterval(function () {
        checkUserActivity(ctx);
    }, 5000);
    ctx.channelActivityInterval = setInterval(function () {
        dropEmptyChannels(ctx);
    }, 60000);
    socketServer.on('connection', function(socket, req) {
        if (!socket.upgradeReq) { socket.upgradeReq = req; }
        let conn = socket.upgradeReq.connection;
        let user = {
            addr: conn.remoteAddress + '|' + conn.remotePort,
            socket: socket,
            id: randName(),
            timeOfLastMessage: now(),
            pingOutstanding: false,
            inQueue: 0,
            sendMsgCallbacks: []
        };
        ctx.users[user.id] = user;
        sendMsg(ctx, user, [0, '', 'IDENT', user.id]);
        socket.on('message', function(message) {
            log.silly('NETFLUX_ON_MESSAGE', message);
            try {
                handleMessage(ctx, user, message);
            } catch (e) {
                log.error('NETFLUX_BAD_MESSAGE', e.stack);
                ctx.dropUser(user);
            }
        });
        var drop = function () {
            for (let userId in ctx.users) {
                if (ctx.users[userId].socket === socket) {
                    ctx.dropUser(ctx.users[userId]);
                }
            }
        };
        socket.on('close', drop);
        socket.on('error', function (err) {
            log.error('NETFLUX_WEBSOCKET_ERROR', {
                message: err.message,
                stack: err.stack,
            });
            drop();
        });
    });
};
