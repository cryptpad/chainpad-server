/*@flow*/
/* jshint esversion: 6 */
/* global Buffer, process */
/*::
import type { ChainPadServer_Storage_t } from './storage/file.js';
const flow_WebSocketServer = require('ws').Server;
type WebSocketServer_t = typeof(flow_WebSocketServer);
const flow_Config = require('./config.example.js');
type Config_t = typeof(flow_Config);
type Rpc_t = (any, rpcCall:string, (err:?Error, output:Array<string>)=>void)=>void;
*/
;(function () { 'use strict';
const Crypto = require('crypto');
const Nacl = require('tweetnacl');
const nThen = require('nthen');

const LAG_MAX_BEFORE_DISCONNECT = 30000;
const LAG_MAX_BEFORE_PING = 15000;
const HISTORY_KEEPER_ID = Crypto.randomBytes(8).toString('hex');

const USE_HISTORY_KEEPER = true;

let dropUser;
let historyKeeperKeys = {};

const now = function () { return (new Date()).getTime(); };

const socketSendable = function (socket) {
    return socket && socket.connected;
};

const isBase64 = function (x) {
    return /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(x);
};

const isValidHash = function (hash) {
    if (typeof(hash) !== 'string') { return false; }
    if (hash.length !== 64) { return false; }
    return isBase64(hash);
};

const getHash = function (msg) {
    if (typeof(msg) !== 'string') {
        console.log('getHash() called on', typeof(msg), msg);
        return '';
    }
    return msg.slice(0,64);
};

// Try to keep 4MB of data in queue, if there's more on the buffer, hold off.
const QUEUE_CHR = 1024 * 1024 * 4;

const sendMsg = function (ctx, user, msg, cb) {
    if (!socketSendable(user.socket)) { return; }
    try {
        const strMsg = JSON.stringify(msg);
        if (ctx.config.logToStdout) { console.log('<' + strMsg); }
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
                console.error('Error thrown by sendMsg callback', e);
            }
        });
    } catch (e) {
        console.log("sendMsg()");
        console.log(e.stack);
        dropUser(ctx, user);
    }
};

const tryParse = function (str) {
    try {
        return JSON.parse(str);
    } catch (err) {
        console.error(err);
    }
};

const computeIndex = function (ctx, channelName, cb) {
    const cpIndex = [];
    let messageBuf = [];
    let validateKey;
    let metadata;
    ctx.store.readMessagesBin(channelName, 0, (msgObj, rmcb) => {
        let msg;
        if (!validateKey && msgObj.buff.indexOf('validateKey') > -1) {
            metadata = msg = tryParse(msgObj.buff.toString('utf8'));
            if (typeof msg === "undefined") { return rmcb(); }
            if (msg.validateKey) {
                validateKey = historyKeeperKeys[channelName] = msg;
                return rmcb();
            }
        }
        if (msgObj.buff.indexOf('cp|') > -1) {
            msg = msg || tryParse(msgObj.buff.toString('utf8'));
            if (typeof msg === "undefined") { return rmcb(); }
            if (msg[2] === 'MSG' && msg[4].indexOf('cp|') === 0) {
                cpIndex.push(msgObj.offset);
                messageBuf = [];
            }
        }
        messageBuf.push(msgObj);
        return rmcb();
    }, (err) => {
        if (err && err.code !== 'ENOENT') { return void cb(err); }
        const offsetByHash = {};
        let size = 0;
        messageBuf.forEach((msgObj) => {
            const msg = tryParse(msgObj.buff.toString('utf8'));
            if (typeof msg === "undefined") { return; }
            if (msg[0] === 0 && msg[2] === 'MSG' && typeof(msg[4]) === 'string') {
                offsetByHash[getHash(msg[4])] = msgObj.offset;
            }
            // There is a trailing \n at the end of the file
            size = msgObj.offset + msgObj.buff.length + 1;
        });
        cb(null, {
            cpIndex: cpIndex.slice(-2), // only care about the most recent 2 checkpoints
            offsetByHash: offsetByHash,
            size: size,
            metadata: metadata,
        });
    });
};

const getIndex = (ctx, channelName, cb) => {
    const chan = ctx.channels[channelName];
    if (chan && chan.index) { return void cb(undefined, chan.index); }
    computeIndex(ctx, channelName, (err, ret) => {
        if (err) { return void cb(err); }
        if (chan) { chan.index = ret; }
        cb(undefined, ret);
    });
};

