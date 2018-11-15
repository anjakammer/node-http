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
  const webhook = JSON.parse(payload).body
  const appName = webhook.repository.name
  const repoName = secrets.buildRepoName
  const imageTag = webhook.check_suite.head_sha
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
    `kubectl run ${appName}-${imageTag}-preview --image=${imageName} --labels="app=${appName}-${imageTag}-preview" --port=80 -n preview`,
    'cd /src/manifest',
    `sed -i -e 's/previewPath/${imageTag}/g' -e 's/app-name/${appName}/g' ingress.yaml`,
    `sed -i -e 's/name: app-name/name: ${appName}/g' -e 's/appName-imageTag-preview/${appName}-${imageTag}-preview/g' service.yaml`,
    'kubectl apply -f service.yaml -n preview',
    'kubectl apply -f ingress.yaml -n preview',
    `echo "Status of ${appName}:${imageTag}:"`,
    `kubectl get service/${appName} -n preview`
  ]

  const previewUrl = `${secrets.hostName}/preview/${imageTag}`
  const repo = webhook.repository.full_name
  const pr = webhook.check_suite.pull_requests[0].number
  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${pr}/comments`

  const prCommenter = new Job('4-pr-comment', 'anjakammer/brigade-pr-comment')
  prCommenter.env = {
    APP_NAME: 'Anya-test',
    WAIT_MS: '0',
    COMMENT: `Preview Environment is set up: [https://${previewUrl}](${previewUrl})`,
    COMMENTS_URL: commentsUrl,
    TOKEN: JSON.parse(payload).token
  }

  prCommenter.run()

  let result

  try {
    result = await build.run()
    sendSignal({ stage: buildStage, logs: result.toString(), conclusion: success, payload })
  } catch (err) {
    await sendSignal({ stage: buildStage, logs: err.toString(), conclusion: failure, payload })
    await sendSignal({ stage: testStage, logs: '', conclusion: cancelled, payload })
    return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled, payload })
  }

  try {
    result = await test.run()
    sendSignal({ stage: testStage, logs: result.toString(), conclusion: success, payload })
  } catch (err) {
    await sendSignal({ stage: testStage, logs: err.toString(), conclusion: failure, payload })
    return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled, payload })
  }

  try {
    result = await deploy.run()
    sendSignal({ stage: deployStage, logs: result.toString(), conclusion: success, payload })
  } catch (err) {
    return sendSignal({ stage: deployStage, logs: err.toString(), conclusion: failure, payload })
  }
}

module.exports = { registerCheckSuite, runCheckSuite, sendSignal }
