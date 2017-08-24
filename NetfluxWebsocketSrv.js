;(function () { 'use strict';
const Crypto = require('crypto');
const Nacl = require('tweetnacl');

const LAG_MAX_BEFORE_DISCONNECT = 30000;
const LAG_MAX_BEFORE_PING = 15000;
const HISTORY_KEEPER_ID = Crypto.randomBytes(8).toString('hex');

const USE_HISTORY_KEEPER = true;
const USE_FILE_BACKUP_STORAGE = true;

let dropUser;
let historyKeeperKeys = {};

const now = function () { return (new Date()).getTime(); };

const socketSendable = function (socket) {
    return socket && socket.readyState === 1;
};

const isValidChannelId = function (id) {
    if (typeof(id) !== 'string') { return false; }
    if (id.length !== 32) { return false; }
    if (/[^a-fA-F0-9]/.test(id)) { return false; }
    return true;
};

const isBase64 = function (x) {
    return /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(x);
};

const isValidHash = function (hash) {
    if (typeof(hash) !== 'string') { return false; }
    if (hash.length !== 64) { return false; }
    return isBase64(hash);
};

const sendMsg = function (ctx, user, msg) {
    if (!socketSendable(user.socket)) { return; }
    try {
        if (ctx.config.logToStdout) { console.log('<' + JSON.stringify(msg)); }
        user.socket.send(JSON.stringify(msg));
    } catch (e) {
        console.log(e.stack);
        dropUser(ctx, user);
    }
};

const storeMessage = function (ctx, channel, msg) {
    ctx.store.message(channel.id, msg, function (err) {
        if (err && typeof(err) !== 'function') {
            // ignore functions because older datastores
            // might pass waitFors into the callback
            console.log("Error writing message: " + err);
        }
    });
};

const sendChannelMessage = function (ctx, channel, msgStruct) {
    msgStruct.unshift(0);
    channel.forEach(function (user) {
      if(msgStruct[2] !== 'MSG' || user.id !== msgStruct[1]) { // We don't want to send back a message to its sender, in order to save bandwidth
        sendMsg(ctx, user, msgStruct);
      }
    });
    if (USE_HISTORY_KEEPER && msgStruct[2] === 'MSG') {
        if (historyKeeperKeys[channel.id]) {
            let signedMsg = msgStruct[4].replace(/^cp\|/, '');
            signedMsg = Nacl.util.decodeBase64(signedMsg);
            let validateKey = Nacl.util.decodeBase64(historyKeeperKeys[channel.id]);
            let validated = Nacl.sign.open(signedMsg, validateKey);
            if (!validated) {
                console.log("Signed message rejected");
                return;
            }
        }
        storeMessage(ctx, channel, JSON.stringify(msgStruct));
    }
};

dropUser = function (ctx, user) {
    if (user.socket.readyState !== 2 /* WebSocket.CLOSING */
        && user.socket.readyState !== 3 /* WebSocket.CLOSED */)
    {
        try {
            user.socket.close();
        } catch (e) {
            console.log("Failed to disconnect ["+user.id+"], attempting to terminate");
            try {
                user.socket.terminate();
            } catch (ee) {
                console.log("Failed to terminate ["+user.id+"]  *shrug*");
            }
        }
    }
    delete ctx.users[user.id];
    Object.keys(ctx.channels).forEach(function (chanName) {
        let chan = ctx.channels[chanName];
        let idx = chan.indexOf(user);
        if (idx < 0) { return; }

        if (ctx.config.verbose) {
            console.log("Removing ["+user.id+"] from channel ["+chanName+"]");
        }
        chan.splice(idx, 1);
        if (chan.length === 0) {
            if (ctx.config.verbose) {
                console.log("Removing empty channel ["+chanName+"]");
            }
            delete ctx.channels[chanName];
            delete historyKeeperKeys[chanName];

            /*  Call removeChannel if it is a function and channel removal is
                set to true in the config file */
            if (ctx.config.removeChannels) {
                if (typeof(ctx.store.removeChannel) === 'function') {
                    ctx.timeouts[chanName] = setTimeout(function () {
                        ctx.store.removeChannel(chanName, function (err) {
                            if (err) { console.error("[removeChannelErr]: %s", err); }
                            else {
                                if (ctx.config.verbose) {
                                    console.log("Deleted channel [%s] history from database...", chanName);
                                }
                            }
                        });
                    }, ctx.config.channelRemovalTimeout);
                } else {
                    console.error("You have configured your server to remove empty channels, " +
                        "however, the database adaptor you are using has not implemented this behaviour.");
                }
            }
        } else {
            sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chanName, 'Quit: [ dropUser() ]']);
        }
    });
};

