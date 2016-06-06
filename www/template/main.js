define([
    '/bower_components/chainpad-listmap/chainpad-listmap.js',
    '/bower_components/chainpad-crypto/crypto.js'
], function (Listmap, Crypto) {

    var userName = window.prompt('What is your name?');

    var config = {
        "websocketURL":"ws://localhost:3001/cryptpad_websocket",
        "channel":"b87dff2e9a465f0e0ae36453d19b087c",
        "cryptKey":"sksyaHv+OOlQumRmZrQU4f5N",
        "data":{},
        crypto: Crypto
    };

    var rt = Listmap.create(config);

    var proxy = rt.proxy;

    proxy.on('create', function (info) {

    }).on('ready', function (info) {
        console.log("Ready!");
        console.log(JSON.stringify(proxy));

        proxy.on('change', ['guestBook'], function (o, n, p) {
            console.log(JSON.stringify(proxy));
        }).on('disconnect', function (info) {
            window.alert("Network Connection Lost!");
        });

        if (!proxy.guestBook) {
            proxy.guestBook = [];
        }

        if (proxy.guestBook.indexOf(userName) === -1) {
            proxy.guestBook.push(userName);
        }
    });
});