const storeMessage = function (ctx, channel, msg, isCp, maybeMsgHash) {
    const msgBin = new Buffer(msg + '\n', 'utf8');
    nThen((waitFor) => {
        getIndex(ctx, channel.id, waitFor((err, index) => {
            if (err) {
                console.log("getIndex()");
                console.log(err.stack);
                // non-critical, we'll be able to get the channel index later
                return;
            }
            if (isCp) {
                index.cpIndex.shift();
                for (let k in index.offsetByHash) {
                    if (index.offsetByHash[k] < index.cpIndex[0]) {
                        delete index.offsetByHash[k];
                    }
                }
                index.cpIndex.push(index.size);
            }
            if (maybeMsgHash) { index.offsetByHash[maybeMsgHash] = index.size; }
            index.size += msgBin.length;
        }));
    }).nThen((waitFor) => {
        ctx.store.messageBin(channel.id, msgBin, function (err) {
            if (err) {
                console.log("Error writing message: " + err.message);
            }
        });
    });
};

const sendChannelMessage = function (ctx, channel, msgStruct) {
    msgStruct.unshift(0);
    channel.forEach(function (user) {
        // We don't want to send back a message to its sender, in order to save bandwidth
        if (msgStruct[2] !== 'MSG' || user.id !== msgStruct[1]) {
            sendMsg(ctx, user, msgStruct);
        }
    });
    if (USE_HISTORY_KEEPER && msgStruct[2] === 'MSG' && typeof(msgStruct[4]) === 'string') {
        const isCp = /^cp\|/.test(msgStruct[4]);
        if (historyKeeperKeys[channel.id] && historyKeeperKeys[channel.id].expire &&
                historyKeeperKeys[channel.id].expire < +new Date()) {
            return; // Don't store messages on expired channel
        }
        let id;
        if (isCp) {
            /*::if (typeof(msgStruct[4]) !== 'string') { throw new Error(); }*/
            id = /cp\|(([A-Za-z0-9+\/=]+)\|)?/.exec(msgStruct[4]);
            if (Array.isArray(id) && id[2] && id[2] === channel.lastSavedCp) {
                // Reject duplicate checkpoints
                return;
            }
        }
        if (historyKeeperKeys[channel.id] && historyKeeperKeys[channel.id].validateKey) {
            /*::if (typeof(msgStruct[4]) !== 'string') { throw new Error(); }*/
            let signedMsg = (isCp) ? msgStruct[4].replace(/^cp\|(([A-Za-z0-9+\/=]+)\|)?/, '') : msgStruct[4];
            signedMsg = Nacl.util.decodeBase64(signedMsg);
            const validateKey = Nacl.util.decodeBase64(historyKeeperKeys[channel.id].validateKey);
            const validated = Nacl.sign.open(signedMsg, validateKey);
            if (!validated) {
                console.log("Signed message rejected");
                return;
            }
        }
        if (isCp) {
            // WARNING: the fact that we only check the most recent checkpoints
            // is a potential source of bugs if one editor has high latency and
            // pushes a duplicate of an earlier checkpoint than the latest which
            // has been pushed by editors with low latency
            if (Array.isArray(id) && id[2]) {
                // Store new checkpoint hash
                channel.lastSavedCp = id[2];
            }
        }
        msgStruct.push(now());
        storeMessage(ctx, channel, JSON.stringify(msgStruct), isCp, getHash(msgStruct[4]));
    }
};

