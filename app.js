const fetch = require('node-fetch')
const { v4: uuidv4 } = require('uuid')
const { diff } = require('deep-object-diff')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const WebSocketClient = require('websocket').client
const os = require('os')
require('log-timestamp')

class App {
  constructor (jicofoBaseUrl, rtcStatsServerUrl, interval) {
    this.jicofoUrl = `${jicofoBaseUrl}/rtcstats`
    this.rtcStatsServerUrl = rtcStatsServerUrl
    this.interval = interval
    console.log(`Querying Jicofo REST API at ${this.jicofoUrl} every ${interval} ms.`)
    console.log(`Sending stats data to RTC stats server at ${this.rtcStatsServerUrl}.`)

    // Map conference ID to state about that conference
    // Conference state contains, at least:
    // statsSessionId: (String) the dump ID for this conference
    // endpoints: (Array) endpoint stat IDs for all endpoints *who have ever* been in this conference
    // previousDebugData: (Object) the previous debug data from the last request (used for diffing)
    this.conferenceStates = {}
  }

  start () {
    this.setupWebsocket()
    this.fetchTask = setInterval(async () => {
      console.log('Fetching data')
      const json = await fetchJson(this.jicofoUrl)
      this.processJicofoJson(json)
    }, this.interval)
  }

  stop () {
    clearInterval(this.fetchTask)
  }

  setupWebsocket () {
    // Create the websocket client
    this.wsClient = new WebSocketClient({
      keepalive: true,
      keepaliveInterval: 20000
    })
    // Enclose the websocket connect logic so it can be re-used easily in the reconnect logic below.
    const wsConnectionFunction = () => {
      console.log('Connecting websocket')
      this.wsClient.connect(
        this.rtcStatsServerUrl,
        '1.0_JICOFO',
        os.hostname(),
        { 'User-Agent': `Node ${process.version}` }
      )
    }

    // Install the event handlers on the websocket client
    this.wsClient.on('connectFailed', error => {
      console.log('Websocket connection failed: ', error)
      console.log('Will try to reconnect in 5 seconds')
      setTimeout(wsConnectionFunction, 5000)
    })

    this.wsClient.on('connect', connection => {
      // Assign the new connection to a member so it can be used to send data
      this.ws = connection
      console.log('Websocket connected')

      // Install the event handlers on the connection object
      connection.on('error', error => {
        console.log('Websocket error: ', error)
      })

      connection.on('close', () => {
        console.log('Websocket closed, will try to reconnect in 5 seconds')
        setTimeout(wsConnectionFunction, 5000)
      })
    })

    // Do the initial connection
    wsConnectionFunction()
  }

  processJicofoJson (jicofoJson) {
    this.checkForAddedOrRemovedConferences(jicofoJson)
    const timestamp = Date.now()
    Object.keys(jicofoJson).forEach(confId => {
      // Inject a timestamp into the conference data
      jicofoJson[confId].timestamp = timestamp
      this.processConference(confId, jicofoJson[confId])
    })
  }

  checkForAddedOrRemovedConferences (jicofoJson) {
    const confIds = Object.keys(jicofoJson)
    const newConfIds = confIds.filter(id => !(id in this.conferenceStates))
    const removedConfIds = Object.keys(this.conferenceStates).filter(id => confIds.indexOf(id) === -1)
    newConfIds.forEach(newConfId => {
      const statsSessionId = uuidv4()
      const confState = {
        statsSessionId,
        confName: newConfId.split('@')[0],
        displayName: os.hostname(),
        meetingUniqueId: jicofoJson[newConfId].meeting_id || newConfId,
        applicationName: 'Jicofo',
        endpoints: []
      }
      this.conferenceStates[newConfId] = confState
      this.sendData(createIdentityMessage(confState))
    })
    removedConfIds.forEach(removedConfId => {
      const confState = this.conferenceStates[removedConfId]
      delete this.conferenceStates[removedConfId]
      this.sendData(createCloseMsg(confState.statsSessionId))
    })
  }

  processConference (confId, confData) {
    this.checkForAddedOrRemovedEndpoints(confId, confData.participants)
    const previousData = this.conferenceStates[confId].previousDebugData || {}
    const statDiff = diff(previousData, confData)
    this.sendData(createStatEntryMessage(this.conferenceStates[confId].statsSessionId, statDiff))
    this.conferenceStates[confId].previousDebugData = confData
  }

  checkForAddedOrRemovedEndpoints (confId, currentConfEndpoints) {
    const confState = this.conferenceStates[confId]
    const epIds = Object.keys(currentConfEndpoints)
    const newEndpointIds = epIds.filter(epId => confState.endpoints.indexOf(epId) === -1)
    if (newEndpointIds.length > 0) {
      confState.endpoints.push(...newEndpointIds)
      this.sendData(createIdentityMessage(confState))
    }
  }

  sendData (msgObj) {
    this.ws.send(JSON.stringify(msgObj))
  }
}

const params = yargs(hideBin(process.argv))
  .env()
  .options({
    'jicofo-address': {
      alias: 'j',
      describe: 'The address of the Jicofo whose REST API will be queried (http://127.0.0.1:8888)',
      demandOption: true
    },
    'rtcstats-server': {
      alias: 'r',
      describe: 'The address of the RTC stats server websocket (ws://127.0.0.1:3000)',
      demandOption: true
    },
    interval: {
      alias: 'i',
      describe: 'The interval in milliseconds at which starts will be pulled and pushed.',
      default: 30000
    }
  })
  .help()
  .argv

console.log(`Got jicofo address ${params.jicofoAddress} and rtcstats server ${params.rtcstatsServer} and interval ${params.interval}`)

const app = new App(params.jicofoAddress, params.rtcstatsServer, params.interval)

app.start()

async function fetchJson (url) {
  try {
    const response = await fetch(url)
    return await response.json()
  } catch (e) {
    console.log('Error retrieving data: ', e)
    return null
  }
}

function createIdentityMessage (state) {
  // This is a bit awkward: we keep the statsSessionId in the conference state,
  // but we need to set it as an explicit field of the message.  Also,
  // we need to explicit parse out previousDebugData so that we can
  // not include it in the message
  const { statsSessionId, previousDebugData, ...metadata } = state
  return {
    type: 'identity',
    statsSessionId,
    data: metadata
  }
}

function createCloseMsg (statsSessionId) {
  return {
    type: 'close',
    statsSessionId
  }
}

function createStatEntryMessage (statsSessionId, data) {
  return {
    type: 'stats-entry',
    statsSessionId,
    data: JSON.stringify(data)
  }
}
