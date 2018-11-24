const { events, Job } = require('brigadier')
const eachSeries = require('async/eachSeries')
const request = require('request')

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
  const payload = JSON.parse(e.payload)
  const pr = payload.body.check_suite.pull_requests
  if (pr.length === 0) {
    // re-request the check, to get the pr-id
    if (payload.body.action !== 'rerequested') {
      rerequestCheckSuite(payload.body.check_suite.url, payload.token, p.secrets.ghAppName)
    } // ignore all else
  } else {
    registerCheckSuite(e.payload)
    runCheckSuite(e.payload, p.secrets)
      .then(() => { return console.log('Finished Check-Suite') })
      .catch((err) => { console.log(err) })
  }
}

async function registerCheckSuite (payload) {
  await eachSeries(stages, (check, next) => {
    console.log(`register-${check}`)

    const registerCheck = new Job(`register-${check}`.toLowerCase(), checkRunImage)
    registerCheck.imageForcePull = true
    registerCheck.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description',
      CHECK_SUMMARY: `${check} scheduled`
    }

    registerCheck.run()
      .then(() => { next() })
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

  const previewUrl = `${secrets.hostName}/preview/${appName}/${imageTag}`
  const previewPath = appName + '\\/' + imageTag
  const deploy = new Job(deployStage.toLowerCase(), 'gcr.io/cloud-builders/kubectl')
  deploy.privileged = true
  deploy.serviceAccount = 'anya-deployer'
  deploy.tasks = [
    `echo "Deploying ${appName}:${imageTag}"`,
    `kubectl run ${appName}-${imageTag}-preview --image=${imageName} --labels="app=${appName}-${imageTag}-preview" --port=80 -n preview`,
    'cd /src/manifest',
    `sed -i -e 's/previewPath/${previewPath}/g' -e 's/app-name-app-version/${appName}-${imageTag}/g' ingress.yaml`,
    `sed -i -e 's/app-name-app-version/${appName}-${imageTag}/g' service.yaml`,
    'kubectl apply -f service.yaml -n preview',
    'kubectl apply -f ingress.yaml -n preview',
    `echo "Status of ${appName}:${imageTag}:"`,
    `echo "Preview URL: ${previewUrl}"`
  ]

  const repo = webhook.repository.full_name
  const prNr = webhook.check_suite.pull_requests[0].number
  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNr}/comments`

  const prCommenter = new Job('4-pr-comment', 'anjakammer/brigade-pr-comment')
  prCommenter.env = {
    APP_NAME: secrets.ghAppName,
    WAIT_MS: '0',
    COMMENT: `Preview Environment is set up: [${previewUrl}](https://${previewUrl})`,
    COMMENTS_URL: commentsUrl,
    TOKEN: JSON.parse(payload).token
  }

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
    prCommenter.run()
  } catch (err) {
    return sendSignal({ stage: deployStage, logs: err.toString(), conclusion: failure, payload })
  }
}

function rerequestCheckSuite (url, token, ghAppName) {
  console.log('No PR-id found. Will re-request the check_suite.')
  request({
    uri: `${url}/rerequest`,
    json: true,
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': ghAppName,
      'Accept': 'application/vnd.github.antiope-preview+json'
    },
    method: 'POST'
  }).on('response', function (response) {
    console.log(response.statusCode)
    console.log(response.statusMessage)
  }).on('error', function (err) {
    console.log(err)
  })
}

module.exports = { registerCheckSuite, runCheckSuite, sendSignal, rerequestCheckSuite }
