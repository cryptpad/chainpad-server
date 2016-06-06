define([
    '/bower_components/chainpad-listmap/chainpad-listmap.js',
    '/bower_components/chainpad-crypto/crypto.js',
    '/bower_components/jquery/dist/jquery.min.js',
], function (Listmap, Crypto) {
    var $ = window.jQuery;

    var userName = window.prompt("What is your name?");

    var rt = Listmap.create({
        "websocketURL":"ws://" + window.location.host + "/cryptpad_websocket",
        "channel":"b87dff2e9a465f0e0ae36453d19b087c",
        "cryptKey":"sksyaHv+OOlQumRmZrQU4f5N",
        "data":{},
        crypto: Crypto
    });

    var $guestbook = $('#visitors');

    var render = function (visitors) {
        $guestbook.text(function () {
            return visitors
                .filter(function (x) { return x; })
                .map(function (name) {
                    return '* ' + name;
                }).join('\n');
        });
    };

    var proxy = rt.proxy.on('ready', function (info) {
        console.log("Ready!");

        proxy.on('change', ['guestBook'], function (o, n, p) {
            render(proxy.guestBook);
        }).on('disconnect', function (info) {
            window.alert("Network Connection Lost!");
        });

        if (!proxy.guestBook) { proxy.guestBook = []; }

        if (proxy.guestBook.indexOf(userName) === -1) {
            proxy.guestBook.push(userName);
        }

        render(proxy.guestBook);
    });
});
