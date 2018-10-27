const {events, Job} = require('brigadier')
const eachSeries = require('async/eachSeries')

const checkRunImage = 'technosophos/brigade-github-check-run:latest'
const stages = ['Build', 'Test', 'Deploy']

events.on('check_suite:requested', checkRequested)
events.on('check_suite:rerequested', checkRequested)
events.on('check_run:rerequested', checkRequested)

function checkRequested (e, p) {
  console.log('Check-Suite requested')

  registerCheckSuite(e.payload)
    .then(() => { return runCheckSuite(e.payload) })
    .then(() => { return console.log('Finished Check-Suite') })
    .catch((err) => { console.log(err) })
}

function registerCheckSuite (payload) {
  eachSeries(stages, (check, next) => {
    console.log(`register-${check}`)

    const registerCheck = new Job(`register-${check}`.toLocaleLowerCase(), checkRunImage)
    registerCheck.imageForcePull = true
    registerCheck.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description'
    }
    registerCheck.env.CHECK_SUMMARY = `${check} scheduled`

    return registerCheck.run()
      .then(() => { return next() })
      .catch(err => { console.log(err) })
  })
  return Promise.resolve('Finished Check-Suite registration')
}

function runCheckSuite (payload) {
  return eachSeries(stages, (check, next) => {
    console.log(`run-${check}`)
    const runCheck = new Job(check.toLocaleLowerCase(), 'alpine:3.7', ['sleep 60', 'echo hello'])

    const assertResult = new Job(`assert-result-of-${check}-job`.toLocaleLowerCase(), checkRunImage)
    assertResult.imageForcePull = true
    assertResult.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description'
    }
    return runCheck.run()
      .then((result) => {
        assertResult.env.CHECK_CONCLUSION = 'success'
        assertResult.env.CHECK_SUMMARY = `Job:${check} completed`
        assertResult.env.CHECK_TEXT = result.toString() + 'where am I?'
        return assertResult.run()
          .then(() => { return next() })
          .catch(err => { console.log(err) })
      })
      .catch((err) => {
        assertResult.env.CHECK_CONCLUSION = 'failed'
        assertResult.env.CHECK_SUMMARY = `Job:${check} failed`
        assertResult.env.CHECK_TEXT = `Error: ${err}`
        return assertResult.run()
      })
  })
}

module.exports = {registerCheckSuite, runCheckSuite}
