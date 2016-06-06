/*
    globals module
*/
module.exports = {

    // the address you want to bind to, :: means all ipv4 and ipv6 addresses
    // this may not work on all operating systems
    httpAddress: '::',

    // the port on which your httpd will listen
    httpPort: 3001,
    // the port used for websockets
    websocketPort: 3001,

    /*  Cryptpad can log activity to stdout
     *  This may be useful for debugging
     */
    logToStdout: false,

    /*  Cryptpad can be configured to remove channels some number of ms
        after the last remaining client has disconnected.

        Default behaviour is to keep channels forever.
        If you enable channel removal, the default removal time is one minute
    */
    removeChannels: false,
    channelRemovalTimeout: 60000,

    // You now have a choice of storage engines

    /* amnesiadb only exists in memory.
     * it will not persist across server restarts
     * it will not scale well if your server stays alive for a long time.
     * but it is completely dependency free
     */
    storage: './storage/amnesia',

    /* the 'lvl' storage module uses leveldb
     * it persists, and will perform better than amnesiadb
     * you will need to run 'npm install level' to use it
     * 
     * you can provide a path to a database folder, which will be created
     * if it does not already exist. If you use level and do not pass a path
     * it will be created at cryptpad/test.level.db
     *
     * to delete all pads, run `rm -rf $YOUR_DB`
     */
    //storage: './storage/lvl',
    //levelPath: './test.level.db'

    /* mongo is the original storage engine for cryptpad
     * it has been more thoroughly tested, but requires a little more setup
     */
    // storage: './storage/mongo',

    /* this url is accessible over the internet, it is useful for testing
     * but should not be used in production
     */
    // mongoUri: "mongodb://demo_user:demo_password@ds027769.mongolab.com:27769/demo_database",

    /* mongoUri should really be used to refer to a local installation of mongodb
     * to install the mongodb client, run `npm install mongodb`
     */
    // mongoUri: "mongodb://localhost:27017/cryptpad",
    // mongoCollectionName: 'cryptpad',

    /* it is recommended that you serve cryptpad over https
     * the filepaths below are used to configure your certificates
     */
    //privKeyAndCertFiles: [
    //  '/etc/apache2/ssl/my_secret.key',
    //  '/etc/apache2/ssl/my_public_cert.crt',
    //  '/etc/apache2/ssl/my_certificate_authorities_cert_chain.ca'
    //],
};
