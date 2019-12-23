/*@flow*/
/* jshint esversion: 6 */
/*::
import type { ChainPadServer_Storage_t } from './storage/file.js';
const flow_WebSocketServer = require('ws').Server;
type WebSocketServer_t = typeof(flow_WebSocketServer);
const flow_Config = require('./config.example.js');
type Config_t = typeof(flow_Config);
type Chan_t = {
    indexOf: (any)=>number,
    id: string,
    lastSavedCp: string,
    forEach: ((any)=>void)=>void,
    push: (any)=>void,
};
type HK_t = {
    id: string,
    setConfig: (Object)=>void,
    onChannelMessage: (...any)=>void,
    dropChannel: (any)=>void,
    checkExpired: (...any)=>boolean,
    onDirectMessage: (...any)=>void,
}
*/
;(function () { 'use strict';
const Crypto = require('crypto');

const LAG_MAX_BEFORE_DISCONNECT = 30000;
const LAG_MAX_BEFORE_PING = 15000;

const STANDARD_CHANNEL_LENGTH = 32;
const EPHEMERAL_CHANNEL_LENGTH = 34;

let USE_HISTORY_KEEPER = true;

let dropUser;
let log;

const now = function () { return (new Date()).getTime(); };

const socketSendable = function (socket) {
    return socket && socket.readyState === 1;
};

// Try to keep 4MB of data in queue, if there's more on the buffer, hold off.
const QUEUE_CHR = 1024 * 1024 * 4;

const sendMsg = function (ctx, user, msg, cb) {
    if (!socketSendable(user.socket)) { return; }
    try {
        const strMsg = JSON.stringify(msg);
        ctx.config.log.silly('RAW_NETFLUX', strMsg);
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
        dropUser(ctx, user);
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
        ctx.historyKeeper.onChannelMessage(ctx, channel, msgStruct);
    }
};

dropUser = function (ctx, user) {
    if (user.socket.readyState !== 2 /* WebSocket.CLOSING */
        && user.socket.readyState !== 3 /* WebSocket.CLOSED */)
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
            if (USE_HISTORY_KEEPER) {
                ctx.historyKeeper.dropChannel(chanName);
            }
        } else {
            sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chanName, 'Quit: [ dropUser() ]']);
        }
    });
};

const handleChannelLeave = function (ctx, channel) {
    try {
        if (channel.length === 0) {
            delete ctx.channels[channel.id];
            ctx.historyKeeper.dropChannel(channel.id);
        }
    } catch (err) {
        ctx.config.log.error(err);
    }
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
        if (obj && [STANDARD_CHANNEL_LENGTH, EPHEMERAL_CHANNEL_LENGTH].indexOf(obj.length) === -1) {
            sendMsg(ctx, user, [seq, 'ERROR', 'ENOENT', obj]);
            return;
        }
        let chanName = obj || randName();
        let chan = ctx.channels[chanName] = ctx.channels[chanName] || (([] /*:any*/) /*:Chan_t*/);

        if (chan.indexOf(user) !== -1) {
            // If the user is already in the channel, don't add it again.
            // Send an EJOINED, and send the userlist.
            // Don't broadcast the JOIN to the channel because other members
            // already know this user is in the channel.
            sendMsg(ctx, user, [seq, 'ERROR', 'EJOINED', chanName]);

            if (USE_HISTORY_KEEPER) {
                sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'JOIN', chanName]);
            }

            chan.forEach(function (u) {
                if (u === user) { return; }
                sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]);
            });
            sendMsg(ctx, user, [0, user.id, 'JOIN', chanName]);
            return;
        }

        sendMsg(ctx, user, [seq, 'JACK', chanName]);

        chan.id = chanName;
        if (USE_HISTORY_KEEPER) {
            sendMsg(ctx, user, [0, ctx.historyKeeper.id, 'JOIN', chanName]);
        }
        chan.forEach(function (u) { sendMsg(ctx, user, [0, u.id, 'JOIN', chanName]); });
        chan.push(user);
        sendChannelMessage(ctx, chan, [user.id, 'JOIN', chanName]);
        return;
    }

    if (cmd === 'MSG') {
        if (USE_HISTORY_KEEPER) { ctx.historyKeeper.checkExpired(ctx, obj); }

        if (USE_HISTORY_KEEPER && obj === ctx.historyKeeper.id) {
            ctx.historyKeeper.onDirectMessage(ctx, seq, user, json);
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
            //json.unshift(user.id);
            sendChannelMessage(ctx, chan, [user.id, 'LEAVE', chan.id]);
            chan.splice(idx, 1);
            handleChannelLeave(ctx, chan);
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
    socketServer /*:WebSocketServer_t*/,
    config /*:Config_t*/,
    historyKeeper /*:HK_t*/)
{

    log = config.log;

    let ctx = {
        users: {},
        channels: {},
        timeouts: {},
        config: config,
        historyKeeper: historyKeeper,
    };

    if (historyKeeper) {
        let hkConfig = {
            sendMsg: sendMsg,
            EPHEMERAL_CHANNEL_LENGTH: EPHEMERAL_CHANNEL_LENGTH,
            STANDARD_CHANNEL_LENGTH: STANDARD_CHANNEL_LENGTH,
        };
        historyKeeper.setConfig(hkConfig);
    } else {
        USE_HISTORY_KEEPER = false;
    }

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
    setInterval(function () {
        Object.keys(ctx.channels).forEach(function (chanName) {
            let chan = ctx.channels[chanName];
            if (!chan) { return; }
            if (chan.length === 0) {
                log.debug('REMOVE_EMPTY_CHANNEL_INTERVAL', chanName);
                delete ctx.channels[chanName];
                if (USE_HISTORY_KEEPER) {
                    ctx.historyKeeper.dropChannel(chanName);
                }
            }
        });
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
            log.error('NETFLUX_WEBSOCKET_ERROR', {
                message: err.message,
                stack: err.stack,
            });
            drop();
        });
    });
};
}());
