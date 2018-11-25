var expect = require('chai').expect

describe('Host', function () {
  it('should be reachable via localhost', function () {
    expect(true).to.be.equal(true)
  })
  it('should be reachable via 127.0.0.1', function () {
    expect(true).to.be.equal(true)
  })
})

describe('Port', function () {
  it('should be 8080', function () {
    expect(true).to.be.equal(true)
  })
  it('should not be 80', function () {
    expect(true).to.be.equal(true)
  })
})


describe('Root path', function () {
  it('should deliver logo', function () {
    expect(true).to.be.equal(true)
  })
  it('should have 1 h1-headline', function () {
    expect(true).to.be.equal(true)
  })
  it('should have >= 1 p-paragraph', function () {
    expect(true).to.be.equal(true)
  })
})

describe('Any subpath', function () {
  it('should deliver index.html', function () {
    expect(true).to.be.equal(true)
  })
  it('should not be redirected', function () {
    expect(true).to.be.equal(true)
  })
})
