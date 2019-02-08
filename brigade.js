const { events, Job, Group } = require('brigadier')
const request = require('request')

const checkRunImage = 'deis/brigade-github-check-run:latest'
const buildStage = '1-Build'
const testStage = '2-Test'
const deployStage = '3-Deploy'
const failure = 'failure'
const cancelled = 'cancelled'
const success = 'success'

events.on('check_suite:requested', checkRequested)
events.on('check_suite:rerequested', checkRequested)

async function checkRequested (e, p) {
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

function registerCheckSuite (payload) {
  return Group.runEach([
    new RegisterCheck(buildStage, payload),
    new RegisterCheck(testStage, payload),
    new RegisterCheck(deployStage, payload)
  ]).catch(err => { console.log(err) })
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
  const imageTag = (webhook.check_suite.head_sha).slice(0, 5)
  const imageName = `${secrets.DOCKER_REPO}/${appName}:${imageTag}`

  const build = new Job(buildStage.toLowerCase(), 'docker:stable-dind')
  build.privileged = true
  build.env = {
    DOCKER_DRIVER: 'overlay'
  }
  build.tasks = [
    'dockerd-entrypoint.sh > /dev/null 2>&1 &',
    'sleep 20',
    'cd /src',
    `echo ${secrets.DOCKER_PASS} | docker login -u ${secrets.DOCKER_USER} --password-stdin ${secrets.DOCKER_REGISTRY} > /dev/null 2>&1`,
    `docker build -t ${imageName} .`,
    `docker push ${imageName}`
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

  const deployHelm = new Job('deploy-with-helm', 'lachlanevenson/k8s-helm')
  deployHelm.privileged = true
  deployHelm.serviceAccount = 'anya-deployer'
  deployHelm.tasks = [
    'helm init --client-only',
    'helm repo add anya https://storage.googleapis.com/anya-deployment/charts',
    `helm upgrade --install ${appName}-${imageTag}-preview anya/deployment-template --namespace preview`
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
    result = await deployHelm.run()
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

class RegisterCheck extends Job {
  constructor (check, payload) {
    super(`register-${check}`.toLowerCase(), checkRunImage)
    this.imageForcePull = true
    this.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description',
      CHECK_SUMMARY: `${check} scheduled`
    }
  }
}

module.exports = { registerCheckSuite, runCheckSuite, sendSignal, rerequestCheckSuite }
