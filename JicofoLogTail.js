const { Tail } = require('tail')

const CLEAN_INTERVAL = 60 * 1000 // Retain up to 1 minute of logs

module.exports = class JvbLogTail {
  constructor (path) {
    this.lastMeetingId = null
    this.meetingStates = {}

    this.tail = new Tail(path)
    this.tail.on('line', line => {
      const meetingId = this.getMeetingId(line)

      if (meetingId === null) return

      const state = this.getState(meetingId)
      state.logs.push(line)
      state.lastAccess = new Date()

      this.clean()
    })

    this.tail.on('error', e => {
      console.log('Error reading from the log file:' + e)
      this.tail.unwatch()
    })
  }

  getState (meetingId) {
    let state = this.meetingStates[meetingId]
    if (!state) {
      state = { meetingId, logs: [], last: new Date() }
      this.meetingStates[meetingId] = state
    }
    return state
  }

  clean () {
    for (const meetingId in this.meetingStates) {
      const t = new Date() - this.meetingStates[meetingId].lastAccess
      if (t > CLEAN_INTERVAL) {
        console.log('Remove stale logs ' + meetingId)
        delete this.meetingStates[meetingId]
      }
    };
  }

  getLogs (meetingId) {
    const state = this.meetingStates[meetingId]
    if (state) {
      const logs = state.logs
      state.logs = []
      return logs
    }
    return []
  }

  /* Read the meeting_id from a log line, and update this.lastMeetingId if the line starts a new log. */
  getMeetingId (line) {
    if (!line.startsWith('Jicofo ')) {
      // Subsequent line from a multi-line message.
      return this.lastMeetingId
    }

    const c = line.replaceAll('[', '').replaceAll(']', '').split(' ').filter(m => m.startsWith('meeting_id='))
    if (!c || !c.length) {
      this.lastMeetingId = null
      return null
    }

    const meetingId = c[0].replace('meeting_id=', '')
    this.lastMeetingId = meetingId
    return meetingId
  }
}
