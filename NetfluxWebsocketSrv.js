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
type HK_t = Object;
*/
;(function () { 'use strict';
const Crypto = require('crypto');
const nThen = require('nthen');

const LAG_MAX_BEFORE_DISCONNECT = 30000;
const LAG_MAX_BEFORE_PING = 15000;

const USE_HISTORY_KEEPER = true;

let dropUser;

const now = function () { return (new Date()).getTime(); };

const socketSendable = function (socket) {
    return socket && socket.readyState === 1;
};

const isBase64 = function (x) {
    return /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(x);
};

const isValidHash = function (hash) {
    if (typeof(hash) !== 'string') { return false; }
    if (hash.length !== 64) { return false; }
    return isBase64(hash);
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

const sendChannelMessage = function (ctx, channel, msgStruct) {
    msgStruct.unshift(0);
    channel.forEach(function (user) {
        // We don't want to send back a message to its sender, in order to save bandwidth
        if (msgStruct[2] !== 'MSG' || user.id !== msgStruct[1]) {
            sendMsg(ctx, user, msgStruct);
        }
    });
    if (USE_HISTORY_KEEPER && msgStruct[2] === 'MSG' && typeof(msgStruct[4]) === 'string') {
        ctx.historyKeeper.onMessageBroadcasted(ctx, channel, msgStruct);
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
            ctx.historyKeeper.dropChannel(ctx, chanName);

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
            sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'JOIN', chanName]);
        }
        chan.forEach(function (u) { sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]); });
        chan.push(user);
        sendChannelMessage(ctx, chan, [user.id, 'JOIN', chanName]);
        return;
    }

    var channelName;
    if (cmd === 'MSG') {
        if (USE_HISTORY_KEEPER) { ctx.historyKeeper.checkExpired(ctx, obj); }

        if (USE_HISTORY_KEEPER && obj === ctx.historyKeeper.id) {
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
            if (ctx.historyKeeper.checkExpired(ctx, parsed[1])) { return; }

            if (parsed[0] === 'GET_HISTORY') {
                ctx.historyKeeper.onGetHistory(ctx, parsed, seq, user);
            } else if (parsed[0] === 'GET_HISTORY_RANGE') {
                ctx.historyKeeper.onGetHistoryRange(ctx, parsed, seq, user);
            } else if (parsed[0] === 'GET_FULL_HISTORY') {
                ctx.historyKeeper.onGetFullHistory(ctx, parsed, seq, user);
            } else if (ctx.rpc) {
                /* RPC Calls...  */
                var rpc_call = parsed.slice(1);

                sendMsg(ctx, user, [seq, 'ACK']);
                try {
                // slice off the sequence number and pass in the rest of the message
                ctx.rpc(ctx, rpc_call, function (err, output) {
                    if (err) {
                        sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'MSG', user.id, JSON.stringify([parsed[0], 'ERROR', err])]);
                        return;
                    }
                    var msg = rpc_call[0].slice();
                    if (msg[3] === 'REMOVE_OWNED_CHANNEL') {
                        var chanId = msg[4];
                        ctx.historyKeeper.onChannelDeleted(ctx, chanId);
                    }
                    sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'MSG', user.id, JSON.stringify([parsed[0]].concat(output))]);
                });
                } catch (e) {
                    sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'MSG', user.id, JSON.stringify([parsed[0], 'ERROR', 'SERVER_ERROR'])]);
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
    rpc /*:Rpc_t*/,
    HK /*:HK_t*/)
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
        historyKeeper: {}
    };

    ctx.historyKeeper = HK.create(ctx, sendMsg);

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
        if(socket.upgradeReq.url !== (config.websocketPath || '/cryptpad_websocket')) { return; }
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
        socket.on('close', drop);
        socket.on('error', function (err) {
            console.error('WebSocket Error: ' + err.message);
            drop();
        });
    });
};
}());