dropUser = function (ctx, user) {
    if (user.socket.readyState !== 2 /* WebSocket.CLOSING */
        && user.socket.readyState !== 3 /* WebSocket.CLOSED */)
    {
        try {
            user.socket.disconnect(true);
        } catch (e) {
            console.log("Failed to disconnect ["+user.id+"], attempting to terminate");
        }
    }
    delete ctx.users[user.id];
    Object.keys(ctx.channels).forEach(function (chanName) {
        let chan = ctx.channels[chanName];
        if (!chan) { return; }
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


const getHistoryOffset = (ctx, channelName, lastKnownHash, cb /*:(e:?Error, os:?number)=>void*/) => {
    // lastKnownhash === -1 means we want the complete history
    if (lastKnownHash === -1) { return void cb(null, 0); }
    let offset = -1;
    nThen((waitFor) => {
        getIndex(ctx, channelName, waitFor((err, index) => {
            if (err) { waitFor.abort(); return void cb(err); }
            // Since last 2 checkpoints
            if (!lastKnownHash) {
                waitFor.abort();
                // Less than 2 checkpoints in the history: return everything
                if (index.cpIndex.length < 2) { return void cb(null, 0); }
                // Otherwise return the second last checkpoint's index
                return void cb(null, index.cpIndex[0]);
                /* LATER...
                    in practice, two checkpoints can be very close together
                    we have measures to avoid duplicate checkpoints, but editors
                    can produce nearby checkpoints which are slightly different,
                    and slip past these protections. To be really careful, we can
                    seek past nearby checkpoints by some number of patches so as
                    to ensure that all editors have sufficient knowledge of history
                    to reconcile their differences. */
            }
            const lkh = index.offsetByHash[lastKnownHash];
            if (typeof(lkh) === 'number') { offset = lkh; }
        }));
    }).nThen((waitFor) => {
        if (offset !== -1) { return; }
        ctx.store.readMessagesBin(channelName, 0, (msgObj, rmcb, abort) => {
            const msg = tryParse(msgObj.buff.toString('utf8'));
            if (typeof msg === "undefined") { return rmcb(); }
            if (typeof(msg[4]) !== 'string' || lastKnownHash !== getHash(msg[4])) {
                return void rmcb();
            }
            offset = msgObj.offset;
            abort();
        }, waitFor(function (err) {
            if (err) { waitFor.abort(); return void cb(err); }
        }));
    }).nThen((waitFor) => {
        cb(null, offset);
    });
};

const getHistoryAsync = (ctx, channelName, lastKnownHash, beforeHash, handler, cb) => {
    let offset = -1;
    nThen((waitFor) => {
        getHistoryOffset(ctx, channelName, lastKnownHash, waitFor((err, os) => {
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            offset = os;
        }));
    }).nThen((waitFor) => {
        if (offset === -1) { return void cb(new Error("could not find offset")); }
        const start = (beforeHash) ? 0 : offset;
        ctx.store.readMessagesBin(channelName, start, (msgObj, rmcb, abort) => {
            if (beforeHash && msgObj.offset >= offset) { return void abort(); }
            handler(tryParse(msgObj.buff.toString('utf8')), rmcb);
        }, waitFor(function (err) {
            return void cb(err);
        }));
    });
};

const getOlderHistory = function (ctx, channelName, oldestKnownHash, cb) {
    var messageBuffer = [];
    var found = false;
    ctx.store.getMessages(channelName, function (msgStr) {
        if (found) { return; }

        let parsed = tryParse(msgStr);
        if (typeof parsed === "undefined") { return; }

        if (parsed.validateKey) {
            historyKeeperKeys[channelName] = parsed;
            return;
        }

        var content = parsed[4];
        if (typeof(content) !== 'string') { return; }

        var hash = getHash(content);
        if (hash === oldestKnownHash) {
            found = true;
        }
        messageBuffer.push(parsed);
    }, function (err) {
        if (err) {
            console.error("getOlderHistory", err);
        }
        cb(messageBuffer);
    });
};

const randName = function () { return Crypto.randomBytes(16).toString('hex'); };

/*::
type Chan_t = {
    indexOf: (any)=>number,
    id: string,
    lastSavedCp: string,
    forEach: ((any)=>void)=>void,
    push: (any)=>void,
};
*/


const historyKeeperBroadcast = function (ctx, channel, msg) {
    let chan = ctx.channels[channel] || (([] /*:any*/) /*:Chan_t*/);
    chan.forEach(function (user) {
        sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(msg)]);
    });
};
// When a channel is removed from datastore, broadcast a message to all its connected users
const onChannelDeleted = function (ctx, channel) {
    ctx.store.closeChannel(channel, function () {
        historyKeeperBroadcast(ctx, channel, {
            error: 'EDELETED',
            channel: channel
        });
    });
    delete ctx.channels[channel];
    delete historyKeeperKeys[channel];
};
// Check if the selected channel is expired
// If it is, remove it from memory and broadcast a message to its members
const checkExpired = function (ctx, channel) {
    if (channel && channel.length === 32 && historyKeeperKeys[channel] &&
            historyKeeperKeys[channel].expire && historyKeeperKeys[channel].expire < +new Date()) {
        ctx.store.closeChannel(channel, function () {
            historyKeeperBroadcast(ctx, channel, {
                error: 'EEXPIRED',
                channel: channel
            });
        });
        delete ctx.channels[channel];
        delete historyKeeperKeys[channel];
        return true;
    }
    return;
};

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
        let chan = ctx.channels[chanName] = ctx.channels[chanName] || (([] /*:any*/) /*:Chan_t*/);

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
        checkExpired(ctx, obj);

        if (obj === HISTORY_KEEPER_ID) {
            let parsed;
            try {
                parsed = JSON.parse(json[2]);
            } catch (err) {
                console.error("handleMessage(JSON.parse)", err);
                return;
            }

            // If the requested history is for an expired channel, abort
            // Note the if we don't have the keys for that channel in historyKeeperKeys, we'll
            // have to abort later (once we know the expiration time)
            if (checkExpired(ctx, parsed[1])) { return; }

            if (parsed[0] === 'GET_HISTORY') {
                // parsed[1] is the channel id
                // parsed[2] is a validation key (optionnal)
                // parsed[3] is the last known hash (optionnal)
                sendMsg(ctx, user, [seq, 'ACK']);
                channelName = parsed[1];
                var validateKey = parsed[2];
                var lastKnownHash = parsed[3];
                var owners;
                var expire;
                if (parsed[2] && typeof parsed[2] === "object") {
                    validateKey = parsed[2].validateKey;
                    lastKnownHash = parsed[2].lastKnownHash;
                    owners = parsed[2].owners;
                    if (parsed[2].expire) {
                        expire = +parsed[2].expire * 1000 + (+new Date());
                    }
                }

                nThen(function (waitFor) {
                    if (!ctx.tasks) { return; } // tasks are not supported
                    if (typeof(expire) !== 'number' || !expire) { return; }

                    // the fun part...
                    // the user has said they want this pad to expire at some point
                    ctx.tasks.write(expire, "EXPIRE", [ channelName ], waitFor(function (err) {
                        if (err) {
                            // if there is an error, we don't want to crash the whole server...
                            // just log it, and if there's a problem you'll be able to fix it
                            // at a later date with the provided information
                            console.error('Failed to write expiration to disk:', err);
                            console.error([expire, 'EXPIRE', channelName]);
                        }
                    }));
                }).nThen(function (waitFor) {
                    var w = waitFor();

                    /*  unless this is a young channel, we will serve all messages from an offset
                        this will not include the channel metadata, so we need to explicitly fetch that.
                        unfortunately, we can't just serve it blindly, since then young channels will
                        send the metadata twice, so let's do a quick check of what we're going to serve...
                    */
                    getIndex(ctx, channelName, waitFor((err, index) => {
                        /*  if there's an error here, it should be encountered
                            and handled by the next nThen block.
                            so, let's just fall through...
                        */
                        if (err) { return w(); }
                        if (!index || !index.metadata) { return void w(); }
                        if (!lastKnownHash && index.cpIndex.length > 1) {
                            // Store the metadata if we don't have it in memory
                            if (!historyKeeperKeys[channelName]) { historyKeeperKeys[channelName] = index.metadata; }
                            // And then check if the channel is expired. If it is, send the error and abort
                            if (checkExpired(ctx, channelName)) { return void waitFor.abort(); }

                            sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(index.metadata)], w);
                            return;
                        }
                        w();
                    }));
                }).nThen(() => {
                    let msgCount = 0;
                    let expired = false;
                    getHistoryAsync(ctx, channelName, lastKnownHash, false, (msg, cb) => {
                        if (!msg) { return; }
                        if (msg.validateKey) {
                            // If it is a young channel, this is the part where we get the metadata
                            // Check if the channel is expired and abort if it is.
                            if (!historyKeeperKeys[channelName]) { historyKeeperKeys[channelName] = msg; }
                            expired = checkExpired(ctx, channelName);
                        }
                        if (expired) { return void cb(); }
                        msgCount++;

                        sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(msg)], cb);
                    }, (err) => {
                        // If the pad is expired, stop here, we've already sent the error message
                        if (expired) { return; }

                        if (err && err.code !== 'ENOENT') {
                            console.error("GET_HISTORY", err);
                            const parsedMsg = {error:err.message, channel: channelName};
                            sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(parsedMsg)]);
                            return;
                        }

                        // Here is the dragon
                        //
                        // When a channel is created, we want to specify a validate key, this is a ed25519 key
                        // which is used to validate that messages sent in this channel are ok, meaning that they
                        // were sent by someone with the actual /edit/ link and not just someone with a /view/
                        // link.
                        //
                        // However, netflux is an API which we don't want to arbitrarily break so for RPC and
                        // special things, we use HistoryKeeper, a "magic" user which inexplicably joins every
                        // channel as soon as the user does.
                        //
                        // In practice when one creates a new channel, they will invoke a GET_HISTORY request
                        // right after. This type of request is sent as a private message to the HistoryKeeper
                        // so it does not have any standardized protocol to follow so the validateKey can be
                        // packed in this GET_HISTORY message.
                        //
                        // If they are not joined to the channel or if the channel does not exist, we skip this
                        // part.
                        //
                        const chan = ctx.channels[channelName];
                        if (msgCount === 0 && !historyKeeperKeys[channelName] && chan && chan.indexOf(user) > -1) {
                            var key = {};
                            key.channel = channelName;
                            if (validateKey) {
                                key.validateKey = validateKey;
                            }
                            if (owners) {
                                key.owners = owners;
                            }
                            if (expire) {
                                key.expire = expire;
                            }
                            historyKeeperKeys[channelName] = key;
                            storeMessage(ctx, chan, JSON.stringify(key), false, undefined);
                            sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(key)]);
                        }

                        let parsedMsg = {state: 1, channel: channelName};
                        sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(parsedMsg)]);
                    });
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
                getHistoryAsync(ctx, parsed[1], -1, false, (msg, cb) => {
                    if (!msg) { return; }
                    sendMsg(ctx, user, [0, HISTORY_KEEPER_ID, 'MSG', user.id, JSON.stringify(['FULL_HISTORY', msg])], cb);
                }, (err) => {
                    let parsedMsg = ['FULL_HISTORY_END', parsed[1]];
                    if (err) {
                        console.error(err.stack);
                        parsedMsg = ['ERROR', parsed[1], err.message];
                    }
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
                    var msg = rpc_call[0].slice();
                    if (msg[3] === 'REMOVE_OWNED_CHANNEL') {
                        var chanId = msg[4];
                        onChannelDeleted(ctx, chanId);
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
        if (!obj) {
            err = 'EINVAL';
            obj = 'undefined';
        } else if (!(chan = ctx.channels[obj])) {
            err = 'ENOENT';
        } else if ((idx = chan.indexOf(user)) === -1) {
            err = 'NOT_IN_CHAN';
        } else {
            sendMsg(ctx, user, [seq, 'ACK']);
            json.unshift(user.id);
            sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chan.id]);
            chan.splice(idx, 1);
            return;
        }
        sendMsg(ctx, user, [seq, 'ERROR', err, obj]);
        return;
    }
    if (cmd === 'PING') {
        sendMsg(ctx, user, [seq, 'ACK']);
        return;
    }
};

