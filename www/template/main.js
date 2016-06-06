/*  requirejs resolves the paths you provide. For additional dependencies, add
    the path to the module to the array below: */
define([
    /*  our server provides a configuration API, from which we can determine
        the URL of the websocket we will use */
    '/api/config?cb=' + Math.random().toString(16).slice(2),

    /*  this library creates a collaborative object */
    '/bower_components/chainpad-listmap/chainpad-listmap.js',

    /*  provide some cryptographic functions so that we can 
        pass information through the server without it being readable */
    '/bower_components/chainpad-crypto/crypto.js',
    '/bower_components/jquery/dist/jquery.min.js',
], function (Config, Listmap, Crypto) {
    var $ = window.jQuery;

    var userName = window.prompt("What is your name?");

    /*  Create a Realtime List/Map object
        when you modify the proxy, it will replicate its changes to the
        server, and by extension, to the other users of the application */
    var rt = Listmap.create({
        websocketURL: Config.websocketURL,

        /*  Note that the channel and encryption key are hardcoded in this app.
            This means that everyone who visits this page will end up in the
            same realtime session.

            Depending on your use case, you may want to determine what channel
            and key you should use, based on user input, or perhaps inferred
            from the hash in the URL. */
        channel:"b87dff2e9a465f0e0ae36453d19b087c",
        cryptKey:"sksyaHv+OOlQumRmZrQU4f5N",

        // The object that you want to make realtime
        data:{},

        // The cryptography module is pluggable
        crypto: Crypto
    });

    // the element on the page that we want to modify
    var $guestbook = $('#visitors');

    /*  A simple function to display the users that have signed the guestbook */
    var render = function (visitors) {
        $guestbook.text(function () {
            return visitors
                .filter(function (x) { return x; })
                .map(function (name) {
                    return '* ' + name;
                }).join('\n');
        });
    };

    /*  Wait until the realtime object is ready */
    var proxy = rt.proxy.on('ready', function (info) {
        console.log("Ready!");

        /*  Listen for changes in a specific path (proxy.guestBook) */
        proxy.on('change', ['guestBook'], function (oldValue, newValue, path) {
            console.log("A new user (%s) signed the guestbook", newValue);
            render(proxy.guestBook);
        }).on('disconnect', function (info) {
            /* If the user loses their connection, inform them */
            window.alert("Network Connection Lost!");
        });

        // initialize the guestbook, if it isn't already there
        if (!proxy.guestBook) { proxy.guestBook = []; }

        // add your name to the guestbook
        if (proxy.guestBook.indexOf(userName) === -1) {
            proxy.guestBook.push(userName);
        }

        // display the current list
        render(proxy.guestBook);
    });
});
