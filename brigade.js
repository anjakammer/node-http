const { events, Job } = require('brigadier')
const eachSeries = require('async/eachSeries')

const checkRunImage = 'technosophos/brigade-github-check-run:latest'
const buildStage = '1-Build'
const testStage = '2-Test'
const deployStage = '3-Deploy'
const failure = 'failure'
const cancelled = 'cancelled'
const success = 'success'
const stages = [buildStage, testStage, deployStage]

events.on('check_suite:requested', checkRequested)
events.on('check_suite:rerequested', checkRequested)

function checkRequested (e, p) {
  console.log('Check-Suite requested')

  registerCheckSuite(e.payload)
  runCheckSuite(e.payload, p.secrets)
    .then(() => { return console.log('Finished Check-Suite') })
    .catch((err) => { console.log(err) })
}

function registerCheckSuite (payload) {
  eachSeries(stages, (check, next) => {
    console.log(`register-${check}`)

    const registerCheck = new Job(`register-${check}`.toLowerCase(), checkRunImage)
    registerCheck.imageForcePull = true
    registerCheck.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description',
      CHECK_SUMMARY: `${check} scheduled`
    }

    return registerCheck.run()
      .then(() => { return next() })
      .catch(err => { console.log(err) })
  })
  return Promise.resolve('Finished Check-Suite registration')
}

function sendSignal ({ stage, logs, conclusion, payload }) {
  const assertResult = new Job(`assert-result-of-${stage}-job`.toLowerCase(), checkRunImage)
  assertResult.imageForcePull = true
  assertResult.env = {
    CHECK_PAYLOAD: payload,
    CHECK_NAME: stage,
    CHECK_TITLE: 'Description'
  }
  assertResult.env.CHECK_CONCLUSION = conclusion
  assertResult.env.CHECK_SUMMARY = `${stage} ${conclusion}`
  assertResult.env.CHECK_TEXT = logs
  return assertResult.run()
    .catch(err => { console.log(err) })
}

async function runCheckSuite (payload, secrets) {
  const commit = JSON.parse(payload).body
  const appName = commit.repository.name
  const repoName = secrets.buildRepoName
  const imageTag = commit.check_suite.head_sha
  // const imageName = commit.repository.full_name
  const imageName = `gcr.io/${repoName}/${appName}:${imageTag}`

  const build = new Job(buildStage.toLowerCase(), 'gcr.io/kaniko-project/executor:latest')
  build.args = [
    `-d=${imageName}`,
    '-c=/src'
  ]

  const test = new Job(testStage.toLowerCase(), imageName)
  test.imageForcePull = true
  test.tasks = [
    `echo "Running Tests"`,
    'npm test'
  ]

  const deploy = new Job(deployStage.toLowerCase(), 'gcr.io/cloud-builders/kubectl')
  deploy.privileged = true
  deploy.serviceAccount = 'anya-deployer'
  deploy.tasks = [
    `echo "Deploying ${appName}:${imageTag}"`,
    // `kubectl run ${appName}-${imageTag}-preview --image=${imageName} --port=80 -n preview`,
    'cd /src/manifest',
    `sed -i -e 's/previewPath/${imageTag}/g' -e 's/app-name/${appName}/g' ingress.yaml"`,
    `sed -i -e 's/app-name/${appName}/g' service.yaml"`,
    'ls'
    // 'kubectl apply -f service.yaml -n preview',
    // 'kubectl apply -f ingress.yaml -n preview',
    // `echo "Status of ${appName}:${imageTag}:"`,
    // `kubectl get service/${appName} -n preview`
  ]

  let result

  // try {
  //   result = await build.run()
  //   sendSignal({ stage: buildStage, logs: result.toString(), conclusion: success, payload })
  // } catch (err) {
  //   await sendSignal({ stage: buildStage, logs: err.toString(), conclusion: failure, payload })
  //   await sendSignal({ stage: testStage, logs: '', conclusion: cancelled, payload })
  //   return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled, payload })
  // }

  // try {
  //   result = await test.run()
  //   sendSignal({ stage: testStage, logs: result.toString(), conclusion: success, payload })
  // } catch (err) {
  //   await sendSignal({ stage: testStage, logs: err.toString(), conclusion: failure, payload })
  //   return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled, payload })
  // }

  try {
    result = await deploy.run()
    sendSignal({ stage: deployStage, logs: result.toString(), conclusion: success, payload })
  } catch (err) {
    return sendSignal({ stage: deployStage, logs: err.toString(), conclusion: failure, payload })
  }
}

module.exports = { registerCheckSuite, runCheckSuite, sendSignal }
