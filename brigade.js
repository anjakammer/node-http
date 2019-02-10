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
let config = ''
let payload = ''
let webhook = ''
let secrets = ''
let slackNotifyOnSuccess = false
let slackNotifyOnFailure = false
let previewUrlAsComment = false
let purgePreviewDeployments = false // TODO
let testStageTasks = []

events.on('check_suite:requested', checkRequested)
events.on('check_suite:rerequested', checkRequested)

async function checkRequested (e, p) {
  console.log('Check-Suite requested')
  payload = e.payload
  webhook = JSON.parse(payload)
  secrets = p.secrets

  const pr = webhook.body.check_suite.pull_requests
  prodDeploy = webhook.body.check_suite.head_branch === secrets.prodBranch
  if (pr.length !== 0 || prodDeploy) {
    prNr = pr.length !== 0 ? webhook.body.check_suite.pull_requests[0].number : 0
    await parseConfig()
    return runCheckSuite()
      .then(() => { return console.log('Finished Check-Suite') })
      .catch((err) => { console.log(err) })
  } else if (webhook.body.action !== 'rerequested') {
    return rerequestCheckSuite() // TODO debug this
  }
}

async function runCheckSuite () {
  registerCheckSuite()
  const appName = webhook.body.repository.name
  const imageTag = (webhook.body.check_suite.head_sha).slice(0, 7)
  const imageName = `${secrets.DOCKER_REPO}/${appName}:${imageTag}`

  const build = new Job(buildStage.toLowerCase(), 'docker:stable-dind')
  build.privileged = true
  build.env.DOCKER_DRIVER = 'overlay'
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
  test.tasks = testStageTasks

  const targetPort = 8080 // TODO fetch this from dockerfile
  const host = prodDeploy ? secrets.prodHost : secrets.prevHost
  const path = prodDeploy ? secrets.prodPath : `/preview/${appName}/${imageTag}`
  const url = `${host}${path}`
  const tlsName = prodDeploy ? secrets.prodTLSName : secrets.prevTLSName
  const deploymentName = prodDeploy ? `${appName}` : `${appName}-${imageTag}-preview`
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

  const repo = webhook.body.repository.full_name
  const prCommenter = new Job('pr-comment', 'anjakammer/brigade-pr-comment')
  prCommenter.storage.enabled = false
  prCommenter.useSource = false
  prCommenter.env = {
    APP_NAME: secrets.ghAppName,
    WAIT_MS: '0',
    COMMENT: `Preview Environment is set up: <a href="https://${url}" target="_blank">${url}</a>`,
    COMMENTS_URL: `https://api.github.com/repos/${repo}/issues/${prNr}/comments`,
    TOKEN: webhook.token
  }

  let result

  try {
    result = await build.run()
    sendSignal({ stage: buildStage, logs: result.toString(), conclusion: success })
  } catch (err) {
    await sendSignal({ stage: buildStage, logs: err.toString(), conclusion: failure })
    await sendSignal({ stage: testStage, logs: '', conclusion: cancelled })
    return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled })
  }

  try {
    result = await test.run()
    sendSignal({ stage: testStage, logs: result.toString(), conclusion: success })
  } catch (err) {
    await sendSignal({ stage: testStage, logs: err.toString(), conclusion: failure })
    return sendSignal({ stage: deployStage, logs: '', conclusion: cancelled })
  }

  try {
    result = await deploy.run()
    sendSignal({ stage: deployStage, logs: result.toString(), conclusion: success })
    if (!prodDeploy && previewUrlAsComment) { prCommenter.run() }
    if (slackNotifyOnSuccess) { slackNotify('Successful Deployment', `<${url}>`) }
  } catch (err) {
    if (slackNotifyOnFailure) { slackNotify('Failed Deployment', imageName) }
    return sendSignal({ stage: deployStage, logs: err.toString(), conclusion: failure })
  }
}

function registerCheckSuite () {
  return Group.runEach([
    new RegisterCheck(buildStage),
    new RegisterCheck(testStage),
    new RegisterCheck(deployStage)
  ]).catch(err => { console.log(err) })
}

class RegisterCheck extends Job {
  constructor (check) {
    super(`register-${check}`.toLowerCase(), checkRunImage)
    this.storage.enabled = false
    this.useSource = false
    this.env = {
      CHECK_PAYLOAD: payload,
      CHECK_NAME: check,
      CHECK_TITLE: 'Description',
      CHECK_SUMMARY: `${check} scheduled`
    }
  }
}

async function parseConfig () {
  const parse = new Job('0-parse-yaml', 'anjakammer/yaml-parser:latest')
  parse.imageForcePull = true
  parse.env.DIR = '/src/anya'
  parse.env.EXT = '.yaml'
  parse.run()
    .then((result) => {
      config = result.toString()
      config = JSON.parse(config.substring(config.indexOf('{') - 1, config.lastIndexOf('}') + 1))
      slackNotifyOnSuccess = config.deploy.onSuccess.slackNotify
      slackNotifyOnFailure = config.deploy.onFailure.slackNotify
      previewUrlAsComment = config.deploy.onSuccess.previewUrlAsComment
      purgePreviewDeployments = config.deploy.pullRequest.onClose.purgePreviewDeployments
      testStageTasks = config.test.tasks
    })
    .catch(err => { throw err })
}

function sendSignal ({ stage, logs, conclusion }) {
  const assertResult = new Job(`result-of-${stage}`.toLowerCase(), checkRunImage)
  assertResult.storage.enabled = false
  assertResult.useSource = false
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

function rerequestCheckSuite () {
  console.log('No PR-id found. Will re-request the check_suite.')
  request({
    uri: `${webhook.body.check_suite.url}/rerequest`,
    json: true,
    headers: {
      'Authorization': `token ${webhook.token}`,
      'User-Agent': secrets.ghAppName,
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

function slackNotify (title, message) {
  const slack = new Job('slack-notify', 'technosophos/slack-notify:latest', ['/slack-notify'])
  slack.storage.enabled = false
  slack.useSource = false
  slack.env = {
    SLACK_WEBHOOK: secrets.SLACK_WEBHOOK,
    SLACK_CHANNEL: secrets.SLACK_CHANNEL,
    SLACK_USERNAME: 'anya',
    SLACK_TITLE: title,
    SLACK_MESSAGE: message,
    SLACK_COLOR: '#23B5AF',
    SLACK_ICON: 'https://storage.googleapis.com/anya-deployment/anya-logo.png'
  }
  slack.run()
}

module.exports = { parseConfig, registerCheckSuite, runCheckSuite, sendSignal, rerequestCheckSuite, slackNotify }