const getHash = function (msg) {
    return msg.slice(0,64);
};

/*  getHistory assumes that the channelName is valid
    (32 bytes of hexadecimal) */
const getHistory = function (ctx, channelName, lastKnownHash, handler, cb) {
    let messageBuf = [];
    ctx.store.getMessages(channelName, function (msgStr) {
        let parsed = JSON.parse(msgStr);
        if (parsed.validateKey) {
            historyKeeperKeys[channelName] = parsed.validateKey;
            handler(parsed);
            return;
        }
        messageBuf.push(parsed);
    }, function (err) {
        if (err) {
            console.log("Error getting messages " + err.stack);
            // TODO: handle this better
        }
        let startPoint;
        let cpCount = 0;
        let msgBuff2 = [];
        let sendBuff2 = function () {
            for (let x = msgBuff2.pop(); x; x = msgBuff2.pop()) { handler(x); }
        };
        let isSent = false;
        for (startPoint = messageBuf.length - 1; startPoint >= 0; startPoint--) {
            let msg = messageBuf[startPoint];
            msgBuff2.push(msg);
            if (lastKnownHash) {
                if (msg[2] === 'MSG' && getHash(msg[4]) === lastKnownHash) {
                    msgBuff2.pop();
                    sendBuff2();
                    isSent = true;
                    break;
                }
            } else if (msg[2] === 'MSG' && msg[4].indexOf('cp|') === 0 && lastKnownHash !== -1) {
                // lastKnownhash === -1 means we want the complete history
                cpCount++;
                if (cpCount >= 2) {
                    sendBuff2();
                    isSent = true;
                    break;
                }
            }
        }
        if (!isSent) {
            // no checkpoints.
            sendBuff2();
        }
        cb(messageBuf);
    });
};

const getOlderHistory = function (ctx, channelName, oldestKnownHash, cb) {
    var messageBuffer = [];
    var found = false;
    ctx.store.getMessages(channelName, function (msgStr) {
        if (found) { return; }

        let parsed = JSON.parse(msgStr);
        if (parsed.validateKey) {
            historyKeeperKeys[channelName] = parsed.validateKey;
            return;
        }

        var content = parsed[4];
        if (typeof(content) !== 'string') { return; }

        var hash = getHash(content);
        if (hash === oldestKnownHash) {
            found = true;
            return;
        }
        messageBuffer.push(parsed);
    }, function (err) {
        cb(messageBuffer);
    });
};

const randName = function () { return Crypto.randomBytes(16).toString('hex'); };

