(function () { 'use strict';
const WebSocketServer = require('ws').Server;
const NetfluxSrv = require('./NetfluxWebsocketSrv');

const config = require('./config');
config.port = config.port || 3000;
config.host = config.host || '::';
config.channelRemovalTimeout = config.channelRemovalTimeout || 60000;
config.websocketPath = config.websocketPath || '/cryptpad_websocket';
config.logToStdout = config.logToStdout || false;
config.verbose = config.verbose || false;
config.removeChannels = config.removeChannels || false;
config.storage = config.storage || './storage/file';

const Storage = require(config.storage);
const wsSrv = new WebSocketServer({ host: config.host, port: config.port });
Storage.create(config, (store) => {
    NetfluxSrv.run(store, wsSrv, config);
});
}());
