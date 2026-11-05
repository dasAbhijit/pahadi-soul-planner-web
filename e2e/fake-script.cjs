// The REAL cloud/Code.gs inside a fake Google environment. call(bodyText) -> response text.
const { makeEnv: make } = require('../cloud/fake-google.js');
function makeEnv(token) {
  const env = make(token);
  return { sheets: env.sheets, props: env.props, env, call: (body) => JSON.stringify(env.call(body)) };
}
module.exports = { makeEnv };