const handleMessage = function (ctx, user, msg) {
    let json = JSON.parse(msg);
    let seq = json.shift();
    let cmd = json[0];
    let obj = json[1];

    user.timeOfLastMessage = now();
    user.pingOutstanding = false;

    if (cmd === 'JOIN') {
        if (obj && obj.length !== 32) {
            sendMsg(ctx, user, [seq, 'ERROR', 'ENOENT', obj]);
            return;
        }
        let chanName = obj || randName();
        let chan = ctx.channels[chanName] = ctx.channels[chanName] || [];

        if (chan.indexOf(user) !== -1) {
            sendMsg(ctx, user, [seq, 'ERROR', 'EJOINED', chanName]);
            return;
        }

        sendMsg(ctx, user, [seq, 'JACK', chanName]);

        // prevent removal of the channel if there is a pending timeout
        if (ctx.config.removeChannels && ctx.timeouts[chanName]) {
            clearTimeout(ctx.timeouts[chanName]);
        }

        chan.id = chanName;
        if (USE_HISTORY_KEEPER) {
            sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'JOIN', chanName]);
        }
        chan.forEach(function (u) { sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]); });
        chan.push(user);
        sendChannelMessage(ctx, chan, [user.id, 'JOIN', chanName]);
        return;
    }

    var channelName;
    if (cmd === 'MSG') {
        if (obj === HISTORY_KEEPER_ID) {
            let parsed;
            try { parsed = JSON.parse(json[2]); } catch (err) { console.error(err); return; }
            if (parsed[0] === 'GET_HISTORY') {
                // parsed[1] is the channel id
                // parsed[2] is a validation key (optionnal)
                // parsed[3] is the last known hash (optionnal)
                sendMsg(ctx, user, [seq, 'ACK']);

                channelName = parsed[1];
                var validateKey = parsed[2];
                var lastKnownHash = parsed[3];
                var owners;
                if (parsed[2] && typeof parsed[2] === "object") {
                    validateKey = parsed[2].validateKey;
                    lastKnownHash = parsed[2].lastKnownHash;
                    owners = parsed[2].owners;
                }

                if (!isValidChannelId(channelName)) {
                    sendMsg(ctx, user, [seq, 'ERROR', 'ENOENT', obj]);
                    return;
                }

                getHistory(ctx, channelName, lastKnownHash, function (msg) {
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(msg)]);
                }, function (messages) {
                    if (messages.length === 0 && !historyKeeperKeys[channelName]) {
                        var key = {channel: channelName};
                        if (validateKey) {
                            key.validateKey = validateKey;
                            historyKeeperKeys[channelName] = validateKey;
                        }
                        if (owners) {
                            key.owners = owners;
                        }
                        storeMessage(ctx, ctx.channels[channelName], JSON.stringify(key));
                    }
                    let parsedMsg = {state: 1, channel: channelName};
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(parsedMsg)]);
                });
            } else if (parsed[0] === 'GET_HISTORY_RANGE') {
                channelName = parsed[1];
                var map = parsed[2];
                if (!(map && typeof(map) === 'object')) {
                    return void sendMsg(ctx, user, [seq, 'ERROR', 'INVALID_ARGS', obj]);
                }

                var oldestKnownHash = map.from;
                var desiredMessages = map.count;
                var txid = map.txid;
                if (typeof(desiredMessages) !== 'number') {
                    return void sendMsg(ctx, user, [seq, 'ERROR', 'UNSPECIFIED_COUNT', obj]);
                }
                if (!isValidHash(oldestKnownHash)) {
                    return void sendMsg(ctx, user, [seq, 'ERROR', 'INVALID_HASH', obj]);
                }

                if (!txid) {
                    return void sendMsg(ctx, user, [seq, 'ERROR', 'NO_TXID', obj]);
                }

                sendMsg(ctx, user, [seq, 'ACK']);
                return void getOlderHistory(ctx, channelName, oldestKnownHash, function (messages) {
                    var toSend = messages.slice(-desiredMessages);
                    toSend.forEach(function (msg) {
                        sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id,
                            JSON.stringify(['HISTORY_RANGE', txid, msg])]);
                    });

                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id,
                        JSON.stringify(['HISTORY_RANGE_END', txid, channelName])
                    ]);
                });
            } else if (parsed[0] === 'GET_FULL_HISTORY') {
                // parsed[1] is the channel id
                // parsed[2] is a validation key (optionnal)
                // parsed[3] is the last known hash (optionnal)
                sendMsg(ctx, user, [seq, 'ACK']);
                getHistory(ctx, parsed[1], -1, function (msg) {
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(['FULL_HISTORY', msg])]);
                }, function (messages) {
                    let parsedMsg = ['FULL_HISTORY_END', parsed[1]];
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(parsedMsg)]);
                });
            } else if (ctx.rpc) {
                /* RPC Calls...  */
                var rpc_call = parsed.slice(1);

                sendMsg(ctx, user, [seq, 'ACK']);
                try {
                // slice off the sequence number and pass in the rest of the message
                ctx.rpc(ctx, rpc_call, function (err, output) {
                    if (err) {
                        sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify([parsed[0], 'ERROR', err])]);
                        return;
                    }
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify([parsed[0]].concat(output))]);
                });
                } catch (e) {
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify([parsed[0], 'ERROR', 'SERVER_ERROR'])]);
                }
            }
            return;
        }
        if (obj && !ctx.channels[obj] && !ctx.users[obj]) {
            sendMsg(ctx, user, [seq, 'ERROR', 'ENOENT', obj]);
            return;
        }
        sendMsg(ctx, user, [seq, 'ACK']);
        let target;
        json.unshift(user.id);
        if ((target = ctx.channels[obj])) {
            sendChannelMessage(ctx, target, json);
            return;
        }
        if ((target = ctx.users[obj])) {
            json.unshift(0);
            sendMsg(ctx, target, json);
            return;
        }
    }
    if (cmd === 'LEAVE') {
        let err;
        let chan;
        let idx;
        if (!obj) { err = 'EINVAL'; obj = 'undefined';}
        if (!err && !(chan = ctx.channels[obj])) { err = 'ENOENT'; }
        if (!err && (idx = chan.indexOf(user)) === -1) { err = 'NOT_IN_CHAN'; }
        if (err) {
            sendMsg(ctx, user, [seq, 'ERROR', err, obj]);
            return;
        }
        sendMsg(ctx, user, [seq, 'ACK']);
        json.unshift(user.id);
        sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chan.id]);
        chan.splice(idx, 1);
    }
    if (cmd === 'PING') {
        sendMsg(ctx, user, [seq, 'ACK']);
        return;
    }
};

