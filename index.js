/*
    globals require console
*/
var Http = require('http');
var Https = require('https');
var Fs = require('fs');
var WebSocketServer = require('ws').Server;
var NetfluxWebsocketSrv = require('./NetfluxWebsocketSrv');

var mkHttp = function (config) {
    var httpsOpts;
    if (config.privKeyAndCertFiles) {
        var privKeyAndCerts = '';
        config.privKeyAndCertFiles.forEach(function (file) {
            privKeyAndCerts = privKeyAndCerts + Fs.readFileSync(file);
        });
        var array = privKeyAndCerts.split('\n-----BEGIN ');
        for (var i = 1; i < array.length; i++) { array[i] = '-----BEGIN ' + array[i]; }
        var privKey;
        for (var i = 0; i < array.length; i++) {
            if (array[i].indexOf('PRIVATE KEY-----\n') !== -1) {
                privKey = array[i];
                array.splice(i, 1);
                break;
            }
        }
        if (!privKey) { throw new Error("cannot find private key"); }
        httpsOpts = {
            cert: array.shift(),
            key: privKey,
            ca: array
        };
    }
    return httpsOpts ? Https.createServer(httpsOpts) : Http.createServer();
};

module.exports.launch = function (config)
{
    config = config || {};
    var httpServer = config.httpServer || mkHttp(config);
    var Storage = require(config.storage || './storage/amnesia');

    var wsConfig = { server: httpServer };
    if (config.websocketPort) {
        wsConfig = { port: config.websocketPort};
    }
    var wsSrv = new WebSocketServer(wsConfig);
    Storage.create(config, function (store) {
        NetfluxWebsocketSrv.run(store, wsSrv, config);
    });
    return httpServer;
};
