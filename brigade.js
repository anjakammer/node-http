const { events, Job, Group } = require('brigadier')
const request = require('request')

const checkRunImage = 'deis/brigade-github-check-run:latest'
const buildStage = '1-Build'
const testStage = '2-Test'
const deployStage = '3-Deploy'
const failure = 'failure'
const cancelled = 'cancelled'
const success = 'success'
let prodDeploy = false
let prNr = 0

events.on('check_suite:requested', checkRequested)
events.on('check_suite:rerequested', checkRequested)

async function checkRequested (e, p) {
  console.log('Check-Suite requested')
  const payload = JSON.parse(e.payload)
  const pr = payload.body.check_suite.pull_requests
  prodDeploy = payload.body.check_suite.head_branch === p.secrets.prodBranch
  if (pr.length !== 0 || prodDeploy) {
    prNr = pr.length !== 0 ? payload.body.check_suite.pull_requests[0].number : 0
    runCheckSuite(e.payload, p.secrets)
      .then(() => { return console.log('Finished Check-Suite') })
      .catch((err) => { console.log(err) })
  } else if (payload.body.action !== 'rerequested') {
    rerequestCheckSuite(payload.body.check_suite.url, payload.token, p.secrets.ghAppName)
  }
}

async function runCheckSuite (payload, secrets) {
  registerCheckSuite(payload)
  const parse = new Job('parse-yaml', 'anjakammer/yaml-parser:latest')
  parse.env.DIR = '/src/.anya'
  parse.imageForcePull = true
  let config = ''

  try {
    let result = await parse.run()
    config = JSON.parse(result.substring(result.indexOf('{') - 1, result.lastIndexOf('}')))
    sendSignal({ stage: testStage, logs: config, conclusion: success, payload })
  } catch (err) {
    await sendSignal({ stage: testStage, logs: 'pipeline configuration is missing', conclusion: failure, payload })
    return
  }

  const webhook = JSON.parse(payload).body
  const appName = webhook.repository.name
  const imageTag = (webhook.check_suite.head_sha).slice(0, 7)
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
  test.useSource = false
  test.tasks = [
    `echo "Running Tests"`,
    'npm test' // TODO test call needs to be declared in test.yaml
  ]

  const targetPort = 8080 // TODO fetch this from dockerfile
  const host = prodDeploy ? secrets.prodHost : secrets.prevHost
  const path = prodDeploy ? secrets.prodPath : `/preview/${appName}/${imageTag}`
  const url = `${host}${path}`
  const tlsName = prodDeploy ? secrets.prodTLSName : secrets.prevTLSName
  const deploymentName = prodDeploy ? `${appName}-${imageTag}` : `${appName}-${imageTag}-preview`
  const namespace = prodDeploy ? 'production' : 'preview'
  const deploy = new Job(deployStage.toLowerCase(), 'lachlanevenson/k8s-helm')
  deploy.useSource = false
  deploy.privileged = true
  deploy.serviceAccount = 'anya-deployer'
  deploy.tasks = [
    'helm init --client-only > /dev/null 2>&1',
    'helm repo add anya https://storage.googleapis.com/anya-deployment/charts > /dev/null 2>&1',
    `helm upgrade --install ${deploymentName} anya/deployment-template --namespace ${namespace} --set-string image.repository=${secrets.DOCKER_REGISTRY}/${secrets.DOCKER_REPO}/${appName},image.tag=${imageTag},ingress.path=${path},ingress.host=${host},ingress.tlsSecretName=${tlsName},service.targetPort=${targetPort},nameOverride=${appName},fullnameOverride=${deploymentName}`,
    `echo "URL: <a href="https://${url}" target="_blank">${url}</a>"`
  ]

  const repo = webhook.repository.full_name
  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNr}/comments`
  const prCommenter = new Job('4-pr-comment', 'anjakammer/brigade-pr-comment')
  prCommenter.useSource = false
  prCommenter.env = {
    APP_NAME: secrets.ghAppName,
    WAIT_MS: '0',
    COMMENT: `Preview Environment is set up: <a href="https://${url}" target="_blank">${url}</a>`,
    COMMENTS_URL: commentsUrl,
    TOKEN: JSON.parse(payload).token
  }

//   let result
//
//   try {
//     result = await build.run()
//     sendSignal({ stage: buildStage, logs: result.toString(), conclusion: success, payload })
//   } catch (err) {
//     await sendSignal({ stage: buildStage, logs: err.toString(), conclusion: failure, payload })
//     await sendSignal({ stage: testStage, logs: '', conclusion: cancelled, payload })
//     return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled, payload })
//   }
//
//   try {
//     result = await test.run()
//     sendSignal({ stage: testStage, logs: result.toString(), conclusion: success, payload })
//   } catch (err) {
//     await sendSignal({ stage: testStage, logs: err.toString(), conclusion: failure, payload })
//     return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled, payload })
//   }
//
//   try {
//     result = await deploy.run()
//     sendSignal({ stage: deployStage, logs: result.toString(), conclusion: success, payload })
//     if (!prodDeploy) { prCommenter.run() }
//   } catch (err) {
//     return sendSignal({ stage: deployStage, logs: err.toString(), conclusion: failure, payload })
//   }
// }

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
    this.useSource = false
    this.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description',
      CHECK_SUMMARY: `${check} scheduled`
    }
  }
}

module.exports = { registerCheckSuite, runCheckSuite, sendSignal, rerequestCheckSuite }