let run = module.exports.run = function (storage, socketServer, config, rpc) {
    /*  Channel removal timeout defaults to 60000ms (one minute) */
    config.channelRemovalTimeout =
        typeof(config.channelRemovalTimeout) === 'number'?
            config.channelRemovalTimeout:
            60000;

    let ctx = {
        users: {},
        channels: {},
        timeouts: {},
        store: storage,
        config: config,
        rpc: rpc,
    };
    setInterval(function () {
        Object.keys(ctx.users).forEach(function (userId) {
            let u = ctx.users[userId];
            if (now() - u.timeOfLastMessage > LAG_MAX_BEFORE_DISCONNECT) {
                dropUser(ctx, u);
            } else if (!u.pingOutstanding && now() - u.timeOfLastMessage > LAG_MAX_BEFORE_PING) {
                sendMsg(ctx, u, [0, '', 'PING', now()]);
                u.pingOutstanding = true;
            }
        });
    }, 5000);
    socketServer.on('connection', function(socket) {
        if(socket.upgradeReq.url !== (config.websocketPath || '/cryptpad_websocket')) { return; }
        let conn = socket.upgradeReq.connection;
        let user = {
            addr: conn.remoteAddress + '|' + conn.remotePort,
            socket: socket,
            id: randName(),
            timeOfLastMessage: now(),
            pingOutstanding: false
        };
        ctx.users[user.id] = user;
        sendMsg(ctx, user, [0, '', 'IDENT', user.id]);
        socket.on('message', function(message) {
            if (ctx.config.logToStdout) { console.log('>'+message); }
            try {
                handleMessage(ctx, user, message);
            } catch (e) {
                console.log(e.stack);
                dropUser(ctx, user);
            }
        });
        var drop = function (evt) {
            for (let userId in ctx.users) {
                if (ctx.users[userId].socket === socket) {
                    dropUser(ctx, ctx.users[userId]);
                }
            }
        };
        socket.on('close', drop);
        socket.on('error', function (err) {
            console.error('WebSocket Error: ' + err.message);
            drop();
        });
    });
};
}());
