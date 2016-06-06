# chainpad-server

A minimal standalone server for chainpad applications.

## Installation

You will need:

* nodejs
* npm
* bower
  - `sudo npm install -g bower`

```Bash
# Fetch the repository from github
git clone https://github.com/xwiki-labs/chainpad-server;

# change into the directory
cd chainpad-server;

# install project dependencies
npm install;
bower install;

# create a configuration file
cp config.dist.js config.js
```

## Usage

`chainpad-server` provides a basic webserver (which serves static files), and a _[Netflux server](https://github.com/xwiki-labs/netflux-spec2/blob/serverV2/specification.md)_ which your realtime applications will use to communicate with each other.

Once your server is configured, you can start it:

```
node server.js
```

...then visit it at http://localhost:3000 using a web browser.
If you have configured your server to use a different port, you will have to change that URL to match.

Once you have a webserver up and running, you can start developing an application.

See [MANUAL.md](./MANUAL.md) for a quick tutorial building an example application.

## License

This software is and will always be available under the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the License, or (at your option)
any later version. If you wish to use this technology in a proprietary product, please contact
sales@xwiki.com

