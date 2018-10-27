const {events, Job} = require('brigadier')
const eachSeries = require('async/eachSeries')

const checkRunImage = 'technosophos/brigade-github-check-run:latest'
const stages = ['Build', 'Test', 'Deploy']

events.on('check_suite:requested', checkRequested)
events.on('check_suite:rerequested', checkRequested)
events.on('check_run:rerequested', checkRequested)

function checkRequested (e, p) {
  console.log('Check-Suite requested')

  this.registerCheckRun(e.payload).then(() => {
    return this.runCheck(e.payload)
  }).then(() => {
    console.log('Finished Check-Suite')
  }).catch((err) => {
    console.log(err)
  })
}

exports.registerCheckRun = (payload) => {
  eachSeries(stages, (check, next) => {
    console.log(`register-${check}`)

    const registerCheck = new Job(`register-${check}`, checkRunImage)
    registerCheck.imageForcePull = true
    registerCheck.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description'
    }
    registerCheck.env.CHECK_SUMMARY = `${check} scheduled`

    return registerCheck.run().then((result) => {
      console.log(result.toString())
      next()
    })
  })
}

exports.runCheck = (payload) => {
  eachSeries(stages, (check, next) => {
    console.log(`run-${check}`)
    const runCheck = new Job(check, 'alpine:3.7', ['sleep 60', 'echo hello'])

    const end = new Job(`assert-result-of-${check}`, checkRunImage)
    end.imageForcePull = true
    end.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description'
    }
    return runCheck.run().then((result) => {
      end.env.CHECK_CONCLUSION = 'success'
      end.env.CHECK_SUMMARY = `${check} completed`
      end.env.CHECK_TEXT = result.toString() + 'where am I?'
      end.run()
      next()
    }).catch((err) => {
      end.env.CHECK_CONCLUSION = 'failed'
      end.env.CHECK_SUMMARY = `${check} failed`
      end.env.CHECK_TEXT = `Error: ${err}`
      return end.run()
    })
  })
}