module.exports.run = function (
    storage /*:ChainPadServer_Storage_t*/,
    socketServer /*:WebSocketServer_t*/,
    config /*:Config_t*/,
    rpc /*:Rpc_t*/)
{
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
        tasks: config.tasks,
        // TODO(cjd) This is a dirty mess but we do it so that offsets can be requested by RPC
        getHistoryOffset: getHistoryOffset
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

        let locked = false;
        if (process.env['CRYPTPAD_DEBUG'] && !locked) {
            let nt = nThen;
            locked = true;
            Object.keys(ctx.channels).forEach(function (channelName) {
                const chan = ctx.channels[channelName];
                if (!chan.index) { return; }
                if (chan.index.cpIndex.length > 2) {
                    console.log("channel", channelName, "has cpIndex length", chan.index.cpIndex.length);
                }
                nt = nt((waitFor) => {
                    ctx.store.getChannelSize(channelName, waitFor((err, size) => {
                        if (err) { return void console.log("Couldn't get size of channel", channelName); }
                        if (size !== chan.index.size) {
                            console.log("channel size mismatch for", channelName,
                                "cached:", chan.index.size, "fileSize:", size);
                        }
                    }));
                }).nThen;
                nt((waitFor) => { locked = false; });
            });
        }
    }, 5000);
    socketServer.on('connection', function(socket) {
        let conn = socket.conn;
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
            if (ctx.config.logToStdout) { console.log('>'+message); }
            try {
                handleMessage(ctx, user, message);
            } catch (e) {
                console.log("handleMessage()");
                console.log(e.stack);
                dropUser(ctx, user);
            }
        });
        var drop = function (/*evt*/) {
            for (let userId in ctx.users) {
                if (ctx.users[userId].socket === socket) {
                    dropUser(ctx, ctx.users[userId]);
                }
            }
        };
        socket.on('disconnect', drop);
        socket.on('error', function (err) {
            console.error('WebSocket Error: ' + err.message);
            drop();
        });
    });
};
}());
