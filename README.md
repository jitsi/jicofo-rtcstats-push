### Running

The pusher requires 2 pieces of information: the address of Jicofo's REST API (to be queried) and the address of the
RTCStats server (to which data should be pushed).  This information can be provided in 2 ways:

1) Command line arguments: `node app.js --jicofo-address http://127.0.0.1:8888 --rtcstats-server ws://127.0.0.1:3001`
2) Environment variables: `JICOFO_ADDRESS="http://127.0.0.1:8888" RTCSTATS_SERVER="ws://127.0.0.1:3001" node app.js`
