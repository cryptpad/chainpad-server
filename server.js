var WebSocketServer = require('ws').Server;
var NetfluxSrv = require('./NetfluxWebsocketSrv');

var config = require('./config');
config.port = config.port || 3000;
config.host = config.host || '::';
config.channelRemovalTimeout = config.channelRemovalTimeout || 60000;
config.websocketPath = config.websocketPath || '/cryptpad_websocket';
config.logToStdout = config.logToStdout || false;
config.verbose = config.verbose || false;
config.removeChannels = config.removeChannels || false;

var wsSrv = new WebSocketServer({ host: config.host port: config.port });
Storage.create(config, function (store) {
    NetfluxSrv.run(store, wsSrv, config);
});
