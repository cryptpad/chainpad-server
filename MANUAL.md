# MANUAL

Developing a [Collaborative Real Time Editor](https://en.wikipedia.org/wiki/Collaborative_real-time_editor) is easier than ever!

[XWiki Labs](http://labs.xwiki.com/) has been busy creating a number of libraries that you can use to build clientside applications that utilize this server:

* [chainpad](https://github.com/xwiki-contrib/chainpad)
  - Realtime Collaborative Editor Algorithm based on Nakamoto Blockchains
* [chainpad-crypto](https://github.com/xwiki-labs/chainpad-crypto)
  - pluggable cryptography module for chainpad
* [chainpad-json-validator](https://github.com/xwiki-labs/chainpad-json-validator)
  - pluggable operational transform function for JSON in chainpad
* [chainpad-netflux](https://github.com/xwiki-labs/chainpad-netflux)
  - A convenient wrapper around the chainpad realtime engine and the netflux transport API
* [chainpad-listmap](https://github.com/xwiki-labs/chainpad-listmap)
  - collaborative json arrays and objects

Most of these modules use [Require.js](http://requirejs.org/).

## Quick-Start

If you look inside your server's `www/` directory, you'll find a `template/` directory.

Inside are two files:

* `index.html`
* `main.js`


